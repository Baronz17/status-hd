// Pemeriksaan & konversi media memakai ffprobe/ffmpeg (opsional, tapi sangat disarankan).
import { spawn, spawnSync } from 'node:child_process';

export function hasBinary(name) {
  try {
    const r = spawnSync(name, ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `${cmd} keluar dengan kode ${code}`));
    });
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(out);
}

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Menilai apakah video bisa dikirim apa adanya.
 * Aturan: kirim apa adanya kalau H.264 + yuv420p + AAC (atau tanpa audio) + MP4/MOV
 * dan ukurannya di bawah batas. Selain itu, konversi.
 */
export function analyzeVideo(info, sizeBytes, maxBytes) {
  const v = info.streams?.find((s) => s.codec_type === 'video');
  const a = info.streams?.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('File ini tidak berisi stream video.');

  const duration = parseFloat(info.format?.duration ?? v.duration ?? '0') || 0;
  const container = String(info.format?.format_name || '');
  const isMp4 = /mp4|mov/.test(container);

  let width = v.width;
  let height = v.height;
  const rot = Number(v.tags?.rotate ?? v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0);
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];

  const reasons = [];
  if (v.codec_name !== 'h264') reasons.push(`codec video ${v.codec_name}, bukan H.264`);
  if (v.pix_fmt && v.pix_fmt !== 'yuv420p') reasons.push(`pixel format ${v.pix_fmt}`);
  if (a && a.codec_name !== 'aac') reasons.push(`codec audio ${a.codec_name}, bukan AAC`);
  if (!isMp4) reasons.push(`wadah ${container.split(',')[0] || 'tidak dikenal'}, bukan MP4`);

  const tooBig = sizeBytes > maxBytes;
  if (tooBig) reasons.push(`ukuran ${mb(sizeBytes)} MB melebihi batas ${mb(maxBytes)} MB`);

  const warnings = [];
  if (duration > 30.5) {
    warnings.push('Durasi lebih dari 30 detik. Belum terverifikasi apakah WhatsApp menampilkannya utuh sebagai satu status.');
  }

  return {
    kind: 'video',
    durationSec: Math.round(duration * 10) / 10,
    width,
    height,
    vcodec: v.codec_name,
    acodec: a?.codec_name ?? null,
    sizeMB: mb(sizeBytes),
    willTranscode: reasons.length > 0,
    compress: tooBig,
    reasons,
    warnings,
  };
}

/** Konversi ke H.264/AAC MP4. Tanpa batas ukuran: CRF 18. Dengan batas: bitrate target. */
export function transcode(input, output, { durationSec, maxBytes, compress, onProgress }) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  ];

  if (compress && durationSec > 0) {
    const totalBps = Math.floor((maxBytes * 8 * 0.92) / durationSec);
    const vbr = Math.max(totalBps - 128000, 400000);
    args.push('-b:v', String(vbr), '-maxrate', String(Math.floor(vbr * 1.25)), '-bufsize', String(vbr * 2));
  } else {
    args.push('-crf', '18');
  }

  args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output);

  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let err = '';
    let buf = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        // out_time_ms sebenarnya dalam mikrodetik (kekhasan ffmpeg)
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && durationSec > 0 && onProgress) {
          onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6 / durationSec) * 100)));
        }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg gagal: ' + (err.trim().split('\n').pop() || `kode ${code}`)));
    });
  });
}
