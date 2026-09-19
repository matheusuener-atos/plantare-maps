/* Service worker do Plantare Maps.
   - Página: rede primeiro (sempre a versão nova); sem internet, abre a última guardada.
   - Ícones e manifesto: do cache.
   - Outros domínios (mapa, Pix, bibliotecas) passam direto: nada de pagamento em cache.
   VERSAO é trocada a cada publicação (montar.mjs), o que limpa o cache antigo. */
const VERSAO = '__VERSAO__';
const CACHE = 'plantare-' + VERSAO;
const BASE = ['/', '/site.webmanifest', '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/android-chrome-192x192.png', '/android-chrome-512x512.png', '/maskable-512x512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('plantare-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put('/', copia)); return r; })
      .catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});
