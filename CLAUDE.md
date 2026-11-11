# timetable — 시간표 / 할 일 플래너 (PWA)

효니의 시간표·할 일 달력 앱. PWA(`manifest.json`, `service-worker.js`), 데이터는 `firebase.js`(Firebase)에 둔다. 수업 웹앱이 아니라서 history26 백엔드와 무관하다.
배포: GitHub Pages (`.github` 워크플로, `.nojekyll`).

## 구조
- `index.html` / `app.js` / `style.css` 시간표, `planner.js`·`planner-cal.js`·`planner.css` 할 일 달력(끌어놓기·늘이기)
- `engine/` 계산 로직, `tests/` 테스트(`package.json`의 스크립트로 실행), `demo/` 시연용, `icons/`·`images/`

## 규칙
- 고치기 전에 `git fetch` 후 `origin/main`에서 임시 worktree(`git worktree add <임시폴더> -b <브랜치> origin/main`)를 만들어 작업한다. 여러 세션이 이 폴더를 같이 쓰므로 공용 폴더는 `main`으로 둔다(2026-11-08).
- 작업은 기능 브랜치 → PR → 병합 흐름이다(`feature/…`, `fix/…`). `main`에 직접 푸시하지 않는다.
- 포인터 이벤트 관련 수정(끌기)은 포인터 캡처 위치를 확인한다(날짜 없음 끌기가 한 칸씩만 움직이던 문제 이력).
- 서비스 워커 캐시를 바꾸면 버전을 올려 옛 캐시가 남지 않게 한다. Firebase 설정값은 새로 적지 않는다.
- 수정 뒤 `demo/`와 배포 주소를 내장 브라우저로 직접 열어 확인한다. 테스트는 `tests/`를 먼저 돌린다.
- **history26 교사 대시보드 «📅 오늘» 탭(v134, 2026-11-02)이 이 앱을 불러 쓴다**: 같은 origin이라 `firebase.js`·`engine/progress-engine.js`·`engine/task-engine.js`를 배포 주소에서 동적 import해 오늘 수업·반별 진도·할 일을 보여 주고, 할 일 ✓/↺는 `planComplete`·`planDailyDone`·`planUndoComplete`·`planDailyUndo` + `assertPlannerPatch`로 `users/{uid}/planner`에 쓴다. 이 파일 경로·export 이름·`?tab=tasks`·planner `log/` 모양을 바꾸면 history26 `js/08-dash-today.js`도 같이 고친다.
- **시작 주소 규칙(2026-11-02)**: `?tab=today|weekly|progress|subject|tasks|settings`로 그 탭에서 시작한다. `?tab=tasks&task=ID`는 그 할 일 고치기 창, `?tab=tasks&add=글`은 빠른 입력에 미리 적기(`?tab=tasks`와 함께일 때만 동작하고, 그때 한 번 쓰고 주소에서 지움, `planner.openById`·`prefill`). 여기에 `&save=1`을 붙이면 바로 저장하고 되돌리기 줄을 띄운다(`&area=영역` 선택, `&due=YYYY-MM-DD`가 있으면 글을 해석하지 않고 제목 그대로 저장, 같은 제목의 열린 할 일이 있으면 또 넣지 않음, 실패하면 입력칸에 남김, `planner.quickSave`, 아침 브리핑 `클로드작업\도구\예약작업\briefing-render.ps1`이 쓴다). **받는 창(2026-11-10)**: 브리핑은 이 주소에 `&close=1&ref=항목번호`를 붙여 작은 팝업으로 연다. 저장이 끝나면 `window.opener`에 `{type:'timetable-inbox', ref, status: added|dup|fail, id, title, area}`를 보내고 스스로 닫힌다(fail이면 닫지 않음). `?tab=tasks&del=ID&close=1&ref=..`은 브리핑 «↺ 등록 취소»로, 만든 뒤 손대지 않은 열린 할 일만 지운다(`planner.removeById`, status removed|kept|gone|fail). 숨은 iframe은 저장소 분할 때문에 로그인을 못 읽어 쓰지 않는다. `manifest.json` shortcuts(할 일·진도표)도 이 규칙을 쓴다. 반대 방향은 `window.openHistory26('today'|'records', { cls })`가 history26 `?dash=탭&cls=반`으로 연다(관리자 화면에만: 오늘 탭 머리·수업 카드 «📘 기록»·할 일 탭 «📘 포털»·설정 «연결된 앱»). 주소 규칙을 바꾸면 history26 `js/08-dash-today.js`의 `tdDeepLink_`·`tdOpenTimetable_`도 같이 고친다.
- **바탕화면 위젯(2026-11-11)**: `?widget=1`(보통 `?tab=today&widget=1`)은 앱 화면을 숨기고 미니창(PiP)과 같은 화면(날짜·시각, 오늘 교시·지금 교시, 오늘 할 일 ✓·되돌리기, 한 줄 입력, 간단히/전체)을 창 전체에 띄운다. PiP와 위젯은 `mountPipWidget_`·`renderPipWidget`·`PIP_CSS`를 같이 쓰니 한쪽을 고치면 다른 쪽도 본다. 위젯만: ↗ 앱 열기·↻ 새로고침 버튼, 창 너비 240px 기준 최대 1.6배 확대, 로그인 풀림 안내, 20시간 넘게 켜져 있으면 스스로 새로고침, 간단히 설정은 `widgetCompact`(PiP는 `pipCompact`). 학교 PC에서는 `클로드작업\도구\시간표-위젯.ps1`이 시간표 앱에 로그인된 브라우저(웨일→크롬→엣지 순으로 찾음, 학교 PC는 웨일 Profile 1)의 `--app` 창으로 연다(창 제목 «오늘 시간표»로 찾고 자리·크기는 `%USERPROFILE%\.claude\timetable-widget.txt`)(시작프로그램 등록은 `시간표-위젯-설치.ps1`). 데모 확인은 `?demo=demo&widget=1`.
- 데모는 주소 뒤에 `?demo=demo`를 붙여 연다(`?demo`만 쓰면 값이 비어 로그인 창에서 멈춘다). 로그인 없이 `demo/demo.json`으로 화면을 띄우고 저장하지 않는다.
- **교내 행사 학급 표시(2026-11-05)**: 학사일정 표시 이름에 «교내»가 있는 `event`는 임장 지도를 위해 그 교시 수업 반을 같이 보여 준다(`PE.isInSchoolEvent`, 오늘·주차별·NOW/NEXT·작은 창·할 일 달력). 교외체험·시험·동아리는 일정 이름만 보인다. 새 교내 행사는 이름에 `(교내)`를 붙인다.
