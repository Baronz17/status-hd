// Service worker: menangkap file dari tombol "Bagikan" Android (Web Share Target).
// File disimpan sementara di Cache, lalu halaman utama mengambilnya dan mengunggah ke server lokal.
const SHARE_CACHE = 'wsp-shared-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share') return;

  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const file = form.getAll('media').find((f) => f && f.size);
      if (!file) return Response.redirect('/?shared=empty', 303);
      const cache = await caches.open(SHARE_CACHE);
      await cache.put('/shared-file', new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || 'video.mp4'),
        },
      }));
      return Response.redirect('/?shared=1', 303);
    } catch {
      return Response.redirect('/?shared=error', 303);
    }
  })());
});
