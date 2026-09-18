// Destroyer multiplayer server — reimplementation.
//
// Protocol derived from the DECOMPILED client (output/main_swf/scripts/__Packages/CSocket*.as
// and scripts/frame_1/DoAction.as). Key facts that drive this implementation:
//
//  * Transport is Flash XMLSocket: every message is terminated by a single NUL (\x00).
//    The NUL is the frame delimiter; the client appends/strips it automatically.
//  * Wire format of EVERY message (both directions) is:
//        "<len> <senderID> <COMMAND> <args...>"
//    chopMessage() (CSocket.as) splits on spaces and takes field[2] as the command,
//    so a server message that omits the senderID field is parsed with the command in
//    the senderID slot and is silently dropped. THIS was the original "stuck at
//    Connecting..." bug. We therefore ALWAYS emit a senderID field ("-" for server).
//    <len> is the byte length of "<senderID> <COMMAND> <args>" + 1; the client ignores
//    it but we compute it faithfully.
//  * Login is a 5-stage redirect chain, each stage a fresh TCP connection (here all
//    pointed back at this same server):
//        1. directory       : client -> GETONE x AUTH        ; server -> HERE
//        2. authentication   : server -> CHALLENGE (first!)   ; client -> AUTH x user%%%digest
//                              server -> AUTHOK <token>\n<host>:<port>:<name>
//        3. secure directory : client -> CHECKUSERTOKEN, GETONE x DESTROYER ; server -> TOKENOK, HERE
//        4. lobby            : client -> CHECKUSERTOKEN, MONITORROOMS ; server -> TOKENOK, SERVERPARAMS, ROOMLIST
//        5. game + chat      : client -> CHECKUSERTOKEN, JOIN ; server -> TOKENOK, SCREENNAME, JOINED, ROOMPARAMS
//    The auth stage is the ONLY one where the server speaks first (proactive CHALLENGE).
//  * Auth digest = MD5(username + password + challenge); response content = "user%%%digest".
//  * HERE/AUTHOK addresses are "host:port:name" (colon separated). HERE args are
//    "<type>\t<host>:<port>:<name>"; the secure-directory stage requires type === game id.
//
// Because every stage redirects to this same host:port, the server is essentially
// stateless-per-connection and reacts to whatever the client sends. We send a proactive
// CHALLENGE on connect to satisfy the auth stage; the other stages harmlessly ignore it.

const net = require('net');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TCP_PORT = Number(process.env.DESTROYER_PORT || 10101);
const HTTP_PORT = Number(process.env.DESTROYER_HTTP || 8080);

// Address we redirect every stage back to. Override with env for LAN / isolated testing.
// Address every login stage / room-connect redirects clients back to. By default the server
// REFLECTS whatever address each client connected to (its socket's local address): a localhost
// client gets 127.0.0.1, a LAN client gets the server's LAN IP — so LAN play needs ZERO host
// config (no remote joiner ever gets redirected to its own 127.0.0.1). Set DESTROYER_HOST to
// force a single advertised address (e.g. behind NAT/port-forwarding) and override reflection.
const SELF_HOST = process.env.DESTROYER_HOST || '127.0.0.1';
const SELF_PORT = TCP_PORT;
const GAME_ID = 'DESTROYER';

// Normalize a Node socket localAddress to an IPv4-ish host the Flash client can dial:
// strip the IPv4-mapped-IPv6 prefix and map IPv6 loopback to 127.0.0.1.
function cleanAddr(a) {
  if (!a) return null;
  if (a === '::1') return '127.0.0.1';
  if (a.startsWith('::ffff:')) return a.slice(7);
  return a;
}

// Gap (ms) between consecutive messages flushed to one client. The Director client's de-framer
// (ParentScript mOnGetString) only processes ONE message per network delivery and DROPS leading
// messages when several arrive glued in one read — which corrupted seat state on first join
// (room already has a seated bot => dense SCREENNAME/JOINED/ROOMPARAMS/SITS burst) and threw a
// Lingo "Index out of range". Spacing writes across event-loop ticks guarantees one onData per
// message. Isolated messages (the gameplay relay hot path) are flushed immediately with no gap;
// only bursts are spaced, so this adds no perceptible latency. Overridable for testing.
//
// 2026-08-16: 50ms was enough on Windows but NOT under Wine — the client pumps its socket once
// per Director frame, and the lobby->room transition has frames long enough that three 50ms-spaced
// messages still landed in one read. Proven by the client's own debug Message window:
//   playername = "CPU-Easy16 - ENTERS Player17 me SITS 1"   <- SITS/ENTERS/SITS glued into one
// followed immediately by the "Index out of range" Script Error. 300ms: clean (playerCount = 2,
// no dialog), reproduced 2x each way. Only the join burst pays this; gameplay still flushes hot.
const SEND_GAP_MS = Number(process.env.DESTROYER_SEND_GAP || 300);

