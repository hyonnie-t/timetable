// 설치형(PWA) 앱으로 인식되기 위한 최소 서비스워커.
// 시간표/진도 데이터가 자주 바뀌므로 오프라인 캐싱은 하지 않고,
// 모든 요청을 그대로 네트워크로 통과시킨다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
