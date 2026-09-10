// BLOCKFRONT server — serves the game, runs lobbies, relays multiplayer, keeps names/scores.
//   npm install   (once)      npm start
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { Server } = require('socket.io');   // Socket.IO: falls back to disguised HTTP polling when a network blocks raw WebSocket upgrades
const PORT = +(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA, 'users.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const FFA_TARGET = 20, ROOM_MAX = 8, QUICK_ROTATE_MS = 9 * 60 * 1000;
// ---- economy: Blocks for playing, Prisms for winning (never lost) ----
const PRICES = { gs_arctic: { b: 250 }, gs_woodland: { b: 250 }, gs_crimson: { b: 350 }, gs_carbon: { b: 400 }, gs_desert: { b: 300 }, gs_gilded: { p: 120 }, gs_obsidian: { p: 150 }, ps_camo: { b: 300 }, ps_hivis: { b: 200 }, ps_night: { b: 350 }, ps_commander: { p: 150 },
  gs_frost: { b: 300 }, gs_toxic: { b: 350 }, gs_hazard: { b: 300 }, gs_pastel: { b: 250 }, gs_royal: { p: 130 }, gs_ember: { p: 140 }, gs_void: { p: 160 },
  ps_arctic: { b: 300 }, ps_raider: { b: 350 }, ps_medic: { b: 300 }, ps_desert: { b: 250 }, ps_gold: { p: 160 }, ps_neon: { p: 120 } };
const walletOf = u => { u.blocks = u.blocks ?? 500; u.prisms = u.prisms ?? 0; u.owned = u.owned || []; return u; };
function sendWallet(c, why) { const u = c.user && users[c.user]; if (!u) return; walletOf(u); send(c.ws, { t: 'wallet', b: u.blocks, p: u.prisms, owned: u.owned, why }); }
function credit(c, b, p, why) { const u = c.user && users[c.user]; if (!u) return; walletOf(u); u.blocks += b | 0; u.prisms += p | 0; saveUsers(); sendWallet(c, why ? `${b ? '+' + b + ' BLOCKS ' : ''}${p ? '+' + p + ' PRISMS ' : ''}— ${why}` : undefined); }
function creditRoom(r, b, p, why) { for (const id of r.players) { const c = clients.get(id); if (c) credit(c, b, p, why); } }
// four permanent quick-play rooms, one per mode; the map changes every 9 minutes by player vote (or cycles if nobody voted)
const MAP_POOL = ['forest', 'city', 'refinery', 'wreck', 'compound', 'canyon'];
const QUICK_MODES = [['waves', 'Waves', 'forest'], ['demo', 'Demolition', 'refinery'], ['gun', 'Gun Game', 'compound'], ['ffa', 'Free For All', 'city']];
const GUN_LEVELS = 16;   // must match GUN_LADDER.length in the client

// ---- accounts ----
let users = {}; try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = {}; }
let saveT = null; const saveUsers = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(USERS_FILE, JSON.stringify(users, null, 1), () => {}), 500); };
const hashPin = (pin, salt) => crypto.createHash('sha256').update(salt + '|' + pin).digest('hex');

const server = http.createServer((req, res) => {
  let file = req.url.split('?')[0]; if (file === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); } if (file === '/' || file === '') file = '/index.html';
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data); });
});

// ---- state ----
// polling first (works through antivirus filters / proxies that block WebSockets), generous ping timeouts for slow links
const io = new Server(server, { cors: { origin: '*' }, transports: ['polling', 'websocket'], pingTimeout: 60000, pingInterval: 25000 });
const GRACE_MS = 30000;