// Flash's XMLSocket does an implicit crossdomain-policy handshake (via :843, or inline on this
// same port) before it trusts real data on a freshly-opened socket. We used to send HELO on the
// very next tick after accept -- racing ahead of that handshake -- and the real client tore the
// connection down with zero bytes sent to us (confirmed 2026-08-14: c1 in the log received our
// HELO and closed without ever sending anything). Give the client's own policy check a real
// window before we say anything first.
const GREET_DELAY_MS = Number(process.env.DESTROYER_GREET_DELAY || 150);

function ts() { return new Date().toISOString().slice(11, 23); }
function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function randHex(n) { return crypto.randomBytes(n).toString('hex'); }

// ----------------------------------------------------------------------------
// Rooms
// ----------------------------------------------------------------------------

class Room {
  constructor(id, password) {
    this.id = id;
    this.password = password || '';
    this.public = password ? '0' : '1';
    this.gameType = 'Skirmish';         // Tutorial | Skirmish | Battle (affects game duration)
    this.seats = [null, null];          // two playable seats
    this.members = new Set();           // all connections in the room (game + chat)
    this.started = false;               // guards against double STARTGAME per match
    this.ended = false;                 // guards against double ENDGAME per match
  }
  occupantNames() {
    const names = new Set();
    for (const c of this.members) if (c.name) names.add(c.name);
    return Array.from(names);
  }
  fullness() {
    const taken = this.seats.filter(s => s).length;
    if (taken === 0) return 'Empty';
    if (taken >= this.seats.length) return 'Full';
    return 'Open';
  }
  broadcast(senderId, cmd, args, except) {
    for (const c of this.members) if (c !== except) c.send(senderId, cmd, args);
  }
}

// Maps an issued auth token -> username, so later stages (which only present the
// opaque token via CHECKUSERTOKEN) can recover the player's real screen name.
const tokens = new Map();

const rooms = new Map();
function getOrCreateRoom(id, password) {
  let r = rooms.get(id);
  if (!r) { r = new Room(id, password); rooms.set(id, r); }
  return r;
}
// Three default rooms, one per bot difficulty, so the lobby always offers an Easy/Normal/Hard
// CPU opponent to play. Room ids have no spaces (the protocol is space-delimited). The bots
// (server/bot.js) join these by name; the human clicks Play on the one they want.
const DEFAULT_ROOMS = ['Easy', 'Normal', 'Hard'];
DEFAULT_ROOMS.forEach(id => getOrCreateRoom(id, ''));

// ----------------------------------------------------------------------------
// Connection
// ----------------------------------------------------------------------------

let nextId = 1;
const clients = new Map();

class Conn {
  constructor(sock) {
    this.id = nextId++;
    this.sock = sock;
    this.buf = '';
    // Address WE advertise to THIS client in redirects. DESTROYER_HOST forces it; otherwise we
    // reflect the local address this client reached us on, so localhost and LAN both "just work".
    this.host = process.env.DESTROYER_HOST || cleanAddr(sock.localAddress) || SELF_HOST;
    this.challenge = randHex(16);
    this.name = null;          // screen name, assigned at JOIN
    this.room = null;
    this.seat = -1;
    this.ready = false;
    this.opponent = null;
    this.damage = 0;           // aggregate fleet damage this player has reported (0..1)
    this.isGame = false;       // set true once this conn sends SIT/STAND/READY (the game socket)
    this.isWatcher = false;    // spectator: joined a room but holds no seat — still gets relays
    this.isLobby = false;      // set true on MONITORROOMS — receives live ROOMOPENS broadcasts
    this.skipGreet = false;    // set true by onCheckToken — this conn is reusing a token, never needed the HELO/CHALLENGE greet (see the setTimeout below)
    this.lastSeen = Date.now();// for the dead-connection sweep (frees seats held by dead links)
    this.sendQueue = [];       // outbound frames, flushed one-per-tick so they never coalesce
    this.flushing = false;     // (see SEND_GAP_MS — the Director client de-frames one msg/read)

    sock.setEncoding('binary');
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.onClose());
    sock.on('error', e => console.log(`[${ts()}][c${this.id}] socket error: ${e.message}`));

