// Integration test: plays a full match as the "human" attacker against bot.js and asserts
// the server declares ENDGAME WIN <attacker> once the bot's fleet is destroyed.
// Run: node server.js ; node bot.js ; node test_match.js
const net = require('net'), crypto = require('crypto');
const HOST = process.env.DESTROYER_HOST || '127.0.0.1', PORT = Number(process.env.DESTROYER_PORT || 10101), USER = 'Attacker', PASS = '', GAME_ID = 'DESTROYER', ROOM = 'Battle1';
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const chop = d => { const a = d.split(' '); const h = a.splice(0, 3); h.push(a.join(' ')); return h; };
let TOKEN = '';
class S { constructor(f){this.f=f;this.b='';} connect(h,p){return new Promise((res,rej)=>{this.s=net.connect({host:h,port:+p},res);this.s.setEncoding('binary');this.s.on('data',d=>{this.b+=d;let n;while((n=this.b.indexOf('\x00'))!==-1){const m=this.b.slice(0,n);this.b=this.b.slice(n+1);if(m.length)this.f(m);}});this.s.on('error',rej);});} send(fn,p,c){const b=p+' '+fn+' '+c;this.s.write((b.length+1)+' '+b+'\x00','binary');} close(){try{this.s.destroy();}catch(e){}} }
const dir = () => new Promise(r=>{const s=new S(d=>{const m=chop(d);if(m[2]==='HERE'){const a=m[3].split('\t')[1].split(':');s.close();r({host:a[0],port:a[1]});}});s.connect(HOST,PORT).then(()=>s.send('GETONE','x','AUTH'));});
const auth = a => new Promise(r=>{const s=new S(d=>{const m=d.split(' ');if(m[2]==='CHALLENGE')s.send('AUTH','x',USER+'%%%'+md5(USER+PASS+m[3]));else if(m[2]==='AUTHOK'){TOKEN=m[3].split('\n')[0];const x=m[3].split('\n')[1].split(':');s.close();r({host:x[0],port:x[1]});}});s.connect(a.host,a.port);});
const sdir = a => new Promise(r=>{let q=false;const s=new S(d=>{const m=chop(d);if(m[2]==='TOKENOK'){if(!q){q=true;s.send('GETONE','x',GAME_ID);}}else if(m[2]==='HERE'){const x=m[3].split('\t')[1].split(':');s.close();r({host:x[0],port:x[1]});}});s.connect(a.host,a.port).then(()=>s.send('CHECKUSERTOKEN','x',TOKEN));});
const lob = a => new Promise(r=>{const s=new S(d=>{const m=chop(d);if(m[2]==='TOKENOK')s.send('MONITORROOMS','x','');else if(m[2]==='ROOMLIST'){const L=m[3].split('\n'),F=L[0].split('\t');for(let i=1;i<L.length;i++){const v=L[i].split('\t'),o={};F.forEach((f,j)=>o[f]=v[j]);if(o.name===ROOM){s.close();return r(o);}}s.close();r({connect:`${HOST}:${PORT}:${ROOM}`});}});s.connect(a.host,a.port).then(()=>s.send('CHECKUSERTOKEN','x',TOKEN));});

(async () => {
  const a1 = await dir(), a2 = await auth(a1), a3 = await sdir(a2), room = await lob(a3);
  const [h, p, rid] = room.connect.split(':');
  const MATCHES = 2; // play a match, then a rematch
  let started = false, fire = null, wins = 0;
  // Damage now arrives on projectile travel time, so allow longer; target all three ships.
  const TARGETS = ['BattleShip_IowaClass_017', 'Destroyer_ArleighBurkeClass_023', 'Submarine_000'];
  let ti = 0;
  const timeout = setTimeout(() => { console.error(`FAIL: only ${wins}/${MATCHES} wins before timeout`); process.exit(1); }, 60000);
  const g = new S(d => {
    const m = chop(d);
    switch (m[2]) {
      case 'TOKENOK': g.send('JOIN', 'x', rid + '\t'); break;
      case 'JOINED': g.send('SIT', 'x', ''); g.send('SIT', 'x', ''); break; // double-sit like the real client
      case 'SITS': g.send('READY', 'x', ''); break;
      case 'STARTGAME':
        if (started) break; started = true;
        console.log(`STARTGAME (match ${wins + 1}) — attacker firing missiles at all three ships...`);
        fire = setInterval(() => { const tgt = TARGETS[ti++ % TARGETS.length]; g.send('FIREMISSILE', '-', `${Date.now()%1000},${tgt}`); }, 200);
        break;
      case 'DAMAGE': process.stdout.write(`  bot DAMAGE=${m[3].split('\t')[1]}\r`); break;
      case 'BURKEDEATH': case 'IOWADEATH': case 'SUBMARINEDEATH':
        console.log(`\n  bot reported ${m[2]}`); break;
      case 'ENDGAME': {
        clearInterval(fire);
        const parts = m[3].split('\t'); // x \t WIN \t <winner>
        if (parts[1] !== 'WIN' || parts[2] !== USER) { console.error(`\nFAIL: unexpected ENDGAME ${m[3]}`); process.exit(1); }
        wins++;
        console.log(`\nENDGAME: WIN ${parts[2]} (win ${wins}/${MATCHES})`);
        if (wins >= MATCHES) { clearTimeout(timeout); console.log('PASS: rematch works — server declared attacker winner both times'); process.exit(0); }
        // Rematch: stay seated, re-ready after the server's post-game reset.
        started = false;
        setTimeout(() => { console.log('attacker re-readying for rematch...'); g.send('READY', 'x', ''); }, 2600);
        break;
      }
    }
  });
  g.connect(h, p).then(() => g.send('CHECKUSERTOKEN', 'x', TOKEN));
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
