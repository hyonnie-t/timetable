// 설치형(PWA) 앱으로 인식되기 위한 서비스워커.
// 시간표/진도 데이터와 우리 코드는 자주 바뀌므로 캐싱하지 않고 네트워크로 통과시킨다.
// 단, 버전이 주소에 박혀 바뀔 일이 없는 Firebase 라이브러리(gstatic)만 이 기기에 저장해 두고 바로 꺼내 쓴다.
const LIB_CACHE = 'tt-lib-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname !== 'www.gstatic.com' || !u.pathname.startsWith('/firebasejs/')) return;
  e.respondWith(caches.open(LIB_CACHE).then(async (cache) => {
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  }));
});
