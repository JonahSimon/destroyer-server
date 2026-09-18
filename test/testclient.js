// Faithful test harness for the Destroyer login chain.
//
// This replicates the DECOMPILED client's socket behaviour (output/main_swf/scripts/
// __Packages/CSocket*.as + scripts/frame_1/DoAction.as) closely enough to validate the
// server's protocol end-to-end WITHOUT launching Shockwave/SPR:
//   * XMLSocket framing: messages are NUL-terminated; we append/strip \x00.
//   * chopMessage(): field[1]=senderID, field[2]=command, field[3..]=args (joined).
//   * sendFormatted(fn, params, content) => "<len> <params> <fn> <content>".
//   * The exact redirect orchestration from DoAction.as.
//
// Run the server first (node server.js), then: node testclient.js
// Exits 0 if the chain reaches JOINED + STARTGAME, non-zero otherwise.

const net = require('net');
const crypto = require('crypto');

const HOST = process.env.DESTROYER_HOST || '127.0.0.1';
const PORT = Number(process.env.DESTROYER_PORT || 10101);
const USER = process.env.DESTROYER_USER || 'TestPlayer';
const PASS = process.env.DESTROYER_PASSWORD || '';   // sw2; server accepts any
const GAME_ID = 'DESTROYER';

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function log(tag, m) { console.log(`  [${tag}] ${m}`); }

// Mirror CSocket.chopMessage: split on spaces, first 3 fields, rest joined.
function chop(data) {
  const a = data.split(' ');
  const head = a.splice(0, 3);
  head.push(a.join(' '));
  return head; // [len, senderID, command, content]
}

// A minimal XMLSocket-like connection with a per-message callback.
class Sock {
  constructor(tag, onMsg) {
    this.tag = tag;
    this.onMsg = onMsg;
    this.buf = '';
  }
  connect(host, port) {
    return new Promise((resolve, reject) => {
      this.s = net.connect({ host, port: Number(port) }, () => { log(this.tag, `connected ${host}:${port}`); resolve(); });
      this.s.setEncoding('binary');
      this.s.on('data', d => {
        this.buf += d;
        let n;
        while ((n = this.buf.indexOf('\x00')) !== -1) {
          const msg = this.buf.slice(0, n); this.buf = this.buf.slice(n + 1);
          if (msg.length) { log(this.tag, `<< ${msg.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}`); this.onMsg(msg); }
        }
      });
      this.s.on('error', reject);
    });
  }
  // CSocket.sendFormatted: body = "<params> <fn> <content>", wire = len+1 + " " + body + NUL
  send(fn, params, content) {
    const body = params + ' ' + fn + ' ' + content;
    const wire = (body.length + 1) + ' ' + body;
    log(this.tag, `>> ${wire.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}`);
    this.s.write(wire + '\x00', 'binary');
  }
  close() { try { this.s.destroy(); } catch (e) {} }
}

const got = { here1: false, challenge: false, authok: false, tokenok3: false, here2: false,
  serverparams: false, roomlist: false, joined: false, startgame: false };

function fail(msg) { console.error(`\nFAIL: ${msg}`); printSummary(); process.exit(1); }
function printSummary() {
  console.log('\n=== stage results ===');
  for (const k of Object.keys(got)) console.log(`  ${got[k] ? 'OK  ' : 'MISS'} ${k}`);
}

let TOKEN = '';

// Stage 1: directory -> GETONE x AUTH -> HERE
function stage1() {
  return new Promise((resolve) => {
    const sock = new Sock('directory', (data) => {
      const m = chop(data);
      if (m[2] === 'HERE') {
        got.here1 = true;
        const addr = m[3].split('\t')[1].split(':'); // host:port:name
        sock.close();
        resolve({ host: addr[0], port: addr[1] });
      }
    });
    sock.connect(HOST, PORT).then(() => sock.send('GETONE', 'x', 'AUTH')); // g_directory.onAuthenticate
  });
}

