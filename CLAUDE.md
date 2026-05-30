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

**Deploy**: Push to `main` — GitHub Actions (`.github/workflows/static.yml`) deploys the entire repository to GitHub Pages automatically.

There are no lint, test, or type-check commands.

## Architecture

### File layout

| File | Role |
|------|------|
| `index.html` | Shell: login screen + 4 tab containers (`#tab-today/weekly/progress/settings`) |
| `firebase.js` | Firebase init + re-exports (auth, db, Realtime DB helpers) |
| `app.js` | All application logic (~1 000 lines, no framework) |
| `style.css` | All styles |

### State model (`app.js` top-level globals)

```
currentUser   – Firebase Auth user object
userProfile   – { name, email, role: 'admin'|'teacher', invitedBy? }
userData      – { timetable: { schedule, periods }, progress, curriculum }
schoolData    – { calendar }
currentTab    – 'today' | 'weekly' | 'progress' | 'settings'
```

### Firebase Realtime Database schema

```
users/{uid}/profile               { name, email, role, invitedBy? }
users/{uid}/timetable/schedule    { mon|tue|…|fri: { 1..7: { class, subject } } }
users/{uid}/timetable/periods     { 1..N: { start: "HH:MM", end: "HH:MM" } }
users/{uid}/progress/{cls_subj}   { current: N, lastUpdated: "YYYY-MM-DD" }
users/{uid}/curriculum/{cls_subj}/{stepN}  "topic string"
school/calendar                   { "YYYY-MM-DD": { "1"|…|"all": { type, label } } }
```

The progress key is `{class}_{subject}` (e.g. `308_역사`).

### Rendering flow

1. `onAuthStateChanged` → `loadUserData()` fetches `users/{uid}` + `school` in parallel.
2. `autoUpdateProgress()` scans every past school day since `lastUpdated` and increments `current` for periods whose end time has passed, skipping calendar events marked `holiday` or `noclass`.
3. `renderCurrentTab()` dispatches to one of `renderToday / renderWeekly / renderProgress / renderSettings`.
4. All UI is built with `innerHTML` string concatenation and DOM `insertAdjacentHTML`; no virtual DOM or framework.

### Modal pattern

Modals are injected into `<body>` via `insertAdjacentHTML('beforeend', html)` and removed with `element.remove()` on close. Each modal has an `id` passed to `window.closeModal(id)`.

### Global window functions

Interactive elements use inline `onclick="window.foo()"` handlers. Every function that needs to be callable from HTML is explicitly assigned to `window.*` (e.g. `window.switchTab`, `window.saveStep`, `window.openTimetableEditor`).

### Admin vs teacher

`ADMIN_EMAIL` constant (`app.js:13`) controls who gets `role: 'admin'`. Admins see an extra "학사일정 관리" section in Settings that writes to `school/calendar`, which is shared across all users.

### Invite system

Sharing `?invite={uid}` in the URL stores `invitedBy` in `sessionStorage`; on first sign-in the new user's profile records which teacher invited them.
