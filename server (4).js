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
// every payout goes through credit(); a 'MATCH WON' payout also counts a win for the leaderboard
function credit(c, b, p, why) { const u = c.user && users[c.user]; if (!u) return; walletOf(u); u.blocks += b | 0; u.prisms += p | 0; if (why === 'MATCH WON') u.w = (u.w | 0) + 1; saveUsers(); sendWallet(c, why ? `${b ? '+' + b + ' BLOCKS ' : ''}${p ? '+' + p + ' PRISMS ' : ''}— ${why}` : undefined); }
// ---- redeemable codes. Only salted SHA-256 hashes live here, so the codes cannot be read out of this file or the repo;
// each is 16 random characters (80 bits), so they can't be guessed or brute-forced either — on top of which attempts are
// rate-limited. One redemption per account per code.
const CODE_SALT = '8979941e65a258e0147b5ea9c381703ae78ccbd767601283';
const CODES = {
  'd42dd2bb4b5f8c4da9bd3f198b786d677d8564790884016de104351dcee35b8c': {"b": 1500, "p": 0, "items": [], "label": "1,500 Blocks"},
  '603ae94fb125dfdfcc4669c00f041c463977e6ee9a4983f6f604dfb46814cf2e': {"b": 0, "p": 60, "items": [], "label": "60 Prisms"},
  'fda6ada999808373262154bd8774e33b2ec36b7a2bb2bc4e98bb744fbdc3d055': {"b": 300, "p": 0, "items": ["gs_cipher"], "label": "the Cipher weapon skin + 300 Blocks"}
};
const hashCode = raw => crypto.createHash('sha256').update(CODE_SALT + ':' + String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32)).digest('hex');
const redeemTries = new Map();   // account -> recent attempt times (in memory; also limited per connection)
function creditRoom(r, b, p, why) { for (const id of r.players) { const c = clients.get(id); if (c) credit(c, b, p, why); } }
// four permanent quick-play rooms, one per mode; the map changes every 9 minutes by player vote (or cycles if nobody voted)
const MAP_POOL = ['forest', 'city', 'refinery', 'wreck', 'compound', 'canyon', 'highline'];
const QUICK_MODES = [['waves', 'Waves', 'forest'], ['demo', 'Demolition', 'refinery'], ['ctf', 'Capture the Flag', 'canyon'], ['tdm', 'Team Deathmatch', 'highline'], ['gun', 'Gun Game', 'compound'], ['ffa', 'Free For All', 'city']];
const GUN_LEVELS = 16;
// Gun Game ladders are random per match: 15 guns drawn from the pool, ending on a random melee weapon. Everyone in the room gets the same order.
const GUN_POOL = ['lmg','dmr','crossbow','blockrifle','scattergun','longshot','whisper','sidearm','mpistol','stinger','deagle','handcannon','boomtube','carbine','sawnoff','thresher','flare','voltline','junker','gauss','harpoon','leech','lance','bounder','kestrel','drifter','breacher','derringer'];
const MELEE_POOL = ['crowbar','hatchet','knife','sledge','katana','machete','battleaxe','chainsaw','spear','tomahawk','bat'];
function makeLadder() { const a = GUN_POOL.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.concat([MELEE_POOL[Math.floor(Math.random() * MELEE_POOL.length)]]); }

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
const DEV_CODE = process.env.DEV_CODE || 'redrock-2026';   // /dev <code> in chat marks that machine as a developer; the tag is cosmetic only

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
const cleanOpts = o => { o = o || {}; const n = (v, lo, hi, d) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d; }; return { max: n(o.max, 2, 8, 8), startWave: n(o.startWave, 1, 20, 1), diff: ['easy', 'normal', 'hard', 'nightmare'].includes(o.diff) ? o.diff : 'normal', target: n(o.target, 5, 50, 20), respawn: n(o.respawn, 1, 10, 3), heavies: o.heavies !== false }; };
// Prisms come from runs that actually started at the bottom. Skipping ahead or turning the raiders
// down still earns Blocks, just no Prisms.
const ranked = r => !r.opts || ((r.opts.startWave || 1) === 1 && r.opts.diff !== 'easy' && r.opts.heavies !== false);
const MIN_MATCH_MS = 60000;
const roomState = r => ({ t: 'room', ctf: isTeam(r) && r.flags ? ctfState(r) : undefined, id: r.id, name: r.name, quick: !!r.quick, hub: !!r.hub, duel: !!r.duel, opts: r.opts || undefined, votes: r.quick ? voteTally(r) : undefined, ladder: r.mode === 'gun' ? (r.ladder || (r.ladder = makeLadder())) : undefined, banned: r.banned || [], host: r.hostId, mode: r.mode, map: r.map, playing: r.playing, nextIn: r.quick ? Math.max(0, Math.round((r.rotAt - Date.now()) / 1000)) : null,
  players: [...r.players].map(id => { const c = clients.get(id); return { id, name: c.name, ready: c.ready, host: id === r.hostId, k: c.k, d: c.d, s: c.s, v: c.vote || null, dev: !!c.dev }; }) });
