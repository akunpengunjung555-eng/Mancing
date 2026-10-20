// Mancing Laut Dalam — API (Cloudflare Worker + D1). File statis dilayani dari ./public.
const enc = new TextEncoder();
const J = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (status, error) => J({ ok: false, error }, status);

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const sha256 = async s => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hashPw(pw, saltB64) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: 100000 }, key, 256);
  return b64(bits);
}
const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));
const newToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

const SESSION_MS = 30 * 24 * 3600 * 1000;
const USER_RE = /^[a-z0-9_.]{3,20}$/;
const MUT_OK = new Set(['', 'neon', 'emas', 'kristal', 'pelangi']);
const MAX_FRIENDS = 100, MAX_PENDING = 30, GIFTS_PER_DAY = 50, INBOX_MAX = 500;

let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users(
      username TEXT PRIMARY KEY, salt TEXT NOT NULL, pw TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', premium INTEGER NOT NULL DEFAULT 0,
      balance INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '{}',
      win_start INTEGER NOT NULL DEFAULT 0, win_amt INTEGER NOT NULL DEFAULT 0,
      fails INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS friends(
      requester TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, PRIMARY KEY(requester, target))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS friends_target ON friends(target)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS gift_log(
      sender TEXT NOT NULL, receiver TEXT NOT NULL, fish TEXT NOT NULL, at INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS gift_log_sender ON gift_log(sender, at)'),
  ]);
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN inbox TEXT NOT NULL DEFAULT '[]'").run(); } catch { /* sudah ada */ }
  ready = true;
}

const features = u => ({ live: u.role === 'admin' || !!u.premium, auto: u.role === 'admin' || !!u.premium });
const publicUser = (u, env) => ({ username: u.username, role: u.role, premium: !!u.premium, features: features(u), connectorUrl: env.CONNECTOR_URL || '' });

async function createUser(env, username, password, role, premium) {
  const salt = newSalt();
  const pw = await hashPw(password, salt);
  await env.DB.prepare('INSERT INTO users(username,salt,pw,role,premium,balance,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(username, salt, pw, role, premium ? 1 : 0, Math.max(0, Math.trunc(Number(env.START_COINS) || 0)), Date.now()).run();
}
async function startSession(env, username) {
  const token = newToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions(token_hash,username,expires) VALUES(?,?,?)').bind(await sha256(token), username, Date.now() + SESSION_MS),
  ]);
  return token;
}
async function authUser(env, req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  return await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.username=s.username WHERE s.token_hash=? AND s.expires>?')
    .bind(await sha256(token), Date.now()).first();
}

async function readJson(req) { try { return await req.json(); } catch { return {}; } }
const cleanName = v => String(v ?? '').trim().toLowerCase();

async function login(env, b) {
  const username = cleanName(b.username), password = String(b.password ?? '');
  if (!USER_RE.test(username) || !password) return err(400, 'Username atau password salah.');
  let u = await env.DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
  // Bootstrap admin: login pertama dengan ADMIN_USERNAME + ADMIN_PASSWORD membuat akun admin.
  if (!u && env.ADMIN_USERNAME && env.ADMIN_PASSWORD && username === cleanName(env.ADMIN_USERNAME)
      && safeEq(password, String(env.ADMIN_PASSWORD))) {
    await createUser(env, username, password, 'admin', true);
    u = await env.DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
  }
  if (!u) return err(401, 'Username atau password salah.');
  if (u.lock_until > Date.now()) return err(429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.');
  const ok = safeEq(await hashPw(password, u.salt), u.pw);
  if (!ok) {
    const fails = u.fails + 1;
    await env.DB.prepare('UPDATE users SET fails=?, lock_until=? WHERE username=?')
      .bind(fails >= 5 ? 0 : fails, fails >= 5 ? Date.now() + 5 * 60000 : 0, username).run();
    return err(401, 'Username atau password salah.');
  }
  if (u.fails) await env.DB.prepare('UPDATE users SET fails=0, lock_until=0 WHERE username=?').bind(username).run();
  const token = await startSession(env, username);
  return J({ ok: true, token, user: publicUser(u, env) });
}

async function register(env, b) {
  if (env.ALLOW_REGISTER === '0') return err(403, 'Pendaftaran ditutup. Minta admin membuatkan akun.');
  const username = cleanName(b.username), password = String(b.password ?? '');
  if (!USER_RE.test(username)) return err(400, 'Username 3-20 karakter: huruf kecil, angka, titik, garis bawah.');
  if (password.length < 6 || password.length > 64) return err(400, 'Password minimal 6 karakter.');
  if (env.ADMIN_USERNAME && username === cleanName(env.ADMIN_USERNAME)) return err(409, 'Username sudah dipakai.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE username=?').bind(username).first()) return err(409, 'Username sudah dipakai.');
  await createUser(env, username, password, 'user', false);
  const u = await env.DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
  return J({ ok: true, token: await startSession(env, username), user: publicUser(u, env) });
}

