#!/usr/bin/env bash
# Jalankan server (Termux). Wake-lock mencegah Android menidurkan prosesnya.
cd "$(dirname "$0")" || exit 1
mkdir -p data
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
exec node server.js
