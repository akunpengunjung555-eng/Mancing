// Cloudflare Worker for Mancing. Durable Object coordinates the shared room.
const PRICE = Object.freeze({ karang: 10, tuna: 250, hiu: 1500, leviathan: 10000 });
const FISH = Object.freeze({
  karang: { name: 'Ikan Karang', rarity: 'biasa', emoji: '🐟' },
  tuna: { name: 'Tuna Raksasa', rarity: 'besar', emoji: '🐠' },
  hiu: { name: 'Hiu Legendaris', rarity: 'legendaris', emoji: '🦈' },
  leviathan: { name: 'Leviathan Mitos', rarity: 'boss', emoji: '🐉' }
});
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'mancing' });
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      const id = env.GAME_ROOM.idFromName('global-live-room');
      return env.GAME_ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
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
