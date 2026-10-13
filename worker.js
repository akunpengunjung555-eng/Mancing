// Cloudflare Worker + Durable Object starter for the shared live game.
// Prototype only: add platform-specific authenticated event adapters before production.
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
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'mancing-laut-dalam' });
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      const id = env.GAME_ROOM.idFromName('global-live-room');
      return env.GAME_ROOM.get(id).fetch(request);
    }
    return new Response('Mancing Laut Dalam Live API', { status: 200 });
  }
};
export class GameRoom {
  constructor(ctx) { this.ctx = ctx; this.sockets = new Set(); }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept(); this.sockets.add(server);
    server.addEventListener('close', () => this.sockets.delete(server));
    server.addEventListener('error', () => this.sockets.delete(server));
    server.addEventListener('message', async event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== 'purchase' || !PRICE[msg.fishId]) return;
        // Prototype identity only. Production must map authenticated platform IDs to viewers.
        const viewerId = String(msg.viewerId || '').slice(0, 80);
        const viewerName = String(msg.viewerName || 'Penonton').slice(0, 32);
        if (!viewerId) return server.send(JSON.stringify({ type: 'error', message: 'viewerId diperlukan' }));
        const result = await this.ctx.storage.transaction(async tx => {
          const key = `wallet:${viewerId}`;
          const balance = await tx.get(key) ?? 1000;
          const cost = PRICE[msg.fishId];
          if (balance < cost) return { ok: false, balance, cost };
          const next = balance - cost;
          await tx.put(key, next);
          return { ok: true, balance: next, cost };
        });
        if (!result.ok) return server.send(JSON.stringify({ type: 'error', message: 'Koin tidak cukup', balance: result.balance }));
        const eventOut = { type: 'global_catch', viewerId, viewerName, fishId: msg.fishId, fish: FISH[msg.fishId], cost: result.cost, balance: result.balance, at: Date.now() };
        const wire = JSON.stringify(eventOut);
        for (const ws of this.sockets) { try { ws.send(wire); } catch { this.sockets.delete(ws); } }
      } catch { try { server.send(JSON.stringify({ type: 'error', message: 'Pesan tidak valid' })); } catch {} }
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}
