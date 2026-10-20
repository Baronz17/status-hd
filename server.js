// Server lokal: melayani web app + API, dan menjadi jembatan ke WhatsApp (linked device).
// Tanpa dependensi selain Baileys/pino (yang hanya dimuat lewat lib/wa.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { hasBinary, probe, analyzeVideo, transcode } from './lib/media.js';

// libsignal mencetak isi sesi enkripsi (termasuk kunci privat) lewat console.info saat sesi diganti.
// Itu normal tapi berbahaya kalau log dibagikan, jadi dibuang.
const origInfo = console.info;
console.info = (...a) => { if (typeof a[0] === 'string' && /session/i.test(a[0])) return; origInfo(...a); };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS = path.join(DATA, 'uploads');
const WORK = path.join(DATA, 'work');
const PUBLIC = path.join(__dirname, 'public');
const MAX_MB = Number(process.env.MAX_MB || 16);
const MAX_BYTES = MAX_MB * 1024 * 1024;
const MAX_UPLOAD = 1024 ** 3; // 1 GB, batas wajar untuk file dari galeri
const DEFAULT_CC = process.env.DEFAULT_CC || '62';
// Pengurang risiko blokir (bukan jaminan): jeda minimal antar posting dan konfirmasi untuk audiens besar.
const MIN_GAP_SEC = Number(process.env.MIN_GAP_SEC ?? 120);
const LARGE_AUDIENCE = Number(process.env.LARGE_AUDIENCE || 300);
// Kirim ke satu chat jauh lebih wajar daripada status ke banyak orang, jadi jedanya lebih pendek.
const CHAT_GAP_SEC = Number(process.env.CHAT_GAP_SEC ?? 15);
let lastChatAt = 0;
const chatCooldownUntil = () => (CHAT_GAP_SEC > 0 ? lastChatAt + CHAT_GAP_SEC * 1000 : 0);
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.3gp']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIME_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/3gpp': '.3gp', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

for (const d of [UPLOADS, WORK]) {
  fs.rmSync(d, { recursive: true, force: true }); // sisa sesi sebelumnya tidak dipakai lagi
  fs.mkdirSync(d, { recursive: true });
}

const FFMPEG = hasBinary('ffmpeg') && hasBinary('ffprobe');
if (!FFMPEG) console.warn('[peringatan] ffmpeg/ffprobe tidak ditemukan. Video akan dikirim apa adanya tanpa pemeriksaan kodek.');

// ---- klien WhatsApp ----
const wa = process.env.WA_MOCK
  ? new (await import('./lib/wa-mock.js')).MockWa({ dataDir: DATA })
  : new (await import('./lib/wa.js')).WaClient({ dataDir: DATA });
wa.start().catch((e) => console.error('[wa] gagal start:', e.message));

// ---- penyimpanan upload & antrean job ----
const uploads = new Map();
const jobs = new Map();
const queue = [];
let working = false;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body terlalu besar'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON tidak valid'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = DEFAULT_CC + d.slice(1);
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

// ---- daftar audiens (kecuali / hanya ke / teman dekat), disimpan lokal ----
const LISTS_FILE = path.join(DATA, 'audiences.json');
function loadLists() {
  const empty = { except: [], only: [], close: [] };
  try { return { ...empty, ...JSON.parse(fs.readFileSync(LISTS_FILE, 'utf8')) }; } catch { return empty; }
}
function saveLists(input) {
  const cur = loadLists();
  for (const k of ['except', 'only', 'close']) {
    if (input[k] === undefined) continue;
    if (!Array.isArray(input[k]) || input[k].length > 5000 || !input[k].every((j) => typeof j === 'string' && /^\d+@s\.whatsapp\.net$/.test(j))) {
      throw Object.assign(new Error(`Daftar "${k}" tidak valid.`), { status: 400 });
    }
    cur[k] = [...new Set(input[k])];
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LISTS_FILE, JSON.stringify(cur));
  return cur;
}

