# Mancing Laut Dalam — Live Global starter

## Isi paket
- `index.html`: game HTML asli dengan panel **Live Global demo** tambahan.
- `worker.js`: starter Cloudflare Worker + Durable Object untuk satu ruang live, pembelian koin, dan broadcast tangkapan.
- `wrangler.toml`: konfigurasi dasar Wrangler.

## Aturan game yang dipasang
- Pembelian berhasil = ikan langsung didapat; tidak ada RNG gagal.
- Harga demo: Ikan Karang 10, Tuna Raksasa 250, Hiu Legendaris 1.500, Leviathan Mitos 10.000 koin.
- Saldo tidak boleh negatif; server mengecek harga dan saldo sebelum transaksi.
- Tangkapan disiarkan ke semua koneksi WebSocket di ruang live global.

## Penting: status saat ini
Panel di `index.html` adalah **demo lokal**, belum mengirim transaksi ke Worker. Worker adalah fondasi backend, belum dipasang ke HTML dan belum terhubung ke event TikTok LIVE, YouTube Live, atau Facebook Live. Setiap platform punya akses/API dan ketentuan yang berbeda; sambungkan hanya lewat akses resmi yang tersedia.

## Deploy Worker
1. Pasang Node.js dan Wrangler (`npm install -g wrangler`).
2. Dari folder ini, jalankan `wrangler login`.
3. Jalankan `wrangler deploy`.
4. Tes endpoint `/health`.

## Sebelum live sungguhan
- Hubungkan UI ke `wss://<worker-domain>/ws` dan render pesan `global_catch` sebagai efek global.
- Implementasikan adapter platform yang terautentikasi; jangan percaya `viewerId` dari browser begitu saja.
- Tambahkan autentikasi moderator, rate limit, deduplikasi event, logging, validasi origin, dan proteksi spam.
- Atur cara saldo koin diperoleh. Wallet awal 1.000 koin pada Worker ini adalah nilai prototipe.
- Jangan menganggap likes/gifts/subscription tersedia sampai akses connector/API platform benar-benar diverifikasi.
