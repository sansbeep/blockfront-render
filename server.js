// BLOCKFRONT server — serves the game, runs lobbies, relays multiplayer, keeps names/scores.
//   npm install   (once)      npm start
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = +(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA, 'users.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const FFA_TARGET = 20, ROOM_MAX = 8, QUICK_ROTATE_MS = 9 * 60 * 1000;
const ROTATION = [['waves','forest'],['ffa','city'],['demo','refinery'],['ffa','wreck'],['waves','city'],['demo','forest'],['ffa','refinery'],['waves','wreck']];

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
const wss = new WebSocketServer({ server });
let seq = 0, rseq = 0, rotIdx = 0;
const clients = new Map();   // id -> { ws, name, user, k, d, s, room, ready }
const rooms = new Map();     // rid -> { id, name, hostId, mode, map, playing, players:Set }
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const log = s => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);
const roomOf = id => { const c = clients.get(id); return c && c.room !== null ? rooms.get(c.room) : null; };
const toRoom = (r, o, except) => { for (const id of r.players) if (id !== except) { const c = clients.get(id); if (c) send(c.ws, o); } };
const lobbiesMsg = () => ({ t: 'lobbies', list: [...rooms.values()].filter(r => !r.hub).map(r => ({ id: r.id, name: r.name, quick: !!r.quick, host: (clients.get(r.hostId) || {}).name || (r.quick ? '—' : '?'), mode: r.mode, map: r.map, n: r.players.size, max: ROOM_MAX, playing: r.playing, nextIn: r.quick ? Math.max(0, Math.round((r.rotAt - Date.now()) / 1000)) : null })) });
const sendLobbies = () => { const m = lobbiesMsg(); for (const c of clients.values()) if (c.room === null || (rooms.get(c.room) || {}).hub) send(c.ws, m); };
const roomState = r => ({ t: 'room', id: r.id, name: r.name, quick: !!r.quick, hub: !!r.hub, banned: r.banned || [], host: r.hostId, mode: r.mode, map: r.map, playing: r.playing, nextIn: r.quick ? Math.max(0, Math.round((r.rotAt - Date.now()) / 1000)) : null,
  players: [...r.players].map(id => { const c = clients.get(id); return { id, name: c.name, ready: c.ready, host: id === r.hostId, k: c.k, d: c.d, s: c.s }; }) });
const pushRoom = r => { toRoom(r, roomState(r)); toRoom(r, { t: 'roster', n: r.players.size, players: roomState(r).players }); };

function login(id, c, name, pin) {
  name = String(name || '').trim().slice(0, 14).replace(/[^\w\- ]/g, '');
  if (name.length < 2) return send(c.ws, { t: 'auth', ok: false, reason: 'Name needs at least 2 letters or numbers.' });
  const key = name.toLowerCase();
  for (const [oid, oc] of clients) if (oid !== id && oc.user === key) return send(c.ws, { t: 'auth', ok: false, reason: 'Someone with that name is already online.' });
  let u = users[key];
  if (u) { if (u.hash && hashPin(pin || '', u.salt) !== u.hash) return send(c.ws, { t: 'auth', ok: false, reason: "That name is taken and the PIN doesn't match." }); }
  else { const salt = crypto.randomBytes(6).toString('hex'); u = users[key] = { name, salt, hash: pin ? hashPin(pin, salt) : '', k: 0, d: 0, w: 0 }; saveUsers(); }
  c.name = u.name; c.user = key;
  send(c.ws, { t: 'auth', ok: true, name: u.name, totals: { k: u.k, d: u.d, w: u.w } });
  send(c.ws, lobbiesMsg()); if (!roomOf(id)) joinRoom(id, hub); sendFriends(); sendLobbies();
  log(`${id} signed in as ${u.name}`);
}
function leaveRoom(id) {
  const c = clients.get(id); if (!c || c.room === null) return; const r = rooms.get(c.room); c.room = null; c.ready = false; c.k = c.d = c.s = 0;
  if (!r) return; r.players.delete(id); toRoom(r, { t: 'leave', id });
  if (!r.players.size) { if (r.quick || r.hub) { r.hostId = null; } else { rooms.delete(r.id); log(`room "${r.name}" closed`); } }
  else { if (r.hostId === id && !r.hub) { r.hostId = r.players.values().next().value; toRoom(r, { t: 'host', id: r.hostId }); } pushRoom(r); }
  send(c.ws, { t: 'room', id: null }); send(c.ws, lobbiesMsg()); sendLobbies();
}
function joinRoom(id, r) {
  const c = clients.get(id); if (!c || r.players.size >= ROOM_MAX) return send(c.ws, { t: 'err', msg: 'That lobby is full.' });
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
  for (const id of r.players) { const c = clients.get(id); if (c) { c.k = 0; c.d = 0; c.s = 0; } }
  pushRoom(r); log(`"${r.name}": match won by ${w.name}`);
}