// ---- riwayat posting (untuk fitur hapus) ----
const POSTS_FILE = path.join(DATA, 'posts.json');
function loadPosts() { try { return JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch { return []; } }
// Waktu percobaan kirim terakhir; dipulihkan dari riwayat supaya jeda tetap berlaku setelah restart.
let lastPostAt = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(DATA, 'posts.json'), 'utf8'));
    const t = Date.parse(list[list.length - 1]?.at);
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
})();
const cooldownUntil = () => (MIN_GAP_SEC > 0 ? lastPostAt + MIN_GAP_SEC * 1000 : 0);

function savePosts(list) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(POSTS_FILE, JSON.stringify(list.slice(-50))); }

function safeUnlink(p) {
  if (p) fs.unlink(p, () => {});
}

// ---- upload mentah (tanpa multipart): body = isi file ----
async function handleUpload(req, res, url) {
  const name = (url.searchParams.get('name') || 'file').slice(0, 120);
  const type = (url.searchParams.get('type') || '').toLowerCase();
  let ext = path.extname(name).toLowerCase() || MIME_EXT[type] || '';
  if (ext === '.jpeg') ext = '.jpg';
  const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : null;
  if (!kind) return sendJson(res, 415, { error: 'Format tidak didukung. Pakai MP4/MOV/WebM/3GP untuk video atau JPG/PNG/WebP untuk foto.' });

  const id = randomUUID().slice(0, 8);
  const dest = path.join(UPLOADS, id + ext);
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > MAX_UPLOAD) cb(Object.assign(new Error('File terlalu besar'), { status: 413 }));
      else cb(null, chunk);
    },
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(dest));
  } catch (e) {
    safeUnlink(dest);
    return sendJson(res, e.status || 400, { error: e.message });
  }
  if (received === 0) { safeUnlink(dest); return sendJson(res, 400, { error: 'File kosong.' }); }

  let info;
  try {
    if (kind === 'video' && FFMPEG) {
      info = analyzeVideo(await probe(dest), received, MAX_BYTES);
    } else {
      info = {
        kind,
        sizeMB: Math.round((received / 1024 / 1024) * 10) / 10,
        willTranscode: false,
        reasons: [],
        warnings: kind === 'video' ? ['ffmpeg tidak ada: kodek tidak diperiksa, video dikirim apa adanya.'] : [],
      };
    }
  } catch (e) {
    safeUnlink(dest);
    const reason = String(e.message).replace(dest, 'file').split('\n').pop();
    return sendJson(res, 422, { error: 'File tidak bisa dibaca sebagai media: ' + reason });
  }

  uploads.set(id, { id, path: dest, kind, name, size: received, info, createdAt: Date.now() });
  sendJson(res, 200, { id, name, info });
}

