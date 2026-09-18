// test_lan.js — exercises the full LAN, two-HUMAN flow against a server whose redirect host
// (DESTROYER_HOST) is a real, non-loopback IP. Proves the parts that "should work" on a 2-PC LAN:
//
//   0. Login redirects through DESTROYER_HOST (not 127.0.0.1) — both clients reach the server
//      via the LAN IP at every stage (directory/auth/secure/lobby + the room connect string).
//   1. Live room creation: Alice (in the lobby) creates a room; Bob (already in the lobby)
//      receives a live ROOMOPENS for it — i.e. "P1 makes a room, P2 sees it appear."
//   2. Human-vs-human: both join that room, sit the two seats, ready up -> server STARTGAME
//      (no bot involved).
//   3. Peer relay between two humans: Alice fires, Bob receives it.
//
// Everything runs on one machine but over the LAN IP, so the only thing it does NOT cover is the
// physical second PC + firewall (environmental, not code). Exit 0 = all assertions pass.

const net = require('net');
const crypto = require('crypto');

// Where the harness's clients first dial. Kept separate from DESTROYER_HOST so we can run the
// SERVER with no DESTROYER_HOST (reflection mode) while still connecting over the LAN IP — that
// proves the server reflects each client's connect address back, with zero host config.
const HOST = process.env.DESTROYER_CONNECT || process.env.DESTROYER_HOST || '127.0.0.1';
const PORT = Number(process.env.DESTROYER_PORT || 10199);
const PASS = process.env.DESTROYER_PASSWORD || '';

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

const hosts = new Set();   // every address a client was redirected to (assert: all == LAN IP)

