// Guarda a "casca" do app para abrir rápido, mesmo com sinal fraco.
// Os dados (/api) sempre vêm do servidor.
const CACHE = 'guincho-v116';
const SHELL = ['/', '/index.html', '/manutencao.html', '/app.js', '/style.css', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/webhook')) return;
  const navigate = event.request.mode === 'navigate';
  // Downloads e PDFs abertos direto (planilha, backup, invoice, gate pass): nunca vêm do cache,
  // mas com o servidor fora do ar mostram o aviso de manutenção no lugar do erro da Render.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/arquivo')) {
    if (!navigate) return;
    const maintenance = () => caches.match('/manutencao.html');
    event.respondWith(
      fetch(event.request)
        .then((res) => (res.status >= 502 && res.status <= 504 ? maintenance().then((hit) => hit || res) : res))
        .catch(() => maintenance().then((hit) => hit || Response.error()))
    );
    return;
  }
  // Rede primeiro; se cair, usa o que está guardado. Servidor fora do ar (502/503/504, ex.: durante
  // uma atualização): a página aberta vira o aviso de manutenção, e o resto vem do que está guardado.
  const down = (res) => res.status >= 502 && res.status <= 504;
  const fallback = () =>
    navigate
      ? caches.match('/manutencao.html').then((hit) => hit || caches.match('/index.html'))
      : caches.match(event.request).then((hit) => hit || caches.match('/index.html'));
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (down(res)) return fallback().then((hit) => hit || res);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/index.html')))
  );
});

// Notificação de serviço novo, mesmo com o app fechado.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || '🔔 Serviço novo', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      renotify: true,
      vibrate: [300, 150, 300, 150, 300],
      data: { url: data.url || '/#/servicos' },
    })
  );
});

// Tocar na notificação abre o app no serviço (usa a janela que já estiver aberta).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#/servicos', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) return win.navigate(url).then((w) => (w || win).focus()).catch(() => win.focus());
      return self.clients.openWindow(url);
    })
  );
});