// Stage 2: authentication -> (server CHALLENGE first) -> AUTH -> AUTHOK
function stage2(addr) {
  return new Promise((resolve) => {
    const sock = new Sock('auth', (data) => {
      const m = data.split(' ');                 // CSocketAuthentication uses raw split
      if (m[2] === 'CHALLENGE') {
        got.challenge = true;
        const digest = md5(USER + PASS + m[3]);  // MD5(user+pass+challenge)
        sock.send('AUTH', 'x', USER + '%%%' + digest);
      } else if (m[2] === 'AUTHOK') {
        got.authok = true;
        const token = m[3].split('\n')[0];
        const a = m[3].split('\n')[1].split(':');
        TOKEN = token;
        sock.close();
        resolve({ host: a[0], port: a[1] });
      }
    });
    sock.connect(addr.host, addr.port); // waits for server CHALLENGE
  });
}

// Stage 3: secure directory -> CHECKUSERTOKEN, GETONE DESTROYER -> TOKENOK, HERE
function stage3(addr) {
  return new Promise((resolve) => {
    let asked = false;
    const sock = new Sock('directorySecure', (data) => {
      const m = chop(data);
      if (m[2] === 'TOKENOK') {
        got.tokenok3 = true;
        if (!asked) { asked = true; sock.send('GETONE', 'x', GAME_ID); } // onAuthenticate
      } else if (m[2] === 'HERE') {
        const type = m[3].split('\t')[0];
        if (type !== GAME_ID) return fail(`secure HERE type "${type}" !== ${GAME_ID}`);
        got.here2 = true;
        const a = m[3].split('\t')[1].split(':');
        sock.close();
        resolve({ host: a[0], port: a[1] });
      }
    });
    sock.connect(addr.host, addr.port).then(() => sock.send('CHECKUSERTOKEN', 'x', TOKEN));
  });
}

// Stage 4: lobby -> CHECKUSERTOKEN, MONITORROOMS -> TOKENOK, SERVERPARAMS, ROOMLIST
function stage4(addr) {
  return new Promise((resolve) => {
    let room = null;
    const sock = new Sock('lobby', (data) => {
      const m = chop(data);
      switch (m[2]) {
        case 'TOKENOK': sock.send('MONITORROOMS', 'x', ''); break; // CSocketLobby.onAuthenticate
        case 'SERVERPARAMS': got.serverparams = true; break;
        case 'ROOMLIST': {
          got.roomlist = true;
          const lines = m[3].split('\n');
          const fields = lines[0].split('\t');
          if (lines.length < 2) return fail('ROOMLIST has no rooms');
          const vals = lines[1].split('\t');
          const r = {}; fields.forEach((f, i) => r[f] = vals[i]);
          room = r;
          log('lobby', `room available: ${r.name} connect=${r.connect} public=${r.public} full=${r.full}`);
          // QuickPlay: pick first non-full public room, then connectToGame(connect)
          if (r.full !== 'Full' && r.public !== '0') {
            sock.close();
            resolve(room);
          } else {
            fail('no joinable room');
          }
          break;
        }
      }
    });
    sock.connect(addr.host, addr.port).then(() => sock.send('CHECKUSERTOKEN', 'x', TOKEN));
  });
}

// Stage 5: game -> CHECKUSERTOKEN, JOIN -> TOKENOK, SCREENNAME, JOINED. Then SIT + READY -> STARTGAME.
function stage5(room) {
  return new Promise((resolve) => {
    const conn = room.connect.split(':'); // host:port:roomId
    const roomId = conn[2];
    let joined = false;
    const sock = new Sock('game', (data) => {
      const m = chop(data);
      switch (m[2]) {
        case 'TOKENOK': sock.send('JOIN', 'x', roomId + '\t'); break; // CSocketGame.onAuthenticate
        case 'JOINED':
          got.joined = true;
          if (!joined) { joined = true; sock.send('SIT', 'x', ''); }
          break;
        case 'SITS':
          // Once seated, signal READY (AllVessels would do this). Drives STARTGAME with a 2nd player.
          sock.send('READY', 'x', '');
          break;
        case 'STARTGAME':
          got.startgame = true;
          sock.close();
          resolve();
          break;
      }
    });
    sock.connect(conn[0], conn[1]).then(() => sock.send('CHECKUSERTOKEN', 'x', TOKEN));
  });
}