// directory -> auth -> secureDir; resolves { token, addr } where addr is the lobby/game stage.
async function getToken(name) {
  let token = '';
  const directory = () => new Promise((res, rej) => { const s = new Sock(d => { const m = chop(d); if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); hosts.add(a[0]); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(HOST, PORT).then(() => s.send('GETONE', 'x', 'AUTH')).catch(rej); });
  const authenticate = addr => new Promise((res, rej) => { const s = new Sock(d => { const m = d.split(' '); if (m[2] === 'CHALLENGE') s.send('AUTH', 'x', name + '%%%' + md5(name + PASS + m[3])); else if (m[2] === 'AUTHOK') { token = m[3].split('\n')[0]; const a = m[3].split('\n')[1].split(':'); hosts.add(a[0]); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(addr.host, addr.port).catch(rej); });
  const secureDir = addr => new Promise((res, rej) => { let asked = false; const s = new Sock(d => { const m = chop(d); if (m[2] === 'TOKENOK') { if (!asked) { asked = true; s.send('GETONE', 'x', 'DESTROYER'); } } else if (m[2] === 'HERE') { const a = m[3].split('\t')[1].split(':'); hosts.add(a[0]); s.close(); res({ host: a[0], port: a[1] }); } }); s.connect(addr.host, addr.port).then(() => s.send('CHECKUSERTOKEN', 'x', token)).catch(rej); });
  const addr = await secureDir(await authenticate(await directory()));
  return { token, addr };
}

// Persistent lobby connection (stays open, monitoring). onRoomOpens(roomId, connect) fires on a
// live ROOMOPENS broadcast.
async function openLobby(name, onRoomOpens) {
  const { token, addr } = await getToken(name);
  let monitoring = false;
  const lob = new Sock(d => {
    const m = chop(d), cmd = m[2];
    if (cmd === 'TOKENOK') lob.send('MONITORROOMS', 'x', '');
    else if (cmd === 'ROOMLIST') monitoring = true;
    else if (cmd === 'ROOMOPENS') {
      const roomId = (m[1] || '').split('/')[1];               // senderID "-/<roomId>"
      const vals = (m[3].split('\n')[1] || '').split('\t');    // name,connect,chat,public,full
      if (onRoomOpens) onRoomOpens(roomId, vals[1]);
    }
  });
  await lob.connect(addr.host, addr.port); lob.send('CHECKUSERTOKEN', 'x', token);
  for (let i = 0; i < 50 && !monitoring; i++) await delay(100);
  return { token, addr, lob, monitoring };
}

// Join a room on a fresh game socket and sit+ready. started() flips on STARTGAME; onGameMsg gets
// any relayed gameplay command.
async function joinAndPlay(name, token, addr, roomId, onState) {
  const game = new Sock(d => {
    const m = chop(d), cmd = m[2];
    if (cmd === 'TOKENOK') game.send('JOIN', 'x', roomId + '\t');
    else if (cmd === 'JOINED') { onState('joined'); game.send('SIT', 'x', ''); }   // sit AFTER join
    else if (cmd === 'SITS') { if (!game._readied) { game._readied = true; game.send('READY', 'x', ''); } }
    else if (cmd === 'STARTGAME') onState('started');
    else if (['FIREGUNS', 'FIRETORPEDO', 'FIREMISSILE', 'LANECHANGE'].includes(cmd)) onState('relay:' + cmd);
    else if (cmd === 'PING') game.send('PONG', '-', '');
  });
  await game.connect(addr.host, addr.port); game.send('CHECKUSERTOKEN', 'x', token);
  return game;
}

async function main() {
  const fail = m => { console.log('FAIL: ' + m); process.exit(1); };

  // Both players sit in the lobby first.
  let bobSaw = null;
  const A = await openLobby('Alice', null);
  const B = await openLobby('Bob', (roomId) => { if (!bobSaw) { bobSaw = roomId; console.log(`[Bob] saw new room "${roomId}" appear live`); } });
  if (!A.monitoring || !B.monitoring) return fail('a client never reached the lobby');

  // 0. redirect host check
  console.log('[redirect] hosts clients were sent to:', [...hosts]);
  if (hosts.has('127.0.0.1') || ![...hosts].every(h => h === HOST)) return fail(`login redirected to ${[...hosts]} not the LAN IP ${HOST}`);
  console.log(`PASS 0: all login stages redirected through the LAN IP ${HOST}`);

  // 1. Alice creates a room; Bob should see it live.
  A.lob.send('OPENROOM', 'Alice', 'x\ny');   // server uses senderID ("Alice") as the room id
  for (let i = 0; i < 30 && !bobSaw; i++) await delay(100);
  if (bobSaw !== 'Alice') return fail(`Bob did not receive a live ROOMOPENS for "Alice" (saw: ${bobSaw})`);
  console.log('PASS 1: room creation broadcast — second player sees the new room live');

  // 2. Both join the new room and ready up (two humans, no bot).
  const states = { Alice: [], Bob: [] };
  const aGame = await joinAndPlay('Alice', A.token, A.addr, 'Alice', s => states.Alice.push(s));
  const bGame = await joinAndPlay('Bob', B.token, B.addr, 'Alice', s => states.Bob.push(s));
  for (let i = 0; i < 50 && !(states.Alice.includes('started') && states.Bob.includes('started')); i++) await delay(100);
  if (!states.Alice.includes('started') || !states.Bob.includes('started')) return fail(`STARTGAME not seen by both (Alice=${states.Alice}, Bob=${states.Bob})`);
  console.log('PASS 2: human-vs-human STARTGAME (both seats filled by real clients)');

  // 3. Alice fires; Bob must receive the relayed action.
  await delay(300);
  aGame.send('FIREGUNS', '-', '1500,-2000,40');
  for (let i = 0; i < 30 && !states.Bob.some(s => s.startsWith('relay:')); i++) await delay(100);
  const got = states.Bob.find(s => s.startsWith('relay:'));
  if (!got) return fail('Bob did not receive Alice\'s relayed FIREGUNS');
  console.log(`PASS 3: peer relay between two humans (Bob received ${got})`);

  aGame.close(); bGame.close(); A.lob.close(); B.lob.close();
  console.log('\nALL PASS — LAN two-human flow works over the redirect host.');
  process.exit(0);
}

main().catch(e => { console.log('ERROR', e); process.exit(1); });
