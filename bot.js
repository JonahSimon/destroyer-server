// Destroyer practice bots — CPU opponents so a solo human can play and exercise every mechanic.
//
// Each bot performs the full login chain (like the real SWF), joins its room, sits, readies,
// and plays at a difficulty. It fires guns/torpedoes/missiles at the human (so they can use
// Nixie decoy and Phalanx CIWS), defends against the human's torpedoes/missiles (TORPEDODECOYED
// /MISSILEDESTROYED), maneuvers (LANECHANGE), and tallies damage to its own fleet the way the
// game does — so the server declares the human the winner when the bot's fleet is sunk.
//
// Damage authority mirrors the game: each side computes damage to its OWN ships and reports it
// (DAMAGE + *DEATH); we relay faithfully. Travel times / hit chances are approximations (the
// bot has no 3D world). The HARD bot also hunts the human's sub (copter -> SUBUP -> torpedo it)
// so it can actually win.
//
// Usage:
//   node bot.js                       -> runs all three default bots (Easy/Normal/Hard rooms)
//   node bot.js <room> <difficulty>   -> runs one bot (difficulty: easy|normal|hard)

const net = require('net');
const crypto = require('crypto');

const HOST = process.env.DESTROYER_HOST || '127.0.0.1';
const PORT = Number(process.env.DESTROYER_PORT || 10101);
const PASS = process.env.DESTROYER_PASSWORD || '';
const GAME_ID = 'DESTROYER';

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const chop = d => { const a = d.split(' '); const h = a.splice(0, 3); h.push(a.join(' ')); return h; };
const rnd = (a, b) => a + Math.random() * (b - a);

// Ship model names the human's client resolves with W.model(); we target these when firing.
const SHIP = { burke: 'Destroyer_ArleighBurkeClass_023', iowa: 'BattleShip_IowaClass_017', sub: 'Submarine_000' };

// Difficulty presets: fire cadence (ms), defense odds, and whether the bot hunts the human's
// submarine (the only way it can fully sink the human's fleet and win).
// ALL tiers can sink you (they hunt your sub) — they differ in how fast and how hard they are
// to kill. firstFire = delay before the first torpedo/missile; torp/missMs = cadence after;
// huntMs = how often it deploys the copter + surfaces & torpedoes your sub (its path to a win);
// defend = odds of Nixie/Phalanx-ing each of YOUR torpedoes/missiles (its durability).
//   Easy: slow offense + barely defends -> you have plenty of time, but it'll sink a passive
//   player eventually. Normal: a real race. Hard: fast, surfaces your sub often, and defends
//   most of your fire — you must defend AND attack efficiently to beat it.
const DIFFICULTY = {
  easy:   { gunMs: 7000, torpMs: 18000, missMs: 21000, firstFire: 4000, laneMs: 8000, defend: 0.03, huntMs: 55000, label: 'Easy' },
  normal: { gunMs: 5000, torpMs: 11000, missMs: 13000, firstFire: 2500, laneMs: 6000, defend: 0.18, huntMs: 32000, label: 'Normal' },
  hard:   { gunMs: 3500, torpMs: 7000,  missMs: 8000,  firstFire: 1500, laneMs: 4500, defend: 0.40, huntMs: 20000, label: 'Hard' },
};

// After STARTGAME the human's client runs an intro/countdown before combat. The bot stays
// SILENT for this long so it never fires into the pre-game screen. firstFire/huntMs are
// measured from the end of this window.
const COMBAT_DELAY = 6500;

class Sock {
  constructor(onMsg) { this.onMsg = onMsg; this.buf = ''; }
  connect(host, port) {
    return new Promise((res, rej) => {
      this.s = net.connect({ host, port: Number(port) }, res);
      this.s.setEncoding('binary');
      this.s.on('data', d => { this.buf += d; let n; while ((n = this.buf.indexOf('\x00')) !== -1) { const m = this.buf.slice(0, n); this.buf = this.buf.slice(n + 1); if (m.length) this.onMsg(m); } });
      this.s.on('error', e => rej(e));
    });
  }
  send(fn, params, content) { try { this.s.write((`${params} ${fn} ${content}`.length + 1) + ` ${params} ${fn} ${content}\x00`, 'binary'); } catch (e) {} }
  close() { try { this.s.destroy(); } catch (e) {} }
}