    // The auth stage waits for the server to challenge first; other stages ignore it.
    // Delayed (see GREET_DELAY_MS) so we don't race the client's own policy handshake.
    //
    // BUG FOUND 2026-08-15: this fired unconditionally for every connection, including ones that
    // skip auth entirely via CHECKUSERTOKEN (the lobby/game/chat connections opened after a token
    // already exists). On a busy connection its queued send lands late -- after ROOMPARAMS/SITS
    // already reached the client -- and the client's shared message dispatcher treats ANY "HELO"
    // as a first-time login (ParentScript 3: `"HELO": me.mFirstMethod()` -> `mReInit()`), which
    // silently resets `pPlayerState` back to #none. That leaves `gameState` stuck at `#init`
    // forever (the #init->#INTRO transition in AllVessels.ls requires pPlayerState = #player), so
    // the 3D scene never initializes: HUD renders, viewport stays black, and per-frame subsystems
    // (camera/smoke/etc, which run unconditionally even in #init) flicker against an empty scene.
    // Confirmed via `--trace` log: SITS set pPlayerState=#player, then a stray HELO arrived and it
    // flipped back to #none, with zero RESETGAME/newPanel afterward. Skip the greet once a
    // connection has proven it's reusing a token (`onCheckToken`) -- it never needed the auth
    // handshake in the first place.
    //
    // AMENDED 2026-08-16: the timing was the bug, not the HELO. A token-reusing conn still needs
    // exactly one HELO -- it is what drives the client into the game score -- so `onCheckToken`
    // sends its own, immediately and in queue order. See the long note there before changing this.
    setTimeout(() => {
      if (sock.destroyed || this.skipGreet) return;
      this.send('-', 'HELO', '');
      this.send('-', 'CHALLENGE', this.challenge);
    }, GREET_DELAY_MS);
  }

  // Build "<len> <senderID> <COMMAND> <args>\0" and enqueue it. Frames are flushed one per tick
  // (see _flush / SEND_GAP_MS) so they never arrive glued in a single client read — the Director
  // client de-frames exactly one message per delivery and drops the rest.
  send(senderId, cmd, args) {
    let body = senderId + ' ' + cmd;
    if (args !== undefined && args !== null && args !== '') body += ' ' + args;
    const len = body.length + 1;
    const wire = len + ' ' + body + '\0';
    this.sendQueue.push({ wire, cmd, args });
    if (!this.flushing) { this.flushing = true; setImmediate(() => this._flush()); }
  }

  // Write one queued frame, then schedule the next after SEND_GAP_MS. Same-tick sends accumulate
  // first (the flush is deferred via setImmediate), so a burst goes out spaced; a lone message
  // goes out on the next tick with no following gap.
  _flush() {
    const item = this.sendQueue.shift();
    if (!item) { this.flushing = false; return; }
    console.log(`[${ts()}][c${this.id}] >> ${item.cmd} ${item.args !== undefined ? item.args : ''}`.trimEnd());
    try { this.sock.write(item.wire, 'binary'); } catch (e) {
      console.log(`[${ts()}][c${this.id}] send failed: ${e.message}`);
    }
    if (this.sendQueue.length) setTimeout(() => this._flush(), SEND_GAP_MS);
    else this.flushing = false;
  }

  onData(chunk) {
    this.lastSeen = Date.now();
    this.buf += chunk;
    // Inline Flash policy fallback: if a client asks for the socket policy on the game port
    // itself (some builds do), answer it here too (the dedicated :843 server is the primary path).
    if (this.buf.indexOf('<policy-file-request/>') !== -1) {
      try { this.sock.write('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0'); this.sock.end(); } catch (e) {}
      this.buf = '';
      return;
    }
    let nul;
    while ((nul = this.buf.indexOf('\x00')) !== -1) {
      const msg = this.buf.slice(0, nul);
      this.buf = this.buf.slice(nul + 1);
      if (msg.length) this.handle(msg);
    }
  }

  // Parse "<len> <senderID> <COMMAND> <args...>" the same way chopMessage does.
  handle(raw) {
    const parts = raw.split(' ');
    const senderId = parts[1];
    const cmd = parts[2];
    const args = parts.slice(3).join(' ');
    console.log(`[${ts()}][c${this.id}] << ${cmd} ${args}`.trimEnd());

    switch (cmd) {
      case 'GETONE':         return this.onGetOne(args);
      case 'AUTH':           return this.onAuth(args);
      case 'CHECKUSERTOKEN': return this.onCheckToken(args);
      case 'MONITORROOMS':   return this.onMonitorRooms();
      case 'JOIN':           return this.onJoin(args);
      case 'OPENROOM':       return this.onOpenRoom(senderId, args);
      case 'SIT':            return this.onSit();
      case 'STAND':          return this.onStand();
      case 'BOOT':           return; // not implemented
      case 'CHAT':           return this.onChat(senderId, args);
      case 'PING':           return this.send('-', 'PONG', '');
      case 'PONG':           return;
      case 'LOGOUT':         return;
      default:               return this.onGameRelay(cmd, args, raw);
    }
  }

  // Stage 1/3: directory lookup. We always redirect back to ourselves; the "type"
  // field must echo the requested name so the secure-directory check (type === GAME_ID)
  // passes for the DESTROYER lookup.
  onGetOne(name) {
    const addr = `${this.host}:${SELF_PORT}:${name}`;
    this.send('-', 'HERE', `${name}\t${addr}`);
  }

  // Stage 2: validate the challenge response and hand back a token + redirect.
  // args = "<username>%%%<digest>". We accept any digest (no password DB in this
  // preservation server) but log whether it matches the expected default password.
  onAuth(args) {
    const sep = args.indexOf('%%%');
    const user = sep === -1 ? args : args.slice(0, sep);
    const digest = sep === -1 ? '' : args.slice(sep + 3);
    this.name = user || `Player${this.id}`;
    const ok = digest === md5(user + (process.env.DESTROYER_PASSWORD || '') + this.challenge);
    console.log(`[${ts()}][c${this.id}] auth user="${user}" digest ${ok ? 'matches default-pass' : '(accepted, unverified)'}`);
    const token = randHex(16);
    tokens.set(token, this.name);
    this.send('-', 'AUTHOK', `${token}\n${this.host}:${SELF_PORT}:auth`);
  }

  // Recover the screen name bound to this token at auth time.
  onCheckToken(token) {
    this.skipGreet = true;   // the delayed auth-stage greet must not fire on this conn (see above)
    if (tokens.has(token)) this.name = tokens.get(token);
    this.send('-', 'TOKENOK', '');
    // HELO IS WHAT STARTS THE 3D GAME -- it is not just a pleasantry (found 2026-08-16).
    // ParentScript 3: `"HELO": me.mFirstMethod()` -> mReInit() + me.ready(). `ready()` only
    // reaches mReady -> goPlay -> go("main") while pPlayerState is NOT #player, and mReInit()
    // is what clears it -- so this one message is the *only* path from the lobby SWF into the
    // Director game score. Suppressing it entirely (the 2026-08-15 skipGreet fix) stopped the
    // late-HELO seat wipe but also meant the movie never left the lobby.
    // Send it HERE, in reply to CHECKUSERTOKEN, rather than on the GREET_DELAY_MS timer: the
    // per-conn send queue is FIFO, so HELO is guaranteed ahead of JOINED/ROOMPARAMS/SITS and
    // can never land after the seat state it would otherwise wipe. No CHALLENGE -- this conn
    // already authenticated with a token, and the client has no handler for it here.
    this.send('-', 'HELO', '');
  }

  // Stage 4: lobby. Send server params (incl. the chat server redirect) and a room list.
  onMonitorRooms() {
    this.isLobby = true;   // now eligible for live ROOMOPENS broadcasts (see onOpenRoom)
    // SERVERPARAMS: "<names...>\n<values...>" (tab separated). The "chat" value triggers
    // the client to open the chat connection.
    const spNames = ['chat', 'gameName', 'gameDescription', 'userCount'];
    const spVals = [`${this.host}:${SELF_PORT}:chat`, 'Destroyer', 'Naval combat', String(clients.size)];
    this.send('-', 'SERVERPARAMS', spNames.join('\t') + '\n' + spVals.join('\t'));
    // Single delayed room list: sending it a beat after MONITORROOMS gives the lobby UI time to
    // be ready to draw the Play/Watch buttons, without re-sending (re-sends do removeAll()+re-add
    // and make the rows flicker, so a click can miss the Play button and land on Watch).
    setTimeout(() => { if (!this.sock.destroyed) this.sendRoomList(); }, 600);
  }

  // ROOMLIST: header line of field names, then one line per room. The room-list row
  // (DefineSprite_296) renders playerList.split(",") — so that field MUST be present.
  sendRoomList() {
    const fields = ['name', 'connect', 'chat', 'public', 'full', 'playerList'];
    const lines = [fields.join('\t')];
    for (const r of rooms.values()) {
      if (r.id === 'chat') continue;   // lobby-wide chat pseudo-room is not a joinable game room
      lines.push([
        r.id,
        `${this.host}:${SELF_PORT}:${r.id}`,
        `${this.host}:${SELF_PORT}:${r.id}`,
        r.public,
        r.fullness(),
        r.occupantNames().join(',') || ' ',
      ].join('\t'));
    }
    this.send('-', 'ROOMLIST', lines.join('\n'));
  }

  onOpenRoom(senderId, args) {
    // OPENROOM <name> ...  — senderId carries the creator name; create + announce.
    const roomId = senderId || `room${this.id}`;
    getOrCreateRoom(roomId, '');
    const fields = ['name', 'connect', 'chat', 'public', 'full'];
    const r = rooms.get(roomId);
    // Broadcast to EVERYONE watching the lobby — not just the creator. The senderID encodes the
    // creator name (`-/<roomId>`, roomId == creator), so the SWF's onData auto-joins only the
    // creator (`split("/")[1] == m_strName`) while every other lobby client just adds the room to
    // its list. Without this broadcast, a second player parked in the lobby never sees the new
    // room appear (they'd have to re-enter the lobby to refresh) — which is the LAN
    // "P1 creates a room, P2 sees it" flow. ROOMLIST already includes created rooms for newcomers.
    // The room's connect address is built per-recipient (c.host) so each client gets a string that
    // points back at the server the way THEY reached it (localhost vs LAN IP).
    for (const c of clients.values()) {
      if (!c.isLobby) continue;
      const vals = [r.id, `${c.host}:${SELF_PORT}:${r.id}`, `${c.host}:${SELF_PORT}:${r.id}`, r.public, r.fullness()];
      c.send(`-/${roomId}`, 'ROOMOPENS', fields.join('\t') + '\n' + vals.join('\t'));
    }
    console.log(`[${ts()}][c${this.id}] OPENROOM "${roomId}" -> broadcast to lobby`);
  }

  // Stage 5: JOIN a room (sent on both the game and chat connections).
  // args = "<roomId>\t<password>"
  onJoin(args) {
    const [roomId] = args.split('\t');
    const room = getOrCreateRoom(roomId, '');
    if (this.room) this.room.members.delete(this);
    this.room = room;
    if (!this.name) this.name = `Player${this.id}`;
    room.members.add(this);

    this.send('-', 'SCREENNAME', this.name);

    // Spectator detection. The client's Watch button joins exactly like Play but never sits
    // (CSocketGame.onStartGame(false) => Director #watcher). If this connection joins while a
    // match is already running, both seats are taken, so it can only be a watcher — flag it so
    // gameplay is relayed to it (see onGameRelay). Players' own chat sockets are excluded because
    // their screen name IS among the seated names. Watchers that join BEFORE a match starts are
    // flagged later, in checkStart.
    const seatedNames = room.seats.filter(s => s).map(s => s.name);
    const joiningAsWatcher = room.started && !room.ended && !seatedNames.includes(this.name);
    if (joiningAsWatcher) this.isWatcher = true;

    // ROOMPARAMS is consumed by BOTH the SWF CSocketChat (needs name/occupantList) and the
    // Director's ParentScript.mSetGameParams (needs seats/occupantList/gametype — it does
    // datastrings.getPos("seats") then data[2][i]; a missing key indexes [0] and throws a
    // Lingo Script Error). So we must include all of them. occupantList is comma separated.
    const occ = room.occupantNames().join(',');
    const sendRoomParams = () => this.send('-', 'ROOMPARAMS',
      `name\tseats\toccupantList\tgametype\n${room.id}\t${room.seats.length}\t${occ}\t${room.gameType}`);
    // Catch the newcomer up on seats that are ALREADY occupied. They missed those SITS
    // broadcasts, and the Director only populates pPlayers from SITS — without this it never
    // sees the opponent seated and is stuck in the pre-game "waiting" state. senderID is the
    // sitter's name (not "me") so the Director records it as the opponent. Sent after
    // ROOMPARAMS so pPlayers is already sized.
    // senderID "0" (NOT "me"): the Director's mSits treats a SITS as "this is me" when the
    // senderID *contains the substring* "me" — so a name like "Gamer"/"Homer" would be
    // misread as self. Only the actor's own SITS gets "me"; everyone else gets "0".
    const sendCatchupSits = () => room.seats.forEach((occupant, idx) => {
      if (occupant && occupant !== this) this.send('0', 'SITS', `${idx}\t${occupant.name}`);
    });

    if (joiningAsWatcher) {
      // WATCHER ORDERING (do not "simplify" back to JOINED-first): a spectator's Director view
      // calls onStartGame(false) the INSTANT it processes JOINED, and mOnStartGame immediately
      // kicks the watcher back to the lobby when mCountPlayers()==0. pPlayers is sized by
      // ROOMPARAMS and populated ONLY by SITS — so if JOINED arrives first, the empty-room check
      // runs (~110ms later) before the catch-up SITS, which are spaced behind ROOMPARAMS by
      // SEND_GAP_MS and land ~4ms too late (measured). Delivering ROOMPARAMS + SITS BEFORE JOINED
      // guarantees pPlayers is populated when onStartGame(false) fires, so the watcher stays.
      sendRoomParams();
      sendCatchupSits();
      this.send('-', 'JOINED', room.id);
    } else {
      // Player / pre-match join: JOINED first (unchanged — players never hit the watcher kick).
      this.send('-', 'JOINED', room.id);
      sendRoomParams();
      sendCatchupSits();
    }
    // Tell everyone else this player entered.
    room.broadcast('-', 'ENTERS', this.name, this);
  }

  onSit() {
    this.isGame = true;
    if (!this.room) return;
    // Idempotent: a connection that is already seated must not grab a second seat. The real
    // client sends SIT twice (the SWF and the Director each issue one); without this guard a
    // single player took BOTH seats and the opponent got SITFAIL. Re-confirm the held seat.
    if (this.seat !== -1) { this.send('me', 'SITS', `${this.seat}\t${this.name}`); return; }
    let idx = this.room.seats.indexOf(null);
    if (idx === -1) {
      // Both seats full. If one is held by a STALE connection with OUR screen name, this is the
      // same player reconnecting (e.g. after a dropped link) — reclaim that seat instead of
      // failing, which would drop us into spectator mode (SITFAIL -> #watcher -> no HUD).
      // Screen names are unique, so a same-name seat-holder is a stale copy of us.
      const stale = this.room.seats.find(s => s && s !== this && s.name === this.name);
      if (!stale) { this.send('-', 'SITFAIL', ''); return; }
      idx = this.room.seats.indexOf(stale);
      stale.seat = -1; stale.opponent = null;          // so its onClose won't clobber the new seat
      this.room.seats[idx] = null;
      try { stale.sock.destroy(); } catch (e) {}
      console.log(`[${ts()}][c${this.id}] reclaimed seat ${idx} from stale "${this.name}" (was c${stale.id})`);
    }
    this.room.seats[idx] = this;
    this.seat = idx;
    // SITS content = "<seat>\t<name>". The Director (ParentScript.mSits) detects "this is
    // me" via `senderID contains "me"`, so echo to the actor with senderID "me" and to
    // everyone else with the actor's name. (CSocketGame detects self by screenname, so it
    // works either way.)
    // Actor sees "me" (mSits self-detection via `id contains "me"`); others get "0" so a name
    // containing the substring "me" can't be misread as self.
    const content = `${idx}\t${this.name}`;
    this.send('me', 'SITS', content);
    this.room.broadcast('0', 'SITS', content, this);
    this.checkStart();
  }

  onStand() {
    this.isGame = true;
    if (!this.room || this.seat === -1) return;
    this.room.seats[this.seat] = null;
    const was = this.seat;
    this.seat = -1;
    this.ready = false;
    this.send('me', 'STANDS', String(was));
    this.room.broadcast('0', 'STANDS', String(was), this);   // "0" not name (mStands also uses `id contains "me"`)
  }

  onChat(senderId, args) {
    if (!this.room) return;
    // Relay chat verbatim; senderId already encodes "<name>/R<room>" etc.
    this.room.broadcast(senderId, 'CHAT', args, this);
  }

  // READY arrives as a relayed game command (handled here so we can drive STARTGAME).
  onGameRelay(cmd, args, raw) {
    if (cmd === 'READY') {
      this.isGame = true;
      this.ready = true;
      this.checkStart();
      return;
    }
    // Only relay gameplay during an ACTIVE match. Same guard declareWinnerOpponent uses
    // (room.ended): once a match is over, a late message — e.g. a SUBUP surfacing the loser's
    // sub that arrives just after ENDGAME — must NOT be forwarded, or it strands "SUB
    // VULNERABLE" over the rematch button. Also skips stray pre-STARTGAME fire.
    if (!this.room || !this.room.started || this.room.ended) return;

    // Forward in-game actions to the opponent. The Director's relay handlers read the
    // SENDER'S SCREEN NAME from the first tab-field of the content (messageData[1][1]) —
    // it identifies which player acted (drives seat 1 vs 2 coordinate mirroring) and is
    // compared against the receiver's own name to ignore self-echoes. The client sends
    // only "<CMD> <payload>", so WE prepend "<screenname>\t". Relay to the opponent's game
    // socket AND to any spectators (isWatcher), so a watcher sees the live match. A watcher's
    // chat socket also carries isWatcher but harmlessly ignores game commands.
    const content = `${this.name}\t${args}`;
    for (const c of this.room.members) {
      if (c !== this && (c.isGame || c.isWatcher)) c.send('0', cmd, content);
    }

    // Win detection: no client ever sends ENDGAME (AllVessels only receives it), so the
    // server is authoritative. A player whose whole fleet is destroyed reports DAMAGE 1.0;
    // when that happens the OTHER seated player wins.
    if (cmd === 'DAMAGE') {
      const v = parseFloat(args);
      if (!isNaN(v)) this.damage = v;
      if (this.damage >= 1.0) this.declareWinnerOpponent();
    }
  }

  declareWinnerOpponent() {
    if (!this.room || this.room.ended) return;
    const winner = this.room.seats.find(s => s && s !== this);
    if (!winner) return;
    const room = this.room;
    room.ended = true;
    // ENDGAME content must have 3 tab fields so the Director's messageData[1].count == 3
    // (field 1 is the conventional screenname slot and is ignored for ENDGAME).
    room.broadcast('0', 'ENDGAME', `x\tWIN\t${winner.name}`);
    console.log(`[${ts()}] ENDGAME in ${room.id}: ${winner.name} WINS (${this.name} fleet destroyed)`);
    // KEEP players seated — after a game the client stays in its seat and offers a REMATCH
    // (clicking ready starts a new match). Just clear readiness/damage and, after a short
    // delay, re-arm the start/end guards so the next pair of READYs starts a fresh match.
    for (const c of room.members) { c.ready = false; c.damage = 0; }
    setTimeout(() => { room.ended = false; room.started = false; }, 2000);
  }

  checkStart() {
    if (!this.room || this.room.started) return;
    const seated = this.room.seats.filter(s => s);
    if (seated.length >= 2 && seated.every(s => s.ready)) {
      // Pair opponents and start (once).
      this.room.started = true;
      seated[0].opponent = seated[1];
      seated[1].opponent = seated[0];
      // Flag spectators that joined BEFORE the match started: any member who holds no seat and
      // whose name isn't one of the players (excludes the players' own chat sockets). They'll
      // receive the gameplay relay (onGameRelay) for the duration of the match.
      const seatedNames = seated.map(s => s.name);
      for (const c of this.room.members) {
        if (c.seat === -1 && !seatedNames.includes(c.name)) c.isWatcher = true;
      }
      this.room.broadcast('-', 'STARTGAME', '');
      console.log(`[${ts()}] STARTGAME in room ${this.room.id}`);
    }
  }

  onClose() {
    console.log(`[${ts()}][c${this.id}] disconnected`);
    if (this.room) {
      const room = this.room;
      const wasSeated = this.seat !== -1;
      if (wasSeated) room.seats[this.seat] = null;
      room.members.delete(this);
      room.broadcast('-', 'LEAVES', this.name || '');
      const opp = this.opponent;
      if (opp) opp.opponent = null;
      // A seated player dropping mid-match = the opponent wins by forfeit. We deliberately use
      // the WIN path (3 tab-fields) rather than ENDGAME ABANDONED: the Director does
      // messageData[1][2] on ENDGAME, so a 1-field "ABANDONED" body throws a Lingo "Index out
      // of range" script error. WIN carries x\tWIN\t<name> (count == 3) and is handled cleanly.
      if (wasSeated && room.started && !room.ended && opp && room.members.has(opp)) {
        room.ended = true;
        opp.send('0', 'ENDGAME', `x\tWIN\t${opp.name}`);
        console.log(`[${ts()}] ${opp.name} WINS by forfeit (${this.name} left ${room.id})`);
      }
      // Re-arm so survivors can start a rematch once the seat refills; clear stale readiness.
      if (wasSeated) { for (const c of room.members) c.ready = false; const r = room; setTimeout(() => { r.started = false; r.ended = false; }, 2000); }
    }
    clients.delete(this.id);
  }
}