// ---- antrean posting (satu per satu) ----
async function processJob(job) {
  const up = uploads.get(job.uploadId);
  if (!up) throw new Error('File sudah dibersihkan dari server. Pilih ulang filenya.');

  let sendPath = up.path;
  let tmp = null;
  try {
    if (up.kind === 'video' && up.info.willTranscode) {
      if (!FFMPEG) throw new Error('Video perlu dikonversi tetapi ffmpeg tidak ada.');
      job.status = 'transcoding';
      job.progress = 0;
      tmp = path.join(WORK, `${job.id}.mp4`);
      await transcode(up.path, tmp, {
        durationSec: up.info.durationSec,
        maxBytes: MAX_BYTES,
        compress: up.info.compress,
        onProgress: (p) => (job.progress = p),
      });
      sendPath = tmp;
      job.notes.push(`Dikonversi ke H.264/AAC (${up.info.reasons.join('; ')}).`);
    } else if (up.kind === 'video') {
      job.notes.push('Dikirim apa adanya: tidak ada kompresi ulang oleh aplikasi ini.');
    }

    job.status = 'sending';
    job.progress = null;
    if (job.dest === 'chat') {
      lastChatAt = Date.now();
      job.result = await wa.sendChat({ filePath: sendPath, kind: up.kind, caption: job.caption, number: job.number });
      job.status = 'done';
      safeUnlink(up.path);
      uploads.delete(up.id);
      return;
    }
    lastPostAt = Date.now(); // jeda dihitung sejak percobaan kirim, termasuk yang gagal di tengah jalan
    job.result = await wa.postStatus({ filePath: sendPath, kind: up.kind, caption: job.caption, audience: job.audience, lists: loadLists() });
    const { jids, ...publicResult } = job.result;
    if (job.result.messageId) {
      const list = loadPosts();
      list.push({ id: job.result.messageId, at: new Date().toISOString(), kind: up.kind, caption: job.caption, audience: job.audience, count: jids?.length ?? 0, jids: jids ?? [], deleted: false });
      savePosts(list);
    }
    job.result = publicResult;
    job.status = 'done';
    safeUnlink(up.path);
    uploads.delete(up.id);
  } finally {
    safeUnlink(tmp);
  }
}

async function drain() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = jobs.get(queue.shift());
    if (!job) continue;
    try {
      await processJob(job);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      console.error(`[job ${job.id}]`, e.message);
    }
  }
  working = false;
}