async function admin(env, req, u, path) {
  if (u.role !== 'admin') return err(403, 'Khusus admin.');
  if (path === '/admin/list') {
    const { results } = await env.DB.prepare('SELECT username,role,premium,balance,created_at FROM users ORDER BY created_at DESC LIMIT 500').all();
    return J({ ok: true, users: results });
  }
  const b = await readJson(req), name = cleanName(b.username);
  if (path === '/admin/detail') {
    const t = await env.DB.prepare('SELECT username,role,premium,balance,state FROM users WHERE username=?').bind(name).first();
    if (!t) return err(404, 'Akun tidak ditemukan.');
    return J({ ok: true, user: { username: t.username, role: t.role, premium: !!t.premium, balance: t.balance }, state: JSON.parse(t.state || '{}') });
  }
  if (path === '/admin/give') {
    const t = await env.DB.prepare('SELECT username,balance,inbox FROM users WHERE username=?').bind(name).first();
    if (!t) return err(404, 'Akun tidak ditemukan.');
    const ID = /^[a-z0-9_]{1,40}$/, items = [];
    const coins = Math.trunc(Number(b.coins) || 0);
    if (coins < 0 || coins > 1e15) return err(400, 'Jumlah koin tidak valid.');
    for (const id of (Array.isArray(b.rods) ? b.rods : []).slice(0, 100)) if (ID.test(String(id))) items.push({ t: 'rod', id: String(id) });
    for (const [id, n] of Object.entries(b.baits && typeof b.baits === 'object' ? b.baits : {}).slice(0, 100))
      if (ID.test(id) && Number(n) >= 1) items.push({ t: 'bait', id, n: Math.min(9999, Math.trunc(Number(n))) });
    for (const f of (Array.isArray(b.fish) ? b.fish : []).slice(0, 200))
      if (f && ID.test(String(f.id)) && Number(f.n) >= 1) items.push({ t: 'fish', id: String(f.id), n: Math.min(999, Math.trunc(Number(f.n))), sh: f.sh ? 1 : 0 });
    if (!coins && !items.length) return err(400, 'Tidak ada yang dikirim.');
    const at = Date.now();
    for (const it of items) it.at = at;
    const inbox = JSON.parse(t.inbox || '[]').concat(items).slice(-500);
    await env.DB.prepare('UPDATE users SET balance=balance+?, inbox=? WHERE username=?').bind(coins, JSON.stringify(inbox), name).run();
    return J({ ok: true, sent: items.length, coins });
  }
  if (path === '/admin/create') {
    const password = String(b.password ?? '');
    if (!USER_RE.test(name)) return err(400, 'Username 3-20 karakter: huruf kecil, angka, titik, garis bawah.');
    if (password.length < 6 || password.length > 64) return err(400, 'Password minimal 6 karakter.');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE username=?').bind(name).first()) return err(409, 'Username sudah dipakai.');
    await createUser(env, name, password, 'user', b.premium !== false); // dibuat admin = terdaftar (fitur aktif)
    return J({ ok: true });
  }
  const target = await env.DB.prepare('SELECT * FROM users WHERE username=?').bind(name).first();
  if (!target) return err(404, 'Akun tidak ditemukan.');
  if (path === '/admin/premium') {
    if (target.role === 'admin') return err(400, 'Admin selalu punya akses.');
    await env.DB.prepare('UPDATE users SET premium=? WHERE username=?').bind(b.premium ? 1 : 0, name).run();
    return J({ ok: true });
  }
  if (path === '/admin/password') {
    const password = String(b.password ?? '');
    if (password.length < 6 || password.length > 64) return err(400, 'Password minimal 6 karakter.');
    const salt = newSalt();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET salt=?, pw=?, fails=0, lock_until=0 WHERE username=?').bind(salt, await hashPw(password, salt), name),
      env.DB.prepare('DELETE FROM sessions WHERE username=?').bind(name),
    ]);
    return J({ ok: true });
  }
  if (path === '/admin/delete') {
    if (target.role === 'admin') return err(400, 'Akun admin tidak bisa dihapus.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE username=?').bind(name),
      env.DB.prepare('DELETE FROM friends WHERE requester=? OR target=?').bind(name, name),
      env.DB.prepare('DELETE FROM users WHERE username=?').bind(name),
    ]);
    return J({ ok: true });
  }
  return err(404, 'Not found');
}

