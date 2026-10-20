# Status HD

Kirim video dan foto ke Status WhatsApp dengan kualitas asli, langsung dari HP. Aplikasi ini tersambung ke WhatsApp sebagai perangkat tertaut (seperti WhatsApp Web), jadi video tidak dikompres ulang oleh aplikasi WhatsApp di HP.

Terdiri dari dua bagian:
- **Server** (Node.js + Baileys) yang berjalan di Termux.
- **Web app** di `http://localhost:3000` yang bisa dipasang sebagai aplikasi dan muncul di menu Bagikan.

> **Peringatan.** Baileys adalah library tidak resmi. Memakainya melanggar ketentuan WhatsApp, dan nomor yang dipakai bisa dibatasi atau diblokir. Pakai **nomor cadangan**, jangan nomor utama. Risiko sepenuhnya ditanggung pemakai.
>
> Proyek ini tidak berafiliasi dengan, didukung oleh, atau terkait dengan WhatsApp atau Meta.

---

## 1. Pasang

1. Pasang **Termux** dari F-Droid. Versi Play Store sudah usang.
2. Di Termux, ambil kode ini ke folder home. Jangan taruh di folder Download: penyimpanan bersama Android tidak mengizinkan symlink, sehingga `npm install` akan gagal di sana.
   ```
   pkg install -y git
   git clone https://github.com/Baronz17/status-hd ~/status-hd
   cd ~/status-hd
   bash setup-termux.sh
   ```
3. Jalankan server:
   ```
   ./start.sh
   ```
4. Buka Chrome ke **http://localhost:3000**, isi nomor cadangan, tekan **Minta kode tautan**, lalu masukkan kodenya di WhatsApp nomor itu: Setelan → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon.

## 2. Pasang sebagai aplikasi dan tombol Bagikan

1. Buka `http://localhost:3000` di Chrome.
2. Menu ⋮ → **Instal aplikasi** (atau Tambahkan ke layar utama).
3. Di galeri: pilih video → **Bagikan** → **Status HD**.

Kalau Status HD tidak muncul di menu Bagikan, buka aplikasinya dan pilih file dari tab **Kirim**. Hasilnya sama.

## 3. Menjalankan server di latar belakang

```
cd ~/status-hd
termux-wake-lock
nohup node server.js >> data/server.log 2>&1 &
```

| Perintah | Fungsi |
|---|---|
| `pgrep -af "node server.js"` | Cek server berjalan |
| `tail -f data/server.log` | Lihat log |
| `pkill -f "node server.js"` | Hentikan server |

**Otomatis saat HP menyala:** pasang **Termux:Boot** dari F-Droid dan buka sekali. `setup-termux.sh` sudah menaruh skrip boot di `~/.termux/boot/wa-status.sh`. Pastikan baris `cd` di skrip itu menunjuk ke `~/status-hd`.

## 4. Supaya server tidak mati sendiri

Android sering mematikan proses di latar belakang. Untuk Termux dan Termux:Boot:
- Pengaturan → Aplikasi → Baterai → **Tanpa batasan**.
- Izinkan **mulai otomatis** kalau HP-mu punya menu itu.
- Kunci Termux di daftar aplikasi terbaru supaya tidak ikut tersapu.
- Jangan hapus notifikasi Termux selama wake-lock aktif.

Kalau server tetap mati: cek bagian akhir `data/server.log`. Tanpa pesan error berarti proses dimatikan sistem, bukan crash.

## 5. Cara pakai

**Kirim:** pilih atau bagikan file → cek info di bawah pratinjau → pilih audiens → **Kirim ke Status**.

**Audiens** meniru pilihan di WhatsApp:
- **Kontak saya**: hanya kontak yang tersimpan di buku teleponmu.
- **Kontak saya, kecuali…**: kontak tersimpan, dikurangi daftar pengecualian.
- **Bagikan hanya ke…** dan **Teman dekat**: hanya orang yang kamu pilih.

Daftar-daftar ini disimpan di HP dan **terpisah** dari pengaturan privasi WhatsApp. Baileys tidak bisa membaca daftar privasimu, jadi isi sekali lewat tombol **Atur**.

Kalau tab **Akun** menunjukkan 0 kontak tersimpan, putuskan nomor lalu tautkan ulang supaya kontak tersinkron dengan nama dari buku telepon.

**Riwayat:** tombol **Hapus** mengirim perintah hapus ke penerima yang sama dengan saat posting. Itu tidak menjamin status hilang di semua HP.

## 6. Apa yang dilakukan dengan videomu

- H.264 + AAC dalam MP4, ukuran ≤ 16 MB: **dikirim apa adanya**, tanpa kompresi ulang.
- Selain itu (H.265/HEVC, VP9, MOV 10-bit, atau lebih besar dari batas): dikonversi dengan ffmpeg ke H.264/AAC. Kalau hanya masalah kodek, kualitasnya CRF 18 (nyaris tanpa kehilangan). Kalau kebesaran, bitrate dihitung supaya muat.
- Batas ukuran bisa diubah: `MAX_MB=32 ./start.sh`. Angka 16 MB adalah tebakan konservatif, belum diverifikasi.
- Konversi di HP lambat. Ekspor dari editor sebagai **H.264** supaya tidak perlu dikonversi.

## 7. Menghapus status lama dengan ID

Untuk status yang dikirim sebelum riwayat ada. ID-nya ada di log, pada baris `status dikirim id=…`. Perintah hapus dikirim ke semua kontak yang tersinkron.

```
curl -X POST -H "X-WSP: 1" -H "Content-Type: application/json" \
  -d '{"id":"3EB0BC0274B3AD8D6A52B5"}' \
  http://localhost:3000/api/posts/delete
```

## 8. Kalau rusak

- **Log:** `data/server.log`. Untuk log lebih rinci: `DEBUG_WA=1 ./start.sh`.
- **Baileys berubah:** WhatsApp sering mengubah protokol. Versi Baileys dikunci ke `7.0.0-rc14`, yang sudah teruji. Kalau suatu hari berhenti bekerja, coba versi terbaru dengan `npm install @whiskeysockets/baileys@latest`. Semua kode yang menyentuh Baileys ada di `lib/wa.js`.
- **Perangkat tertaut dicabut:** terjadi kalau HP utama nomor itu tidak online sekitar 14 hari. Tautkan ulang.
- **Jangan bagikan log `DEBUG_WA`** atau folder `data/auth`: isinya bisa memuat kunci sesi WhatsApp.

## Keamanan

Server hanya mendengarkan `127.0.0.1`, menolak Host selain localhost, dan setiap POST wajib membawa header `X-WSP`.

## Uji tanpa WhatsApp

`WA_MOCK=1 node server.js` menjalankan seluruh antarmuka dengan WhatsApp tiruan. Tidak ada yang dikirim.

## Lisensi

MIT. Lihat [LICENSE](LICENSE).