const pushRoom = r => { toRoom(r, roomState(r)); toRoom(r, { t: 'roster', n: r.players.size, players: roomState(r).players }); };

function login(id, c, name, pin) {
  name = String(name || '').trim().slice(0, 14).replace(/[^\w\- ]/g, '');
  if (name.length < 2) return send(c.ws, { t: 'auth', ok: false, reason: 'Name needs at least 2 letters or numbers.' });
  const key = name.toLowerCase();
  let u = users[key];
  if (u) { if (u.hash && hashPin(pin || '', u.salt) !== u.hash) return send(c.ws, { t: 'auth', ok: false, reason: "That name is taken and the PIN doesn't match." }); }
  else { const salt = crypto.randomBytes(6).toString('hex'); u = users[key] = { name, salt, hash: pin ? hashPin(pin, salt) : '', k: 0, d: 0, w: 0 }; saveUsers(); }
  for (const [oid, oc] of clients) if (oid !== id && oc.user === key) {
    if (!oc.gone) { if (u && u.hash && hashPin(pin || '', u.salt) !== u.hash) return send(c.ws, { t: 'auth', ok: false, reason: 'Someone with that name is already online.' }); try { oc.ws.disconnect(true); } catch (e) {} }   // same person, new tab: hand the seat over
    // resume: hand the dropped seat (same id, same room, same score) to the new connection
    clearTimeout(oc.goneT); oc.gone = null; oc.ws = c.ws; clients.delete(id);
    send(oc.ws, { t: 'auth', ok: true, name: u.name, totals: { k: u.k, d: u.d, w: u.w }, resumed: true, cos: u.cos || null, dev: !!u.dev }); sendWallet(oc); send(oc.ws, lobbiesMsg());
    const r = roomOf(oid); if (r) { send(oc.ws, { t: 'welcome', id: oid, host: oid === r.hostId }); send(oc.ws, roomState(r)); send(oc.ws, { t: 'roster', n: r.players.size, players: roomState(r).players }); } else joinRoom(oid, hub);
    sendFriends(); log(`${u.name} reconnected and resumed as ${oid}`); return { id: oid, c: oc };
  }
  c.name = u.name; c.user = key; c.dev = !!u.dev;
  send(c.ws, { t: 'auth', ok: true, name: u.name, totals: { k: u.k, d: u.d, w: u.w }, cos: u.cos || null, dev: !!u.dev }); sendWallet(c);
  send(c.ws, lobbiesMsg()); if (!roomOf(id)) joinRoom(id, hub); sendFriends(); sendLobbies();
  log(`${id} signed in as ${u.name}`);
}
function leaveRoom(id) {
  const c = clients.get(id); if (!c || c.room === null) return; const r = rooms.get(c.room); c.room = null; c.ready = false; c.vote = null; c.k = c.d = c.s = 0;
  if (!r) return; r.players.delete(id); toRoom(r, { t: 'leave', id });
  if (isTeam(r) && r.teams) { const dropped = ctfDrop(r, id, c.lastPos); r.teams.delete(id); if (r.players.size) { ctfBalance(r); ctfPush(r, dropped ? { type: 'drop', by: id } : null); } }
  if (!r.players.size) { if (r.quick || r.hub) { r.hostId = null; } else { rooms.delete(r.id); log(`room "${r.name}" closed`); } }
  else { if (r.hostId === id && !r.hub) { r.hostId = r.players.values().next().value; toRoom(r, { t: 'host', id: r.hostId }); } pushRoom(r); }
  send(c.ws, { t: 'room', id: null }); send(c.ws, lobbiesMsg()); sendLobbies();
}
function joinRoom(id, r) {
  const c = clients.get(id); if (!c || r.players.size >= (r.duel ? 2 : (r.opts && r.opts.max) || ROOM_MAX)) return send(c.ws, { t: 'err', msg: 'That lobby is full.' });
  leaveRoom(id); c.room = r.id; c.ready = false; r.players.add(id); if (r.hostId === null && !r.hub) r.hostId = id; if (isTeam(r)) ctfAssign(r, id);
  send(c.ws, { t: 'welcome', id, host: id === r.hostId });   // (re)announce host status in this room
  pushRoom(r); if (isTeam(r)) ctfPush(r); sendLobbies(); log(`${c.name} joined "${r.name}" (${r.players.size})`);
}
const onlineByUser = () => { const m = new Map(); for (const c of clients.values()) if (c.user) m.set(c.user, c); return m; };
function friendsFor(c) { const u = c.user && users[c.user]; if (!u) return []; const on = onlineByUser(); return (u.friends || []).map(k => ({ name: (users[k] || {}).name || k, online: on.has(k), room: on.has(k) ? ((rooms.get(on.get(k).room) || {}).name || null) : null })); }
function sendFriends() { for (const c of clients.values()) if (c.user) send(c.ws, { t: 'friends', list: friendsFor(c) }); }
// ================= Capture the Flag =================
// Two teams: 0 = RED, 1 = BLUE; flag i belongs to team i. The server owns the truth — who's on which team, where both
// flags are, the score — and every client request (grab / return / capture / drop) is checked before anything changes.
// Fair teams: joiners go to the smaller team (ties: the team that's behind). If a leave leaves it uneven by 2+, the newest
// player on the bigger team switches — on their next death, or after 20 s. Each new match re-deals teams by snake draft
// on the last match's score, so the best two players never end up together by accident.
const CTF_TARGET = 3, CTF_RETURN_MS = 25000, CTF_TIME_MS = 10 * 60000, CTF_SWAP_MS = 20000, TDM_TARGET = 30;
// Team Deathmatch uses the same team system — fair joins, auto-balance, snake-draft re-deals, no friendly fire, team spawns —
// just without flags: every kill of an enemy scores for your team. 'caps' holds the team score in both modes.
const TEAM_MODES = new Set(['ctf', 'tdm']), isTeam = r => TEAM_MODES.has(r.mode), teamTarget = r => r.mode === 'tdm' ? TDM_TARGET : CTF_TARGET;
function ctfReset(r, keepTeams) {
  r.flags = [{ s: 'home', by: null, pos: null, t: 0 }, { s: 'home', by: null, pos: null, t: 0 }]; r.caps = [0, 0]; r.ctfStart = Date.now(); r.startedAt = Date.now();
  if (!r.teams) r.teams = new Map(); if (!r.joinSeq) r.joinSeq = new Map();
  if (!keepTeams) {   // snake draft on score: A B B A A B B A ...
    const ps = [...r.players].map(id => [id, clients.get(id)]).filter(x => x[1]).sort((a, b) => (b[1].s - a[1].s) || (b[1].k - a[1].k));
    ps.forEach(([id], i) => r.teams.set(id, [0, 1, 1, 0][i % 4]));
  }
  for (const id of r.players) { const c = clients.get(id); if (c) c.ctfMove = 0; }
}
const teamCount = (r, t) => { let n = 0; for (const [id, v] of r.teams) if (v === t && r.players.has(id)) n++; return n; };
function ctfAssign(r, id) {
  if (!r.flags) ctfReset(r, true); r.joinSeq.set(id, Date.now());
  const a = teamCount(r, 0), b = teamCount(r, 1);
  r.teams.set(id, a < b ? 0 : b < a ? 1 : r.caps[0] < r.caps[1] ? 0 : r.caps[1] < r.caps[0] ? 1 : (Math.random() < 0.5 ? 0 : 1));
}
const ctfState = (r, ev) => ({ t: 'ctf', teams: Object.fromEntries([...r.teams].filter(([id]) => r.players.has(id))), flags: r.flags.map(f => ({ s: f.s, by: f.by, pos: f.pos })), caps: r.caps, target: teamTarget(r), ends: r.ctfStart + CTF_TIME_MS, ev: ev || null });
const ctfPush = (r, ev) => toRoom(r, ctfState(r, ev));
function ctfDrop(r, id, pos) { let any = false; for (const f of r.flags) if (f.s === 'carried' && f.by === id) { f.s = 'dropped'; f.by = null; f.pos = (Array.isArray(pos) ? pos : [0, 0, 0]).slice(0, 3).map(v => +v || 0); f.t = Date.now(); any = true; } return any; }
function ctfBalance(r) {   // uneven by 2+: mark the newest arrival on the bigger team to switch
  const a = teamCount(r, 0), b = teamCount(r, 1); if (Math.abs(a - b) < 2) return;
  const big = a > b ? 0 : 1; let pick = null, newest = -1;
  for (const [id, t] of r.teams) { if (t !== big || !r.players.has(id) || r.flags.some(f => f.by === id)) continue; const j = r.joinSeq.get(id) || 0; if (j > newest) { newest = j; pick = id; } }
  const c = pick !== null && clients.get(pick); if (c && !c.ctfMove) { c.ctfMove = Date.now(); send(c.ws, { t: 'ctfnote', msg: 'Teams are uneven — you\'ll switch sides on your next respawn.' }); }
}
function ctfSwap(r, id, c) { r.teams.set(id, 1 - r.teams.get(id)); c.ctfMove = 0; send(c.ws, { t: 'ctfswap', team: r.teams.get(id) }); }
function ctfEnd(r, team) {   // team 0/1 wins, or -1 for a draw at the time limit
  const n0 = teamCount(r, 0), n1 = teamCount(r, 1), real = n0 >= 2 && n1 >= 2 && Date.now() - (r.startedAt || 0) >= 3 * 60000;
  for (const id of r.players) { const c = clients.get(id); if (!c) continue; const t = r.teams.get(id);
    if (team < 0) credit(c, 15, 0, 'MATCH DRAWN'); else if (t === team) credit(c, 40, real ? 10 : 0, 'MATCH WON'); else credit(c, 10, 0, 'MATCH PLAYED'); }
  ctfPush(r, { type: team < 0 ? 'draw' : 'win', team }); log(`${r.name}: ctf ${team < 0 ? 'draw' : ['RED', 'BLUE'][team] + ' wins'} ${r.caps.join('-')}`);
  if (r.quick) rotateQuick(r, 'match won'); else { ctfReset(r, false); for (const id of r.players) { const c = clients.get(id); if (c) { c.k = c.d = c.s = 0; } } ctfPush(r, { type: 'new' }); pushRoom(r); }
}
setInterval(() => {   // dropped flags go home on their own; swaps that waited too long happen anyway; the clock runs out
  for (const r of rooms.values()) { if (!isTeam(r) || !r.flags) continue; let ch = false;
    for (let i = 0; i < 2; i++) { const f = r.flags[i]; if (f.s === 'dropped' && Date.now() - f.t > CTF_RETURN_MS) { f.s = 'home'; f.pos = null; ch = true; ctfPush(r, { type: 'autoreturn', f: i }); } }
    for (const id of r.players) { const c = clients.get(id); if (c && c.ctfMove && Date.now() - c.ctfMove > CTF_SWAP_MS && !r.flags.some(f => f.by === id)) { ctfSwap(r, id, c); ch = true; } }
    if (ch) ctfPush(r);
    if (r.players.size && r.playing !== false && Date.now() > r.ctfStart + CTF_TIME_MS) ctfEnd(r, r.caps[0] > r.caps[1] ? 0 : r.caps[1] > r.caps[0] ? 1 : -1);
  }
}, 1000);
function endMatch(r, winnerId) {
  const w = clients.get(winnerId); if (!w) return;
  if (w.user && users[w.user]) { users[w.user].w++; saveUsers(); }
  toRoom(r, { t: 'matchend', id: winnerId, name: w.name, k: w.k });
  const real = r.duel || (r.players.size > 1 && Date.now() - (r.startedAt || 0) >= MIN_MATCH_MS);
  credit(w, 40, real ? 15 : 0, 'MATCH WON'); for (const id of r.players) if (id !== winnerId) { const c = clients.get(id); if (c) credit(c, 10, 0, 'MATCH PLAYED'); }
  for (const id of r.players) { const c = clients.get(id); if (c) { c.k = 0; c.d = 0; c.s = 0; } }
  pushRoom(r); log(`"${r.name}": match won by ${w.name}`);
}