// Kosongkan hanya item inbox yang sudah dibaca (n item pertama); item baru yang masuk di sela-sela tetap aman.
const CLEAR_READ_INBOX = "COALESCE((SELECT json_group_array(json(value)) FROM json_each(users.inbox) WHERE key>=?),'[]')";

async function fish(env, req, u, path) {
  if (path === '/fish/load') {
    const inbox = JSON.parse(u.inbox || '[]');
    if (inbox.length) await env.DB.prepare(`UPDATE users SET inbox=${CLEAR_READ_INBOX} WHERE username=?`).bind(inbox.length, u.username).run();
    return J({ ok: true, balance: u.balance, state: JSON.parse(u.state || '{}'), inbox });
  }
  if (path === '/fish/sync') {
    const b = await readJson(req);
    let d = Math.trunc(Number(b.d) || 0), capped = false;
    if (!Number.isFinite(d)) return err(400, 'Data tidak valid.');
    const stateStr = JSON.stringify(b.state && typeof b.state === 'object' ? b.state : {});
    if (stateStr.length > 150000) return err(413, 'Data terlalu besar.');
    let winStart = u.win_start, winAmt = u.win_amt;
    if (d > 0 && u.role !== 'admin') {
      const now = Date.now(), maxMin = Number(env.MAX_GAIN_PER_MIN) || 2e12;
      if (now - winStart > 60000) { winStart = now; winAmt = 0; }
      const allowed = Math.max(0, maxMin - winAmt);
      if (d > allowed) { d = allowed; capped = true; }
      winAmt += d;
    }
    const balance = u.balance + d;
    if (balance < 0) return err(400, 'Saldo tidak cukup.');
    const fresh = await env.DB.prepare('SELECT balance, inbox FROM users WHERE username=?').bind(u.username).first();
    const inbox = JSON.parse((fresh && fresh.inbox) || '[]');
    const newBal = (fresh ? fresh.balance : u.balance) + d; // termasuk koin kiriman admin yang masuk barusan
    if (newBal < 0) return err(400, 'Saldo tidak cukup.');
    await env.DB.prepare(`UPDATE users SET balance=?, state=?, win_start=?, win_amt=?, inbox=${CLEAR_READ_INBOX} WHERE username=?`)
      .bind(newBal, stateStr, winStart, winAmt, inbox.length, u.username).run();
    return J({ ok: true, balance: newBal, capped, inbox });
  }
  return err(404, 'Not found');
}

