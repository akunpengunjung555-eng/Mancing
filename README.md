# Mancing — Cloudflare Worker deployment

Repository files are kept at the repository root: `index.html`, `worker.js`, `wrangler.toml`, and `README.md`.

## Deploy
1. Upload/replace these files in the `Mancing` GitHub repository (do not touch `Tiger`).
2. In Cloudflare Workers & Pages, project name stays `mancing`.
3. Leave Build command empty and Deploy command as `npx wrangler deploy`.
4. Retry the failed deployment.
5. Test `/health`; it should return JSON containing `ok: true`.

## Prototype limitations
- New viewer IDs start with 1,000 demo coins; viewer IDs are browser-generated, not authenticated platform identities.
- Global catches broadcast to connected clients, but do not automatically trigger overlays/animations in other game areas.
- TikTok LIVE, YouTube Live, and Facebook Live event adapters are not connected.
- Add authentication, origin validation, rate limits, deduplication, and abuse protection before production use.
