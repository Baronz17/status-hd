// Klien WhatsApp (linked device) berbasis Baileys.
// PERINGATAN: ini library tidak resmi. Melanggar ToS WhatsApp; nomor bisa dibatasi/diblokir.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const STATUS_JID = 'status@broadcast';

export class WaClient extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.authDir = path.join(dataDir, 'auth');
    this.contactsFile = path.join(dataDir, 'contacts.json');
    this.lib = null;
    this.sock = null;
    this.state = 'starting'; // starting | unlinked | pairing | connecting | open | error
    this.pairPhone = null;
    this.pairingCode = null;
    this.user = null;
    this.lastError = null;
    this.contacts = new Map(); // jid -> nama
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.saveTimer = null;
    this.stopping = false;
    this.acks = new Map(); // id pesan -> kode status terakhir (0 error, 1 pending, 2 server, 3 terkirim, 4 dibaca)
    this.debug = !!process.env.DEBUG_WA;
  }

  async _loadLib() {
    let mod;
    try {
      mod = await import('@whiskeysockets/baileys');
    } catch (e) {
      throw new Error('Paket @whiskeysockets/baileys belum terpasang. Jalankan: npm install');
    }
    // Baileys bisa diekspor sebagai ESM atau CJS; ambil dengan toleran.
    const pick = (name) => mod[name] ?? mod.default?.[name];
    const makeWASocket = typeof mod.default === 'function' ? mod.default : (mod.default?.default ?? mod.makeWASocket);
    this.lib = {
      makeWASocket,
      useMultiFileAuthState: pick('useMultiFileAuthState'),
      fetchLatestBaileysVersion: pick('fetchLatestBaileysVersion'),
      DisconnectReason: pick('DisconnectReason') ?? { loggedOut: 401, restartRequired: 515, timedOut: 408 },
      Browsers: pick('Browsers'),
      jidNormalizedUser: pick('jidNormalizedUser'),
    };
    if (!this.lib.makeWASocket || !this.lib.useMultiFileAuthState) {
      throw new Error('Versi Baileys terpasang tidak cocok dengan kode ini (API berubah). Lihat README bagian "Kalau rusak".');
    }
    const pinoMod = await import('pino');
    this.logger = (pinoMod.default ?? pinoMod)({ level: process.env.LOG_LEVEL || 'warn' });
  }

  async start() {
    try {
      await this._loadLib();
    } catch (e) {
      this.state = 'error';
      this.lastError = e.message;
      throw e;
    }
    this._loadContacts();
    const { state } = await this.lib.useMultiFileAuthState(this.authDir);
    if (state.creds.registered) {
      await this._connect();
    } else {
      this.state = 'unlinked';
    }
  }

  async startPairing(phone) {
    if (this.state === 'open') throw new Error('Sudah terhubung. Putuskan dulu kalau mau ganti nomor.');
    this.pairPhone = phone;
    this.pairingCode = null;
    this.lastError = null;
    await this._teardown();
    this.state = 'pairing';
    await this._connect();
  }

  async _teardown() {
    clearTimeout(this.reconnectTimer);
    if (this.sock) {
      try { this.sock.ev.removeAllListeners(); } catch {}
      try { this.sock.end(undefined); } catch {}
      this.sock = null;
    }
  }

  async _connect() {
    const { state, saveCreds } = await this.lib.useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await this.lib.fetchLatestBaileysVersion());
    } catch {
      /* pakai versi bawaan library */
    }

    const browser = this.lib.Browsers?.ubuntu ? this.lib.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'];
    const sock = this.lib.makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: this.logger,
      browser,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;
    if (this.state !== 'pairing') this.state = 'connecting';

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this._onConnection(sock, u).catch((e) => (this.lastError = e.message)));
    sock.ev.on('contacts.upsert', (c) => this._addContacts(c));
    sock.ev.on('contacts.update', (c) => this._addContacts(c));
    sock.ev.on('messaging-history.set', (h) => h?.contacts && this._addContacts(h.contacts));
    sock.ev.on('messages.update', (ups) => {
      for (const u of ups ?? []) {
        const id = u?.key?.id;
        if (!id || u.update?.status === undefined) continue;
        this.acks.set(id, u.update.status);
        if (this.acks.size > 200) this.acks.delete(this.acks.keys().next().value);
        if (this.debug) console.log('[wa] messages.update', id, JSON.stringify(u.update));
      }
    });
    // Untuk status, konfirmasi datang sebagai "receipt" per penerima (bukan messages.update).
    sock.ev.on('message-receipt.update', (list) => {
      for (const r of list ?? []) {
        const id = r?.key?.id;
        if (!id || !r.receipt) continue;
        const level = r.receipt.readTimestamp ? 4 : r.receipt.receiptTimestamp ? 3 : 0;
        if (level > (this.acks.get(id) ?? 0)) this.acks.set(id, level);
        if (this.debug) console.log('[wa] receipt', id, level === 4 ? 'dibaca' : 'terkirim');
      }
      if (this.acks.size > 200) this.acks.delete(this.acks.keys().next().value);
    });
  }

  async _onConnection(sock, update) {
    if (sock !== this.sock) return; // socket lama
    const { connection, lastDisconnect, qr } = update;
    const R = this.lib.DisconnectReason;

    // Soket menghasilkan "qr" saat siap dipasangkan; di sinilah kode pairing diminta.
    if (qr && !sock.authState.creds.registered && this.pairPhone && !this.pairingCode) {
      const code = await sock.requestPairingCode(this.pairPhone);
      this.pairingCode = String(code).match(/.{1,4}/g)?.join('-') ?? String(code);
      this.state = 'pairing';
    }

    if (connection === 'open') {
      this.state = 'open';
      this.user = sock.user ?? null;
      this.pairingCode = null;
      this.pairPhone = null;
      this.reconnectAttempts = 0;
      this.lastError = null;
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      this.user = null;

      if (status === R.loggedOut) {
        this._wipeAuth();
        this.state = 'unlinked';
        this.lastError = 'Perangkat tertaut dicabut dari HP. Hubungkan ulang.';
        return;
      }
      if (!sock.authState.creds.registered) {
        // Pairing belum selesai (kode kedaluwarsa / dibatalkan)
        this.state = 'unlinked';
        this.pairingCode = null;
        this.pairPhone = null;
        this.lastError = 'Pairing tidak selesai (kode kedaluwarsa atau dibatalkan). Minta kode baru.';
        return;
      }
      // Selain itu (termasuk restartRequired setelah pairing): sambung ulang dengan backoff.
      this.state = 'connecting';
      const delay = status === R.restartRequired ? 500 : Math.min(30000, 2000 * ++this.reconnectAttempts);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (this.stopping) return;
        this._connect().catch((e) => {
          this.state = 'error';
          this.lastError = e.message;
        });
      }, delay);
    }
  }

  _wipeAuth() {
    try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch {}
    this.contacts.clear();
    try { fs.rmSync(this.contactsFile, { force: true }); } catch {}
  }

  // ---- kontak (dipakai sebagai daftar penerima Status) ----
  _loadContacts() {
    try {
      const obj = JSON.parse(fs.readFileSync(this.contactsFile, 'utf8'));
      this.contacts = new Map();
      let dropped = 0;
      for (const [jid, v] of Object.entries(obj)) {
        // Format lama (string): tanpa nama sama sekali berarti pasti bukan kontak tersimpan.
        const c = typeof v === 'string'
          ? { name: v, saved: v ? null : false }
          : { name: v?.name ?? '', saved: v?.saved ?? null };
        if (c.saved === false) { dropped++; continue; }
        this.contacts.set(jid, c);
      }
      if (dropped) {
        fs.writeFileSync(this.contactsFile, JSON.stringify(Object.fromEntries(this.contacts)));
        console.log(`[wa] ${dropped} entri bukan kontak tersimpan dibuang dari daftar`);
      }
    } catch {
      /* belum ada */
    }
  }

  _addContacts(list) {
    let changed = false;
    for (const c of list ?? []) {
      // Beberapa versi memakai LID sebagai id dan menaruh nomor di phoneNumber.
      const jid = [c.id, c.phoneNumber].find((x) => typeof x === 'string' && x.endsWith('@s.whatsapp.net'));
      if (!jid) continue;
      const prev = this.contacts.get(jid);
      if (!prev && !c.name) continue; // orang asing (grup, pengirim pesan): jangan simpan
      // "name" = nama di buku telepon; "notify" = nama yang dipasang orang itu sendiri (bisa orang asing di grup).
      const saved = c.name ? true : prev ? prev.saved : false;
      const name = c.name || c.notify || c.verifiedName || prev?.name || '';
      if (!prev || prev.name !== name || prev.saved !== saved) {
        this.contacts.set(jid, { name, saved });
        changed = true;
      }
    }
    if (changed) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        try {
          fs.mkdirSync(path.dirname(this.contactsFile), { recursive: true });
          fs.writeFileSync(this.contactsFile, JSON.stringify(Object.fromEntries(this.contacts)));
        } catch {}
      }, 2000);
    }
  }

  _ownJid() {
    const id = this.sock?.user?.id;
    if (!id) return null;
    return this.lib.jidNormalizedUser ? this.lib.jidNormalizedUser(id) : id.replace(/:\d+@/, '@');
  }

  listContacts() {
    return [...this.contacts].map(([jid, c]) => ({ jid, name: c.name, saved: c.saved, number: jid.split('@')[0] }))
      .sort((x, y) => (x.name || x.number).localeCompare(y.name || y.number, 'id'));
  }

  _savedJids() {
    return [...this.contacts].filter(([, c]) => c.saved === true).map(([jid]) => jid);
  }

  // Mode meniru Privasi Status WhatsApp: all | except | only | close.
  // "all" dan "except" hanya memakai kontak yang terbukti tersimpan di buku teleponmu.
  // Daftarnya dikelola di aplikasi ini, TIDAK terhubung ke pengaturan privasi di WhatsApp.
  _audience(mode, lists) {
    const me = this._ownJid();
    let base;
    if (mode === 'all' || mode === 'except') {
      base = this._savedJids();
      if (!base.length) {
        throw new Error('Belum ada kontak tersimpan yang terdeteksi, jadi mode ini ditolak agar status tidak terkirim ke orang asing. Pakai Hanya ke... atau lakukan pairing ulang untuk menyinkronkan kontak.');
      }
      if (mode === 'except') { const ex = new Set(lists.except); base = base.filter((j) => !ex.has(j)); }
    } else if (mode === 'only') base = lists.only;
    else if (mode === 'close') base = lists.close;
    else throw new Error('Audiens tidak dikenal.');
    if (!base.length) throw new Error('Daftar penerima kosong. Isi daftarnya dulu lewat tombol Edit.');
    return [...new Set([me, ...base])];
  }

  // Jumlah penerima (tanpa diri sendiri) untuk mode audiens; melempar error kalau daftarnya kosong.
  audienceSize(mode, lists) {
    return this._audience(mode, lists).length - 1;
  }

  getState() {
    const number = this.user?.id ? this.user.id.split(/[:@]/)[0] : null;
    return {
      state: this.state,
      number,
      name: this.user?.name ?? null,
      pairingCode: this.pairingCode,
      contactCount: this.contacts.size,
      savedCount: this._savedJids().length,
      lastError: this.lastError,
      mock: false,
    };
  }

  async postStatus({ filePath, kind, caption, audience, lists }) {
    if (this.state !== 'open' || !this.sock) throw new Error('WhatsApp belum terhubung.');
    const jids = this._audience(audience, lists);
    const content =
      kind === 'video'
        ? { video: { url: filePath }, mimetype: 'video/mp4' }
        : { image: { url: filePath } };
    if (caption) content.caption = caption;

    const msg = await this.sock.sendMessage(STATUS_JID, content, { statusJidList: jids });
    const id = msg?.key?.id ?? null;
    console.log(`[wa] status dikirim id=${id} penerima=${jids.length} jenis=${kind} audiens=${audience}`);

    // Tunggu konfirmasi dari server WhatsApp (maks 12 dtk). Tidak ada konfirmasi != pasti gagal.
    let ack = 'none';
    for (let i = 0; i < 24 && id; i++) {
      const st = this.acks.get(id);
      if (st === 0) throw new Error('WhatsApp menolak pesan status ini (status ERROR dari server).');
      if (st >= 3) { ack = 'delivered'; break; }
      if (st >= 2) ack = 'server';
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`[wa] konfirmasi id=${id}: ${ack}`);
    return { messageId: id, recipients: jids.length, ack, jids };
  }

  async _waitAck(id, ms = 12000) {
    let ack = 'none';
    for (let i = 0; i < ms / 500 && id; i++) {
      const st = this.acks.get(id);
      if (st === 0) throw new Error('WhatsApp menolak pesan ini (status ERROR dari server).');
      if (st >= 3) { ack = 'delivered'; break; }
      if (st >= 2) ack = 'server';
      await new Promise((r) => setTimeout(r, 500));
    }
    return ack;
  }

  // Kirim file sebagai pesan chat biasa ke satu nomor (misalnya nomor utamamu), tanpa kompresi ulang.
  async sendChat({ filePath, kind, caption, number }) {
    if (this.state !== 'open' || !this.sock) throw new Error('WhatsApp belum terhubung.');
    const jid = `${number}@s.whatsapp.net`;
    const content =
      kind === 'video'
        ? { video: { url: filePath }, mimetype: 'video/mp4' }
        : { image: { url: filePath } };
    if (caption) content.caption = caption;
    const msg = await this.sock.sendMessage(jid, content);
    const id = msg?.key?.id ?? null;
    console.log(`[wa] chat dikirim id=${id} ke=+${number} jenis=${kind}`);
    const ack = await this._waitAck(id);
    console.log(`[wa] konfirmasi id=${id}: ${ack}`);
    return { messageId: id, recipients: 1, ack, number };
  }

  // Cabut status yang pernah dikirim. Perintah hapus harus menyertakan penerima yang sama dengan saat posting.
  async revokeStatus({ id, jids }) {
    if (this.state !== 'open' || !this.sock) throw new Error('WhatsApp belum terhubung.');
    const list = [...new Set([this._ownJid(), ...jids])];
    await this.sock.sendMessage(
      STATUS_JID,
      { delete: { remoteJid: STATUS_JID, fromMe: true, id } },
      { statusJidList: list },
    );
    console.log(`[wa] perintah hapus status id=${id} penerima=${list.length}`);
    return { recipients: list.length };
  }

  async logout() {
    this.stopping = false;
    try { await this.sock?.logout(); } catch {}
    await this._teardown();
    this._wipeAuth();
    this.state = 'unlinked';
    this.user = null;
    this.pairingCode = null;
  }

  async stop() {
    this.stopping = true;
    await this._teardown();
  }
}
