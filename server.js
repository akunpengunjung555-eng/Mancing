import http from 'node:http';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';
import { LiveChat } from 'youtube-chat';

const PORT = Number(process.env.PORT || 8788);
const TOKEN = String(process.env.CONNECTOR_TOKEN || '').trim();
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'mancing-live-connector', websocket: '/ws', tokenProtected: Boolean(TOKEN) }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const sessions = new Map();
const send = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
const emit = (ws, data) => send(ws, { type: 'event', data: { at: Date.now(), ...data } });
function closeSession(ws) {
  const s = sessions.get(ws); if (!s) return;
  try { s.tiktok?.disconnect(); } catch {}
  try { s.youtube?.stop(); } catch {}
  sessions.delete(ws);
}
function getYoutubeId(input) {
  if (!input) return null;
  const text = input.trim();
  try {
    const u = new URL(text);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || null;
    return u.searchParams.get('v') || u.pathname.match(/\/(?:live|embed|shorts)\/([^/?]+)/)?.[1] || null;
  } catch { return /^[\w-]{11}$/.test(text) ? text : null; }
}
function clean(v, max = 500) { return String(v ?? '').trim().slice(0, max); }
server.on('upgrade', (req, socket, head) => {
  let url; try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  const token = url.searchParams.get('token') || req.headers['x-connector-token'] || '';
  if (TOKEN && token !== TOKEN) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  send(ws, { type: 'status', message: 'Connector Node.js aktif. Masukkan akun LIVE dari panel game.' });
  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Format pesan tidak valid.' }); }
    if (msg.type === 'disconnect') { closeSession(ws); return send(ws, { type: 'status', message: 'Sesi LIVE diputus.' }); }
    if (msg.type === 'test') return emit(ws, { platform: 'TEST', kind: 'comment', username: 'tester', text: 'Tes dari connector' });
    if (msg.type !== 'configure') return;
    closeSession(ws);
    const session = { tiktok: null, youtube: null }; sessions.set(ws, session);
    const tt = clean(msg.tiktokUsername, 80).replace(/^@/, '').replace(/[^\w.]/g, '');
    const yt = getYoutubeId(clean(msg.youtubeLive, 300));
    const statuses = [];
    if (tt) {
      try {
        const conn = new TikTokLiveConnection(tt, {}); session.tiktok = conn;
        const ttUser = d => String(d?.user?.uniqueId || d?.user?.displayId || d?.user?.nickname || d?.uniqueId || d?.nickname || d?.user?.id || 'viewer');
        const ttGift = d => String(d?.gift?.name || d?.gift?.giftName || d?.giftDetails?.giftName || d?.giftName || d?.giftId || 'gift');
        conn.on(WebcastEvent.CHAT, d => emit(ws, { platform: 'TikTok', kind: 'comment', username: ttUser(d), text: clean(d?.content ?? d?.comment ?? '', 500) }));
        conn.on(WebcastEvent.GIFT, d => emit(ws, { platform: 'TikTok', kind: 'gift', username: ttUser(d), giftName: ttGift(d), count: Number(d?.repeatCount) || 1 }));
        conn.on(WebcastEvent.LIKE, d => emit(ws, { platform: 'TikTok', kind: 'like', username: ttUser(d), count: Number(d?.count ?? d?.likeCount) || 1 }));
        await conn.connect(); statuses.push(`TikTok tersambung: @${tt}`);
      } catch (e) { try { session.tiktok?.disconnect(); } catch {} session.tiktok = null; send(ws, { type: 'error', message: `TikTok @${tt}: ${clean(e?.message || e, 300)}` }); }
    } else statuses.push('TikTok belum diisi.');
    if (yt) {
      try {
        const chat = new LiveChat({ liveId: yt }); session.youtube = chat;
        chat.on('chat', item => emit(ws, { platform: 'YouTube', kind: 'comment', username: item.author?.name || item.authorName || 'viewer', text: Array.isArray(item.message) ? item.message.map(x => x.text || '').join('') : clean(item.message, 1000) }));
        chat.on('error', e => send(ws, { type: 'error', message: `YouTube: ${clean(e?.message || e, 300)}` }));
        const started = await chat.start();
        if (started === false) throw new Error('Tidak bisa membaca live chat. Pastikan siaran sedang LIVE dan ID/URL benar.');
        statuses.push(`YouTube live chat tersambung: ${yt}`);
      } catch (e) { try { session.youtube?.stop(); } catch {} session.youtube = null; send(ws, { type: 'error', message: `YouTube: ${clean(e?.message || e, 300)}` }); }
    } else if (clean(msg.youtubeLive)) statuses.push('YouTube: URL/ID live tidak valid.');
    else statuses.push('YouTube belum diisi.');
    send(ws, { type: 'status', message: statuses.join(' | ') });
  });
  ws.on('close', () => closeSession(ws)); ws.on('error', () => closeSession(ws));
});
server.listen(PORT, '0.0.0.0', () => console.log(`Mancing LIVE connector listening on :${PORT}; websocket /ws`));
process.on('SIGTERM', () => { for (const ws of sessions.keys()) closeSession(ws); wss.close(); server.close(() => process.exit(0)); });
