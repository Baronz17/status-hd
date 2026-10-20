#!/data/data/com.termux/files/usr/bin/bash
# Pasang semua kebutuhan di Termux dan (opsional) jalankan otomatis saat HP menyala via Termux:Boot.
set -e
cd "$(dirname "$0")"
APP_DIR="$(pwd)"

pkg update -y
pkg install -y nodejs-lts ffmpeg git

npm install --no-audit --no-fund
mkdir -p data

mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/wa-status.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd "$APP_DIR" && exec node server.js >> data/server.log 2>&1
BOOT
chmod +x "$HOME/.termux/boot/wa-status.sh" start.sh

echo
echo "Selesai. Jalankan:  ./start.sh"
echo "Lalu buka Chrome ke http://localhost:3000"
echo "Autostart butuh aplikasi Termux:Boot (dari F-Droid) dan dibuka sekali."