// ---------- chat filter ----------
// Matches each word with leetspeak variants, repeated letters and separators ("f.u.c.k", "sh1t", "fuuuck") and stars it out.
const BAD_WORDS = ['fuck','fucker','fucking','motherfucker','shit','shitty','bullshit','bitch','bitches','asshole','arsehole','dick','dickhead','cock','pussy','cunt','cunts','whore','slut','bastard','wanker','twat','prick','fag','faggot','nigger','nigga','niggers','retard','retarded','chink','spic','kike','tranny','dyke','rape','rapist','nazi','porn','sex','sexy','boobs','tits','penis','vagina','anal','cum','jizz','blowjob','handjob','dildo','kys','kill yourself','chutiya','madarchod','behenchod','bhenchod','gandu','lodu','randi','bsdk','mc','bc'];
const LEET = { a: '[a4@àáâä]', b: '[b8]', c: '[c(k]', e: '[e3€èéê]', g: '[g69]', i: '[i1!|íìî]', l: '[l1|]', o: '[o0öóò]', s: '[s5$z]', t: '[t7+]', u: '[uüúù]', y: '[yi]' };
const SEP = '[\\s._\\-*]*';
const BAD_RE = BAD_WORDS.map(w => {
  const body = w.split('').map((ch, i) => { if (ch === ' ') return '\\s+'; const cls = LEET[ch] || ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return cls + '+' + (i < w.length - 1 ? SEP : ''); }).join('');
  return new RegExp('(^|[^a-z])(' + body + ')(?=$|[^a-z])', 'gi');
});
function censor(text) { let t = String(text); for (const re of BAD_RE) t = t.replace(re, (m, pre, word) => pre + '*'.repeat(Math.min(word.length, 12))); return t; }
const EMOTE_IDS = new Set(['wave', 'dance', 'salute', 'laugh', 'point', 'gg', 'no', 'cheer']);   // a dropped player keeps their seat this long; signing back in with the same name resumes it
let seq = 0, rseq = 0, rotIdx = 0;
const clients = new Map();   // id -> { ws, name, user, k, d, s, room, ready }
const rooms = new Map();     // rid -> { id, name, hostId, mode, map, playing, players:Set }
const send = (ws, o) => { ws.emit('msg', o); };
const log = s => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);
const roomOf = id => { const c = clients.get(id); return c && c.room !== null ? rooms.get(c.room) : null; };
const toRoom = (r, o, except) => { for (const id of r.players) if (id !== except) { const c = clients.get(id); if (c) send(c.ws, o); } };
const voteTally = r => { const t = {}; for (const id of r.players) { const c = clients.get(id); if (c && c.vote) t[c.vote] = (t[c.vote] || 0) + 1; } return t; };
const lobbiesMsg = () => ({ t: 'lobbies', list: [...rooms.values()].filter(r => !r.hub && !r.duel).map(r => ({ id: r.id, name: r.name, quick: !!r.quick, host: (clients.get(r.hostId) || {}).name || (r.quick ? '—' : '?'), mode: r.mode, map: r.map, n: r.players.size, max: ROOM_MAX, playing: r.playing, nextIn: r.quick ? Math.max(0, Math.round((r.rotAt - Date.now()) / 1000)) : null })) });
const sendLobbies = () => { const m = lobbiesMsg(); for (const c of clients.values()) if (c.room === null || (rooms.get(c.room) || {}).hub) send(c.ws, m); };
const roomState = r => ({ t: 'room', id: r.id, name: r.name, quick: !!r.quick, hub: !!r.hub, duel: !!r.duel, votes: r.quick ? voteTally(r) : undefined, banned: r.banned || [], host: r.hostId, mode: r.mode, map: r.map, playing: r.playing, nextIn: r.quick ? Math.max(0, Math.round((r.rotAt - Date.now()) / 1000)) : null,
  players: [...r.players].map(id => { const c = clients.get(id); return { id, name: c.name, ready: c.ready, host: id === r.hostId, k: c.k, d: c.d, s: c.s, v: c.vote || null }; }) });
const pushRoom = r => { toRoom(r, roomState(r)); toRoom(r, { t: 'roster', n: r.players.size, players: roomState(r).players }); };