// ---- Teman ----
async function social(env, req, u, path) {
  const me = u.username;
  if (path === '/friends/list') {
    const { results } = await env.DB.prepare('SELECT requester,target,status FROM friends WHERE requester=? OR target=?').bind(me, me).all();
    const friends = [], incoming = [], outgoing = [];
    for (const r of results) {
      const other = r.requester === me ? r.target : r.requester;
      if (r.status === 'accepted') friends.push(other);
      else if (r.target === me) incoming.push(other);
      else outgoing.push(other);
    }
    return J({ ok: true, friends: friends.sort(), incoming: incoming.sort(), outgoing: outgoing.sort() });
  }
  const b = await readJson(req), name = cleanName(b.username);
  if (!USER_RE.test(name) || name === me) return err(400, 'Username tidak valid.');
  const rel = (a, c) => env.DB.prepare('SELECT status FROM friends WHERE requester=? AND target=?').bind(a, c).first();
  const countFriends = async who => (await env.DB.prepare("SELECT COUNT(*) c FROM friends WHERE status='accepted' AND (requester=? OR target=?)").bind(who, who).first()).c;

  if (path === '/friends/add') {
    if (!(await env.DB.prepare('SELECT 1 FROM users WHERE username=?').bind(name).first())) return err(404, 'Akun tidak ditemukan.');
    const mine = await rel(me, name), theirs = await rel(name, me);
    if ((mine && mine.status === 'accepted') || (theirs && theirs.status === 'accepted')) return err(409, 'Kalian sudah berteman.');
    if (mine) return err(409, 'Permintaan sudah terkirim, tunggu dia menerima.');
    if (await countFriends(me) >= MAX_FRIENDS) return err(400, 'Daftar temanmu penuh.');
    if (theirs) { // dia sudah lebih dulu mengajak -> langsung berteman
      if (await countFriends(name) >= MAX_FRIENDS) return err(400, 'Daftar teman dia penuh.');
      await env.DB.prepare("UPDATE friends SET status='accepted' WHERE requester=? AND target=?").bind(name, me).run();
      return J({ ok: true, status: 'friends' });
    }
    const pend = await env.DB.prepare("SELECT COUNT(*) c FROM friends WHERE requester=? AND status='pending'").bind(me).first();
    if (pend.c >= MAX_PENDING) return err(429, 'Terlalu banyak permintaan menunggu.');
    await env.DB.prepare("INSERT INTO friends(requester,target,status,created_at) VALUES(?,?, 'pending', ?)").bind(me, name, Date.now()).run();
    return J({ ok: true, status: 'pending' });
  }
  if (path === '/friends/accept') {
    const r = await rel(name, me);
    if (!r || r.status !== 'pending') return err(404, 'Permintaan tidak ditemukan.');
    if (await countFriends(me) >= MAX_FRIENDS) return err(400, 'Daftar temanmu penuh.');
    if (await countFriends(name) >= MAX_FRIENDS) return err(400, 'Daftar teman dia penuh.');
    await env.DB.prepare("UPDATE friends SET status='accepted' WHERE requester=? AND target=?").bind(name, me).run();
    return J({ ok: true });
  }
  if (path === '/friends/decline') {
    await env.DB.prepare("DELETE FROM friends WHERE requester=? AND target=? AND status='pending'").bind(name, me).run();
    return J({ ok: true });
  }
  if (path === '/friends/remove') {
    await env.DB.prepare("DELETE FROM friends WHERE status='accepted' AND ((requester=? AND target=?) OR (requester=? AND target=?))").bind(me, name, name, me).run();
    return J({ ok: true });
  }
  return err(404, 'Not found');
}

