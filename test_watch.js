// test_watch.js — verifies the server relays live gameplay to a SPECTATOR (Watch button).
//
// Flow against an isolated server+bot (default port 10199):
//   1. "TestPlayer" logs in, joins Easy, sits, readies -> with the waiting bot this triggers
//      STARTGAME. TestPlayer is passive (never fires), so the bot never takes damage and the
//      match runs indefinitely while still emitting fire/maneuver messages.
//   2. After the bot's combat delay, "Spectator" logs in and joins Easy WITHOUT sitting — the
//      real client's Watch path (CSocketGame.onStartGame(false)).
//   3. We assert the spectator receives relayed gameplay (FIREGUNS / FIRETORPEDO / LANECHANGE…).
//
// PASS => the server now feeds watchers; FAIL => no gameplay reached the spectator.

const net = require('net');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.DESTROYER_PORT || 10199);
const PASS = process.env.DESTROYER_PASSWORD || '';
const ROOM = 'Easy';
const GAMEPLAY = ['FIREGUNS', 'FIREGUN', 'FIRETORPEDO', 'FIREMISSILE', 'LANECHANGE', 'DEPLOYCOPTER', 'SUBUP'];

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const chop = d => { const a = d.split(' '); const h = a.splice(0, 3); h.push(a.join(' ')); return h; };
const delay = ms => new Promise(r => setTimeout(r, ms));

class Sock {
  constructor(onMsg) { this.onMsg = onMsg; this.buf = ''; }
  connect(host, port) {
    return new Promise((res, rej) => {
      this.s = net.connect({ host, port: Number(port) }, res);
      this.s.setEncoding('binary');
      this.s.on('data', d => { this.buf += d; let n; while ((n = this.buf.indexOf('\x00')) !== -1) { const m = this.buf.slice(0, n); this.buf = this.buf.slice(n + 1); if (m.length) this.onMsg(m); } });
      this.s.on('error', rej);
    });
  }
  send(fn, params, content) { try { this.s.write((`${params} ${fn} ${content}`.length + 1) + ` ${params} ${fn} ${content}\x00`, 'binary'); } catch (e) {} }
  close() { try { this.s.destroy(); } catch (e) {} }
}

// Full 4-stage login chain; resolves { token, room:{connect} }.
async function login(name) {
  let token = '';
  const directory = () => new Promise((res, rej) => { const s = new Sock(d => { const m = chop(d); if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(HOST, PORT).then(() => s.send('GETONE', 'x', 'AUTH')).catch(rej); });
  const authenticate = addr => new Promise((res, rej) => { const s = new Sock(d => { const m = d.split(' '); if (m[2] === 'CHALLENGE') s.send('AUTH', 'x', name + '%%%' + md5(name + PASS + m[3])); else if (m[2] === 'AUTHOK') { token = m[3].split('\n')[0]; const a = m[3].split('\n')[1].split(':'); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(addr.host, addr.port).catch(rej); });
  const secureDir = addr => new Promise((res, rej) => { let asked = false; const s = new Sock(d => { const m = chop(d); if (m[2] === 'TOKENOK') { if (!asked) { asked = true; s.send('GETONE', 'x', 'DESTROYER'); } } else if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(addr.host, addr.port).then(() => s.send('CHECKUSERTOKEN', 'x', token)).catch(rej); });
  const lobby = addr => new Promise((res, rej) => { const s = new Sock(d => { const m = chop(d); if (m[2] === 'TOKENOK') s.send('MONITORROOMS', 'x', ''); else if (m[2] === 'ROOMLIST') { const lines = m[3].split('\n'), fields = lines[0].split('\t'); for (let i = 1; i < lines.length; i++) { const v = lines[i].split('\t'), r = {}; fields.forEach((f, j) => r[f] = v[j]); if (r.name === ROOM) { s.close(); return res(r); } } s.close(); res({ name: ROOM, connect: `${HOST}:${PORT}:${ROOM}` }); } }); s.connect(addr.host, addr.port).then(() => s.send('CHECKUSERTOKEN', 'x', token)).catch(rej); });
  const room = await lobby(await secureDir(await authenticate(await directory())));
  return { token, room };
}

async function main() {
  // --- 1. Passive player starts a match vs the bot ---
  const P = await login('TestPlayer');
  const [ph, pp, prid] = P.room.connect.split(':');
  let started = false;
  const pgame = new Sock(d => {
    const cmd = chop(d)[2];
    if (cmd === 'TOKENOK') pgame.send('JOIN', 'x', prid + '\t');
    else if (cmd === 'JOINED') pgame.send('SIT', 'x', '');
    else if (cmd === 'SITS') pgame.send('READY', 'x', '');
    else if (cmd === 'STARTGAME') { started = true; console.log('[player] STARTGAME — staying passive'); }
    else if (cmd === 'PING') pgame.send('PONG', '-', '');
  });
  await pgame.connect(ph, pp); pgame.send('CHECKUSERTOKEN', 'x', P.token);

  for (let i = 0; i < 100 && !started; i++) await delay(100);
  if (!started) { console.log('FAIL: match never started (is a bot waiting in Easy?)'); process.exit(1); }

  // Let the bot get through its combat delay and start firing.
  await delay(9000);

  // --- 2. Spectator joins mid-match (no sit) ---
  const W = await login('Spectator');
  const [wh, wp, wrid] = W.room.connect.split(':');
  const got = [];
  const wgame = new Sock(d => {
    const cmd = chop(d)[2];
    if (cmd === 'TOKENOK') wgame.send('JOIN', 'x', wrid + '\t');
    else if (cmd === 'JOINED') console.log('[watcher] JOINED — entered as spectator (no seat)');
    else if (GAMEPLAY.includes(cmd)) got.push(cmd);
    else if (cmd === 'PING') wgame.send('PONG', '-', '');
  });
  await wgame.connect(wh, wp); wgame.send('CHECKUSERTOKEN', 'x', W.token);

  // --- 3. Listen and assert ---
  await delay(12000);
  pgame.close(); wgame.close();
  const counts = got.reduce((a, c) => (a[c] = (a[c] || 0) + 1, a), {});
  console.log(`[watcher] received ${got.length} gameplay message(s):`, counts);
  if (got.length > 0) { console.log('PASS: spectator receives live gameplay relay'); process.exit(0); }
  console.log('FAIL: spectator received NO gameplay relay'); process.exit(1);
}

main().catch(e => { console.log('ERROR', e); process.exit(1); });
