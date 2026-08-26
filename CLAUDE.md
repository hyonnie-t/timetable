# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Korean-language teacher timetable and lesson-progress tracking web app. Teachers log in with Google, set up their weekly schedule, and track which lesson (차시) they are on per class/subject. The app auto-advances lesson counts based on elapsed school days when the teacher next opens the app.

## Development

No build step, no package manager, no bundler. The app is pure ES-module HTML/CSS/JS served as static files.

**Run locally** with any static file server, e.g.:
```
npx serve .
# or
python3 -m http.server 8080
```

**Deploy**: Push to `main` — GitHub Actions (`.github/workflows/static.yml`) deploys the entire repository to GitHub Pages automatically. No build step needed; the entire repo is the artifact.

There are no lint, test, or type-check commands.

## Architecture

### File layout

| File | Role |
|------|------|
| `index.html` | Shell: login screen + 4 tab containers (`#tab-today/weekly/progress/settings`) |
| `firebase.js` | Firebase SDK v10.12.0 init + re-exports (auth, db, Realtime DB helpers) |
| `app.js` | All application logic (~1 006 lines, no framework) |
| `style.css` | All styles (~21 KB), 17 named sections mirroring app sections |

Firebase is imported via CDN ESM URLs (`https://www.gstatic.com/firebasejs/10.12.0/…`), so no `npm install` is ever needed.

### State model (`app.js` top-level globals)

```
currentUser   – Firebase Auth user object (null when logged out)
userProfile   – { name, email, role: 'admin'|'teacher', invitedBy? }
userData      – { timetable: { schedule, periods }, progress, curriculum }
schoolData    – { calendar }
currentTab    – 'today' | 'weekly' | 'progress' | 'settings'
```

### Firebase Realtime Database schema

```
users/{uid}/profile               { name, email, role, invitedBy? }
users/{uid}/timetable/schedule    { mon|tue|…|fri: { 1..N: { class, subject } } }
users/{uid}/timetable/periods     { 1..N: { start: "HH:MM", end: "HH:MM" } }
users/{uid}/progress/{cls_subj}   { current: N, lastUpdated: "YYYY-MM-DD" }
users/{uid}/curriculum/{cls_subj}/{stepN}  "topic string"
school/calendar                   { "YYYY-MM-DD": { "1"|…|"N"|"all": { type, label } } }
```

**Progress key** is `{class}_{subject}` (e.g. `308_역사`). This key is used consistently across `progress`, `curriculum`, and DOM `data-key` attributes.

**Calendar period key** can be a specific period number string (`"1"`, `"3"`) or `"all"` to affect the entire day.

### Rendering flow

1. `onAuthStateChanged` → creates/loads profile → `loadUserData()` fetches `users/{uid}` + `school` in parallel.
2. `autoUpdateProgress()` scans every date from each class's `lastUpdated` up to now, increments `current` for periods whose end time has passed, and skips `holiday`/`noclass` calendar events.
3. `renderCurrentTab()` dispatches to `renderToday / renderWeekly / renderProgress / renderSettings`.
4. All UI is built with `innerHTML` string concatenation and `insertAdjacentHTML`; no virtual DOM or framework.

### Auto-progress logic (important)

`autoUpdateProgress()` runs on every login. It iterates over all `progress` keys, finds the earliest `lastUpdated` date, then walks day-by-day up to now. For each day it checks:
- Is there a scheduled class for that period?
- If today: has the period's end time passed?
- Does the school calendar mark that day/period as `holiday` or `noclass`? → skip

Both `holiday` and `noclass` suppress the lesson-count increment. Other types (`event`, `exam`, `club`) do **not** suppress it — they only show a badge in the UI.

### Modal pattern

Modals are injected into `<body>` via:
```js
document.body.insertAdjacentHTML('beforeend', html);
```
Each modal has a unique `id`. Close with `window.closeModal(id)` which calls `document.getElementById(id)?.remove()`. No modal state is kept globally — removing the element is the full teardown.

### Global `window.*` function convention

All functions called from inline `onclick="window.foo()"` attributes must be assigned to `window.*`. This is the only way inline handlers work with ES modules (which have their own scope). Every interactive handler in rendered HTML follows this pattern.

**Full list of `window.*` functions in `app.js`:**

| Function | Purpose |
|---|---|
| `toggleEditor(p)` | Toggles the inline edit panel on a period card |
| `adjustStep(p, delta)` | Increments/decrements lesson counter; auto-fills topic from curriculum |
| `saveStep(p)` | Saves updated step + topic to Firebase and updates local state |
| `weekSwitch(idx)` | Switches week view (0=this, 1=next, 2=week after); defined as closure inside `renderWeekly()` |
| `openTimetableEditor()` | Opens the timetable grid modal |
| `saveTimetable()` | Saves schedule to Firebase; initializes `progress` for new class/subject pairs |
| `openPeriodsEditor()` | Opens the period-time editor modal |
| `savePeriods()` | Saves period times to Firebase |
| `addPeriodRow()` | Adds a new period row (auto-calculates start = last-end + 10 min, duration 45 min) |
| `reindexPeriods()` | Renumbers all period rows after a deletion |
| `openCalendarEditor()` | Opens school calendar modal (admin only) |
| `addCalRow()` | Adds a new calendar entry row |
| `saveCalendar()` | Saves calendar to `school/calendar` (shared across all users) |
| `closeModal(id)` | Removes modal element from DOM by ID |
| `copyInviteLink()` | Writes `?invite={uid}` URL to clipboard |
| `handleSignIn()` | Triggers Google popup authentication |
| `handleSignOut()` | Signs out via Firebase |
| `switchTab(tab)` | Switches active tab (also exported as `window.switchTab = switchTab`) |

Note: `weekSwitch` is the only `window.*` function defined inside another function (`renderWeekly`). It is re-assigned every time the weekly tab renders.

### Admin vs teacher

`ADMIN_EMAIL` constant at `app.js:13` controls who gets `role: 'admin'` on first sign-in. Admins see an extra "학사일정 관리" section in Settings. Admin writes to `school/calendar`, which is **shared across all users** and read by everyone during `autoUpdateProgress()`.

To change the admin, update `ADMIN_EMAIL` — role assignment only happens at first sign-in, so existing users are unaffected unless their profile is deleted from Firebase.

### Invite system

Visiting `?invite={uid}` stores `invitedBy` in `sessionStorage`. On first sign-in the new user's profile records `invitedBy: uid`. The link is generated by `window.copyInviteLink()` using `currentUser.uid`.

### Default period times

If `userData.timetable.periods` is empty, `getPeriods()` returns hardcoded defaults (periods 1–7, starting 09:00). New users see these defaults until they save custom times.

### CSS organization

`style.css` uses CSS custom properties defined in `:root` (no dark mode — single light theme). Google Fonts loads Noto Sans KR (body) and Space Mono (logo). Sections (in order): 로그인, 앱 레이아웃, 탭 네비게이션, 헤더, 배너, 교시 카드, 이벤트 뱃지, 주차별 탭, 진도표 탭, 설정 탭, 모달, 시간표 편집기, 교시 시간 편집기, 학사일정 편집기, 공통 버튼, 토스트, 애니메이션. Two `@media (min-width: 480px)` blocks inside the modal section add responsive padding.

### Toast notifications

`showToast(msg, isErr = false)` sets text and class on `#toast`, then removes the `show` class after 2 500 ms. Error toasts add the `.error` class. Only one toast is visible at a time; a new call cancels the previous timer.