function login(id, c, name, pin) {
  name = String(name || '').trim().slice(0, 14).replace(/[^\w\- ]/g, '');
  if (name.length < 2) return send(c.ws, { t: 'auth', ok: false, reason: 'Name needs at least 2 letters or numbers.' });
  const key = name.toLowerCase();
  let u = users[key];
  if (u) { if (u.hash && hashPin(pin || '', u.salt) !== u.hash) return send(c.ws, { t: 'auth', ok: false, reason: "That name is taken and the PIN doesn't match." }); }
  else { const salt = crypto.randomBytes(6).toString('hex'); u = users[key] = { name, salt, hash: pin ? hashPin(pin, salt) : '', k: 0, d: 0, w: 0 }; saveUsers(); }
  for (const [oid, oc] of clients) if (oid !== id && oc.user === key) {
    if (!oc.gone) return send(c.ws, { t: 'auth', ok: false, reason: 'Someone with that name is already online.' });
    // resume: hand the dropped seat (same id, same room, same score) to the new connection
    clearTimeout(oc.goneT); oc.gone = null; oc.ws = c.ws; clients.delete(id);
    send(oc.ws, { t: 'auth', ok: true, name: u.name, totals: { k: u.k, d: u.d, w: u.w }, resumed: true }); sendWallet(oc); send(oc.ws, lobbiesMsg());
    const r = roomOf(oid); if (r) { send(oc.ws, { t: 'welcome', id: oid, host: oid === r.hostId }); send(oc.ws, roomState(r)); send(oc.ws, { t: 'roster', n: r.players.size, players: roomState(r).players }); } else joinRoom(oid, hub);
    sendFriends(); log(`${u.name} reconnected and resumed as ${oid}`); return { id: oid, c: oc };
  }
  c.name = u.name; c.user = key;
  send(c.ws, { t: 'auth', ok: true, name: u.name, totals: { k: u.k, d: u.d, w: u.w } }); sendWallet(c);
  send(c.ws, lobbiesMsg()); if (!roomOf(id)) joinRoom(id, hub); sendFriends(); sendLobbies();
  log(`${id} signed in as ${u.name}`);
}
function leaveRoom(id) {
  const c = clients.get(id); if (!c || c.room === null) return; const r = rooms.get(c.room); c.room = null; c.ready = false; c.vote = null; c.k = c.d = c.s = 0;
  if (!r) return; r.players.delete(id); toRoom(r, { t: 'leave', id });
  if (!r.players.size) { if (r.quick || r.hub) { r.hostId = null; } else { rooms.delete(r.id); log(`room "${r.name}" closed`); } }
  else { if (r.hostId === id && !r.hub) { r.hostId = r.players.values().next().value; toRoom(r, { t: 'host', id: r.hostId }); } pushRoom(r); }
  send(c.ws, { t: 'room', id: null }); send(c.ws, lobbiesMsg()); sendLobbies();
}
function joinRoom(id, r) {
  const c = clients.get(id); if (!c || r.players.size >= (r.duel ? 2 : ROOM_MAX)) return send(c.ws, { t: 'err', msg: 'That lobby is full.' });
  leaveRoom(id); c.room = r.id; c.ready = false; r.players.add(id); if (r.hostId === null && !r.hub) r.hostId = id;
  send(c.ws, { t: 'welcome', id, host: id === r.hostId });   // (re)announce host status in this room
  pushRoom(r); sendLobbies(); log(`${c.name} joined "${r.name}" (${r.players.size})`);
}
const onlineByUser = () => { const m = new Map(); for (const c of clients.values()) if (c.user) m.set(c.user, c); return m; };
function friendsFor(c) { const u = c.user && users[c.user]; if (!u) return []; const on = onlineByUser(); return (u.friends || []).map(k => ({ name: (users[k] || {}).name || k, online: on.has(k), room: on.has(k) ? ((rooms.get(on.get(k).room) || {}).name || null) : null })); }
function sendFriends() { for (const c of clients.values()) if (c.user) send(c.ws, { t: 'friends', list: friendsFor(c) }); }
function endMatch(r, winnerId) {
  const w = clients.get(winnerId); if (!w) return;
  if (w.user && users[w.user]) { users[w.user].w++; saveUsers(); }
  toRoom(r, { t: 'matchend', id: winnerId, name: w.name, k: w.k });
  credit(w, 40, 15, 'MATCH WON'); for (const id of r.players) if (id !== winnerId) { const c = clients.get(id); if (c) credit(c, 10, 0, 'MATCH PLAYED'); }
  for (const id of r.players) { const c = clients.get(id); if (c) { c.k = 0; c.d = 0; c.s = 0; } }
  pushRoom(r); log(`"${r.name}": match won by ${w.name}`);
}

