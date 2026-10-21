# Mancing — Cloudflare game + LIVE connector 
 
This bundle contains the game and the separately hosted Node.js connector. Cloudflare project name stays `mancing`.

## Contents
- `index.html`: Mancing game with LIVE CONNECT panel inside the game. Auto mode is OFF by default.
- `worker.js`, `wrangler.toml`: Cloudflare Worker and Durable Object for the existing Mancing project. Keep the Worker name `mancing`.
- `connector/`: persistent Node.js service for TikTok LIVE comments/gifts/likes and YouTube LIVE chat comments.
- `render.yaml`: deployment blueprint for the Node.js service (hosted separately from Cloudflare Worker).

## Deploy
1. Commit these files to the existing GitHub repository `Mancing` (do not touch `Tiger`). Deploy the root Cloudflare project as usual; `wrangler.toml` keeps the Worker named `mancing`.
2. Deploy `render.yaml` as a Blueprint/service on a Node.js host that supports persistent WebSockets. It uses `connector/` as the service root. GitHub itself does not run the connector.
3. In the Node service settings, get the generated `CONNECTOR_TOKEN`. Never publish this token in the repository.
4. Check `https://YOUR-NODE-HOST/health` returns `{\"ok\":true,...}`.
5. Open the game → LIVE CONNECT. Enter `wss://YOUR-NODE-HOST/ws`, the service token, TikTok username, and YouTube LIVE video URL/ID. YouTube username alone is not enough to select a live chat.

## Game actions
With Auto mode enabled, incoming comments/gifts/likes call the game's real fishing controls: cast when idle, hook on bite, and reel during fight for selected 5/7/10 seconds. Cooldown limits repeated events. When game is waiting for a bite or a UI sheet is open, actions are skipped. Manual mode remains default.

## Mabar & Kabar Global (baru)
Tombol 👥 di kanan atas (sebelah 📡) membuka panel. Butuh login; tidak perlu akun premium. Semua lewat `/ws` di Worker `mancing` (Durable Object `GameRoom`, tidak perlu migrasi/binding baru).
- **Kabar global**: saat pemain mana pun dapat ikan **Epik** atau **Legendaris**, semua pemain online melihat banner di atas layar (+ bunyi lonceng, bisa dimatikan di panel). Legendaris lebih lama & bercahaya emas.
- **Mabar + split-screen**: layar otomatis terbagi sesuai jumlah pemain (2 pemain → 2 layar, 3-4 → 4 layar, 5-6 → 6 layar). Layar pertama = game aslimu; layar lain menampilkan pancingan teman realtime (lempar, nunggu, STRIKE, bar melawan ikan, ikan terangkat) dari status ~8x/detik lewat `/ws`. Bisa dimatikan di panel 👥.
- **Mabar**: buat room (kode 4 karakter) atau gabung dengan kode, maks 6 pemain. Anggota melihat status satu sama lain (Siap / STRIKE! / Melawan ikan), tangkapan Langka+ di feed room, emote cepat, dan **poin tim** (Langka 1, Epik 3, Legendaris 10, Berkilau x2). Teman yang sudah accepted bisa diundang langsung dari panel.
- Poin tim hanya skor; tidak mengubah koin/ekonomi game.
- Anti-spam di server: 1 laporan ikan per 6 detik per pemain, maks 40 pengumuman global per menit, 8 pesan/detik per koneksi, satu koneksi per akun.

## Honest status / limits
- Node connector code and game bridge are included; it is not possible to confirm your account's real LIVE connection from this environment. Test with actual active streams and check the in-game event log.
- TikTok uses a community Node.js connector; protocol/account access can change. YouTube reads the specified active video's live chat.
- Cloudflare Worker serves the game but is not used to run the persistent Node.js connector. The connector needs its own Node-compatible host.
- Kabar global & poin tim berdasarkan laporan dari game (klien), sama seperti sistem koin lain di game ini; server hanya membatasi laju dan memvalidasi bentuk data. Pemain yang memodifikasi klien bisa memalsukan pengumuman.
- Room disimpan di memori Durable Object. Jika Cloudflare merestart DO, room hilang; klien otomatis menyambung ulang dan membuat room dengan kode yang sama.
- Fitur mabar/kabar global belum diuji dengan banyak pemain sungguhan di Cloudflare dari sini. Logika room diuji dengan tes lokal, tampilan dengan WebSocket tiruan.
