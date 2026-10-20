// WhatsApp tiruan untuk menguji server dan web app tanpa akun asli. Aktifkan: WA_MOCK=1
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export class MockWa extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.postsFile = path.join(dataDir, 'mock-posts.json');
    this.state = 'unlinked';
    this.pairingCode = null;
    this.number = null;
    this.lastError = null;
  }

  async start() {}

  async startPairing(phone) {
    this.state = 'pairing';
    this.pairingCode = null;
    setTimeout(() => (this.pairingCode = 'ABCD-1234'), 300);
    setTimeout(() => {
      this.state = 'open';
      this.pairingCode = null;
      this.number = phone;
    }, 2500);
  }

  getState() {
    return {
      state: this.state,
      number: this.number,
      name: 'Mock',
      pairingCode: this.pairingCode,
      contactCount: 40,
      savedCount: 35,
      lastError: this.lastError,
      mock: true,
    };
  }

  listContacts() {
    return Array.from({ length: 40 }, (_, i) => ({ jid: `62811000${String(i).padStart(4, '0')}@s.whatsapp.net`, name: i % 7 === 0 ? '' : `Kontak ${String.fromCharCode(65 + (i % 26))}${i}`, saved: i % 8 !== 0, number: `62811000${String(i).padStart(4, '0')}` }));
  }

  audienceSize(mode, lists) {
    const n = { all: 35, except: 35 - lists.except.length, only: lists.only.length, close: lists.close.length }[mode];
    if (!n) throw new Error('Daftar penerima kosong. Isi daftarnya dulu lewat tombol Atur.');
    return n;
  }

  async postStatus({ filePath, kind, caption, audience, lists }) {
    if (this.state !== 'open') throw new Error('WhatsApp belum terhubung.');
    const n = { all: 35, except: 35 - lists.except.length, only: lists.only.length, close: lists.close.length }[audience];
    if (!n) throw new Error('Daftar penerima kosong. Isi daftarnya dulu lewat tombol Edit.');
    const size = fs.statSync(filePath).size;
    await new Promise((r) => setTimeout(r, 800));
    let list = [];
    try { list = JSON.parse(fs.readFileSync(this.postsFile, 'utf8')); } catch {}
    list.push({ at: new Date().toISOString(), kind, caption, audience, size, file: path.basename(filePath) });
    fs.writeFileSync(this.postsFile, JSON.stringify(list, null, 2));
    return { messageId: '3EB0MOCK' + String(list.length).padStart(14, '0'), recipients: n + 1, ack: 'server', jids: ['62811000000@s.whatsapp.net', '62811000001@s.whatsapp.net'] };
  }

  async sendChat({ filePath, kind, caption, number }) {
    if (this.state !== 'open') throw new Error('WhatsApp belum terhubung.');
    fs.statSync(filePath);
    await new Promise((r) => setTimeout(r, 600));
    return { messageId: '3EB0CHAT' + Date.now().toString().slice(-14), recipients: 1, ack: 'delivered', number };
  }

  async revokeStatus({ id, jids }) {
    if (this.state !== 'open') throw new Error('WhatsApp belum terhubung.');
    return { recipients: jids.length + 1 };
  }

  async logout() {
    this.state = 'unlinked';
    this.number = null;
  }

  async stop() {}
}