const quicks = [];
for (const [mode, name, map] of QUICK_MODES) { const r = { id: ++rseq, name, quick: true, hostId: null, mode, map, playing: true, players: new Set(), banned: [], rotAt: Date.now() + QUICK_ROTATE_MS }; rooms.set(r.id, r); quicks.push(r); }
const hub = { id: ++rseq, name: 'Briefing Room', hub: true, hostId: null, mode: 'hub', map: 'hub', playing: false, players: new Set(), banned: [] };
rooms.set(hub.id, hub);
function rotateQuick(r, reason) {
  const tally = voteTally(r); let best = null, bestN = 0; for (const [map, n] of Object.entries(tally)) if (n > bestN) { best = map; bestN = n; }
  if (!best) { const i = MAP_POOL.indexOf(r.map); best = MAP_POOL[(i + 1) % MAP_POOL.length]; }   // nobody voted: cycle
  r.map = best; r.rotAt = Date.now() + QUICK_ROTATE_MS; r.p10 = false; r.p5 = false;
  for (const id of r.players) { const c = clients.get(id); if (c) { c.k = 0; c.d = 0; c.s = 0; c.vote = null; } }
  toRoom(r, { t: 'rotate', mode: r.mode, map: r.map, reason }); pushRoom(r); sendLobbies(); log(`${r.name} → ${r.map} (${reason}${bestN ? ', ' + bestN + ' votes' : ''})`);
}
setInterval(() => { for (const r of quicks) if (Date.now() >= r.rotAt) rotateQuick(r, r.players.size ? 'timer' : 'idle'); }, 5000);