// ---- HTTP ----
function hostAllowed(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, ...EXTRA_HOSTS].includes(h);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Lindungi dari DNS rebinding & situs lain yang menembak localhost.
    if (!hostAllowed(req)) { res.writeHead(403); return res.end('Host tidak diizinkan'); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === 'POST') {
      // Header kustom memaksa preflight CORS untuk situs lain, yang tidak akan kita setujui.
      if (req.headers['x-wsp'] !== '1' && p !== '/share') return sendJson(res, 403, { error: 'Header X-WSP wajib ada.' });
    }

    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, { ...wa.getState(), ffmpeg: FFMPEG, maxMB: MAX_MB, cooldownUntil: cooldownUntil(), minGapSec: MIN_GAP_SEC, largeAudience: LARGE_AUDIENCE, chatCooldownUntil: chatCooldownUntil() });
    }

    if (req.method === 'POST' && p === '/api/pair') {
      const { phone } = await readJson(req);
      const num = normalizePhone(phone);
      if (!num) return sendJson(res, 400, { error: 'Nomor tidak valid. Tulis dengan kode negara, contoh 6281234567890.' });
      await wa.startPairing(num);
      return sendJson(res, 200, { ok: true, number: num });
    }

    if (req.method === 'GET' && p === '/api/contacts') return sendJson(res, 200, wa.listContacts());
    if (req.method === 'GET' && p === '/api/lists') return sendJson(res, 200, loadLists());
    if (req.method === 'POST' && p === '/api/lists') return sendJson(res, 200, saveLists(await readJson(req, 1024 * 1024)));

    if (req.method === 'GET' && p === '/api/posts') {
      return sendJson(res, 200, loadPosts().map(({ jids, ...rest }) => rest).reverse());
    }
    if (req.method === 'POST' && p === '/api/posts/delete') {
      const { id } = await readJson(req);
      if (!/^[A-Za-z0-9]{10,40}$/.test(String(id || ''))) return sendJson(res, 400, { error: 'ID status tidak valid.' });
      const list = loadPosts();
      const post = list.find((x) => x.id === id);
      // Status yang tidak tercatat (dikirim sebelum fitur ini ada): kirim perintah hapus ke semua kontak tersinkron.
      const jids = post ? post.jids : wa.listContacts().map((c) => c.jid);
      const r = await wa.revokeStatus({ id, jids });
      if (post) { post.deleted = true; savePosts(list); }
      return sendJson(res, 200, { ok: true, recipients: r.recipients, known: !!post });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      await wa.logout();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res, url);

    if (req.method === 'POST' && p === '/api/post') {
      const { id, caption = '', audience, confirmLarge = false, dest = 'status', target } = await readJson(req);
      if (!uploads.has(id)) return sendJson(res, 404, { error: 'File tidak ditemukan. Pilih ulang.' });
      if (!['status', 'chat'].includes(dest)) return sendJson(res, 400, { error: 'Tujuan tidak valid.' });
      if (String(caption).length > 700) return sendJson(res, 400, { error: 'Keterangan terlalu panjang (maks 700 karakter).' });
      if (wa.getState().state !== 'open') return sendJson(res, 409, { error: 'WhatsApp belum terhubung.' });
      if ([...jobs.values()].some((j) => ['queued', 'transcoding', 'sending'].includes(j.status))) {
        return sendJson(res, 409, { error: 'Masih ada kiriman yang berjalan. Tunggu sampai selesai.' });
      }

      if (dest === 'chat') {
        const number = normalizePhone(target);
        if (!number) return sendJson(res, 400, { error: 'Nomor tujuan tidak valid. Tulis dengan kode negara, contoh 6281234567890.' });
        const cw = Math.ceil((chatCooldownUntil() - Date.now()) / 1000);
        if (cw > 0) return sendJson(res, 429, { error: `Tunggu ${cw} detik lagi sebelum mengirim lagi.`, retryAfter: cw });
        const job = { id: randomUUID().slice(0, 8), uploadId: id, caption: String(caption).trim(), dest: 'chat', number, status: 'queued', progress: null, notes: [], error: null, result: null, createdAt: Date.now() };
        jobs.set(job.id, job);
        queue.push(job.id);
        drain();
        return sendJson(res, 202, { jobId: job.id });
      }

      if (!['all', 'except', 'only', 'close'].includes(audience)) return sendJson(res, 400, { error: 'Pilih audiens dulu.' });
      const wait = Math.ceil((cooldownUntil() - Date.now()) / 1000);
      if (wait > 0) {
        return sendJson(res, 429, { error: `Tunggu ${wait} detik lagi sebelum mengirim status berikutnya. Jeda ini mengurangi risiko blokir.`, retryAfter: wait });
      }
      let size;
      try { size = wa.audienceSize(audience, loadLists()); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      if (size > LARGE_AUDIENCE && confirmLarge !== true) {
        return sendJson(res, 409, {
          error: `Status akan dikirim ke ${size} orang sekaligus. Audiens sebesar ini lebih berisiko membuat nomor diblokir.`,
          needsConfirm: true,
          recipients: size,
        });
      }
      const job = { id: randomUUID().slice(0, 8), uploadId: id, caption: String(caption).trim(), audience, status: 'queued', progress: null, notes: [], error: null, result: null, createdAt: Date.now() };
      jobs.set(job.id, job);
      queue.push(job.id);
      drain();
      return sendJson(res, 202, { jobId: job.id });
    }

    const jm = p.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
    if (req.method === 'GET' && jm) {
      const job = jobs.get(jm[1]);
      if (!job) return sendJson(res, 404, { error: 'Job tidak ada.' });
      const { id, status, progress, notes, error, result } = job;
      return sendJson(res, 200, { id, status, progress, notes, error, result });
    }

    // Jaring pengaman bila Share Target sampai ke server (service worker belum aktif).
    if (p === '/share') {
      req.resume();
      res.writeHead(303, { Location: '/?shared=nosw' });
      return res.end();
    }

    if (req.method === 'GET') return serveStatic(res, p);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message || 'Kesalahan server' });
  }
});

// bersihkan sisa file lebih dari 6 jam
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [id, up] of uploads) if (up.createdAt < cutoff) { safeUnlink(up.path); uploads.delete(id); }
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Status HD siap di http://localhost:${PORT}${process.env.WA_MOCK ? '  (MODE TIRUAN)' : ''}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await wa.stop?.(); server.close(); process.exit(0); });
}
