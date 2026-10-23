# timetable — 시간표 / 할 일 플래너 (PWA)

효니의 시간표·할 일 달력 앱. PWA(`manifest.json`, `service-worker.js`), 데이터는 `firebase.js`(Firebase)에 둔다. 수업 웹앱이 아니라서 history26 백엔드와 무관하다.
배포: GitHub Pages (`.github` 워크플로, `.nojekyll`).

## 구조
- `index.html` / `app.js` / `style.css` 시간표, `planner.js`·`planner-cal.js`·`planner.css` 할 일 달력(끌어놓기·늘이기)
- `engine/` 계산 로직, `tests/` 테스트(`package.json`의 스크립트로 실행), `demo/` 시연용, `icons/`·`images/`

## 규칙
- 작업은 기능 브랜치 → PR → 병합 흐름이다(`feature/…`, `fix/…`). `main`에 직접 푸시하지 않는다.
- 포인터 이벤트 관련 수정(끌기)은 포인터 캡처 위치를 확인한다(날짜 없음 끌기가 한 칸씩만 움직이던 문제 이력).
- 서비스 워커 캐시를 바꾸면 버전을 올려 옛 캐시가 남지 않게 한다. Firebase 설정값은 새로 적지 않는다.
- 수정 뒤 `demo/`와 배포 주소를 내장 브라우저로 직접 열어 확인한다. 테스트는 `tests/`를 먼저 돌린다.