// ---- Kirim ikan ke teman ----
async function giftFish(env, req, u) {
  const b = await readJson(req), me = u.username, to = cleanName(b.to);
  const id = String(b.id ?? ''), w = Number(b.w), sh = b.sh ? 1 : 0, mut = String(b.mut ?? '');
  if (!USER_RE.test(to) || to === me) return err(400, 'Penerima tidak valid.');
  if (!/^[a-z0-9_]{1,40}$/.test(id) || !(w > 0 && w <= 1e6) || !MUT_OK.has(mut)) return err(400, 'Data ikan tidak valid.');
  const fr = await env.DB.prepare("SELECT 1 FROM friends WHERE status='accepted' AND ((requester=? AND target=?) OR (requester=? AND target=?))").bind(me, to, to, me).first();
  if (!fr) return err(403, 'Hanya bisa mengirim ke teman.');
  const cnt = await env.DB.prepare('SELECT COUNT(*) c FROM gift_log WHERE sender=? AND at>?').bind(me, Date.now() - 86400000).first();
  if (cnt.c >= GIFTS_PER_DAY) return err(429, 'Batas kirim ikan harian tercapai (' + GIFTS_PER_DAY + ' per 24 jam).');
  const rcv = await env.DB.prepare('SELECT json_array_length(inbox) n FROM users WHERE username=?').bind(to).first();
  if (!rcv) return err(404, 'Penerima tidak ditemukan.');
  if (rcv.n >= INBOX_MAX) return err(409, 'Kotak masuk penerima penuh. Minta dia membuka game dulu.');

  const row = await env.DB.prepare('SELECT state FROM users WHERE username=?').bind(me).first();
  const oldState = (row && row.state) || '{}';
  let st; try { st = JSON.parse(oldState); } catch { st = {}; }
  const bag = Array.isArray(st.bag) ? st.bag : [];
  const i = bag.findIndex(x => x && x.id === id && Math.abs(Number(x.w) - w) < 0.006 && (x.sh ? 1 : 0) === sh && String(x.mut || '') === mut);
  if (i < 0) return err(409, 'Ikan itu tidak ada di tasmu. Tunggu sebentar lalu coba lagi.');
  const [f] = bag.splice(i, 1);
  const item = { t: 'fish', id, n: 1, w: Math.round(Number(f.w) * 100) / 100, sh, from: me, at: Date.now() }; // 'at' = jam kirim asli, dipakai Riwayat di game
  if (mut) item.mut = mut;

  // Dua langkah dalam satu transaksi; keduanya hanya jalan jika state pengirim belum berubah (cegah dobel kirim).
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE users SET inbox=json_insert(inbox,'$[#]',json(?)) WHERE username=? AND EXISTS(SELECT 1 FROM users s WHERE s.username=? AND s.state=?)")
      .bind(JSON.stringify(item), to, me, oldState),
    env.DB.prepare('UPDATE users SET state=? WHERE username=? AND state=?').bind(JSON.stringify(st), me, oldState),
  ]);
  if (!res[0].meta.changes || !res[1].meta.changes) return err(409, 'Data berubah saat mengirim. Coba lagi.');
  await env.DB.prepare('INSERT INTO gift_log(sender,receiver,fish,at) VALUES(?,?,?,?)').bind(me, to, id + (mut ? '+' + mut : ''), Date.now()).run();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM gift_log WHERE at<?').bind(Date.now() - 7 * 86400000).run();
  return J({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'mancing' });
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      const id = env.GAME_ROOM.idFromName('global-live-room');
      return env.GAME_ROOM.get(id).fetch(req);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const path = url.pathname.slice(4);
    try {
      await init(env);
      if (path === '/auth/login' && req.method === 'POST') return await login(env, await readJson(req));
      if (path === '/auth/register' && req.method === 'POST') return await register(env, await readJson(req));
      const u = await authUser(env, req);
      if (!u) return err(401, 'Sesi berakhir. Silakan masuk lagi.');
      if (path === '/auth/me') return J({ ok: true, user: publicUser(u, env) });
      if (path === '/auth/logout') {
        const t = (req.headers.get('authorization') || '').slice(7).trim();
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(t)).run();
        return J({ ok: true });
      }
      if (path === '/auth/verify') { // dipakai connector LIVE
        const f = features(u);
        return f[url.searchParams.get('feature') || 'live'] ? J({ ok: true, username: u.username }) : err(403, 'Akun belum terdaftar untuk fitur ini.');
      }
      if (path.startsWith('/admin/')) return await admin(env, req, u, path);
      if (path.startsWith('/fish/') && req.method === 'POST') return await fish(env, req, u, path);
      if (path.startsWith('/friends/') && req.method === 'POST') return await social(env, req, u, path);
      if (path === '/gift/fish' && req.method === 'POST') return await giftFish(env, req, u);
      return err(404, 'Not found');
    } catch (e) {
      console.error(e);
      return err(500, 'Terjadi kesalahan server.');
    }
  },
};

