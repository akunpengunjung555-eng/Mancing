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
  ]);
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
      env.DB.prepare('DELETE FROM users WHERE username=?').bind(name),
    ]);
    return J({ ok: true });
  }
  return err(404, 'Not found');
}

async function fish(env, req, u, path) {
  if (path === '/fish/load') return J({ ok: true, balance: u.balance, state: JSON.parse(u.state || '{}') });
  if (path === '/fish/sync') {
    const b = await readJson(req);
    let d = Math.trunc(Number(b.d) || 0), capped = false;
    if (!Number.isFinite(d)) return err(400, 'Data tidak valid.');
    const stateStr = JSON.stringify(b.state && typeof b.state === 'object' ? b.state : {});
    if (stateStr.length > 60000) return err(413, 'Data terlalu besar.');
    let winStart = u.win_start, winAmt = u.win_amt;
    if (d > 0 && u.role !== 'admin') {
      const now = Date.now(), maxMin = Number(env.MAX_GAIN_PER_MIN) || 2e11;
      if (now - winStart > 60000) { winStart = now; winAmt = 0; }
      const allowed = Math.max(0, maxMin - winAmt);
      if (d > allowed) { d = allowed; capped = true; }
      winAmt += d;
    }
    const balance = u.balance + d;
    if (balance < 0) return err(400, 'Saldo tidak cukup.');
    await env.DB.prepare('UPDATE users SET balance=?, state=?, win_start=?, win_amt=? WHERE username=?')
      .bind(balance, stateStr, winStart, winAmt, u.username).run();
    return J({ ok: true, balance, capped });
  }
  return err(404, 'Not found');
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