// ----------------------------------------------------------------------------
// Servers
// ----------------------------------------------------------------------------

net.createServer(sock => {
  const c = new Conn(sock);
  clients.set(c.id, c);
  console.log(`[${ts()}][c${c.id}] connected from ${sock.remoteAddress}:${sock.remotePort}`);
}).listen(TCP_PORT, '0.0.0.0', () => console.log(`[${ts()}] TCP game server on :${TCP_PORT} (redirect host ${SELF_HOST})`));

// Flash socket-policy server. Under Flashpoint the client runs from a URL (network sandbox) and
// its XMLSocket to 127.0.0.1 is cross-domain, so Flash first fetches a socket policy from
// xmlsocket://<host>:843 before it will connect — with no policy it silently refuses and the game
// shows "Service is down". (Our local-file dev tests ran in the local sandbox and skipped this;
// the Node bots skip it too — it's Flash-only.) Answer any <policy-file-request/> with an
// allow-all policy. Binding 843 can fail (privileged/in-use) — log and continue if so.
const FLASH_POLICY =
  '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0';
net.createServer(sock => {
  sock.setEncoding('binary');
  console.log(`[${ts()}][policy] connection from ${sock.remoteAddress}:${sock.remotePort}`);
  const reply = () => { try { sock.write(FLASH_POLICY); sock.end(); console.log(`[${ts()}][policy] sent policy`); } catch (e) {} };
  sock.on('data', d => { console.log(`[${ts()}][policy] recv ${JSON.stringify(String(d).slice(0,60))}`); });
  sock.on('error', () => {});
  // Real Adobe socket-policy servers push immediately on connect, no request needed.
  // A delayed fallback here loses the race against the client's own near-instant
  // :10101 connect attempt (observed: client opens both sockets within ~1ms of each
  // other, and its :10101 attempt gives up in <50ms) -- so reply with zero delay.
  reply();
}).listen(843, '0.0.0.0', () => console.log(`[${ts()}] Flash socket-policy server on :843`))
  .on('error', e => console.log(`[${ts()}] policy server :843 unavailable (${e.code}) — inline :${TCP_PORT} fallback still active`));