const quicks = [];
for (const [mode, name, map] of QUICK_MODES) { const r = { id: ++rseq, name, quick: true, hostId: null, mode, map, playing: true, players: new Set(), banned: [], rotAt: Date.now() + QUICK_ROTATE_MS, startedAt: Date.now(), paidWave: 0, paidRound: 0 }; rooms.set(r.id, r); quicks.push(r); }
const hub = { id: ++rseq, name: 'Briefing Room', hub: true, hostId: null, mode: 'hub', map: 'hub', playing: false, players: new Set(), banned: [] };
rooms.set(hub.id, hub);
function rotateQuick(r, reason) {
  const tally = voteTally(r); let best = null, bestN = 0; for (const [map, n] of Object.entries(tally)) if (n > bestN) { best = map; bestN = n; }
  if (!best) { const i = MAP_POOL.indexOf(r.map); best = MAP_POOL[(i + 1) % MAP_POOL.length]; }   // nobody voted: cycle
  r.map = best; r.rotAt = Date.now() + QUICK_ROTATE_MS; r.p10 = false; r.p5 = false; r.startedAt = Date.now(); r.paidWave = 0; r.paidRound = 0; r.paidBoss = false; if (r.mode === 'gun') r.ladder = makeLadder();
  if (isTeam(r)) ctfReset(r, false);
  for (const id of r.players) { const c = clients.get(id); if (c) { c.k = 0; c.d = 0; c.s = 0; c.vote = null; } }
  toRoom(r, { t: 'rotate', mode: r.mode, map: r.map, reason }); pushRoom(r); if (isTeam(r)) ctfPush(r, { type: 'new' }); sendLobbies(); log(`${r.name} → ${r.map} (${reason}${bestN ? ', ' + bestN + ' votes' : ''})`);
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
    if (m.t === 'ping') return send(ws, { t: 'pong', n: m.n });
    if (m.t === 'bye') { const cid = id; leaveRoom(cid); clients.delete(cid); sendLobbies(); sendFriends(); log(`${c.name} left (tab closed)`); try { ws.disconnect(true); } catch (e) {} return; }
    if (m.t === 'lobbies') return send(ws, lobbiesMsg());
    if (m.t === 'create') { const name = String(m.name || (c.name + "'s lobby")).slice(0, 24); const r = { id: ++rseq, name, hostId: id, mode: m.mode || 'waves', map: m.map || 'forest', playing: false, players: new Set(), opts: cleanOpts(m.opts), banned: Array.isArray(m.banned) ? m.banned.slice(0, 40) : [] }; rooms.set(r.id, r); joinRoom(id, r); log(`room "${name}" created by ${c.name}`); return; }
    if (m.t === 'join') { const r = rooms.get(m.room); if (r) joinRoom(id, r); return; }
    if (m.t === 'leaveroom') { leaveRoom(id); joinRoom(id, hub); return; }
    if (m.t === 'lb') { const now = Date.now(); if (now - (c.lbT || 0) < 1500) return; c.lbT = now;   // the leaderboard: accounts only, top 50 by kills
      const rows = Object.values(users).filter(u => u && u.name && ((u.k | 0) + (u.d | 0) + (u.w | 0)) > 0).map(u => ({ n: u.name, k: u.k | 0, d: u.d | 0, w: u.w | 0 }));
      rows.sort((a, b) => (b.k - a.k) || (b.w - a.w) || (a.d - b.d)); return send(ws, { t: 'lb', rows: rows.slice(0, 50), you: c.user && users[c.user] ? users[c.user].name : null }); }
    if (m.t === 'redeem') { const u = c.user && users[c.user]; const reply = (ok, msg) => send(ws, { t: 'redeem', ok, msg });
      if (!u) return reply(false, 'Sign in to redeem a code.');
      const now = Date.now(), key = c.user, tries = (redeemTries.get(key) || []).filter(t => now - t < 60000); c.rt = (c.rt || []).filter(t => now - t < 60000);
      if (tries.length >= 5 || c.rt.length >= 5) return reply(false, 'Too many attempts. Wait a minute and try again.');
      tries.push(now); c.rt.push(now); redeemTries.set(key, tries);
      const h = hashCode(m.code), R = CODES[h]; if (!R) return reply(false, 'That code isn\'t valid.');
      walletOf(u); u.redeemed = u.redeemed || []; const tag = h.slice(0, 20); if (u.redeemed.includes(tag)) return reply(false, 'You\'ve already redeemed that code.');
      u.redeemed.push(tag); u.blocks += R.b | 0; u.prisms += R.p | 0; for (const it of R.items || []) if (!u.owned.includes(it)) u.owned.push(it);
      saveUsers(); sendWallet(c, 'CODE REDEEMED — ' + R.label); log(`${c.name} redeemed a code (${R.label})`); return reply(true, 'Redeemed: ' + R.label + '.'); }
    const r = roomOf(id); if (!r) return;    // everything below happens inside a room
    if (m.t === 'duel' && m.act === 'acc') {   // accepter (id) + challenger (m.to) get their own 1v1 arena, first to 5
      const o = clients.get(m.to); if (!o || o.room !== r.id) return; if (r.duel) return;
      const maps = MAP_POOL; const d = { id: ++rseq, name: `${o.name} vs ${c.name}`, hostId: m.to, mode: 'ffa', map: maps[Math.floor(Math.random() * maps.length)], playing: true, duel: true, players: new Set(), banned: [], startedAt: Date.now() };
      rooms.set(d.id, d); send(o.ws, m); joinRoom(m.to, d); joinRoom(id, d); log(`duel: ${d.name} on ${d.map}`); return; }
    if (m.t === 'friend') { const o = clients.get(m.to); if (!o || !c.user || !o.user) return;
      if (m.act === 'req') { send(o.ws, { t: 'friend', act: 'req', id, name: c.name }); return; }
      if (m.act === 'acc') { const a = users[c.user], b = users[o.user]; a.friends = a.friends || []; b.friends = b.friends || []; if (!a.friends.includes(o.user)) a.friends.push(o.user); if (!b.friends.includes(c.user)) b.friends.push(c.user); saveUsers(); send(o.ws, { t: 'friend', act: 'acc', id, name: c.name }); sendFriends(); return; }
      if (m.act === 'dec') { send(o.ws, { t: 'friend', act: 'dec', id, name: c.name }); return; } return; }
    if (m.t === 'ready') { c.ready = !!m.r; pushRoom(r); return; }
    if (m.t === 'cos') { const u = c.user && users[c.user]; if (!u || !m.c || typeof m.c !== 'object') return; u.cos = m.c; saveUsers(); return; }
    if (m.t === 'dev') { const u = c.user && users[c.user]; if (!u) return; if (m.code === DEV_CODE) { u.dev = true; c.dev = true; saveUsers(); send(ws, { t: 'devok', on: true }); pushRoom(r); } else if (m.code === 'off') { u.dev = false; c.dev = false; saveUsers(); send(ws, { t: 'devok', on: false }); pushRoom(r); } else send(ws, { t: 'devok', on: false, bad: true }); return; }
    if (m.t === 'chat') { const now = Date.now(); if (now - (c.lastChat || 0) < 700) return; c.lastChat = now;
      let text = String(m.text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 140); if (!text) return;
      toRoom(r, { t: 'chat', id, name: c.name, text: censor(text), dev: !!c.dev }); return; }
    if (m.t === 'emote') { const now = Date.now(); if (!EMOTE_IDS.has(m.e) || now - (c.lastEmote || 0) < 1000) return; c.lastEmote = now; toRoom(r, { t: 'emote', id, name: c.name, e: m.e }, id); return; }
    if (m.t === 'vote') { if (r.quick && MAP_POOL.includes(m.map)) { c.vote = m.map; pushRoom(r); } return; }
    if (m.t === 'wv' && id === r.hostId) { const w = m.w | 0; if (w <= (r.paidWave || 0)) { toRoom(r, m, id); return; } r.paidWave = w;
      creditRoom(r, 15, ranked(r) && w % 5 === 0 ? (w === 10 && !r.p10 ? 10 : 5) : 0, 'WAVE ' + w + ' CLEARED'); if (w === 10) r.p10 = true; toRoom(r, m, id); return; }
    if (m.t === 'rnd' && id === r.hostId) { const done = m.r - 1; if (done <= (r.paidRound || 0)) { toRoom(r, m, id); return; } r.paidRound = done;
      creditRoom(r, 25, ranked(r) && done % 3 === 0 ? (done === 6 && !r.p5 ? 10 : 5) : 0, 'ROUND ' + done + ' CLEARED'); if (done === 6) r.p5 = true; toRoom(r, m, id); return; }
    // What people joined is what they get: mode, map and options can't move once the room exists.
    // The host's client still heartbeats cfg, so answer it with the room's settings rather than letting it write them.
    if (m.t === 'cfg' && id === r.hostId) { if (m.gm === undefined) return; m.gm = r.mode; m.map = r.map; toRoom(r, m, id); return; }
    if (m.t === 'restrict' && id === r.hostId && !r.quick) { r.banned = Array.isArray(m.banned) ? m.banned.slice(0, 40) : []; pushRoom(r); return; }
    if (m.t === 'start' && id === r.hostId) { r.playing = true; r.p10 = false; r.p5 = false; r.startedAt = Date.now(); r.paidWave = (r.opts && r.opts.startWave || 1) - 1; r.paidRound = 0; r.paidBoss = false; toRoom(r, { t: 'start' }); pushRoom(r); sendLobbies(); return; }
    if (m.t === 'score' && id === r.hostId) { const w = clients.get(m.who); if (w && w.room === r.id) { w.k += m.k || 0; w.s += m.pts || 0; if (w.user && users[w.user]) { users[w.user].k += m.k || 0; saveUsers(); } const pts = m.pts || 0; credit(w, pts >= 1000 ? 40 : pts >= 250 ? 8 : 3, (pts >= 1000 && ranked(r) && !r.paidBoss) ? 5 : 0, pts >= 1000 ? 'WARLORD DOWN' : undefined); if (pts >= 1000) r.paidBoss = true; pushRoom(r); } return; }
    if (m.t === 'buy') { const item = m.item; const u = c.user && users[c.user]; const pr = PRICES[item]; if (!u || !pr) return; walletOf(u); if (u.owned.includes(item)) return sendWallet(c); if ((pr.b && u.blocks < pr.b) || (pr.p && u.prisms < pr.p)) return sendWallet(c, 'NOT ENOUGH ' + (pr.p ? 'PRISMS' : 'BLOCKS')); u.blocks -= pr.b || 0; u.prisms -= pr.p || 0; u.owned.push(item); saveUsers(); sendWallet(c, 'UNLOCKED'); return; }   // note: m.id is overwritten with the sender's id above, so the item travels as m.item
    if (isTeam(r) && r.flags) {
      if (m.t === 's' && Array.isArray(m.p)) c.lastPos = m.p;   // (still relayed below) remembered so a leaver's flag drops where they were
      const my = r.teams.get(id);
      if (r.mode === 'ctf' && m.t === 'fg') { const fi = m.f | 0, f = r.flags[fi]; if (!f || my === undefined || fi === my || f.s === 'carried' || r.flags.some(x => x.by === id)) return;
        f.s = 'carried'; f.by = id; f.pos = null; return ctfPush(r, { type: 'grab', by: id, f: fi }); }
      if (r.mode === 'ctf' && m.t === 'fr') { const fi = m.f | 0, f = r.flags[fi]; if (!f || my !== fi || f.s !== 'dropped') return; f.s = 'home'; f.pos = null; credit(c, 5, 0, 'FLAG RETURNED'); return ctfPush(r, { type: 'return', by: id, f: fi }); }
      if (r.mode === 'ctf' && m.t === 'fc') { if (my === undefined) return; const ef = r.flags[1 - my]; if (ef.s !== 'carried' || ef.by !== id || r.flags[my].s !== 'home') return;
        ef.s = 'home'; ef.by = null; r.caps[my]++; credit(c, 50, 0, 'FLAG CAPTURED');
        for (const pid of r.players) { if (pid !== id && r.teams.get(pid) === my) { const tc = clients.get(pid); if (tc) credit(tc, 15, 0, 'TEAM CAPTURE'); } }
        ctfPush(r, { type: 'cap', by: id, team: my }); if (r.caps[my] >= teamTarget(r)) ctfEnd(r, my); return; }
      if (r.mode === 'ctf' && m.t === 'fd') { if (ctfDrop(r, id, m.pos)) ctfPush(r, { type: 'drop', by: id }); return; }
      if (m.t === 'dmg' && typeof m.to === 'number' && my !== undefined && r.teams.get(m.to) === my) return;   // no friendly fire, enforced here too
    }
    if (m.t === 'died') {
      if (isTeam(r) && r.flags) { if (r.mode === 'ctf' && ctfDrop(r, id, c.lastPos)) ctfPush(r, { type: 'drop', by: id }); if (c.ctfMove) { ctfSwap(r, id, c); ctfPush(r); }
        if (r.mode === 'tdm') { const kt = r.teams.get(m.by), vt = r.teams.get(id); if (kt !== undefined && vt !== undefined && kt !== vt && clients.has(m.by)) { r.caps[kt]++; ctfPush(r, { type: 'point', team: kt }); if (r.caps[kt] >= TDM_TARGET) { ctfEnd(r, kt); } } } }
      c.d++; if (c.user && users[c.user]) { users[c.user].d++; saveUsers(); }
      const killer = clients.get(m.by);
      if (killer && m.by !== id && killer.room === r.id) { killer.k++; killer.s += 100; if (killer.user && users[killer.user]) { users[killer.user].k++; saveUsers(); }
        toRoom(r, { t: 'kill', k: m.by, kn: killer.name, v: id, vn: c.name, w: String(m.w || '').slice(0, 24), h: m.h ? 1 : 0 });
        if ((r.mode === 'ffa' || r.mode === 'gun') && killer.k >= (r.duel ? 5 : r.mode === 'gun' ? (r.ladder ? r.ladder.length : GUN_LEVELS) : (r.opts && r.opts.target) || FFA_TARGET)) { endMatch(r, m.by); if (r.mode === 'gun' && !r.quick) { r.ladder = makeLadder(); pushRoom(r); } if (r.quick) rotateQuick(r, 'match won');
          if (r.duel) setTimeout(() => { for (const pid of [...r.players]) { if (clients.has(pid)) { leaveRoom(pid); joinRoom(pid, hub); } } }, 6000);   // duel over: both back to the briefing room
          return; } }
      pushRoom(r); return;
    }
    if (m.t === 'h') { const h = clients.get(r.hostId); if (h) send(h.ws, m); return; }
    if (typeof m.to === 'number') { const d = clients.get(m.to); if (d && d.room === r.id) send(d.ws, m); return; }
    toRoom(r, m, id);
  }
  ws.on('disconnect', () => {
    const cid = id, cc = c; if (clients.get(cid) !== cc || cc.ws !== ws) return;   // this socket was replaced by a resume; nothing to clean up
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
