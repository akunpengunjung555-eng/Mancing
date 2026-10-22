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

// ---- TURN: gabungan beberapa penyedia (Metered, cadangan statis, Cloudflare); dikirim semua, browser memilih yang berhasil ----
const turnCache = {}; // per penyedia: { at, ice }
async function cachedIce(name, ttl, load) {
  const c = turnCache[name];
  if (c && Date.now() - c.at < ttl) return c.ice;
  let ice = null;
  try { ice = await load(); } catch (e) { console.error('turn ' + name, e); }
  if (Array.isArray(ice) && ice.length) { turnCache[name] = { at: Date.now(), ice }; return ice; }
  return c ? c.ice : null; // gagal ambil baru -> pakai yang lama kalau masih ada
}
async function turnServers(env) {
  const out = [];
  if (env.METERED_APP && env.METERED_API_KEY) {
    const ice = await cachedIce('metered', 3600 * 1000, async () => {
      const r = await fetch('https://' + encodeURIComponent(env.METERED_APP) + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(env.METERED_API_KEY));
      if (!r.ok) return null;
      const d = await r.json().catch(() => null);
      return Array.isArray(d) ? d : null;
    });
    if (ice) out.push(...ice);
  }
  if (env.TURN_FALLBACK) { // secret berisi JSON: [{"urls":[...],"username":"...","credential":"..."}]
    const ice = await cachedIce('fallback', 6 * 3600 * 1000, async () => {
      const d = JSON.parse(env.TURN_FALLBACK), a = Array.isArray(d) ? d : [d];
      return a.filter(x => x && (typeof x.urls === 'string' || Array.isArray(x.urls))).slice(0, 10);
    });
    if (ice) out.push(...ice);
  }
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    const ice = await cachedIce('cloudflare', 6 * 3600 * 1000, async () => {
      const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(env.TURN_KEY_ID) + '/credentials/generate-ice-servers', {
        method: 'POST', headers: { authorization: 'Bearer ' + env.TURN_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
      });
      if (!r.ok) return null;
      const d = await r.json().catch(() => null);
      return d && Array.isArray(d.iceServers) ? d.iceServers : null;
    });
    if (ice) out.push(...ice);
  }
  return out.length ? out : null;
}
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
    // Turnamen: biaya pendaftaran yang sedang ditahan (held) + riwayat hasil global
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tourney_entry(
      mid TEXT NOT NULL, username TEXT NOT NULL, fee INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'held',
      at INTEGER NOT NULL, UNIQUE(mid, username))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tourney_log(
      mid TEXT NOT NULL, code TEXT NOT NULL, username TEXT NOT NULL, pts INTEGER NOT NULL, catches INTEGER NOT NULL,
      epic INTEGER NOT NULL, legend INTEGER NOT NULL, place INTEGER NOT NULL, prize INTEGER NOT NULL, fee INTEGER NOT NULL, at INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS tourney_log_user ON tourney_log(username)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS tourney_log_at ON tourney_log(at)'),
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
    const newBal = (fresh ? fresh.balance : u.balance) + d; // termasuk koin kiriman admin / biaya & hadiah turnamen yang masuk barusan
    if (newBal < 0) return err(400, 'Saldo tidak cukup.');
    // relatif (balance+d), bukan menimpa: biaya/hadiah turnamen dari server tidak ikut tertimpa
    const upd = await env.DB.prepare(`UPDATE users SET balance=balance+?, state=?, win_start=?, win_amt=?, inbox=${CLEAR_READ_INBOX} WHERE username=? AND balance+?>=0`)
      .bind(d, stateStr, winStart, winAmt, inbox.length, u.username, d).run();
    if (!upd.meta.changes) return err(400, 'Saldo tidak cukup.');
    const after = await env.DB.prepare('SELECT balance FROM users WHERE username=?').bind(u.username).first();
    return J({ ok: true, balance: after ? after.balance : newBal, capped, inbox });
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

// ---- Papan peringkat turnamen (global) ----
async function tourney(env, req, u, path) {
  if (path !== '/tourney/board') return err(404, 'Not found');
  const b = await readJson(req);
  const ORDER = {
    prize: 'prize DESC, wins DESC, pts DESC',
    wins: 'wins DESC, prize DESC, pts DESC',
    pts: 'pts DESC, wins DESC, prize DESC',
  };
  const by = ORDER[b.by] ? b.by : 'prize';
  const agg = 'SELECT username, COUNT(*) matches, SUM(CASE WHEN place=1 THEN 1 ELSE 0 END) wins, SUM(prize) prize, SUM(pts) pts, SUM(fee) spent FROM tourney_log';
  const { results } = await env.DB.prepare(agg + ' GROUP BY username ORDER BY ' + ORDER[by] + ' LIMIT 30').all();
  const mine = await env.DB.prepare(agg + ' WHERE username=? GROUP BY username').bind(u.username).first();
  const { results: recent } = await env.DB.prepare('SELECT code, username, pts, prize, fee, at FROM tourney_log WHERE place=1 ORDER BY at DESC LIMIT 8').all();
  return J({ ok: true, by, board: results, me: mine || null, recent });
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
      // Hanya pemain login (token sesi) yang boleh masuk; username diambil dari D1, bukan dari klien.
      const token = (url.searchParams.get('token') || '').trim();
      let username = '';
      if (token) {
        try {
          await init(env);
          const row = await env.DB.prepare('SELECT u.username FROM sessions s JOIN users u ON u.username=s.username WHERE s.token_hash=? AND s.expires>?')
            .bind(await sha256(token), Date.now()).first();
          username = row ? row.username : '';
        } catch (e) { console.error(e); }
      }
      if (!username) return new Response('Unauthorized', { status: 401 });
      const headers = new Headers(req.headers);
      headers.set('x-mancing-user', username); // header ini selalu ditimpa di sini, nilai dari klien dibuang
      const id = env.GAME_ROOM.idFromName('global-live-room');
      return env.GAME_ROOM.get(id).fetch(new Request(url.origin + '/ws', { headers }));
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
      if (path === '/turn') return J({ ok: true, iceServers: await turnServers(env) }); // kunci tetap di server
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
      if (path.startsWith('/tourney/') && req.method === 'POST') return await tourney(env, req, u, path);
      if (path === '/gift/fish' && req.method === 'POST') return await giftFish(env, req, u);
      return err(404, 'Not found');
    } catch (e) {
      console.error(e);
      return err(500, 'Terjadi kesalahan server.');
    }
  },
};