// One self-healing bot. All state is local so multiple bots run in one process.
function runBot({ room: roomName, name, difficulty }) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const log = m => console.log(`[${name}] ${m}`);
  let token = '';

  // ---- login stages (closures over token/name/roomName) ----
  // Each rejects on a connect error (.catch(rej)) so connectAndPlay's try/catch retries instead
  // of the process crashing with an unhandled rejection (e.g. when the server is momentarily down).
  const directory = () => new Promise((res, rej) => { const s = new Sock(d => { const m = chop(d); if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(HOST, PORT).then(() => s.send('GETONE', 'x', 'AUTH')).catch(rej); });
  const authenticate = addr => new Promise((res, rej) => { const s = new Sock(d => { const m = d.split(' '); if (m[2] === 'CHALLENGE') s.send('AUTH', 'x', name + '%%%' + md5(name + PASS + m[3])); else if (m[2] === 'AUTHOK') { token = m[3].split('\n')[0]; const a = m[3].split('\n')[1].split(':'); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(addr.host, addr.port).catch(rej); });
  const secureDir = addr => new Promise((res, rej) => { let asked = false; const s = new Sock(d => { const m = chop(d); if (m[2] === 'TOKENOK') { if (!asked) { asked = true; s.send('GETONE', 'x', GAME_ID); } } else if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(addr.host, addr.port).then(() => s.send('CHECKUSERTOKEN', 'x', token)).catch(rej); });
  const lobby = addr => new Promise((res, rej) => { const s = new Sock(d => { const m = chop(d); if (m[2] === 'TOKENOK') s.send('MONITORROOMS', 'x', ''); else if (m[2] === 'ROOMLIST') { const lines = m[3].split('\n'), fields = lines[0].split('\t'); for (let i = 1; i < lines.length; i++) { const v = lines[i].split('\t'), r = {}; fields.forEach((f, j) => r[f] = v[j]); if (r.name === roomName) { s.close(); return res(r); } } s.close(); res({ name: roomName, connect: `${HOST}:${PORT}:${roomName}` }); } }); s.connect(addr.host, addr.port).then(() => s.send('CHECKUSERTOKEN', 'x', token)).catch(rej); });

  function playGame(roomObj) {
    const [host, port, roomId] = roomObj.connect.split(':');
    let started = false, dead = false, gameDuration = 1.0, torpId = 1, missId = 1, subOpenUntil = 0;
    let fireTimer = null, laneTimer = null, torpTimer = null, missTimer = null, huntTimer = null;
    const pending = new Set();
    const fleet = { burke: 0, iowa: 0, sub: 0 };
    const deathMsg = { burke: 'BURKEDEATH', iowa: 'IOWADEATH', sub: 'SUBMARINEDEATH' };
    const sent = { burke: false, iowa: false, sub: false };
    const aliveShips = () => ['burke', 'iowa', 'sub'].filter(s => fleet[s] < 1.0);
    function shipFromTarget(n) { n = (n || '').toLowerCase(); if (n.indexOf('iowa') !== -1) return 'iowa'; if (n.indexOf('burke') !== -1 || n.indexOf('destroyer') !== -1) return 'burke'; if (n.indexOf('sub') !== -1) return 'sub'; return null; }
    function stopTimers() { for (const t of pending) clearTimeout(t); pending.clear(); [fireTimer, laneTimer, torpTimer, missTimer, huntTimer].forEach(t => t && clearInterval(t)); fireTimer = laneTimer = torpTimer = missTimer = huntTimer = null; }

    // Tally damage to one of OUR ships, emit its death, and broadcast aggregate DAMAGE. The
    // server declares the human the winner once aggregate hits 1.0 (whole fleet sunk).
    function applyDamage(game, ship, amount) {
      if (dead || !ship || amount <= 0 || fleet[ship] >= 1.0) return;
      fleet[ship] = Math.min(1.0, fleet[ship] + amount);
      if (fleet[ship] >= 1.0 && !sent[ship]) { sent[ship] = true; game.send(deathMsg[ship], '-', ''); log(`${ship} destroyed`); }
      const agg = (fleet.burke + fleet.iowa + fleet.sub) / 3;
      game.send('DAMAGE', '-', String(Number(agg.toFixed(4))));
      if (agg >= 1.0) { dead = true; log('fleet destroyed — human wins'); stopTimers(); }
    }

    // Incoming fire from the human, resolved on projectile ARRIVAL. Torpedoes/missiles: we may
    // actively DEFEND (Nixie decoy / Phalanx CIWS) per cfg.defend — echo the attacker's id back
    // and take no damage; else it hits for 0.5/dur to the targeted ship. Guns: ~40% land in
    // range for 0.1*hitPercent*|mode|/dur (chip damage).
    function incoming(game, cmd, payload) {
      if (dead) return;
      const parts = payload.split(',');
      if (cmd === 'FIRETORPEDO' || cmd === 'FIREMISSILE') {
        const id = parts[0], isTorp = cmd === 'FIRETORPEDO';
        // Nixie (decoy) and Phalanx (intercept) are BURKE systems — only available while alive.
        if (fleet.burke < 1 && Math.random() < cfg.defend) {
          const t = setTimeout(() => { pending.delete(t); game.send(isTorp ? 'TORPEDODECOYED' : 'MISSILEDESTROYED', '-', id); log(isTorp ? `decoyed torpedo ${id}` : `shot down missile ${id}`); }, isTorp ? rnd(1500, 3500) : rnd(1000, 2200));
          pending.add(t); return;
        }
        const ship = shipFromTarget(parts[1] || '');
        const t = setTimeout(() => { pending.delete(t); applyDamage(game, ship || aliveShips()[0], 0.5 / gameDuration); }, isTorp ? rnd(4500, 6500) : rnd(2800, 4000));
        pending.add(t);
      } else {
        const mode = cmd === 'FIREGUNS' ? 2 : 1;
        const t = setTimeout(() => { pending.delete(t); if (Math.random() >= 0.40) return; const alive = aliveShips(); if (alive.length) applyDamage(game, alive[Math.floor(Math.random() * alive.length)], 0.1 * Math.random() * mode / gameDuration); }, rnd(800, 2000));
        pending.add(t);
      }
    }

    // Launch a torpedo/missile at the human. Normally hits the surface ships; while the sub is
    // "open" (we surfaced it with a copter+SUBUP) we prioritize finishing it — sinking all three
    // is how the bot wins.
    function fireAt(game, kind) {
      if (dead || !started) return;
      // A weapon goes offline when the ship it belongs to is sunk (same rule the human plays by):
      // torpedoes come from our sub, Harpoon missiles from our Burke.
      if (kind === 'FIRETORPEDO' && fleet.sub >= 1) return;
      if (kind === 'FIREMISSILE' && fleet.burke >= 1) return;
      const subOpen = Date.now() < subOpenUntil;
      const target = (subOpen && Math.random() < 0.55) ? SHIP.sub : (Math.random() < 0.5 ? SHIP.burke : SHIP.iowa);
      game.send(kind, '-', `${(kind === 'FIRETORPEDO' ? torpId++ : missId++)},${target}`);
    }

    const game = new Sock(d => {
      const m = chop(d), cmd = m[2];
      switch (cmd) {
        case 'TOKENOK': game.send('JOIN', 'x', roomId + '\t'); break;
        case 'JOINED': log(`joined ${roomId}; sitting`); game.send('SIT', 'x', ''); break;
        case 'SITS': game.send('READY', 'x', ''); break;
        case 'ROOMPARAMS': { const keys = (m[3].split('\n')[0] || '').split('\t'); const vals = (m[3].split('\n')[1] || '').split('\t'); gameDuration = vals[keys.indexOf('gametype')] === 'Battle' ? 2.0 : 1.0; break; }
        case 'STARTGAME':
          if (started) break;
          started = true; dead = false; torpId = 1; missId = 1; subOpenUntil = 0;
          Object.assign(fleet, { burke: 0, iowa: 0, sub: 0 });
          Object.assign(sent, { burke: false, iowa: false, sub: false });
          stopTimers();
          log(`STARTGAME — ${cfg.label} CPU; holding fire through the intro (${COMBAT_DELAY}ms).`);
          // Stay silent through the intro/countdown, THEN start every weapon. Each callback is
          // guarded on `started` (and gun/lane on `dead`) so a stale timer can never fire after
          // the game ends.
          const begin = setTimeout(() => {
            pending.delete(begin);
            if (!started || dead) return;
            log('engaging.');
            // 16-inch guns are an IOWA weapon — offline once our Iowa is sunk.
            fireTimer = setInterval(() => { if (started && !dead && fleet.iowa < 1) { const x = 1500 + Math.floor(Math.random() * 3000), z = -3000 + Math.floor(Math.random() * 4000), flight = 20 + Math.floor(Math.random() * 70); game.send('FIREGUNS', '-', `${x},${z},${flight}`); } }, cfg.gunMs);
            laneTimer = setInterval(() => { if (started && !dead) game.send('LANECHANGE', '-', String(Math.floor(Math.random() * 4))); }, cfg.laneMs);
            const tt = setTimeout(() => { pending.delete(tt); if (!started || dead) return; fireAt(game, 'FIRETORPEDO'); torpTimer = setInterval(() => fireAt(game, 'FIRETORPEDO'), cfg.torpMs); }, cfg.firstFire);
            const mt = setTimeout(() => { pending.delete(mt); if (!started || dead) return; fireAt(game, 'FIREMISSILE'); missTimer = setInterval(() => fireAt(game, 'FIREMISSILE'), cfg.missMs); }, cfg.firstFire + 1400);
            pending.add(tt); pending.add(mt);
            // Sub hunt: deploy the copter and surface the human's sub (SUBUP), opening a window to
            // torpedo it — surfacing the sub IS the point of the hunt. The leak where this stranded
            // "SUB VULNERABLE" over the rematch is now handled SERVER-SIDE (the server stops
            // relaying gameplay once a match has ended), so we don't gimp the mechanic here.
            huntTimer = setInterval(() => {
              if (!started || dead || fleet.burke >= 1) return;   // copter + sonobuoys are Burke systems
              game.send('DEPLOYCOPTER', '-', '');
              const su = setTimeout(() => { pending.delete(su); if (started && !dead) { game.send('SUBUP', '-', ''); subOpenUntil = Date.now() + 10000; log('copter + sonobuoys — surfacing the human sub'); } }, 1500);
              pending.add(su);
            }, cfg.huntMs);
          }, COMBAT_DELAY);
          pending.add(begin);
          break;
        case 'FIRETORPEDO': case 'FIREMISSILE': case 'FIREGUNS': case 'FIREGUN':
          incoming(game, cmd, (m[3].split('\t')[1] || '')); break;
        case 'UPDATEREQUEST': { const agg = (fleet.burke + fleet.iowa + fleet.sub) / 3; game.send('UPDATE', '-', `${agg},${fleet.sub},${fleet.iowa},${fleet.burke},0,0,0`); break; }
        case 'ENDGAME':
          log(`ENDGAME (${m[3].replace(/\t/g, ' ')}) — staying seated for a rematch`);
          stopTimers(); started = false; dead = false;
          Object.assign(fleet, { burke: 0, iowa: 0, sub: 0 });
          Object.assign(sent, { burke: false, iowa: false, sub: false });
          setTimeout(() => { if (!started) { log('re-readying for rematch'); game.send('READY', 'x', ''); } }, 3000);
          break;
        case 'PING': game.send('PONG', '-', ''); break;
        case 'PONG': break;
      }
    });
    game.connect(host, port).then(() => {
      game.send('CHECKUSERTOKEN', 'x', token);
      const ping = setInterval(() => game.send('PING', '-', ''), 25000);   // heartbeat vs the dead-conn sweep
      game.s.on('close', () => { clearInterval(ping); stopTimers(); log('socket closed — reconnecting in 2s'); setTimeout(connectAndPlay, 2000); });
    }).catch(e => { log('game connect failed: ' + e.message + ' — retry 3s'); setTimeout(connectAndPlay, 3000); });
  }

  async function connectAndPlay() {
    try {
      const r = await lobby(await secureDir(await authenticate(await directory())));
      log(`in ${cfg.label} room "${r.name}" — waiting for a human to Play and accept`);
      playGame(r);
    } catch (e) { log('login failed: ' + (e.message || e) + ' — retry 3s'); setTimeout(connectAndPlay, 3000); }
  }
  connectAndPlay();
}

// Entry point.
const argRoom = process.argv[2], argDiff = (process.argv[3] || '').toLowerCase();
if (argRoom) {
  runBot({ room: argRoom, difficulty: argDiff || 'normal', name: process.argv[4] || `CPU-${argRoom}` });
} else {
  console.log('Starting Easy/Normal/Hard CPU bots...');
  runBot({ room: 'Easy', difficulty: 'easy', name: 'CPU-Easy' });
  runBot({ room: 'Normal', difficulty: 'normal', name: 'CPU-Normal' });
  runBot({ room: 'Hard', difficulty: 'hard', name: 'CPU-Hard' });
}