// Flash's documented fallback when it can't reach the :843 socket-policy server: fetch a normal
// crossdomain.xml over HTTP from port 80 of the target host. :843 and :80 are both privileged
// ports (need root on Linux/Mac), so a non-root run can lose :843 silently -- a Flashpoint tester
// hit exactly this and only got past "Service is down" after adding this file by hand (2026-09-18,
// FP Discord). Same allow-all policy, same privileged-port guard.
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/x-cross-domain-policy' });
  res.end('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>');
}).listen(80, '0.0.0.0', () => console.log(`[${ts()}] crossdomain.xml fallback on :80`))
  .on('error', e => console.log(`[${ts()}] :80 crossdomain.xml fallback unavailable (${e.code})`));

const PROJECT_DIR = path.resolve(__dirname, '..');
const MIME = { '.dcr': 'application/x-director', '.swf': 'application/x-shockwave-flash',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.txt': 'text/plain' };

http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/launcher.html';
  const filePath = path.join(PROJECT_DIR, url.replace(/^\//, ''));
  if (!filePath.startsWith(PROJECT_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { console.log(`[${ts()}][http] 404 ${req.url}`); res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(HTTP_PORT, '0.0.0.0', () => console.log(`[${ts()}] HTTP server on http://localhost:${HTTP_PORT}`));

// Dead-connection sweep. The client (CSocket) pings the server every 30s, so any live link
// has traffic within ~30s; a connection silent for 75s is a dead/half-open socket. Dropping
// it fires onClose, which frees its seat — so a crashed client can't leave a room stuck
// "full" and force the next joiner into spectator mode.
const IDLE_LIMIT = 75000;
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    if (now - c.lastSeen > IDLE_LIMIT) {
      console.log(`[${ts()}][c${c.id}] idle ${Math.round((now - c.lastSeen) / 1000)}s — dropping dead connection`);
      try { c.sock.destroy(); } catch (e) {}
    }
  }
}, 20000);
