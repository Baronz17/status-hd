'use strict';

const $ = (id) => document.getElementById(id);
const SHARE_CACHE = 'wsp-shared-v1';

let wa = { state: 'starting' };
let offline = false;
let tab = 'send';
let current = null; // { id, info, name }
let previewUrl = null;
let uploading = false;
let posting = false;
let note = null; // pesan dari aksi pengguna: { text, err, until }

// ---------- util ----------
function show(el, on) { el.hidden = !on; }
function setText(el, t) { el.textContent = t; }
function store(k, v) { try { localStorage.setItem(k, v); } catch {} }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
const fmtNum = (n) => Number(n || 0).toLocaleString('id-ID');
const fmtDec = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 1 });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'X-WSP': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Kesalahan ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function flash(text, err) {
  note = text ? { text, err: !!err, until: Date.now() + 9000 } : null;
  renderAlert();
}

function renderAlert() {
  let text = '';
  let err = false;
  if (note && Date.now() < note.until) {
    ({ text, err } = note);
  } else {
    const msgs = [];
    if (wa.mock) msgs.push('Mode uji: tidak ada yang dikirim ke WhatsApp sungguhan.');
    if (wa.lastError) msgs.push(wa.lastError);
    if (wa.ffmpeg === false) msgs.push('ffmpeg tidak terpasang di server, jadi kodek video tidak diperiksa.');
    text = offline ? '' : msgs.join(' ');
    err = wa.state === 'error' || !!wa.lastError;
  }
  const a = $('alert');
  a.textContent = text;
  a.classList.toggle('err', err);
  show(a, !!text);
}

// ---------- tab & keadaan ----------
const TABS = { send: 'vSend', hist: 'vHist', acct: 'vAcct' };
{ const t = load('wsp-tab'); if (TABS[t]) tab = t; }

