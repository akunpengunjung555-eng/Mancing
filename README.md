# Mancing — Cloudflare Worker deployment

## Files
- `public/index.html`: Mancing game UI with Live Global panel connected to the Worker WebSocket.
- `worker.js`: Worker routes `/ws` and `/health`, serves static assets, and coordinates purchases through a Durable Object.
- `wrangler.toml`: Worker name stays `mancing`; static assets and Durable Object binding are configured.

## Deploy from this repository
This repository uses Wrangler configuration. The safest deployment path is from the repository root with Wrangler:
1. `npm install -g wrangler` (if needed)
2. `wrangler login`
3. `wrangler deploy`
4. Open `https://<your-worker-domain>/health` and verify JSON with `ok: true`.
5. Open the Worker URL and test the Live Global panel in two browser sessions.

If deploying through the Cloudflare dashboard Git integration, use Worker project name `mancing`, leave Build command empty, and use `npx wrangler deploy` as the deploy command. Ensure the build system runs at the repository root so it reads `wrangler.toml`.

## Prototype limitations
- Each new viewer ID starts with 1,000 server-side demo coins. Viewer IDs are browser-generated for this prototype, not authenticated platform identities.
- Global catches broadcast to connected clients. This does not automatically trigger overlays or animations elsewhere in the main game.
- TikTok LIVE, YouTube Live, and Facebook Live event adapters are **not connected**. Do not represent this as a production-ready platform integration.
- Add authenticated event adapters, moderation/authentication, origin validation, rate limits, deduplication, and abuse protections before public production use.