const quick = { id: ++rseq, name: 'Quick Play', quick: true, hostId: null, mode: ROTATION[0][0], map: ROTATION[0][1], playing: true, players: new Set(), banned: [], rotAt: Date.now() + QUICK_ROTATE_MS };
rooms.set(quick.id, quick);
const hub = { id: ++rseq, name: 'Briefing Room', hub: true, hostId: null, mode: 'hub', map: 'hub', playing: false, players: new Set(), banned: [] };
rooms.set(hub.id, hub);
function rotateQuick(reason) {
  rotIdx = (rotIdx + 1) % ROTATION.length; [quick.mode, quick.map] = ROTATION[rotIdx]; quick.rotAt = Date.now() + QUICK_ROTATE_MS;
  for (const id of quick.players) { const c = clients.get(id); if (c) { c.k = 0; c.d = 0; c.s = 0; } }
  toRoom(quick, { t: 'rotate', mode: quick.mode, map: quick.map, reason }); pushRoom(quick); sendLobbies(); log(`quick play → ${quick.mode} on ${quick.map} (${reason})`);
}
setInterval(() => { if (Date.now() >= quick.rotAt) rotateQuick(quick.players.size ? 'timer' : 'idle'); }, 5000);

wss.on('connection', (ws, req) => {
  const id = ++seq; const c = { ws, name: 'Player ' + id, user: null, k: 0, d: 0, s: 0, room: null, ready: false }; clients.set(id, c); ws.isAlive = true;
  send(ws, { t: 'welcome', id, host: false }); send(ws, lobbiesMsg());
  log(`${id} connected from ${req.socket.remoteAddress} (${clients.size} online)`);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => { try { handle(data); } catch (e) { log(`error handling message from ${id}: ${e.stack || e}`); } });
  function handle(data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    m.id = id;
    if (m.t === 'login') return login(id, c, m.name, m.pin);
    if (m.t === 'lobbies') return send(ws, lobbiesMsg());
    if (m.t === 'create') { const name = String(m.name || (c.name + "'s lobby")).slice(0, 24); const r = { id: ++rseq, name, hostId: id, mode: m.mode || 'waves', map: m.map || 'forest', playing: false, players: new Set(), banned: Array.isArray(m.banned) ? m.banned.slice(0, 40) : [] }; rooms.set(r.id, r); joinRoom(id, r); log(`room "${name}" created by ${c.name}`); return; }
    if (m.t === 'join') { const r = rooms.get(m.room); if (r) joinRoom(id, r); return; }
    if (m.t === 'leaveroom') { leaveRoom(id); joinRoom(id, hub); return; }
    const r = roomOf(id); if (!r) return;    // everything below happens inside a room
    if (m.t === 'friend') { const o = clients.get(m.to); if (!o || !c.user || !o.user) return;
      if (m.act === 'req') { send(o.ws, { t: 'friend', act: 'req', id, name: c.name }); return; }
      if (m.act === 'acc') { const a = users[c.user], b = users[o.user]; a.friends = a.friends || []; b.friends = b.friends || []; if (!a.friends.includes(o.user)) a.friends.push(o.user); if (!b.friends.includes(c.user)) b.friends.push(c.user); saveUsers(); send(o.ws, { t: 'friend', act: 'acc', id, name: c.name }); sendFriends(); return; }
      if (m.act === 'dec') { send(o.ws, { t: 'friend', act: 'dec', id, name: c.name }); return; } return; }
    if (m.t === 'ready') { c.ready = !!m.r; pushRoom(r); return; }
    if (m.t === 'cfg' && id === r.hostId) { if (r.quick) { m.gm = r.mode; m.map = r.map; } else if (r.mode !== m.gm || r.map !== m.map) { r.mode = m.gm; r.map = m.map; pushRoom(r); sendLobbies(); } toRoom(r, m, id); return; }
    if (m.t === 'restrict' && id === r.hostId && !r.quick) { r.banned = Array.isArray(m.banned) ? m.banned.slice(0, 40) : []; pushRoom(r); return; }
    if (m.t === 'start' && id === r.hostId) { r.playing = true; toRoom(r, { t: 'start' }); pushRoom(r); sendLobbies(); return; }
    if (m.t === 'score' && id === r.hostId) { const w = clients.get(m.who); if (w && w.room === r.id) { w.k += m.k || 0; w.s += m.pts || 0; if (w.user && users[w.user]) { users[w.user].k += m.k || 0; saveUsers(); } pushRoom(r); } return; }
    if (m.t === 'died') {
      c.d++; if (c.user && users[c.user]) { users[c.user].d++; saveUsers(); }
      const killer = clients.get(m.by);
      if (killer && m.by !== id && killer.room === r.id) { killer.k++; killer.s += 100; if (killer.user && users[killer.user]) { users[killer.user].k++; saveUsers(); }
        toRoom(r, { t: 'kill', k: m.by, kn: killer.name, v: id, vn: c.name });
        if (r.mode === 'ffa' && killer.k >= FFA_TARGET) { endMatch(r, m.by); if (r.quick) rotateQuick('match won'); return; } }
      pushRoom(r); return;
    }
    if (m.t === 'h') { const h = clients.get(r.hostId); if (h) send(h.ws, m); return; }
    if (typeof m.to === 'number') { const d = clients.get(m.to); if (d && d.room === r.id) send(d.ws, m); return; }
    toRoom(r, m, id);
  }
  ws.on('close', () => { leaveRoom(id); clients.delete(id); sendLobbies(); sendFriends(); log(`${c.name} disconnected (${clients.size} online)`); });
});
setInterval(() => { for (const c of clients.values()) { if (!c.ws.isAlive) return c.ws.terminate(); c.ws.isAlive = false; c.ws.ping(); } }, 15000);

function addresses() { const out = { tailscale: [], lan: [] };
  for (const list of Object.values(os.networkInterfaces())) for (const a of list) { if (a.family !== 'IPv4' || a.internal) continue; const [o1, o2] = a.address.split('.').map(Number); (o1 === 100 && o2 >= 64 && o2 <= 127 ? out.tailscale : out.lan).push(a.address); } return out; }
server.listen(PORT, '0.0.0.0', () => { const a = addresses(); console.log('\n  BLOCKFRONT server is up.\n');
  if (a.tailscale.length) { console.log('  Tailscale:'); for (const ip of a.tailscale) console.log(`      http://${ip}:${PORT}`); }
  if (a.lan.length) { console.log('  Same Wi-Fi:'); for (const ip of a.lan) console.log(`      http://${ip}:${PORT}`); }
  console.log(`  This machine:  http://localhost:${PORT}\n  (Hosted: players use the https address your host gives you.)\n`); });