// --- Realtime: notif global ikan epik/legendaris + room mabar (satu Durable Object untuk semua pemain) ---
const RAR_OK = new Set(['rare', 'epic', 'legend']);
const RAR_PTS = { rare: 1, epic: 3, legend: 10 };
const ROOM_MAX = 6;
const MATCH_DURS = new Set([300, 600, 900, 1800, 3600]); // detik: 5, 10, 15, 30, 60 menit
const MIN_FEE = 100_000_000;      // 100M koin
const MAX_FEE = 1_000_000_000_000; // 1T koin
const PRIZE_PCT = 50;             // juara dapat 50% dari total biaya pendaftaran (sisanya hangus)
const COUNTDOWN_MS = 5000;
const EMPTY_GRACE_MS = 90000;     // semua pemain putus saat pertandingan jalan: tunggu 90 dtk sebelum diselesaikan
const PREP_MS = 30000; // waktu siap-siap duel (pilih joran & umpan) sebelum hitung mundur
const TOUR_DUR = 180, TOUR_MAXP = 36; // playoff: duel 3 menit, peserta 2-36 (genap)
const TOUR_SIZES = [2, 4, 8, 16, 32, 36]; // server selalu menyediakan satu turnamen terbuka untuk tiap kombinasi biaya x jumlah pemain
const TOUR_FEES = [0, 1e6, 1e7, 1e8, 1e9, 1e10]; // biaya daftar dari server: gratis, 1M, 10M, 100M, 1B, 10B
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{4}$/;
const EMOTES = new Set(['👍', '🔥', '😂', '😱', '🎣', '👑', '🐟', '❤️']);
const cap = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.peers = new Map();   // ws -> { user, room, st, tokens, tAt, lastCatch }
    this.rooms = new Map();   // code -> room (lihat makeRoom)
    this.globalWin = { at: 0, n: 0 };
    this.tickT = null;
    this.TS = new Map();      // turnamen playoff global: id -> turnamen (banyak sekaligus)
    // Instance baru = tidak ada pertandingan yang masih berjalan: kembalikan biaya pendaftaran yang masih tertahan.
    ctx.blockConcurrencyWhile(async () => {
      try {
        await init(env);
        const { results } = await env.DB.prepare("SELECT mid, username, fee FROM tourney_entry WHERE status='held' LIMIT 500").all();
        if (results.length) {
          await env.DB.batch(results.flatMap(e => [
            env.DB.prepare('UPDATE users SET balance=balance+? WHERE username=?').bind(e.fee, e.username),
            env.DB.prepare("DELETE FROM tourney_entry WHERE mid=? AND username=? AND status='held'").bind(e.mid, e.username),
          ]));
        }
      } catch (e) { console.error('recover', e); }
    });
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { this.drop(ws); } }
  broadcast(obj, except) {
    const wire = JSON.stringify(obj);
    for (const ws of this.peers.keys()) { if (ws === except) continue; try { ws.send(wire); } catch { this.drop(ws); } }
  }
  online() { return this.peers.size; }
  drop(ws) {
    if (!this.peers.has(ws)) return;
    this.leaveRoom(ws, true);
    this.tLeave(ws);
    this.peers.delete(ws);
    this.broadcast({ type: 'online', n: this.online() });
  }
  newMid() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
  makeRoom(code, host, mode, fee, dur) {
    return { code, host, members: new Set(), mode, fee, dur, phase: 'lobby', mid: this.newMid(),
      entrants: new Map(), scores: new Map(), startAt: 0, endAt: 0, emptyAt: 0, settled: false, results: null };
  }
  zero() { return { pts: 0, catches: 0, epic: 0, legend: 0 }; }
  // papan poin per individu, urut dari poin tertinggi
  board(r) {
    return [...r.scores].map(([u, s]) => ({ u, ...s }))
      .sort((a, b) => b.pts - a.pts || b.legend - a.legend || b.epic - a.epic || a.u.localeCompare(b.u));
  }
  roomView(r) {
    const now = Date.now();
    return {
      code: r.code, host: r.host, mode: r.mode, fee: r.fee, dur: r.dur, phase: r.phase, lbl: r.lbl || '',
      pool: r.fee * r.entrants.size, pct: PRIZE_PCT,
      left: r.phase === 'countdown' ? Math.max(0, r.startAt - now) : r.phase === 'running' ? Math.max(0, r.endAt - now) : 0,
      board: this.board(r), results: r.phase === 'ended' ? r.results : null,
      members: [...r.members].map(w => { const p = this.peers.get(w); return { u: p.user, st: p.st, last: p.lastCatch || null }; }),
    };
  }
  pushRoom(r) { const v = { type: 'room', room: this.roomView(r) }; for (const w of r.members) this.send(w, v); }
  toRoom(r, obj, except) { for (const w of r.members) if (w !== except) this.send(w, obj); }
  wallet(user) { for (const [w, q] of this.peers) if (q.user === user) this.send(w, { type: 'wallet' }); }
  newCode() {
    for (let t = 0; t < 50; t++) {
      const b = crypto.getRandomValues(new Uint8Array(4));
      const c = [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join('');
      if (!this.rooms.has(c)) return c;
    }
    return '';
  }
  // ---- uang turnamen (semua lewat D1, atomik) ----
  async charge(user, fee, mid) {
    const D = this.env.DB;
    try {
      const res = await D.batch([
        D.prepare("INSERT INTO tourney_entry(mid,username,fee,status,at) SELECT ?,?,?,'held',? FROM users WHERE username=? AND balance>=?").bind(mid, user, fee, Date.now(), user, fee),
        D.prepare("UPDATE users SET balance=balance-? WHERE username=? AND balance>=? AND EXISTS(SELECT 1 FROM tourney_entry WHERE mid=? AND username=? AND status='held')").bind(fee, user, fee, mid, user),
      ]);
      return res[0].meta.changes === 1 && res[1].meta.changes === 1;
    } catch (e) { console.error('charge', e); return false; }
  }
  async refund(mid, user) {
    const D = this.env.DB;
    try {
      await D.batch([
        D.prepare("UPDATE users SET balance=balance+(SELECT fee FROM tourney_entry WHERE mid=? AND username=? AND status='held') WHERE username=? AND EXISTS(SELECT 1 FROM tourney_entry WHERE mid=? AND username=? AND status='held')").bind(mid, user, user, mid, user),
        D.prepare("DELETE FROM tourney_entry WHERE mid=? AND username=? AND status='held'").bind(mid, user),
      ]);
    } catch (e) { console.error('refund', e); }
    this.wallet(user);
  }
  async finish(r) {
    if (r.settled) return;
    if (r.tm && !r.tm.ot) { // duel seri: babak tambahan 60 detik
      const v = [...r.scores.values()];
      if (v.length === 2 && v[0].pts === v[1].pts) { r.tm.ot = true; r.endAt = Date.now() + 60000; r.emptyAt = 0; r.settled = false; this.toRoom(r, { type: 'room_event', kind: 'ot' }); this.pushRoom(r); return; }
    }
    r.settled = true; r.phase = 'ended';
    const D = this.env.DB, now = Date.now();
    const list = this.board(r).map(b => ({ ...b, place: 0, prize: 0 }));
    list.forEach(b => { b.place = 1 + list.filter(x => x.pts > b.pts).length; });
    const top = list.length ? list[0].pts : 0;
    const paying = r.fee > 0, entrants = [...r.entrants.keys()];
    const pool = r.fee * entrants.length;
    const refunded = paying && top <= 0; // tidak ada yang dapat poin: semua biaya dikembalikan
    if (paying && !refunded) {
      const win = list.filter(b => b.place === 1);
      const each = Math.floor(Math.floor(pool * PRIZE_PCT / 100) / win.length); // seri = hadiah dibagi rata
      win.forEach(b => { b.prize = each; });
    }
    const stmts = [];
    if (paying) {
      if (refunded) entrants.forEach(u => stmts.push(D.prepare('UPDATE users SET balance=balance+? WHERE username=?').bind(r.fee, u)));
      else list.forEach(b => { if (b.prize > 0) stmts.push(D.prepare('UPDATE users SET balance=balance+? WHERE username=?').bind(b.prize, b.u)); });
      stmts.push(D.prepare("UPDATE tourney_entry SET status=? WHERE mid=? AND status='held'").bind(refunded ? 'refunded' : 'done', r.mid));
    }
    const global = r.mode === 'tourney' && top > 0;
    if (global) list.forEach(b => stmts.push(D.prepare('INSERT INTO tourney_log(mid,code,username,pts,catches,epic,legend,place,prize,fee,at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind(r.mid, r.code, b.u, b.pts, b.catches, b.epic, b.legend, b.place, b.prize, r.fee, now)));
    let saved = true;
    if (stmts.length) { try { await D.batch(stmts); } catch (e) { console.error('finish', e); saved = false; } }
    r.results = { mode: r.mode, fee: r.fee, pool, pct: PRIZE_PCT, refunded, list, global, saved };
    this.toRoom(r, { type: 'room_event', kind: 'end', results: r.results });
    this.pushRoom(r);
    entrants.forEach(u => this.wallet(u));
    if (r.tm) this.tMatchDone(r);
    if (!r.members.size) this.rooms.delete(r.code);
  }
  // ---- jalannya pertandingan ----
  ensureTick() { if (!this.tickT) this.tickT = setInterval(() => this.tick(), 1000); }
  tick() {
    const now = Date.now(); let live = false;
    for (const r of [...this.rooms.values()]) {
      if (r.phase === 'countdown') {
        live = true;
        if (now >= r.startAt) { r.phase = 'running'; this.toRoom(r, { type: 'room_event', kind: 'go' }); this.pushRoom(r); }
      }
      if (r.phase === 'running') {
        live = true;
        if (now >= r.endAt) this.finish(r).catch(e => console.error(e));
      }
      if ((r.phase === 'countdown' || r.phase === 'running') && r.emptyAt && now - r.emptyAt > EMPTY_GRACE_MS) this.finish(r).catch(e => console.error(e));
    }
    if (this.TS.size && this.tourTick(now)) live = true;
    if (!live) { clearInterval(this.tickT); this.tickT = null; }
  }
  startMatch(ws) {
    const p = this.peers.get(ws), r = p && p.room && this.rooms.get(p.room);
    const bad = m => this.send(ws, { type: 'error', message: m });
    if (!r) return bad('Kamu belum di dalam room.');
    if (r.tm) return bad('Duel playoff dimulai otomatis.');
    if (r.host !== p.user) return bad('Hanya host yang bisa memulai.');
    if (!(r.phase === 'lobby' || (r.phase === 'ended' && r.fee === 0))) return bad('Pertandingan sudah berjalan atau selesai. Buat room baru untuk ronde berikutnya.');
    if (r.members.size < 2) return bad('Butuh minimal 2 pemain untuk mulai.');
    if (r.phase === 'ended') { // ronde ulang (khusus room gratis)
      r.scores.clear(); r.entrants.clear();
      for (const w of r.members) { const u = this.peers.get(w).user; r.scores.set(u, this.zero()); r.entrants.set(u, true); }
      r.settled = false; r.results = null; r.mid = this.newMid();
    }
    r.phase = 'countdown'; r.startAt = Date.now() + COUNTDOWN_MS; r.endAt = r.startAt + r.dur * 1000; r.emptyAt = 0;
    this.toRoom(r, { type: 'room_event', kind: 'start', by: p.user });
    this.pushRoom(r); this.ensureTick();
  }
  // ---- room ----
  async joinRoom(ws, m) {
    const p = this.peers.get(ws); if (!p) return;
    const bad = t => this.send(ws, { type: 'error', message: t });
    const code = String(m.code || '').toUpperCase().trim();
    if (!CODE_RE.test(code)) return bad('Kode room harus 4 huruf/angka.');
    if (p.room === code && this.rooms.get(code)) return this.pushRoom(this.rooms.get(code));
    let r = this.rooms.get(code);
    if (!r) {
      if (m.resume) { r = this.makeRoom(code, p.user, 'casual', 0, 600); this.rooms.set(code, r); } // sambung ulang room gratis setelah server restart
      else { if (m.rejoin) this.send(ws, { type: 'room', room: null }); return bad('Room ' + code + ' tidak ditemukan atau sudah selesai.'); }
    }
    const known = r.entrants.has(p.user); // sudah terdaftar di pertandingan ini (sambung ulang): tidak bayar lagi
    if (!known && r.members.size >= ROOM_MAX) return bad('Room penuh (maks ' + ROOM_MAX + ' pemain).');
    if (!known && r.fee > 0) {
      if (r.phase === 'ended') return bad('Pertandingan di room ini sudah selesai.');
      if (r.phase !== 'lobby') return bad('Pertandingan sudah dimulai, pendaftaran ditutup.');
      if (Number(m.fee) !== r.fee) // minta persetujuan biaya dulu
        return this.send(ws, { type: 'join_need', code, mode: r.mode, fee: r.fee, dur: r.dur, pct: PRIZE_PCT, host: r.host, n: r.members.size });
      if (!(await this.charge(p.user, r.fee, r.mid))) return bad('Saldo tidak cukup untuk biaya pendaftaran. Pastikan koinmu sudah tersinkron ke server.');
      // keadaan bisa berubah selama menunggu pembayaran
      const cur = this.rooms.get(code);
      if (!this.peers.has(ws) || cur !== r || r.phase !== 'lobby' || r.members.size >= ROOM_MAX) {
        await this.refund(r.mid, p.user);
        return bad('Room berubah saat mendaftar, biaya dikembalikan. Coba lagi.');
      }
    }
    this.leaveRoom(ws, false);
    r.members.add(ws); p.room = code; r.emptyAt = 0;
    r.entrants.set(p.user, true);
    if (!r.scores.has(p.user)) r.scores.set(p.user, this.zero());
    this.toRoom(r, { type: 'room_event', kind: 'join', user: p.user }, ws);
    this.pushRoom(r);
  }
  async createRoom(ws, m) {
    const p = this.peers.get(ws); if (!p) return;
    const bad = t => this.send(ws, { type: 'error', message: t });
    const mode = m.mode === 'tourney' ? 'tourney' : 'casual';
    const dur = MATCH_DURS.has(Number(m.dur)) ? Number(m.dur) : 600;
    const fee = Math.trunc(Number(m.fee) || 0);
    if (!(fee >= 0 && fee <= MAX_FEE)) return bad('Biaya pendaftaran tidak valid.');
    if (fee > 0 && fee < MIN_FEE) return bad('Biaya pendaftaran minimal 100M koin (atau 0 untuk gratis).');
    if (mode === 'tourney' && fee < MIN_FEE) return bad('Turnamen wajib biaya pendaftaran minimal 100M koin.');
    const code = this.newCode();
    if (!code) return bad('Gagal membuat room, coba lagi.');
    const r = this.makeRoom(code, p.user, mode, fee, dur);
    this.rooms.set(code, r); // pesan kode sementara agar tidak dipakai room lain selama membayar
    if (fee > 0 && !(await this.charge(p.user, fee, r.mid))) {
      this.rooms.delete(code);
      return bad('Saldo tidak cukup untuk biaya pendaftaran. Pastikan koinmu sudah tersinkron ke server.');
    }
    if (!this.peers.has(ws)) { this.rooms.delete(code); if (fee > 0) await this.refund(r.mid, p.user); return; }
    this.leaveRoom(ws, false);
    r.members.add(ws); p.room = code;
    r.entrants.set(p.user, true); r.scores.set(p.user, this.zero());
    this.pushRoom(r);
    if (fee > 0) this.wallet(p.user);
  }
  leaveRoom(ws, silent) {
    const p = this.peers.get(ws);
    if (!p || !p.room) return;
    const r = this.rooms.get(p.room); p.room = '';
    if (!r) return;
    r.members.delete(ws);
    if (!silent) this.send(ws, { type: 'room', room: null });
    // keluar sebelum mulai = pendaftaran dibatalkan dan biaya dikembalikan. Setelah mulai, poin tetap tercatat (bisa sambung ulang).
    if (r.phase === 'lobby' && r.entrants.has(p.user)) {
      r.entrants.delete(p.user); r.scores.delete(p.user);
      if (r.fee > 0) this.refund(r.mid, p.user).catch(e => console.error(e));
    }
    if (!r.members.size) {
      if (r.phase === 'countdown' || r.phase === 'running') r.emptyAt = Date.now(); // masa tenggang sambung ulang
      else this.rooms.delete(r.code);
      return;
    }
    if (r.host === p.user) r.host = this.peers.get([...r.members][0]).user;
    this.toRoom(r, { type: 'room_event', kind: 'leave', user: p.user });
    this.pushRoom(r);
  }
  // ---- TURNAMEN PLAYOFF (global, tanpa room): pilih biaya + jumlah pemain, otomatis mulai saat penuh ----
  tEnsure() { // selalu ada satu turnamen terbuka per kombinasi; yang sudah penuh/mulai otomatis diganti baru
    for (const fee of TOUR_FEES) for (const size of TOUR_SIZES) {
      if ([...this.TS.values()].some(x => x.phase === 'reg' && x.fee === fee && x.size === size)) continue;
      const id = this.newMid(); this.TS.set(id, { id, phase: 'reg', dur: TOUR_DUR, fee, size, players: new Set(), rounds: [], champ: '', doneAt: 0, pts: {}, prize: null });
    }
  }
  tList() { this.tEnsure(); return [...this.TS.values()].map(T => this.tView(T)); }
  tView(T) {
    return { id: T.id, phase: T.phase, fee: T.fee, size: T.size, dur: T.dur, champ: T.champ, players: [...T.players], pool: T.fee * T.players.size, prize: T.prize,
      rounds: T.rounds.map(rd => rd.map(m => ({ a: m.a, b: m.b, w: m.w, sa: m.sa, sb: m.sb, live: !!m.code && !m.w }))) };
  }
  tPush() { this.broadcast({ type: 'tour', list: this.tList() }); }
  tOf(user) { for (const T of this.TS.values()) if (T.phase !== 'done' && T.players.has(user)) return T; return null; }
  async tJoin(ws, m) {
    const p = this.peers.get(ws); if (!p) return;
    const bad = t => this.send(ws, { type: 'error', message: t });
    const fee = Math.trunc(Number(m.fee) || 0), size = Math.trunc(Number(m.size) || 0);
    if (!TOUR_FEES.includes(fee) || !TOUR_SIZES.includes(size)) return bad('Pilihan turnamen tidak valid.');
    if (this.tOf(p.user)) return bad('Kamu sudah terdaftar di sebuah turnamen.');
    let T = [...this.TS.values()].find(x => x.phase === 'reg' && x.fee === fee && x.size === size);
    if (!T) { const id = this.newMid(); T = { id, phase: 'reg', dur: TOUR_DUR, fee, size, players: new Set(), rounds: [], champ: '', doneAt: 0, pts: {}, prize: null }; this.TS.set(id, T); }
    const gone = () => {};
    if (fee > 0) {
      if (!(await this.charge(p.user, fee, T.id))) { gone(); return bad('Saldo tidak cukup untuk biaya pendaftaran. Pastikan koinmu sudah tersinkron ke server.'); }
      if (T.phase !== 'reg' || T.players.size >= size || !this.peers.has(ws) || this.tOf(p.user)) { await this.refund(T.id, p.user); gone(); return bad('Turnamen berubah saat mendaftar, biaya dikembalikan. Coba lagi.'); }
      this.wallet(p.user);
    }
    T.players.add(p.user);
    if (T.players.size >= size) this.tBegin(T); // penuh = langsung mulai
    this.tPush(); this.ensureTick();
  }
  tLeave(ws) {
    const p = this.peers.get(ws), T = p && this.tOf(p.user);
    if (!T || T.phase !== 'reg') return;
    T.players.delete(p.user);
    if (T.fee > 0) this.refund(T.id, p.user).catch(e => console.error(e));
    this.tPush();
  }
  tMatch(a, b) { return { a, b, w: '', sa: 0, sb: 0, code: '', readyAt: Date.now() + 6000 }; }
  tBegin(T) {
    const arr = [...T.players];
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    let size = 2; while (size < arr.length) size *= 2;
    const half = size / 2, r1 = [];
    for (let j = 0; j < half; j++) r1.push(this.tMatch(arr[j], arr[j + half] || null)); // slot kosong = bye
    T.rounds = [r1];
    for (let n = half / 2; n >= 1; n /= 2) T.rounds.push(Array.from({ length: n }, () => this.tMatch(null, null)));
    T.phase = 'run';
    r1.forEach((m, j) => { if (!m.b) this.tWin(T, 0, j, m.a, 0, 0); });
  }
  tWin(T, i, j, w, sa, sb) {
    const m = T.rounds[i][j]; m.w = w; m.sa = sa; m.sb = sb;
    if (i === T.rounds.length - 1) { T.champ = w; T.phase = 'done'; T.doneAt = Date.now(); this.tFinish(T).catch(e => console.error(e)); return; }
    const nx = T.rounds[i + 1][j >> 1]; if (j % 2 === 0) nx.a = w; else nx.b = w;
    nx.readyAt = Date.now() + 8000;
  }
  tOpen(T, i, j) {
    const m = T.rounds[i][j], find = u => [...this.peers].find(([, p]) => p.user === u);
    const A = find(m.a), B = find(m.b);
    if (!A || !B) { // WO: yang offline kalah
      m.code = '-'; this.tWin(T, i, j, A ? m.a : B ? m.b : (Math.random() < 0.5 ? m.a : m.b), 0, 0); this.tPush(); return;
    }
    const code = this.newCode(); if (!code) return;
    const r = this.makeRoom(code, m.a, 'duel', 0, T.dur); r.tm = { id: T.id, i, j }; this.rooms.set(code, r);
    const nr = T.rounds.length; r.lbl = i === nr - 1 ? 'FINAL' : i === nr - 2 ? 'SEMIFINAL' : 'BABAK ' + (i + 1);
    for (const [ws, p] of [A, B]) { this.leaveRoom(ws, false); r.members.add(ws); p.room = code; r.entrants.set(p.user, true); r.scores.set(p.user, this.zero()); }
    m.code = code; r.phase = 'countdown'; r.startAt = Date.now() + PREP_MS; r.endAt = r.startAt + r.dur * 1000;
    this.toRoom(r, { type: 'room_event', kind: 'start', by: 'turnamen' });
    this.pushRoom(r); this.tPush();
  }
  tMatchDone(r) {
    const T = r.tm && this.TS.get(r.tm.id); if (!T) return;
    const { i, j } = r.tm, m = T.rounds[i][j]; if (m.w) return;
    const za = r.scores.get(m.a) || this.zero(), zb = r.scores.get(m.b) || this.zero();
    const key = z => z.pts * 1e6 + z.legend * 1e3 + z.epic * 10 + z.catches; // seri: legendaris > epik > jumlah ikan > undian
    const ka = key(za), kb = key(zb);
    T.pts[m.a] = (T.pts[m.a] || 0) + za.pts; T.pts[m.b] = (T.pts[m.b] || 0) + zb.pts;
    this.tWin(T, i, j, ka > kb ? m.a : kb > ka ? m.b : (Math.random() < 0.5 ? m.a : m.b), za.pts, zb.pts);
    this.tPush();
    setTimeout(() => { for (const ws of [...r.members]) this.leaveRoom(ws, false); }, 6000);
  }
  async tFinish(T) { // hadiah: juara 50% dari total biaya, runner-up 20%; semua peserta masuk papan peringkat global
    const D = this.env.DB, now = Date.now(), fin = T.rounds[T.rounds.length - 1][0];
    const ru = fin.a === T.champ ? fin.b : fin.a, pool = T.fee * T.players.size, prize = {};
    if (T.fee > 0) { prize[T.champ] = Math.floor(pool * PRIZE_PCT / 100); if (ru) prize[ru] = Math.floor(pool * 20 / 100); }
    const st = Object.entries(prize).map(([u, v]) => D.prepare('UPDATE users SET balance=balance+? WHERE username=?').bind(v, u));
    if (T.fee > 0) st.push(D.prepare("UPDATE tourney_entry SET status='done' WHERE mid=? AND status='held'").bind(T.id));
    for (const u of T.players) st.push(D.prepare('INSERT INTO tourney_log(mid,code,username,pts,catches,epic,legend,place,prize,fee,at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind(T.id, 'TURN', u, T.pts[u] || 0, 0, 0, 0, u === T.champ ? 1 : u === ru ? 2 : 3, prize[u] || 0, T.fee, now));
    try { await D.batch(st); } catch (e) { console.error('tfinish', e); }
    T.prize = prize; this.tPush(); for (const u of T.players) this.wallet(u);
  }
  tourTick(now) {
    let busy = false;
    for (const T of [...this.TS.values()]) {
      if (T.phase === 'reg') continue;
      busy = true;
      if (T.phase === 'done') { if (now - T.doneAt > 90000) { this.TS.delete(T.id); this.tPush(); } continue; }
      T.rounds.forEach((rd, i) => rd.forEach((m, j) => { if (!m.w && !m.code && m.a && m.b && now >= m.readyAt) this.tOpen(T, i, j); }));
    }
    return busy;
  }
  async fetch(request) {
    const user = request.headers.get('x-mancing-user') || '';
    if (!user) return new Response('Unauthorized', { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    // satu koneksi per akun: tab lama ditutup
    for (const [w, p] of this.peers) if (p.user === user) { try { w.close(4000, 'replaced'); } catch {} this.drop(w); }
    this.peers.set(server, { user, room: '', st: 'lobi', tokens: 20, tAt: Date.now(), lastCatch: null, lastGlobal: 0 });
    this.send(server, { type: 'hello', user, online: this.online() });
    this.send(server, { type: 'tour', list: this.tList() });
    this.broadcast({ type: 'online', n: this.online() }, server);
    server.addEventListener('close', () => this.drop(server));
    server.addEventListener('error', () => this.drop(server));
    server.addEventListener('message', ev => { this.onMessage(server, ev).catch(e => console.error(e)); });
    return new Response(null, { status: 101, webSocket: client });
  }
  async onMessage(ws, ev) {
    const p = this.peers.get(ws); if (!p) return;
    if (typeof ev.data !== 'string' || ev.data.length > 6000) return; // 'rtc' (SDP suara) butuh ruang lebih besar; pesan lain dibatasi 1500 di bawah
    const now = Date.now();
    // 'view' = status pancingan realtime untuk split-screen mabar; batas laju sendiri (maks ~11/detik), tidak memakan jatah pesan lain
    if (ev.data.length < 480 && ev.data.startsWith('{"type":"view"')) {
      if (now - (p.vAt || 0) < 85) return; p.vAt = now;
      const r = p.room && this.rooms.get(p.room); if (!r || r.members.size < 2) return;
      let q; try { q = JSON.parse(ev.data); } catch { return; }
      const n = (v, a, b) => Math.max(a, Math.min(b, Math.round((Number(v) || 0) * 1000) / 1000));
      const s = cap(q.s, 12).toLowerCase();
      const v = { s: /^[a-z]{1,12}$/.test(s) ? s : 'idle', x: n(q.x, -1, 1), d: n(q.d, 0, 1), fi: n(q.fi, 0, 1), zo: n(q.zo, 0, 1), sz: n(q.sz, 0, 1), pr: n(q.pr, 0, 1), te: n(q.te, 0, 1), pw: n(q.pw, 0, 1), p: q.p ? 1 : 0, fn: cap(q.fn, 40), fr: RAR_OK.has(q.fr) || q.fr === 'common' ? q.fr : '', fk: /^[a-z0-9_]{1,32}$/.test(String(q.fk || '')) ? q.fk : '', rd: /^[a-z0-9_]{1,24}$/.test(String(q.rd || '')) ? q.rd : '' };
      this.toRoom(r, { type: 'view', u: p.user, v }, ws);
      return;
    }
    // 'rtc' = sinyal penyambungan mic (WebRTC) antar anggota room. Suara TIDAK lewat server, hanya SDP/ICE.
    if (ev.data.startsWith('{"type":"rtc"')) {
      p.rtcTok = Math.min(80, (p.rtcTok ?? 80) + (now - (p.rtcAt || now)) * 0.03); p.rtcAt = now;
      if (p.rtcTok < 1) return; p.rtcTok -= 1;
      const r = p.room && this.rooms.get(p.room); if (!r || r.members.size < 2) return;
      let q; try { q = JSON.parse(ev.data); } catch { return; }
      const to = cap(q.to, 20).toLowerCase();
      const target = [...r.members].find(w => w !== ws && this.peers.get(w) && this.peers.get(w).user === to);
      if (!target) return;
      const k = String(q.k || '');
      if (!['o', 'a', 'c', 'x'].includes(k)) return;
      const out = { type: 'rtc', from: p.user, k, r: q.r === 'i' ? 'i' : 'o' };
      if (k === 'o' || k === 'a') { const sdp = typeof q.sdp === 'string' ? q.sdp : ''; if (!sdp || sdp.length > 5000) return; out.sdp = sdp; }
      if (k === 'c') {
        const c = q.c; if (!c || typeof c.candidate !== 'string' || c.candidate.length > 400) return;
        out.c = { candidate: c.candidate, sdpMid: c.sdpMid == null ? null : cap(c.sdpMid, 16), sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : 0 };
      }
      this.send(target, out);
      return;
    }
    if (ev.data.length > 1500) return;
    // batas laju pesan per koneksi: 20 pesan burst, isi ulang 8/detik
    p.tokens = Math.min(20, p.tokens + (now - p.tAt) / 125); p.tAt = now;
    if (p.tokens < 1) return; p.tokens -= 1;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'ping': return this.send(ws, { type: 'pong' });
      case 'room_create': return this.createRoom(ws, m);
      case 'room_join': return this.joinRoom(ws, m);
      case 'room_start': return this.startMatch(ws);
      case 't_join': return this.tJoin(ws, m);
      case 't_leave': return this.tLeave(ws);
      case 'room_leave': return this.leaveRoom(ws, false);
      case 'status': {
        const st = cap(m.st, 12).toLowerCase();
        if (!/^[a-z]{1,12}$/.test(st) || st === p.st) return;
        p.st = st;
        const r = p.room && this.rooms.get(p.room);
        if (r) this.toRoom(r, { type: 'room_status', user: p.user, st });
        return;
      }
      case 'emote': {
        const r = p.room && this.rooms.get(p.room);
        if (r && EMOTES.has(m.e) && now - (p.lastEmote || 0) > 1200) { p.lastEmote = now; this.toRoom(r, { type: 'room_event', kind: 'emote', user: p.user, e: m.e }); }
        return;
      }
      case 'chat': {
        const r = p.room && this.rooms.get(p.room), t = cap(m.t, 120);
        if (r && t && now - (p.lastChat || 0) > 700) { p.lastChat = now; this.toRoom(r, { type: 'room_event', kind: 'chat', user: p.user, t }, ws); }
        return;
      }
      case 'invite': {
        const to = cap(m.to, 20).toLowerCase(), r = p.room && this.rooms.get(p.room);
        if (!r) return this.send(ws, { type: 'error', message: 'Buat atau masuk room dulu.' });
        if (!USER_RE.test(to) || to === p.user) return this.send(ws, { type: 'error', message: 'Username tidak valid.' });
        const fr = await this.env.DB.prepare("SELECT 1 FROM friends WHERE status='accepted' AND ((requester=? AND target=?) OR (requester=? AND target=?))").bind(p.user, to, to, p.user).first();
        if (!fr) return this.send(ws, { type: 'error', message: 'Hanya bisa mengundang teman.' });
        const target = [...this.peers].find(([, q]) => q.user === to);
        if (!target) return this.send(ws, { type: 'error', message: '@' + to + ' sedang tidak online.' });
        this.send(target[0], { type: 'invite', from: p.user, code: r.code, mode: r.mode, fee: r.fee });
        return this.send(ws, { type: 'notice', message: 'Undangan terkirim ke @' + to });
      }
      case 'catch': {
        const rar = String(m.rar || '');
        if (!RAR_OK.has(rar)) return;
        if (now - p.lastGlobal < 6000) return; // satu pemain tidak mungkin dapat ikan langka tiap <6 dtk
        p.lastGlobal = now;
        const fish = { id: cap(m.id, 40), name: cap(m.name, 48) || 'Ikan misterius', rar, w: Math.max(0, Math.min(1e6, Number(m.w) || 0)), shiny: m.shiny ? 1 : 0, mut: cap(m.mut, 12) };
        p.lastCatch = { name: fish.name, rar };
        const r = p.room && this.rooms.get(p.room);
        if (r) {
          // poin per individu, hanya dihitung saat pertandingan berjalan
          const sc = r.phase === 'running' && now <= r.endAt + 1500 ? r.scores.get(p.user) : null;
          const pts = sc ? RAR_PTS[rar] * (fish.shiny ? 2 : 1) : 0;
          if (sc) { sc.pts += pts; sc.catches++; if (rar === 'epic') sc.epic++; if (rar === 'legend') sc.legend++; }
          this.toRoom(r, { type: 'room_event', kind: 'catch', user: p.user, fish, pts });
          if (sc) this.pushRoom(r);
        }
        if (rar === 'epic' || rar === 'legend') {
          // pagar global: maks 40 pengumuman per menit untuk seluruh server
          if (now - this.globalWin.at > 60000) this.globalWin = { at: now, n: 0 };
          if (this.globalWin.n++ >= 40) return;
          this.broadcast({ type: 'global_catch', user: p.user, fish, at: now });
        }
        return;
      }
    }
  }
}