function setTab(t) {
  tab = t;
  store('wsp-tab', t);
  render();
  if (t === 'hist') loadPosts();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

const STATE_TEXT = {
  open: 'Terhubung', pairing: 'Menunggu kode', unlinked: 'Belum terhubung',
  connecting: 'Menyambung…', error: 'Bermasalah', starting: 'Memeriksa…',
};

function render() {
  const s = wa.state;
  const needsLink = s === 'unlinked' || s === 'pairing';
  const ready = !needsLink && s !== 'starting';

  const chip = $('chip');
  chip.className = 'chip' + (offline || s === 'error' ? ' bad' : s === 'open' ? ' ok' : ' busy');
  setText($('chipText'), offline ? 'Server mati' : s === 'open' && wa.number ? `+${wa.number}` : STATE_TEXT[s] || s);
  show($('offline'), offline);

  show($('vLink'), needsLink);
  show($('codeBox'), s === 'pairing');
  if (s === 'pairing') setText($('code'), wa.pairingCode || '…');
  $('pairBtn').disabled = s === 'pairing';

  show($('tabs'), ready);
  for (const [k, id] of Object.entries(TABS)) show($(id), ready && tab === k);
  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const sending = ready && tab === 'send';
  show($('sendBar'), sending);
  document.body.classList.toggle('sending', sending);

  setText($('acctNumber'), wa.number ? '+' + wa.number : '–');
  setText($('acctState'), offline ? 'Server mati' : STATE_TEXT[s] || s);
  setText($('acctSaved'), fmtNum(wa.savedCount));
  setText($('acctOther'), fmtNum(Math.max(0, (wa.contactCount || 0) - (wa.savedCount || 0))));

  renderAlert();
  renderAudience();
  updatePostButton();
}

async function refreshState() {
  try { wa = await api('/api/state'); offline = false; } catch { offline = true; }
  render();
}
async function loop() {
  await refreshState();
  setTimeout(loop, wa.state === 'pairing' ? 1000 : 3000);
}
$('retryBtn').addEventListener('click', refreshState);

// ---------- pairing & akun ----------
$('pairBtn').addEventListener('click', async () => {
  $('pairBtn').disabled = true;
  try {
    await api('/api/pair', { method: 'POST', body: { phone: $('phone').value } });
    wa = { ...wa, state: 'pairing', pairingCode: null };
    render();
    // Kode biasanya siap dalam sekejap; jangan tunggu siklus 3 detik.
    setTimeout(refreshState, 600);
    setTimeout(refreshState, 1500);
  } catch (e) {
    flash(e.message, true);
    $('pairBtn').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  if (!confirm('Putuskan nomor ini? Kamu perlu menautkan ulang untuk mengirim lagi.')) return;
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) { flash(e.message, true); }
  refreshState();
});

// ---------- file ----------
const CODEC = { h264: 'H.264', hevc: 'H.265', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4' };

function setPreview(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|webm|3gp)$/i.test(file.name);
  show($('frameEmpty'), false);
  show($('pv'), isVideo);
  show($('pi'), !isVideo);
  setText($('frameName'), file.name);
  show($('frameName'), true);
  if (isVideo) { $('pv').src = previewUrl; $('pv').play().catch(() => {}); } else $('pi').src = previewUrl;
}

function resetFile() {
  current = null;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  $('pv').pause();
  $('pv').removeAttribute('src');
  $('pi').removeAttribute('src');
  show($('pv'), false);
  show($('pi'), false);
  show($('frameName'), false);
  show($('frameEmpty'), true);
  show($('fileInfo'), false);
  $('file').value = '';
  updatePostButton();
}

function renderInfo(info) {
  const specs = $('specs');
  specs.replaceChildren();
  const cell = (k, v) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    d.append(dt, dd);
    specs.appendChild(d);
  };
  let verdict;
  let ok = true;
  if (info.kind === 'video') {
    if (info.width) cell('Resolusi', `${info.width}×${info.height}`);
    if (info.durationSec != null) cell('Durasi', `${fmtDec(info.durationSec)} dtk`);
    cell('Ukuran', `${fmtDec(info.sizeMB)} MB`);
    if (info.vcodec) cell('Kodek', CODEC[info.vcodec] || info.vcodec.toUpperCase());
    if (info.willTranscode) {
      ok = false;
      verdict = info.compress ? 'Dikonversi dan dikecilkan supaya muat' : 'Dikonversi ke H.264 sebelum dikirim';
    } else {
      verdict = 'Dikirim apa adanya, tanpa kompresi ulang';
    }
  } else {
    cell('Jenis', 'Foto');
    cell('Ukuran', `${fmtDec(info.sizeMB)} MB`);
    verdict = 'Foto dikirim apa adanya';
  }
  const n = specs.children.length;
  // Kolom pertama (resolusi) paling panjang, beri ruang lebih.
  specs.style.gridTemplateColumns = info.kind === 'video' && n > 1 ? `1.45fr repeat(${n - 1}, 1fr)` : `repeat(${n}, 1fr)`;

  const v = $('verdict');
  v.textContent = verdict;
  v.className = 'verdict ' + (ok ? 'ok' : 'conv');

  const reasons = info.reasons || [];
  show($('techBox'), reasons.length > 0);
  $('techList').replaceChildren(...reasons.map((r) => { const li = document.createElement('li'); li.textContent = r; return li; }));

  const warns = info.warnings || [];
  setText($('infoWarn'), warns.join(' '));
  show($('infoWarn'), warns.length > 0);
  show($('fileInfo'), true);
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || '')}`);
    xhr.setRequestHeader('X-WSP', '1');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('uploadFill').style.width = `${(e.loaded / e.total) * 100}%`; };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Unggahan gagal (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Koneksi ke server terputus. Pastikan Termux masih berjalan.'));
    xhr.send(file);
  });
}

async function handleFile(file) {
  if (!file) return;
  if (!posting) $('jobArea').replaceChildren();
  note = null;
  current = null;
  setPreview(file);
  show($('fileInfo'), false);
  $('uploadFill').style.width = '0';
  show($('uploadBar'), true);
  uploading = true;
  updatePostButton();
  try {
    const r = await uploadFile(file);
    current = { id: r.id, info: r.info, name: file.name };
    renderInfo(r.info);
  } catch (e) {
    flash(e.message, true);
    resetFile();
  } finally {
    uploading = false;
    show($('uploadBar'), false);
    updatePostButton();
  }
}

$('file').addEventListener('change', () => handleFile($('file').files[0]));
$('changeFile').addEventListener('click', () => $('file').click());

// ---------- file dari tombol Bagikan (Web Share Target) ----------
async function takeSharedFile() {
  const flag = new URLSearchParams(location.search).get('shared');
  if (!flag) return;
  history.replaceState(null, '', '/');
  setTab('send');
  if (flag === 'nosw') return flash('Tombol Bagikan butuh aplikasi yang terpasang. Buka ulang aplikasinya, atau pilih file dari sini.', true);
  if (flag !== '1') return flash('File dari tombol Bagikan tidak diterima. Pilih file dari sini.', true);
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match('/shared-file');
    if (!res) return flash('File yang dibagikan tidak ditemukan. Pilih file dari sini.', true);
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get('X-File-Name') || 'video.mp4');
    await cache.delete('/shared-file');
    await handleFile(new File([blob], name, { type: blob.type }));
  } catch (e) {
    flash('Gagal membaca file yang dibagikan: ' + e.message, true);
  }
}

// ---------- audiens ----------
const MODES = ['all', 'except', 'only', 'close'];
const lists = { except: new Set(), only: new Set(), close: new Set() };
let contacts = null;
let editing = null;

function audience() {
  const el = document.querySelector('input[name=aud]:checked');
  return el ? el.value : null;
}

function audInfo(mode) {
  const saved = wa.savedCount || 0;
  if (mode === 'all') return { name: 'Kontak saya', n: saved };
  if (mode === 'except') return { name: 'Kontak saya, kecuali…', n: Math.max(0, saved - lists.except.size), approx: true };
  if (mode === 'only') return { name: 'Bagikan hanya ke…', n: lists.only.size };
  if (mode === 'close') return { name: 'Teman dekat', n: lists.close.size };
  return null;
}

function renderAudience() {
  setText($('cnt-all'), `${fmtNum(wa.savedCount)} kontak tersimpan`);
  setText($('cnt-except'), `${fmtNum(lists.except.size)} dikecualikan`);
  setText($('cnt-only'), `${fmtNum(lists.only.size)} dipilih`);
  setText($('cnt-close'), `${fmtNum(lists.close.size)} orang`);

  const m = audience();
  const btn = $('audBtn');
  if (!m) {
    setText($('audLabel'), 'Pilih audiens');
    setText($('audCount'), 'Wajib dipilih sebelum mengirim');
    btn.classList.add('need');
    return;
  }
  const i = audInfo(m);
  setText($('audLabel'), i.name);
  const big = i.n > (wa.largeAudience || 300);
  btn.classList.toggle('big', big);
  if (i.n > 0) setText($('audCount'), `${i.approx ? 'Sekitar ' : ''}${fmtNum(i.n)} penerima${big ? '. Audiens besar: risiko blokir lebih tinggi.' : ''}`);
  else if (m === 'all' || m === 'except') setText($('audCount'), 'Belum ada kontak tersimpan. Lihat tab Akun.');
  else setText($('audCount'), 'Daftarnya masih kosong. Ketuk untuk mengatur.');
  btn.classList.toggle('need', !(i.n > 0));
}

async function loadLists() {
  try {
    const l = await api('/api/lists');
    for (const k of ['except', 'only', 'close']) lists[k] = new Set(l[k] || []);
  } catch {}
  render();
}

async function saveLists() {
  const body = {};
  for (const k of ['except', 'only', 'close']) body[k] = [...lists[k]];
  try { await api('/api/lists', { method: 'POST', body }); } catch (e) { flash(e.message, true); }
  render();
}

{
  const saved = load('wsp-aud');
  if (MODES.includes(saved)) document.querySelector(`input[name=aud][value=${saved}]`).checked = true;
}
document.querySelectorAll('input[name=aud]').forEach((r) => r.addEventListener('change', () => {
  store('wsp-aud', audience());
  renderAudience();
  updatePostButton();
}));

const audSheet = $('audSheet');
$('audBtn').addEventListener('click', () => audSheet.showModal());
$('audDone').addEventListener('click', () => audSheet.close());
audSheet.addEventListener('click', (e) => { if (e.target === audSheet) audSheet.close(); });

// ---------- pemilih kontak ----------
const picker = $('picker');
const TITLES = { except: 'Kecualikan dari status', only: 'Bagikan hanya ke', close: 'Teman dekat' };

function renderPicker() {
  const q = $('pickSearch').value.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const set = lists[editing];
  const frag = document.createDocumentFragment();
  for (const c of contacts) {
    if (q && !(c.name || '').toLowerCase().includes(q) && !(digits && c.number.includes(digits))) continue;
    const li = document.createElement('li');
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = set.has(c.jid);
    cb.addEventListener('change', () => {
      if (cb.checked) set.add(c.jid); else set.delete(c.jid);
      setText($('pickCount'), `${fmtNum(set.size)} dipilih`);
    });
    const span = document.createElement('span');
    span.textContent = c.name || '+' + c.number;
    const bits = [];
    if (c.name) bits.push('+' + c.number);
    if (c.saved === false) bits.push('bukan kontak tersimpan');
    if (bits.length) { const sm = document.createElement('small'); sm.textContent = bits.join(', '); span.appendChild(sm); }
    lab.append(cb, span);
    li.appendChild(lab);
    frag.appendChild(li);
  }
  $('pickList').replaceChildren(frag);
  setText($('pickCount'), `${fmtNum(set.size)} dipilih`);
}

document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
  editing = b.dataset.edit;
  try { contacts = await api('/api/contacts'); } catch (e) { return flash(e.message, true); }
  if (!contacts.length) return flash('Belum ada kontak yang tersinkron dari WhatsApp. Tunggu beberapa menit setelah menautkan.', true);
  setText($('pickTitle'), TITLES[editing]);
  $('pickSearch').value = '';
  renderPicker();
  picker.showModal();
}));
$('pickSearch').addEventListener('input', renderPicker);
$('pickClear').addEventListener('click', () => { lists[editing].clear(); renderPicker(); });
$('pickClose').addEventListener('click', () => picker.close());
picker.addEventListener('close', saveLists);

// ---------- kirim ----------
let dest = load('wsp-dest') === 'chat' ? 'chat' : 'status';
$('target').value = load('wsp-target') || '';

function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function setDest(d) {
  dest = d;
  store('wsp-dest', d);
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dest === d)));
  show($('audBtn'), d === 'status');
  show($('chatBox'), d === 'chat');
  updatePostButton();
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setDest(b.dataset.dest)));
$('target').addEventListener('input', () => { store('wsp-target', $('target').value); updatePostButton(); });

function updatePostButton() {
  const btn = $('postBtn');
  const base = wa.state === 'open' && current && !uploading && !posting;
  const head =
    posting ? 'Mengirim…' :
    uploading ? 'Mengunggah ke server…' :
    wa.state !== 'open' ? 'Menunggu WhatsApp terhubung' : null;

  if (dest === 'chat') {
    const num = normPhone($('target').value);
    const wait = Math.ceil(((wa.chatCooldownUntil || 0) - Date.now()) / 1000);
    btn.disabled = !(base && num && wait <= 0);
    btn.textContent = head ||
      (wait > 0 ? `Bisa kirim lagi dalam ${fmtWait(wait)}` :
      !current ? 'Pilih file dulu' :
      !num ? 'Isi nomor tujuan dulu' :
      `Kirim ke +${num}`);
    return;
  }

  const m = audience();
  const i = m && audInfo(m);
  const wait = Math.ceil(((wa.cooldownUntil || 0) - Date.now()) / 1000);
  btn.disabled = !(base && i && i.n > 0 && wait <= 0);
  btn.textContent = head ||
    (wait > 0 ? `Bisa kirim lagi dalam ${fmtWait(wait)}` :
    !current ? 'Pilih file dulu' :
    !m ? 'Pilih audiens dulu' :
    !(i.n > 0) ? 'Daftar audiens masih kosong' :
    'Kirim ke Status');
}

function fmtWait(s) {
  if (s < 60) return `${s} dtk`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// Hitung mundur jeda di tombol kirim.
setInterval(() => {
  const until = Math.max(wa.cooldownUntil || 0, wa.chatCooldownUntil || 0);
  if (until > Date.now() - 1500) updatePostButton();
}, 1000);

function jobCard() {
  const box = document.createElement('div');
  box.className = 'job';
  $('jobArea').replaceChildren(box);
  return (j) => {
    const finished = j.status === 'done' || j.status === 'error';
    const confirmed = j.status === 'done' && j.result && j.result.ack !== 'none';
    const toChat = !!(j.result && j.result.number);
    box.className = 'job' + (j.status === 'done' ? ' done' : j.status === 'error' ? ' error' : '');
    box.replaceChildren();

    const t = document.createElement('div');
    t.className = 'jt';
    const title = document.createElement('span');
    title.textContent = {
      queued: 'Menunggu giliran…',
      transcoding: `Mengonversi video${j.progress != null ? ` ${j.progress}%` : ''}…`,
      sending: 'Mengirim ke WhatsApp…',
      done: !confirmed ? 'Perintah kirim selesai' : toChat ? `Terkirim ke +${j.result.number}` : 'Terkirim ke Status',
      error: 'Gagal mengirim',
    }[j.status];
    t.appendChild(title);
    if (finished) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.setAttribute('aria-label', 'Tutup');
      x.textContent = '×';
      x.addEventListener('click', () => box.remove());
      t.appendChild(x);
    }
    box.appendChild(t);

    if (j.status === 'transcoding' && j.progress != null) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.style.width = `${j.progress}%`;
      bar.appendChild(fill);
      box.appendChild(bar);
    }

    let text = '';
    if (j.status === 'done' && j.result && toChat) {
      text = j.result.ack === 'none'
        ? 'Belum ada konfirmasi dalam 12 detik. Cek chat di nomor tujuan.'
        : 'Buka chat ini di nomor tujuan, lalu teruskan ke Status saya.';
    } else if (j.status === 'done' && j.result) {
      const ack = j.result.ack === 'delivered' ? 'Sudah diterima di HP penerima.'
        : j.result.ack === 'server' ? 'Diterima server WhatsApp.'
        : 'Belum ada konfirmasi dalam 12 detik. Cek tab Status di WhatsApp.';
      text = `${fmtNum(j.result.recipients)} penerima. ${ack}`;
    } else if (j.status === 'error') {
      text = j.error;
    }
    if (text) { const p = document.createElement('p'); p.className = 'jn'; p.textContent = text; box.appendChild(p); }
  };
}

async function runJob(started) {
  const render = jobCard();
  render({ status: 'queued' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const j = await api(`/api/jobs/${started.jobId}`);
    render(j);
    if (j.status === 'done') { resetFile(); $('caption').value = ''; loadPosts(); return; }
    if (j.status === 'error') return;
  }
}

$('postBtn').addEventListener('click', async () => {
  if (!current) return;

  if (dest === 'chat') {
    posting = true;
    updatePostButton();
    try {
      const started = await api('/api/post', { method: 'POST', body: { id: current.id, caption: $('caption').value, dest: 'chat', target: $('target').value } });
      await runJob(started);
    } catch (e) {
      flash(e.message, true);
    } finally {
      posting = false;
      refreshState();
    }
    return;
  }

  const mode = audience();
  const info = audInfo(mode);
  let confirmLarge = false;
  if (info && info.n > (wa.largeAudience || 300)) {
    const ok = confirm(`Status akan dikirim ke ${info.approx ? 'sekitar ' : ''}${fmtNum(info.n)} orang sekaligus. Audiens sebesar ini lebih berisiko membuat nomor diblokir. Tetap kirim?`);
    if (!ok) return;
    confirmLarge = true;
  }
  posting = true;
  updatePostButton();
  try {
    const send = (confirmed) => api('/api/post', { method: 'POST', body: { id: current.id, caption: $('caption').value, audience: mode, confirmLarge: confirmed } });
    let started;
    try {
      started = await send(confirmLarge);
    } catch (e) {
      // Server menghitung jumlah penerima lebih besar dari perkiraan di layar.
      if (!(e.data && e.data.needsConfirm)) throw e;
      if (!confirm(`${e.message} Tetap kirim?`)) return;
      started = await send(true);
    }
    await runJob(started);
  } catch (e) {
    flash(e.message, true);
  } finally {
    posting = false;
    refreshState(); // ambil waktu jeda terbaru dari server
  }
});
setDest(dest);

// ---------- riwayat ----------
const AUD_NAME = { all: 'Kontak saya', except: 'Kontak saya, kecuali…', only: 'Bagikan hanya ke…', close: 'Teman dekat' };

async function deleteStatus(id, btn) {
  if (!confirm('Kirim perintah hapus untuk status ini?')) return false;
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/posts/delete', { method: 'POST', body: { id } });
    flash(`Perintah hapus dikirim ke ${fmtNum(r.recipients)} penerima. Cek dari HP lain beberapa saat lagi.`, false);
    return true;
  } catch (e) {
    flash(e.message, true);
    return false;
  } finally {
    if (btn) btn.disabled = false;
    loadPosts();
  }
}

async function loadPosts() {
  let list;
  try { list = await api('/api/posts'); } catch { return; }
  const box = $('hist');
  box.replaceChildren();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Belum ada status yang dikirim dari aplikasi ini.';
    box.appendChild(p);
    return;
  }
  for (const x of list.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'hrow' + (x.deleted ? ' gone' : '');
    const t = document.createElement('div');
    t.className = 't';
    const a = document.createElement('b');
    a.textContent = `${x.kind === 'video' ? 'Video' : 'Foto'} untuk ${AUD_NAME[x.audience] || x.audience}`;
    const b = document.createElement('span');
    const when = new Date(x.at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    b.textContent = x.deleted ? `${when}, perintah hapus sudah dikirim` : `${when}, ${fmtNum(x.count)} penerima${x.caption ? `, “${x.caption}”` : ''}`;
    t.append(a, b);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost small';
    btn.textContent = x.deleted ? 'Hapus lagi' : 'Hapus';
    btn.addEventListener('click', () => deleteStatus(x.id, btn));
    row.append(t, btn);
    box.appendChild(row);
  }
}

// ---------- mulai ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
takeSharedFile();
loadLists();
loadPosts();
loop();
