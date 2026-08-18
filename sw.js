/* 墨刃 Service Worker：網路優先，開啟時盡量拿最新章節；離線時退回快取 */
const CACHE = 'moren-v8';   // v8：章級分片（data/ch/*.json?v=指紋 改走快取優先）
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 章節檔（data/ch/NNNN.json?v=<內容指紋>）→ 快取優先：
// URL 已經帶了內容指紋，同一個 URL 的內容永遠不會變；章一改指紋就變、URL 也就變成另一個。
// 所以命中快取＝一定是對的內容，不必回頭問網路（手機開 App 只需下載真的改過的那幾章）。
function isVersionedChapter(url) {
  return url.pathname.includes('/data/ch/') && url.searchParams.has('v');
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (isVersionedChapter(url)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }))
    );
    return;
  }

  // 其餘（index.json、卷目錄、App 本體）維持網路優先：一定要拿到最新的目錄與指紋
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