(async () => {
  console.log(`Destroyer protocol harness -> ${HOST}:${PORT} as "${USER}"\n`);
  console.log('--- stage 1: directory ---');
  const a1 = await stage1();
  console.log('--- stage 2: authentication ---');
  const a2 = await stage2(a1);
  console.log('--- stage 3: secure directory ---');
  const a3 = await stage3(a2);
  console.log('--- stage 4: lobby ---');
  const room = await stage4(a3);
  console.log('--- stage 5: game (join + sit + ready) ---');

  // STARTGAME needs two seated+ready players. Spin up a second harness player in this room.
  const second = secondPlayer(room).catch(e => fail('2nd player: ' + e.message));
  await stage5(room);
  await second;

  printSummary();
  const reachedLobby = got.here1 && got.challenge && got.authok && got.tokenok3 && got.here2 && got.serverparams && got.roomlist;
  const reachedGame = got.joined;
  if (!reachedLobby) fail('did not reach lobby');
  console.log(`\nPASS: login chain OK, reached lobby${reachedGame ? ' + joined game' : ''}${got.startgame ? ' + STARTGAME' : ''}`);
  process.exit(0);
})().catch(e => fail(e.stack || e.message));

// A second player that just joins, sits and readies so STARTGAME can fire.
function secondPlayer(room) {
  return new Promise(async (resolve) => {
    // Full login for player 2 (own token).
    const a1 = await stage1Quiet();
    const a2 = await stage2Quiet(a1, 'TestPlayer2');
    const a3 = await stage3Quiet(a2, a2.token);
    const conn = room.connect.split(':');
    const sock = new Sock('game2', (data) => {
      const m = chop(data);
      if (m[2] === 'TOKENOK') sock.send('JOIN', 'x', conn[2] + '\t');
      else if (m[2] === 'JOINED') sock.send('SIT', 'x', '');
      else if (m[2] === 'SITS') sock.send('READY', 'x', '');
      else if (m[2] === 'STARTGAME') { sock.close(); resolve(); }
    });
    sock.connect(conn[0], conn[1]).then(() => sock.send('CHECKUSERTOKEN', 'x', a3.token));
  });
}
// Quiet variants reuse the same flow without asserting global flags.
function stage1Quiet() {
  return new Promise((resolve) => {
    const s = new Sock('p2-dir', (d) => { const m = chop(d); if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); s.close(); resolve({ host: a[0], port: a[1] }); } });
    s.connect(HOST, PORT).then(() => s.send('GETONE', 'x', 'AUTH'));
  });
}
function stage2Quiet(addr, user) {
  return new Promise((resolve) => {
    const s = new Sock('p2-auth', (d) => { const m = d.split(' ');
      if (m[2] === 'CHALLENGE') s.send('AUTH', 'x', user + '%%%' + md5(user + PASS + m[3]));
      else if (m[2] === 'AUTHOK') { const t = m[3].split('\n')[0]; const a = m[3].split('\n')[1].split(':'); s.close(); resolve({ host: a[0], port: a[1], token: t }); } });
    s.connect(addr.host, addr.port);
  });
}
function stage3Quiet(addr, token) {
  return new Promise((resolve) => {
    let asked = false;
    const s = new Sock('p2-dir2', (d) => { const m = chop(d);
      if (m[2] === 'TOKENOK') { if (!asked) { asked = true; s.send('GETONE', 'x', GAME_ID); } }
      else if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); s.close(); resolve({ host: a[0], port: a[1], token }); } });
    s.connect(addr.host, addr.port).then(() => s.send('CHECKUSERTOKEN', 'x', token));
  });
}