// --- Room lama (dipertahankan apa adanya supaya deploy tidak error) ---
const PRICE = Object.freeze({ karang: 10, tuna: 250, hiu: 1500, leviathan: 10000 });
const FISH = Object.freeze({
  karang: { name: 'Ikan Karang', rarity: 'biasa', emoji: '🐟' },
  tuna: { name: 'Tuna Raksasa', rarity: 'besar', emoji: '🐠' },
  hiu: { name: 'Hiu Legendaris', rarity: 'legendaris', emoji: '🦈' },
  leviathan: { name: 'Leviathan Mitos', rarity: 'boss', emoji: '🐉' }
});
export class GameRoom {
  constructor(ctx) { this.ctx = ctx; this.sockets = new Map(); }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.set(server, { viewerId: '', viewerName: 'Penonton' });
    server.addEventListener('close', () => this.sockets.delete(server));
    server.addEventListener('error', () => this.sockets.delete(server));
    server.addEventListener('message', async event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'identify') {
          const viewerId = String(msg.viewerId || '').slice(0, 80);
          if (!viewerId) return server.send(JSON.stringify({ type: 'error', message: 'viewerId diperlukan' }));
          const viewerName = String(msg.viewerName || 'Penonton').slice(0, 32) || 'Penonton';
          this.sockets.set(server, { viewerId, viewerName });
          const balance = await this.ctx.storage.get(`wallet:${viewerId}`) ?? 1000;
          server.send(JSON.stringify({ type: 'wallet', balance }));
          return;
        }
        if (msg.type !== 'purchase' || !PRICE[msg.fishId]) return;
        const identity = this.sockets.get(server) || {};
        const viewerId = identity.viewerId;
        if (!viewerId || String(msg.viewerId || '') !== viewerId) return server.send(JSON.stringify({ type: 'error', message: 'Identitas penonton belum terverifikasi di sesi ini' }));
        const viewerName = identity.viewerName || 'Penonton';
        const cost = PRICE[msg.fishId];
        const result = await this.ctx.storage.transaction(async tx => {
          const key = `wallet:${viewerId}`;
          const balance = await tx.get(key) ?? 1000;
          if (balance < cost) return { ok: false, balance };
          const next = balance - cost;
          await tx.put(key, next);
          return { ok: true, balance: next };
        });
        if (!result.ok) return server.send(JSON.stringify({ type: 'purchase_result', ok: false, message: 'Koin tidak cukup', balance: result.balance }));
        server.send(JSON.stringify({ type: 'purchase_result', ok: true, balance: result.balance }));
        const eventOut = { type: 'global_catch', viewerId, viewerName, fishId: msg.fishId, fish: FISH[msg.fishId], cost, at: Date.now() };
        const wire = JSON.stringify(eventOut);
        for (const ws of this.sockets.keys()) { try { ws.send(wire); } catch { this.sockets.delete(ws); } }
      } catch {
        try { server.send(JSON.stringify({ type: 'error', message: 'Pesan tidak valid' })); } catch {}
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}