io.on('connection', (ws) => {
  let id = ++seq; let c = { ws, name: 'Player ' + id, user: null, k: 0, d: 0, s: 0, room: null, ready: false, gone: null, goneT: null }; clients.set(id, c);
  send(ws, { t: 'welcome', id, host: false }); send(ws, lobbiesMsg());
  log(`${id} connected from ${ws.handshake.address} via ${ws.conn.transport.name} (${clients.size} online)`);
  ws.conn.on('upgrade', () => log(`${id} upgraded to a real WebSocket`));   // logs if/when it escapes the polling fallback
  ws.on('msg', data => { try { handle(data); } catch (e) { log(`error handling message from ${id}: ${e.stack || e}`); } });
  function handle(m) {
    if (!m || typeof m !== 'object') return;
    m.id = id;
    if (m.t === 'login') { const res = login(id, c, m.name, m.pin); if (res) { id = res.id; c = res.c; } return; }
    if (m.t === 'lobbies') return send(ws, lobbiesMsg());
    if (m.t === 'create') { const name = String(m.name || (c.name + "'s lobby")).slice(0, 24); const r = { id: ++rseq, name, hostId: id, mode: m.mode || 'waves', map: m.map || 'forest', playing: false, players: new Set(), banned: Array.isArray(m.banned) ? m.banned.slice(0, 40) : [] }; rooms.set(r.id, r); joinRoom(id, r); log(`room "${name}" created by ${c.name}`); return; }
    if (m.t === 'join') { const r = rooms.get(m.room); if (r) joinRoom(id, r); return; }
    if (m.t === 'leaveroom') { leaveRoom(id); joinRoom(id, hub); return; }
    const r = roomOf(id); if (!r) return;    // everything below happens inside a room
    if (m.t === 'duel' && m.act === 'acc') {   // accepter (id) + challenger (m.to) get their own 1v1 arena, first to 5
      const o = clients.get(m.to); if (!o || o.room !== r.id) return; if (r.duel) return;
      const maps = MAP_POOL; const d = { id: ++rseq, name: `${o.name} vs ${c.name}`, hostId: m.to, mode: 'ffa', map: maps[Math.floor(Math.random() * maps.length)], playing: true, duel: true, players: new Set(), banned: [] };
      rooms.set(d.id, d); send(o.ws, m); joinRoom(m.to, d); joinRoom(id, d); log(`duel: ${d.name} on ${d.map}`); return; }
    if (m.t === 'friend') { const o = clients.get(m.to); if (!o || !c.user || !o.user) return;
      if (m.act === 'req') { send(o.ws, { t: 'friend', act: 'req', id, name: c.name }); return; }
      if (m.act === 'acc') { const a = users[c.user], b = users[o.user]; a.friends = a.friends || []; b.friends = b.friends || []; if (!a.friends.includes(o.user)) a.friends.push(o.user); if (!b.friends.includes(c.user)) b.friends.push(c.user); saveUsers(); send(o.ws, { t: 'friend', act: 'acc', id, name: c.name }); sendFriends(); return; }
      if (m.act === 'dec') { send(o.ws, { t: 'friend', act: 'dec', id, name: c.name }); return; } return; }
    if (m.t === 'ready') { c.ready = !!m.r; pushRoom(r); return; }
    if (m.t === 'chat') { const now = Date.now(); if (now - (c.lastChat || 0) < 700) return; c.lastChat = now;
      let text = String(m.text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 140); if (!text) return;
      toRoom(r, { t: 'chat', id, name: c.name, text: censor(text) }); return; }
    if (m.t === 'emote') { const now = Date.now(); if (!EMOTE_IDS.has(m.e) || now - (c.lastEmote || 0) < 1000) return; c.lastEmote = now; toRoom(r, { t: 'emote', id, name: c.name, e: m.e }, id); return; }
    if (m.t === 'vote') { if (r.quick && MAP_POOL.includes(m.map)) { c.vote = m.map; pushRoom(r); } return; }
    if (m.t === 'wv' && id === r.hostId) { creditRoom(r, 15, m.w % 5 === 0 ? (m.w === 10 && !r.p10 ? 10 : 5) : 0, 'WAVE ' + m.w + ' CLEARED'); if (m.w === 10) r.p10 = true; toRoom(r, m, id); return; }
    if (m.t === 'rnd' && id === r.hostId) { const done = m.r - 1; creditRoom(r, 25, done % 3 === 0 ? (done === 6 && !r.p5 ? 10 : 5) : 0, 'ROUND ' + done + ' CLEARED'); if (done === 6) r.p5 = true; toRoom(r, m, id); return; }
    if (m.t === 'cfg' && id === r.hostId) { if (r.quick) { m.gm = r.mode; m.map = r.map; } else if (r.mode !== m.gm || r.map !== m.map) { r.mode = m.gm; r.map = m.map; pushRoom(r); sendLobbies(); } toRoom(r, m, id); return; }
    if (m.t === 'restrict' && id === r.hostId && !r.quick) { r.banned = Array.isArray(m.banned) ? m.banned.slice(0, 40) : []; pushRoom(r); return; }
    if (m.t === 'start' && id === r.hostId) { r.playing = true; r.p10 = false; r.p5 = false; toRoom(r, { t: 'start' }); pushRoom(r); sendLobbies(); return; }
    if (m.t === 'score' && id === r.hostId) { const w = clients.get(m.who); if (w && w.room === r.id) { w.k += m.k || 0; w.s += m.pts || 0; if (w.user && users[w.user]) { users[w.user].k += m.k || 0; saveUsers(); } const pts = m.pts || 0; credit(w, pts >= 1000 ? 40 : pts >= 250 ? 8 : 3, pts >= 1000 ? 5 : 0, pts >= 1000 ? 'WARLORD DOWN' : undefined); pushRoom(r); } return; }
    if (m.t === 'buy') { const item = m.item; const u = c.user && users[c.user]; const pr = PRICES[item]; if (!u || !pr) return; walletOf(u); if (u.owned.includes(item)) return sendWallet(c); if ((pr.b && u.blocks < pr.b) || (pr.p && u.prisms < pr.p)) return sendWallet(c, 'NOT ENOUGH ' + (pr.p ? 'PRISMS' : 'BLOCKS')); u.blocks -= pr.b || 0; u.prisms -= pr.p || 0; u.owned.push(item); saveUsers(); sendWallet(c, 'UNLOCKED'); return; }   // note: m.id is overwritten with the sender's id above, so the item travels as m.item
    if (m.t === 'died') {
      c.d++; if (c.user && users[c.user]) { users[c.user].d++; saveUsers(); }
      const killer = clients.get(m.by);
      if (killer && m.by !== id && killer.room === r.id) { killer.k++; killer.s += 100; if (killer.user && users[killer.user]) { users[killer.user].k++; saveUsers(); }
        toRoom(r, { t: 'kill', k: m.by, kn: killer.name, v: id, vn: c.name });
        if ((r.mode === 'ffa' || r.mode === 'gun') && killer.k >= (r.duel ? 5 : r.mode === 'gun' ? GUN_LEVELS : FFA_TARGET)) { endMatch(r, m.by); if (r.quick) rotateQuick(r, 'match won');
          if (r.duel) setTimeout(() => { for (const pid of [...r.players]) { if (clients.has(pid)) { leaveRoom(pid); joinRoom(pid, hub); } } }, 6000);   // duel over: both back to the briefing room
          return; } }
      pushRoom(r); return;
    }
    if (m.t === 'h') { const h = clients.get(r.hostId); if (h) send(h.ws, m); return; }
    if (typeof m.to === 'number') { const d = clients.get(m.to); if (d && d.room === r.id) send(d.ws, m); return; }
    toRoom(r, m, id);
  }
  ws.on('disconnect', () => {
    const cid = id, cc = c; if (clients.get(cid) !== cc) return;   // this socket was replaced by a resume; nothing to clean up
    const r = roomOf(cid);
    if (!cc.user || !r || r.hub) { leaveRoom(cid); clients.delete(cid); sendLobbies(); sendFriends(); log(`${cc.name} disconnected (${clients.size} online)`); return; }
    cc.gone = Date.now(); log(`${cc.name} dropped mid-match — holding their seat for ${GRACE_MS / 1000}s`);
    cc.goneT = setTimeout(() => { if (clients.get(cid) !== cc || !cc.gone) return; leaveRoom(cid); clients.delete(cid); sendLobbies(); sendFriends(); log(`${cc.name} did not come back (${clients.size} online)`); }, GRACE_MS);
  });
});

function addresses() { const out = { tailscale: [], lan: [] };
  for (const list of Object.values(os.networkInterfaces())) for (const a of list) { if (a.family !== 'IPv4' || a.internal) continue; const [o1, o2] = a.address.split('.').map(Number); (o1 === 100 && o2 >= 64 && o2 <= 127 ? out.tailscale : out.lan).push(a.address); } return out; }
server.listen(PORT, '0.0.0.0', () => { const a = addresses(); console.log('\n  BLOCKFRONT server is up.\n');
  if (a.tailscale.length) { console.log('  Tailscale:'); for (const ip of a.tailscale) console.log(`      http://${ip}:${PORT}`); }
  if (a.lan.length) { console.log('  Same Wi-Fi:'); for (const ip of a.lan) console.log(`      http://${ip}:${PORT}`); }
  console.log(`  This machine:  http://localhost:${PORT}\n  (Hosted: players use the https address your host gives you.)\n`); });
