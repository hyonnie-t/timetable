import {
  auth, db, googleProvider,
  ref, get, set, update, onValue,
  signInWithPopup, signOut, onAuthStateChanged
} from './firebase.js';
import * as PE from './engine/progress-engine.js';

// ============================================================
// 상수
// ============================================================
const DOW_KO  = ['일','월','화','수','목','금','토'];
const DOW_KEY = ['sun','mon','tue','wed','thu','fri','sat'];
const ADMIN_EMAIL = '0000.yhshin@gmail.com';
// 새 학기 데이터를 처음 만들 때 쓰는 학기 — 학기 바뀔 때 여기만 수정
// (이미 만든 데이터는 users/{uid}/v2/semester 에 저장된 값을 쓴다)
const DEFAULT_SEMESTER = { id: '2026-2', start: '2026-08-18', end: '2027-01-08' };
// 진도 데이터 v2 뿌리. v1(users/{uid}/progress 등)은 읽기만 하고(처음 옮길 때) 쓰지 않는다.
// 옛 버전 앱이 v1에 써도 v2 진도에는 아무 영향이 없다.
const dataRoot = () => `users/${currentUser.uid}/v2`;
// ?demo  → demo/demo.json 으로 로그인·DB 없이 열기 (화면 확인용, 저장은 메모리에만)
const DEMO = new URLSearchParams(location.search).get('demo');
// 기말고사 D-차시 표시 대상 — 학기 바뀔 때 여기만 수정
// includeStart: 시험 첫날 수업도 세는지 (2학년은 첫날이 시험이라 수업 없음 → false)
const FINAL_EXAM_GROUPS = [
  { label: '3학년',   subject: '역사',  start: '2026-10-28', includeStart: true,  classes: ['305', '306', '307', '308'] },
  { label: '2학년 A', subject: '역사A', start: '2026-12-14', includeStart: false, classes: ['201 A', '202 A', '203 A'] },
  { label: '2학년 B', subject: '역사B', start: '2026-12-14', includeStart: false, classes: ['201 B', '202 B', '203 B', '204 B'] },
];

// ============================================================
// 상태
// ============================================================
let currentUser  = null;
let userProfile  = null;
let userData     = null;
let schoolData   = null;
let currentTab   = 'today';
let todayRefreshTimer = null;
let pipWindow      = null;
let pipRefreshTimer = null;
let lastKnownDateStr  = null; // 날짜 넘어감 감지용 (자정을 넘기면 차시를 새 날짜 기준으로 다시 그리게)
let dateRolloverTimer = null;
let lastRefreshAt      = 0;     // 서버에서 마지막으로 데이터를 읽어온 시각 (여러 기기 동기화용)
let refreshing         = false;

// ============================================================
// 유틸: 시간 → 분
// ============================================================
function toMin(h, m) { return h * 60 + m; }

function parseTimeToMin(str) {
  if (!str) return 0;
  const [h, m] = str.split(':').map(Number);
  return toMin(h, m);
}

function minToStr(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function dateToStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function getWeekDates(offsetWeeks = 0) {
  const now  = new Date();
  const dow  = now.getDay();
  const mon  = new Date(now);
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1) + offsetWeeks * 7);
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
}

// ============================================================
// 교시 유틸
// ============================================================
const DEFAULT_PERIODS = {
  1: { start: '09:00', end: '09:45' },
  2: { start: '09:55', end: '10:40' },
  3: { start: '10:50', end: '11:35' },
  4: { start: '11:45', end: '12:30' },
  5: { start: '13:20', end: '14:05' },
  6: { start: '14:15', end: '15:00' },
  7: { start: '15:10', end: '15:55' },
};

// DB가 배열([null, {...}])로 돌려줘도 { 1: {...} } 모양으로 쓴다
function cleanPeriods_(p) {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) if (v?.start && v?.end && Number(k) > 0) out[k] = v;
  return out;
}

function getPeriods() {
  const p = cleanPeriods_(userData?.periods);
  return Object.keys(p).length ? p : DEFAULT_PERIODS;
}

function getCurrentPeriod() {
  const periods = getPeriods();
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const [p, t] of Object.entries(periods)) {
    const s = parseTimeToMin(t.start);
    const e = parseTimeToMin(t.end);
    if (cur >= s && cur <= e) return Number(p);
  }
  return null;
}

function getNextPeriod(schedule) {
  const periods = getPeriods();
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const sorted = Object.keys(periods).map(Number).sort((a,b) => a-b);
  for (const p of sorted) {
    const s = parseTimeToMin(periods[p].start);
    if (s > cur && schedule[p]) return p;
  }
  return null;
}

function formatPeriodTime(p) {
  const periods = getPeriods();
  const t = periods[p];
  if (!t) return '';
  return `${t.start}~${t.end}`;
}

// ============================================================
// 진도 — 계산은 모두 engine/progress-engine.js 가 한다 (테스트: tests/)
// ============================================================
// userData = v2 데이터 { semester, periods, timetables, dayOverrides, specials, pins, curriculum, lessonNotes, classNotes, log, devices }
//            + calendar(school/calendar, 저장하지 않음)
// userData를 바꾸는 길은 setData_() 하나뿐이고, 바뀔 때마다 dataRev가 올라가 장부 캐시가 버려진다.
// DB에 쓰는 길은 commit_() 하나뿐이다 (v2 뿌리 아래 경로만 쓴다).
let dataRev = 0;
const ledgerCache = new Map();
let healthCache = null;

function setData_(d) {
  // 새 학기 시작처럼 주제·메모를 통째로 비우면 DB에서 칸이 사라지므로 빈 객체로 채워 둔다
  userData = { curriculum: {}, lessonNotes: {}, classNotes: {}, ...d };
  dataRev++;
}

function ledger(key) {
  const c = ledgerCache.get(key);
  if (c && c.rev === dataRev) return c.rows;
  const rows = PE.buildLedger(userData, key);
  ledgerCache.set(key, { rev: dataRev, rows });
  return rows;
}

function health() {
  const today = todayStr();
  if (healthCache?.rev === dataRev && healthCache.today === today) return healthCache.issues;
  let issues;
  try { issues = PE.checkHealth(userData, { today }); }
  catch (e) { issues = [{ level: 'error', code: 'check-failed', msg: '자체 점검 실패: ' + e.message }]; }
  healthCache = { rev: dataRev, today, issues };
  return issues;
}

function nowPos_() {
  const n = new Date();
  return { date: todayStr(), min: n.getHours() * 60 + n.getMinutes() };
}

// 오늘 적용되는 주간 시간표 (진도표 탭·시간표 편집기·진단에서 "지금 시간표"로 쓴다)
// 새 학기를 미리 시작해 둔 경우(오늘이 학기 시작 전)는 학기 첫 시간표
function semesterToday_() {
  const t = todayStr(), s = userData.semester?.start;
  return s && t < s ? s : t;
}

function currentWeek() {
  const v = PE.timetableVersionOn(userData, semesterToday_());
  return v ? (userData.timetables[v] || {}) : {};
}

// 그날 하루만 바꾼 시간표가 있으면 그것, 없으면 그날 적용되는 시간표 버전의 요일
function daySchedule(dateStr) {
  return PE.scheduleOn(userData, dateStr);
}

function getCalendarEvent(dateStr, periodStr) {
  // 학년별 일정(예: 3학년 기말고사)은 그 교시 수업 반의 학년으로 가려 본다
  return PE.calendarEvent(userData, dateStr, periodStr, daySchedule(dateStr)[periodStr]?.class);
}

// 특별 수업(자습·다른 내용 등 진도에 안 들어가는 수업) — specials/{날짜}/{교시} = { key, label }
function getSpecialLesson(dateStr, p, key) {
  return PE.specialAt(userData, dateStr, p, key);
}

// 기말고사까지(오늘 포함) 남은 역사 수업 차시 — 학사일정 예외 자동 반영
function remainingLessonsUntilExam(cls, g) {
  const key = PE.lessonKey(cls, g.subject);
  return PE.remainingUntil(userData, key, todayStr(), g.start, g.includeStart, ledger(key));
}

function parseDateStr_(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// dateStr p교시 수업이 몇 차시인지 (정규 수업이 아니면 null)
function lessonStep(key, dateStr, p) {
  return PE.stepAt(userData, key, dateStr, p, ledger(key));
}

// 아직 안 끝난 가장 가까운 key 수업 (지금 진행 중인 수업 포함). 없으면 null
function nextLesson(key) {
  return PE.nextLesson(userData, key, nowPos_(), ledger(key));
}

// 지금 기준 "다음 수업" 차시 (진도표·수업 주제 탭 표시용)
function nextStep(key) {
  return PE.nextStep(userData, key, nowPos_(), ledger(key));
}

function lessonLabel(n) {
  if (!n) return '';
  const d = parseDateStr_(n.date);
  return `${n.date === todayStr() ? '오늘' : `${d.getMonth() + 1}/${d.getDate()}(${DOW_KO[d.getDay()]})`} ${n.p}교시`;
}

// 시간표 칸 하나(그날 p교시 수업)를 화면에 그릴 때 필요한 정보
// 특별 수업이면 차시를 세지 않으므로 step·topic이 없다
function lessonCellInfo(dateStr, p, cell) {
  const key     = PE.cellKey(cell);
  const special = getSpecialLesson(dateStr, p, key);
  if (special) return { key, special, step: null, topic: '' };
  const step = lessonStep(key, dateStr, p);
  return { key, special: null, step, topic: userData.curriculum?.[key]?.[step] || '' };
}

// ============================================================
// 저장 — patch(v2 뿌리 기준 경로 → 값)를 DB에 쓰고 메모리에도 같은 patch를 반영한다.
// log를 주면 변경 이력(log/)도 같은 patch에 얹는다 (설정 > 데이터 진단에서 확인).
// ============================================================
const APP_BUILD = '2026-10-19-engine2';   // 낡은 app.js가 캐시된 기기를 가려내는 용도 — 배포할 때 바꾼다
const LOG_MAX = 80;
let lastDeviceBeatAt = 0;

function deviceInfo() {
  let id = 'noid';
  try {
    id = localStorage.getItem('ttDeviceId') || '';
    if (!id) { id = Math.random().toString(36).slice(2, 6); localStorage.setItem('ttDeviceId', id); }
  } catch (e) { id = 'noid'; }
  const label = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? '폰' : 'PC';
  return { id, label };
}

function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${todayStr()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 이력 한 줄 + 오래된 이력 정리 + 이 기기의 마지막 접속(빌드 포함)을 patch에 얹는다
function withHousekeeping_(patch, log) {
  const out = { ...patch };
  const dev = deviceInfo();
  if (log) {
    out[`log/${Date.now()}_${Math.random().toString(36).slice(2, 5)}`] =
      { t: nowStamp(), dev: `${dev.label}·${dev.id}`, build: APP_BUILD, src: log.src, key: log.key || '', n: log.n || '' };
  }
  const ids = Object.keys(userData?.log || {});
  if (ids.length > LOG_MAX) {
    ids.sort((a, b) => (userData.log[a].t || '').localeCompare(userData.log[b].t || ''))
       .slice(0, ids.length - LOG_MAX).forEach(id => { out[`log/${id}`] = null; });
  }
  if (Date.now() - lastDeviceBeatAt > 5 * 60 * 1000) {
    lastDeviceBeatAt = Date.now();
    out[`devices/${dev.id}`] = { label: dev.label, t: nowStamp(), build: APP_BUILD };
  }
  return out;
}

async function commit_(patch, log) {
  const full = withHousekeeping_(patch, log);
  if (!Object.keys(full).length) return;
  if (!DEMO) {
    const abs = {};
    for (const [k, v] of Object.entries(full)) abs[`${dataRoot()}/${k}`] = v;
    await update(ref(db), abs);
  }
  setData_(PE.applyPatch(userData, full));
}

// ============================================================
// 데이터 로드
// ============================================================
async function fetchDemoData_() {
  const name = /^[a-z0-9-]+$/.test(DEMO) ? DEMO : 'demo';
  const res  = await fetch(`demo/${name}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`demo/${name}.json ${res.status}`);
  const data = await res.json();
  return { v2: data, calendar: data.calendar || {} };
}

// v2가 아직 없으면(처음 여는 사용자) v1 데이터를 v2로 옮겨 한 번 저장한다. 옮긴 결과 보고서도 같이 남긴다.
async function ensureV2_(calendar) {
  const v1 = (await get(ref(db, `users/${currentUser.uid}`))).val() || {};
  if (v1.v2) return v1.v2; // 그 사이 다른 기기가 먼저 옮김
  let v2, report = [];
  if (v1.timetable?.schedule || v1.progress?.[DEFAULT_SEMESTER.id]) {
    ({ data: v2, report } = PE.migrateFromV1(v1, {
      semesterId: DEFAULT_SEMESTER.id,
      semester: { start: DEFAULT_SEMESTER.start, end: DEFAULT_SEMESTER.end },
      calendar, today: todayStr(),
    }));
  } else {
    v2 = { engineVersion: PE.ENGINE_VERSION, semester: { ...DEFAULT_SEMESTER }, periods: DEFAULT_PERIODS, timetables: {} };
  }
  v2.migration = { at: nowStamp(), build: APP_BUILD, report };
  await set(ref(db, dataRoot()), v2);
  return v2;
}

async function loadUserData() {
  if (!currentUser) return;

  let v2, calendar;
  if (DEMO) {
    ({ v2, calendar } = await fetchDemoData_());
  } else {
    const [v2Snap, calSnap] = await Promise.all([
      get(ref(db, dataRoot())),
      get(ref(db, 'school/calendar'))
    ]);
    calendar = calSnap.val() || {};
    v2 = v2Snap.exists() ? v2Snap.val() : await ensureV2_(calendar);
  }

  schoolData = { calendar };
  setData_({ curriculum: {}, lessonNotes: {}, classNotes: {}, ...v2, calendar });

  lastKnownDateStr = todayStr();
  lastRefreshAt    = Date.now();
  renderCurrentTab();
  // 이 기기 접속 기록·오래된 이력 정리 (실패해도 화면에는 영향 없음)
  commit_({}).catch(e => console.warn('접속 기록 저장 실패', e));
}

// ============================================================
// 날짜 넘어감 감지 + 다른 기기 변경 반영
// ============================================================
// 폰과 PC처럼 여러 기기에서 열어두면 한쪽 메모리의 데이터가 낡은 채로 남는다.
// 낡은 값을 기준으로 +1 계산해 저장하면 다른 기기에서 수동으로 고친 차시를
// 덮어쓰므로, 탭이 다시 보이거나 포커스를 받을 때(최소 1분 간격) 서버에서
// 최신 데이터를 다시 읽는다. (진도는 자동 저장하지 않으므로 다른 기기 값을 덮어쓸 일은 없다)
// 입력 중(편집기·모달·입력창)에는 화면이 다시 그려지며 입력이 날아가므로 건너뛴다.
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;

function isEditingNow() {
  const a = document.activeElement;
  return !!document.querySelector('.step-editor.open, .modal-overlay')
    || !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

async function refreshFromServer() {
  if (DEMO || !currentUser || !userData || refreshing || isEditingNow()) return;
  refreshing = true;
  try {
    await loadUserData();
    if (pipWindow) renderPipWidget();
  } catch (e) {
    console.error('서버 데이터 새로고침 실패', e);
  } finally {
    refreshing = false;
  }
}

// ============================================================
// 새 버전 자동 반영 — 홈 화면 앱·백그라운드 탭은 새로고침 없이 옛 app.js를 계속 쓴다
// 이 페이지가 쓰는 app.js(브라우저 캐시본)와 서버의 최신 app.js 내용을 비교해서 다르면 새로고침한다.
// 빌드 번호를 손으로 올릴 필요 없이 파일 내용 자체를 비교한다.
// ============================================================
let codeSigAtStart = null;   // 이 페이지가 시작될 때 쓰던 app.js의 서명
let lastCodeCheckAt = 0;

function textSig_(t) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return `${t.length}:${h}`;
}

// 화면 코드가 여러 파일이라 app.js 하나만 보면 나머지가 바뀐 걸 못 알아챈다 → 모두 합쳐서 서명한다
// (app.js 만 꼭 있어야 하고, 나머지는 없거나 못 받아도 넘어간다)
const CODE_FILES = ['app.js', 'planner.js', 'planner-cal.js', 'engine/progress-engine.js', 'engine/task-engine.js'];

async function fetchCodeSig_(fresh) {
  const texts = await Promise.all(CODE_FILES.map(async (f, i) => {
    try {
      const res = await fetch(f, fresh ? { cache: 'no-store' } : undefined);
      if (res.ok) return await res.text();
    } catch (e) { if (i === 0) throw e; }
    if (i === 0) throw new Error('app.js 를 받지 못했습니다');
    return '';
  }));
  return textSig_(texts.join('\u0000'));
}

function reloadForUpdate_() {
  // 새로고침해도 같은 상태가 이어질 때 무한 반복하지 않게 60초에 한 번만
  try {
    const last = Number(sessionStorage.getItem('ttCodeReloadAt') || 0);
    if (Date.now() - last < 60 * 1000) return;
    if (isEditingNow()) return; // 입력 중이면 이번엔 건너뛰고 다음 확인 때
    sessionStorage.setItem('ttCodeReloadAt', String(Date.now()));
  } catch (e) { /* 저장소 막힌 환경이면 그냥 진행 */ }
  console.info('새 버전을 받아 새로고침합니다');
  location.reload();
}

async function checkCodeUpdate_() {
  try {
    if (Date.now() - lastCodeCheckAt < 5 * 60 * 1000) return;
    lastCodeCheckAt = Date.now();
    if (codeSigAtStart === null) {
      // 첫 확인: 지금 쓰는 캐시본과 서버 최신본이 이미 다르면 바로 새로고침
      const [cached, fresh] = await Promise.all([fetchCodeSig_(false), fetchCodeSig_(true)]);
      codeSigAtStart = cached;
      if (cached !== fresh) reloadForUpdate_();
      return;
    }
    if (await fetchCodeSig_(true) !== codeSigAtStart) reloadForUpdate_();
  } catch (e) { /* 오프라인 등은 조용히 넘어간다 */ }
}

async function checkDateRollover() {
  checkCodeUpdate_(); // 로그인 전이어도 옛 코드는 새로고침한다 (기다리지 않음)
  if (!currentUser || !userData) return;
  const cur = todayStr();
  if (lastKnownDateStr && cur !== lastKnownDateStr) {
    lastKnownDateStr = cur;
    // 날짜가 넘어가면 다시 그리기만 하면 차시가 새 날짜 기준으로 계산된다
    renderCurrentTab();
    if (pipWindow) renderPipWidget();
    lastRefreshAt = 0;
  }
  if (Date.now() - lastRefreshAt > REFRESH_MIN_INTERVAL_MS) await refreshFromServer();
}

// ============================================================
// 할 일 (관리자 전용) — planner.js 는 로그인 뒤에 따로 불러온다.
// 정적 import 가 아니라서 그 파일에 문제가 있어도 시간표는 그대로 뜨고, 할 일 탭만 안 생긴다.
// 저장 위치는 users/{uid}/planner/ (진도 데이터 v2 와 분리 — 새 학기를 시작해도 지워지지 않는다)
// ============================================================
let planner = null;

async function startPlanner_() {
  if (planner || !currentUser || userProfile?.role !== 'admin') return;
  try {
    const mod = await import('./planner.js');
    if (planner || !currentUser) return;   // 불러오는 사이 로그아웃·중복 호출
    planner = mod.createPlanner({
      uid: currentUser.uid,
      demo: !!DEMO,
      getSchoolData: () => userData,
      toast: showToast,
    });
    document.getElementById('tab-btn-tasks').style.display = '';
    const want = new URLSearchParams(location.search).get('tab');
    if (want === 'tasks' && currentTab === 'today') switchTab('tasks');   // ?tab=tasks → 브라우저 시작 페이지로 쓸 수 있게
    else if (currentTab === 'tasks') planner.render();
  } catch (e) {
    console.error('할 일 기능을 불러오지 못했어요', e);
  }
}

function stopPlanner_() {
  if (planner) { planner.destroy(); planner = null; }
  const btn = document.getElementById('tab-btn-tasks');
  if (btn) btn.style.display = 'none';
  if (currentTab === 'tasks') switchTab('today');
}

// ============================================================
// 탭 전환
// ============================================================
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  ['today','weekly','progress','subject','tasks','settings'].forEach(t => {
    const el = document.getElementById(`tab-${t}`);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  renderCurrentTab();
}

function renderCurrentTab() {
  if (currentTab === 'tasks') { planner?.render(); return; }   // 할 일은 시간표 데이터 없이도 그린다
  if (!userData) return;
  if (currentTab === 'today')    renderToday();
  if (currentTab === 'weekly')   renderWeekly();
  if (currentTab === 'progress') renderProgress();
  if (currentTab === 'subject')  renderSubject();
  if (currentTab === 'settings') renderSettings();
}

// ============================================================
// 학급 메모 (classNotes) — 차시 진도와 무관하게 반별로 상시 유지되는 메모
// 오늘 탭 / 진도표 탭에서 공통으로 사용
// ============================================================
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderClassNoteBlock(key) {
  const noteText = userData.classNotes?.[key]?.text || '';
  const safeKey  = escapeHtml(key);
  return `
    <div class="classnote-wrap${noteText ? ' has-note' : ''}" data-classnote-key="${safeKey}">
      <div class="classnote-view" data-classnote-action="edit" data-classnote-key="${safeKey}">
        <span class="classnote-text">🗒 ${noteText ? escapeHtml(noteText) : '학급 메모 없음 (탭해서 입력)'}</span>
      </div>
      <div class="classnote-edit">
        <textarea class="classnote-input" placeholder="학급 메모 (상시, 차시와 무관)">${escapeHtml(noteText)}</textarea>
        <div class="classnote-edit-actions">
          <button class="classnote-cancel-btn" data-classnote-action="cancel" data-classnote-key="${safeKey}">취소</button>
          <button class="classnote-save-btn" data-classnote-action="save" data-classnote-key="${safeKey}">저장</button>
        </div>
      </div>
    </div>`;
}

window.saveClassNote = async function(key, wrap) {
  if (!wrap) {
    wrap = document.querySelector(`.classnote-wrap[data-classnote-key="${CSS.escape(key)}"]`);
  }
  if (!wrap) return;

  const textarea = wrap.querySelector('.classnote-input');
  const saveBtn  = wrap.querySelector('[data-classnote-action="save"]');
  if (!textarea) return;

  const newText = textarea.value.trim();

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '저장 중…'; }

  try {
    await commit_({ [`classNotes/${key}`]: newText ? { text: newText, updatedAt: Date.now() } : null });

    // 오늘 탭 / 진도표 탭에 같은 key로 렌더링된 모든 인스턴스를 동기화
    document.querySelectorAll(`.classnote-wrap[data-classnote-key="${CSS.escape(key)}"]`).forEach(w => {
      const view  = w.querySelector('.classnote-text');
      const input = w.querySelector('.classnote-input');
      if (view)  view.textContent = `🗒 ${newText || '학급 메모 없음 (탭해서 입력)'}`;
      if (input) input.value = newText;
      w.classList.toggle('has-note', !!newText);
      w.classList.remove('editing');
    });

    showToast('학급 메모 저장 완료');
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '저장'; }
  }
};

// ============================================================
// 오늘 탭
// ============================================================
// 공강 카드용 — 이 교시 뒤에 오는 오늘의 첫 수업과 그 차시 주제
function nextLessonPrep(today, p, periodList, schedule) {
  const q = periodList.find(x => x > p && schedule[x]?.class && !getCalendarEvent(today, String(x)));
  if (!q) return null;
  const cell = schedule[q];
  const key = PE.cellKey(cell);
  if (getSpecialLesson(today, q, key)) return null;
  return { p: q, cls: cell.class, subject: cell.subject, topic: userData.curriculum[key]?.[lessonStep(key, today, q)] || '' };
}

function renderToday() {
  const el = document.getElementById('tab-today');
  if (!el) return;

  if (todayRefreshTimer) clearInterval(todayRefreshTimer);
  todayRefreshTimer = setInterval(() => {
    if (currentTab === 'today') renderToday();
  }, 60000);

  const now      = new Date();
  const dowIdx   = now.getDay();
  const dayKey   = DOW_KEY[dowIdx];
  const periods  = getPeriods();
  const today    = todayStr();
  const schedule = daySchedule(today);
  const changed  = !!userData.dayOverrides?.[today];

  el.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `
    <div class="date-label">TODAY</div>
    <div class="header-row">
      <span class="date-main">${now.getMonth()+1}월 ${now.getDate()}일</span>
      <span class="date-sub">(${DOW_KO[dowIdx]})</span>
      ${PE.swapOn(userData, today) ? `<span class="swap-badge">${DOW_KO[DOW_KEY.indexOf(PE.swapOn(userData, today))]}요일 수업</span>` : ''}
    </div>
    <div class="update-time">${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} 기준</div>
  `;
  el.appendChild(header);

  // 자체 점검 — 진도가 틀릴 수 있는 데이터가 있으면 조용히 넘어가지 않고 맨 위에 띄운다
  const issues = health();
  if (issues.length) {
    const errs = issues.filter(i => i.level === 'error').length;
    el.innerHTML += `
      <div class="health-bar${errs ? ' health-error' : ''}" onclick="window.openDataDiag()">
        <span>⚠ 진도 점검: ${errs ? `확인 필요 ${errs}건` : ''}${errs && issues.length > errs ? ' · ' : ''}${issues.length > errs ? `참고 ${issues.length - errs}건` : ''}</span>
        <span class="health-first">${escapeHtml(issues[0].msg)}</span>
        <span class="health-more">자세히 →</span>
      </div>`;
  }
  if (DEMO) el.innerHTML += `<div class="health-bar">데모 화면이에요. 바꾼 내용은 저장되지 않아요.</div>`;

  // 할 일 한 줄 요약 (관리자만) — 눌러서 할 일 탭으로
  const ps = planner?.summary?.();
  if (ps?.loaded) {
    el.innerHTML += `
      <div class="todo-line${ps.overdue ? ' has-over' : ''}" onclick="window.switchTab('tasks')">
        <span>✅ 오늘 할 일 <b>${ps.chosen}/${ps.cap}</b></span>
        ${ps.overdue ? `<span class="todo-over">밀린 일 ${ps.overdue}건</span>` : ''}
        <span class="todo-go">할 일 탭 →</span>
      </div>`;
  }

  const examGroups = FINAL_EXAM_GROUPS.filter(g => today <= g.start);
  if (examGroups.length) {
    const rowsHtml = examGroups.map(g => {
      const [, exM, exD] = g.start.split('-').map(Number);
      const itemsHtml = g.classes.map(cls => `
        <span class="exam-dday-item">
          <span class="exam-dday-class">${cls.replace(' ', '')}</span>
          <span class="exam-dday-count">D-${remainingLessonsUntilExam(cls, g)}</span>
        </span>`).join('');
      return `
        <div class="exam-dday-row">
          <div class="exam-dday-label">${g.label}<small>${exM}/${exD}</small></div>
          <div class="exam-dday-items">${itemsHtml}</div>
        </div>`;
    }).join('');
    el.innerHTML += `
      <div class="exam-dday-card">
        <div class="exam-dday-title">기말고사까지 남은 역사 수업</div>
        ${rowsHtml}
      </div>`;
  }

  const periodList = Object.keys(periods).map(Number).sort((a,b) => a-b);
  const hasAnyClass = periodList.some(p => schedule[p]?.class);

  if (!hasAnyClass && (dowIdx === 0 || dowIdx === 6)) {
    el.innerHTML += `<div class="empty-day">오늘은 주말이에요 🎉</div>`;
    return;
  }

  const curP  = getCurrentPeriod();
  const nextP = getNextPeriod(schedule);

  if (curP && schedule[curP]?.class) {
    const ev = getCalendarEvent(today, String(curP));
    if (!ev) {
      const { class: cls, subject } = schedule[curP];
      const info  = lessonCellInfo(today, curP, schedule[curP]);
      const topic = info.special ? `특별 · ${escapeHtml(info.special.label)}` : info.topic;
      el.innerHTML += `
        <div class="banner banner-now">
          <span class="banner-label">NOW</span>
          <span class="banner-info">${curP}교시 · <b>${cls}</b> ${subject} ${topic ? '— ' + topic : ''}</span>
          <span class="banner-time">${formatPeriodTime(curP)}</span>
        </div>`;
    }
  } else if (nextP && schedule[nextP]?.class) {
    const ev = getCalendarEvent(today, String(nextP));
    if (!ev) {
      const { class: cls, subject } = schedule[nextP];
      const info  = lessonCellInfo(today, nextP, schedule[nextP]);
      const topic = info.special ? `특별 · ${escapeHtml(info.special.label)}` : info.topic;
      el.innerHTML += `
        <div class="banner banner-next">
          <span class="banner-label">NEXT</span>
          <span class="banner-info">${nextP}교시 · <b>${cls}</b> ${subject} ${topic ? '— ' + topic : ''}</span>
          <span class="banner-time">${formatPeriodTime(nextP)}</span>
        </div>`;
    }
  }

  const list = document.createElement('div');
  list.className = 'period-list';

  for (const p of periodList) {
    const cell  = schedule[p];
    const isCur = p === curP;
    const ev    = getCalendarEvent(today, String(p));
    const card  = document.createElement('div');

    if (ev) {
      card.className = `period-card event-card${isCur ? ' current' : ''}`;
      card.innerHTML = `
        ${isCur ? '<div class="current-dot"></div>' : ''}
        <div class="period-num">${p}<span class="period-time">${formatPeriodTime(p).replace('~','\n')}</span></div>
        <div class="period-divider"></div>
        <div class="period-body">
          <span class="event-badge badge-${ev.type}">${ev.label}</span>
          <span class="empty-label"></span>
        </div>
      `;
    } else if (cell?.class && getSpecialLesson(today, p, PE.cellKey(cell))) {
      const { class: cls, subject } = cell;
      const key = PE.cellKey(cell);
      const sp  = getSpecialLesson(today, p, key);
      card.className = `period-card has-class special-card${isCur ? ' current' : ''}${swapCls(p)}`;
      card.dataset.key = key;
      card.innerHTML = `
        ${isCur ? '<div class="current-dot"></div>' : ''}
        <div class="period-num">${p}<span class="period-time">${formatPeriodTime(p).replace('~','\n')}</span></div>
        <div class="period-divider"></div>
        <div class="period-body">
          <div class="class-info">
            <span class="class-badge">${cls}</span>
            <span class="class-subject">${subject}</span>
            <span class="special-badge">특별 · ${escapeHtml(sp.label)}</span>
          </div>
          ${renderClassNoteBlock(key)}
          <div class="step-editor" id="editor-${p}">
            <div class="step-editor-label">진도에 안 들어가는 수업으로 표시돼 있어</div>
            <button class="special-undo-btn" onclick="window.unmarkSpecialToday(${p})">정규 수업으로 되돌리기</button>
          </div>
        </div>
        <button class="edit-btn" onclick="window.toggleEditor(${p})">✏️</button>
        ${swapBtn(p)}
      `;
    } else if (cell?.class) {
      const { class: cls, subject } = cell;
      const key           = PE.cellKey(cell);
      const current       = lessonStep(key, today, p);          // 이 수업의 차시
      const completedStep = current - 1;                        // 메모는 직전 차시(어디까지 나갔는지)
      const topic         = userData.curriculum[key]?.[current] || '';
      const note          = userData.lessonNotes?.[key]?.[completedStep] || '';

      card.className = `period-card has-class${isCur ? ' current' : ''}${swapCls(p)}`;
      card.dataset.key = key;
      card.innerHTML = `
        ${isCur ? '<div class="current-dot"></div>' : ''}
        <div class="period-num">${p}<span class="period-time">${formatPeriodTime(p).replace('~','\n')}</span></div>
        <div class="period-divider"></div>
        <div class="period-body">
          <div class="class-info">
            <span class="class-badge">${cls}</span>
            <span class="class-subject">${subject}</span>
            <span class="class-topic" id="topic-display-${p}">${topic || '주제 미설정'}</span>
            <span class="class-step" id="step-display-${p}">${current}차시</span>
          </div>
          ${note ? `<div class="class-note" id="note-display-${p}">📝 ${note}</div>` : `<div class="class-note" id="note-display-${p}" style="display:none"></div>`}
          ${renderClassNoteBlock(key)}
          <div class="step-editor" id="editor-${p}">
            <div class="step-editor-label">이 수업(${p}교시)은 몇 차시?</div>
            <button class="step-btn" onclick="window.adjustStep(${p}, -1)">−</button>
            <span class="step-display" id="step-disp-${p}">${current}</span>
            <button class="step-btn" onclick="window.adjustStep(${p}, +1)">+</button>
            <span class="topic-label" id="topic-label-${p}">${current}차시 주제</span>
            <input class="topic-input" id="topic-inp-${p}" value="${topic}" placeholder="수업 주제 입력" />
            <span class="note-label" id="note-label-${p}">${completedStep}차시 메모</span>
            <textarea class="note-input" id="note-inp-${p}" placeholder="메모 (선택, 어디까지 나갔는지 등)">${note}</textarea>
            <button class="save-btn" id="save-btn-${p}" onclick="window.saveStep(${p})">저장</button>
            <div class="special-row">
              <span class="special-row-label">진도 대신 다른 걸 했으면</span>
              <input class="special-input" id="special-inp-${p}" value="자습" placeholder="자습, 영상 시청 등" />
              <button class="special-mark-btn" onclick="window.markSpecialToday(${p})">특별 수업으로</button>
            </div>
          </div>
        </div>
        <button class="edit-btn" onclick="window.toggleEditor(${p})">✏️</button>
        ${swapBtn(p)}
      `;
    } else {
      const prep = nextLessonPrep(today, p, periodList, schedule);
      card.className = `period-card empty${prep ? ' prep' : ''}${swapCls(p)}`;
      card.innerHTML = `
        <div class="period-num">${p}<span class="period-time">${formatPeriodTime(p).replace('~','\n')}</span></div>
        <div class="period-divider"></div>
        <div class="period-body">
          <span class="empty-label">공강</span>
          ${prep ? `<div class="prep-line">📖 다음 수업 준비 · ${prep.p}교시 <b>${prep.cls}</b> ${prep.subject} — ${prep.topic ? escapeHtml(prep.topic) : '주제 미설정'}</div>` : ''}
        </div>
        ${swapBtn(p)}
      `;
    }
    list.appendChild(card);
  }
  el.appendChild(list);

  const bar = document.createElement('div');
  bar.className = 'swap-bar';
  bar.innerHTML = swapFrom !== null
    ? `<span>${swapFrom}교시와 바꿀 교시의 ⇅를 누르세요</span><button onclick="window.tapSwap(${swapFrom})">취소</button>`
    : changed
      ? `<span>🔀 오늘만 순서를 바꿨어요</span><button onclick="window.resetDaySwap()">원래대로</button>`
      : `<span>오늘만 바꾸려면 카드의 ⇅를 다른 카드로 끌어다 놓으세요</span>`;
  el.insertBefore(bar, list); // (header는 위에서 innerHTML += 로 다시 만들어져 연결이 끊겨 있으므로 list 기준)
}

// ============================================================
// 오늘만 교시 바꾸기 — dayOverrides/{날짜} 에 그날 시간표 전체를 저장 (다음 날엔 자동으로 기본 시간표)
// ============================================================
let swapFrom = null;
function swapCls(p) { return swapFrom === p ? ' swap-from' : swapFrom !== null ? ' swap-target' : ''; }
function swapBtn(p) {
  return `<button class="edit-btn swap-btn" data-swap-p="${p}" title="끌어서 옮기기 (또는 눌러서 선택)">⇅</button>`;
}

// ⇅ 손잡이를 끌어 다른 카드 위에 놓으면 바뀐다. 거의 안 움직이고 놓으면 "누르기" 선택으로 처리.
// pointer 이벤트라 마우스·터치 모두 된다.
(function setupSwapDrag() {
  let drag = null;
  const cardAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('#tab-today .period-card');
  const clearMarks = () => document.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
  const cardP = c => c?.querySelector('[data-swap-p]')?.dataset.swapP;

  document.addEventListener('pointerdown', e => {
    const btn = e.target.closest?.('.swap-btn');
    if (!btn) return;
    drag = { p: Number(btn.dataset.swapP), x: e.clientX, y: e.clientY, moved: false, card: btn.closest('.period-card') };
    try { btn.setPointerCapture?.(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    drag.moved = true;
    drag.card?.classList.add('dragging');
    clearMarks();
    const over = cardAt(e.clientX, e.clientY);
    if (over && over !== drag.card) over.classList.add('drag-over');
  });
  document.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag; drag = null;
    clearMarks();
    d.card?.classList.remove('dragging');
    if (!d.moved) { window.tapSwap(d.p); return; }
    const to = Number(cardP(cardAt(e.clientX, e.clientY)));
    if (to && to !== d.p) { swapFrom = d.p; window.tapSwap(to); }
  });
  // 끄는 동안 화면이 같이 스크롤되거나 길게 눌러 메뉴가 뜨는 것을 막는다 (폰 대비)
  document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', e => { if (e.target.closest?.('.swap-btn')) e.preventDefault(); });
  document.addEventListener('pointercancel', () => {
    drag?.card?.classList.remove('dragging'); drag = null; clearMarks();
  });
})();

window.tapSwap = async function(p) {
  if (swapFrom === null) { swapFrom = p; renderToday(); return; }
  const a = swapFrom;
  swapFrom = null;
  if (a === p) { renderToday(); return; }
  const today = todayStr();
  const base  = daySchedule(today);
  const snap  = {};
  for (const q of Object.keys(getPeriods())) {
    snap[q] = { class: base[q]?.class || '', subject: base[q]?.subject || '' };
  }
  [snap[a], snap[p]] = [snap[p], snap[a]];
  try {
    await commit_({ [`dayOverrides/${today}`]: snap }, { src: '하루바꾸기', n: `${today} ${a}교시 ↔ ${p}교시` });
    showToast(`${a}교시 ↔ ${p}교시 (오늘만)`);
  } catch (e) {
    showToast('저장 실패: ' + e.message, true);
  }
  renderCurrentTab();
  if (pipWindow) renderPipWidget();
};

window.resetDaySwap = async function() {
  const today = todayStr();
  try {
    await commit_({ [`dayOverrides/${today}`]: null }, { src: '하루바꾸기해제', n: today });
    showToast('원래 시간표로 되돌렸어요');
  } catch (e) {
    showToast('저장 실패: ' + e.message, true);
  }
  renderCurrentTab();
  if (pipWindow) renderPipWidget();
};

// ============================================================
// 수정 UI
// ============================================================
window.toggleEditor = function(p) {
  document.getElementById(`editor-${p}`)?.classList.toggle('open');
};

window.adjustStep = function(p, delta) {
  const disp = document.getElementById(`step-disp-${p}`);
  if (!disp) return;
  const cur  = parseInt(disp.textContent) || 1;
  const step = Math.max(1, cur + delta); // 이 수업의 차시 (1차시부터)
  disp.textContent = step;

  let key = '';
  document.querySelectorAll('.period-card').forEach(c => {
    if (c.querySelector(`#editor-${p}`)) key = c.dataset.key;
  });

  if (key) {
    document.getElementById(`topic-inp-${p}`).value = userData.curriculum[key]?.[step] || '';
    document.getElementById(`note-inp-${p}`).value  = userData.lessonNotes?.[key]?.[step - 1] || '';
    const topicLabel = document.getElementById(`topic-label-${p}`);
    if (topicLabel) topicLabel.textContent = `${step}차시 주제`;
    const noteLabel = document.getElementById(`note-label-${p}`);
    if (noteLabel) noteLabel.textContent = `${step - 1}차시 메모`;
  }
};

// 차시·주제·메모 저장 (오늘 탭·진도표 탭 공통)
// lesson = {date, p}: "그 수업 = step차시"로 고정핀을 둔다. 수업 전에 고치든 후에 고치든 뜻이 같다.
// 차시 숫자를 안 바꿨으면 핀은 건드리지 않고 주제·메모만 저장한다.
// 돌려주는 값: 이 수업 뒤에 이미 고정된 차시가 있으면 그 개수 (그 뒤 수업은 그 핀을 따른다는 안내용)
async function saveLessonEdit_(key, lesson, step, newTopic, newNote, src) {
  const r = PE.planSetStep(userData, key, lesson.date, lesson.p, step);
  const patch = { ...r.patch };
  if (newTopic) patch[`curriculum/${key}/${step}`] = newTopic;
  patch[`lessonNotes/${key}/${step - 1}`] = newNote || null;
  await commit_(patch, r.changed
    ? { src, key, n: `${lessonLabel(lesson)} 수업을 ${r.from}차시 → ${r.to}차시로 고침` }
    : { src, key, n: `${lessonLabel(lesson)} ${step}차시 주제·메모 저장` });
  return r.changed ? r.laterPins.length : 0;
}

function savedToast_(key, laterPins) {
  showToast(laterPins
    ? `${key} 저장 완료 · 뒤에 직접 고친 차시가 ${laterPins}곳 있어 그 뒤는 그대로예요 (장부 📌)`
    : `${key} 저장 완료`);
}

// 화면 숫자 = 이 수업(오늘 p교시)의 차시
window.saveStep = async function(p) {
  const btn      = document.getElementById(`save-btn-${p}`);
  const disp     = document.getElementById(`step-disp-${p}`);
  const input    = document.getElementById(`topic-inp-${p}`);
  const noteInp  = document.getElementById(`note-inp-${p}`);

  let key = '';
  document.querySelectorAll('.period-card').forEach(c => {
    if (c.querySelector(`#editor-${p}`)) key = c.dataset.key;
  });
  if (!key) return;

  btn.disabled    = true;
  btn.textContent = '저장 중…';

  try {
    const step = Math.max(1, parseInt(disp.textContent) || 1);
    const later = await saveLessonEdit_(key, { date: todayStr(), p }, step, input.value.trim(), noteInp.value.trim(), '수동(오늘탭)');
    savedToast_(key, later);
    renderCurrentTab(); // 같은 반의 다른 교시·배너도 새 기준으로 다시 계산
    if (pipWindow) renderPipWidget();
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
    btn.disabled    = false;
    btn.textContent = '저장';
  }
};


// ============================================================
// 특별 수업 — 자습·다른 내용 등 정규 진도에 안 들어가는 수업
// specials/{날짜}/{교시} = { key, label }
// ============================================================
// 표시하면 그 뒤 정규 수업 차시가 하나씩 당겨지고(다음 고정핀까지), 앞 수업 차시는 그대로다. 해제는 반대.
// label === null 이면 해제.
async function setSpecialLesson_(key, dateStr, p, label, src) {
  await commit_(PE.planSetSpecial(userData, key, dateStr, p, label), {
    src, key,
    n: label !== null ? `${lessonLabel({ date: dateStr, p })} 수업을 특별 수업(${label})으로 표시`
                      : `${lessonLabel({ date: dateStr, p })} 수업을 정규 수업으로 되돌림`
  });
}

function cardKeyAt_(p) {
  let key = '';
  document.querySelectorAll('#tab-today .period-card').forEach(c => {
    if (c.querySelector(`#editor-${p}`)) key = c.dataset.key;
  });
  return key;
}

window.markSpecialToday = async function(p) {
  const key   = cardKeyAt_(p);
  const label = document.getElementById(`special-inp-${p}`)?.value.trim() || '자습';
  if (!key) return;
  try {
    await setSpecialLesson_(key, todayStr(), p, label, '특별수업(오늘탭)');
    showToast(`${p}교시를 특별 수업(${label})으로 표시했어요`);
  } catch (e) {
    showToast('저장 실패: ' + e.message, true);
  }
  renderCurrentTab();
  if (pipWindow) renderPipWidget();
};

window.unmarkSpecialToday = async function(p) {
  const key = cardKeyAt_(p);
  if (!key) return;
  try {
    await setSpecialLesson_(key, todayStr(), p, null, '특별수업해제(오늘탭)');
    showToast(`${p}교시를 정규 수업으로 되돌렸어요`);
  } catch (e) {
    showToast('저장 실패: ' + e.message, true);
  }
  renderCurrentTab();
  if (pipWindow) renderPipWidget();
};

// ============================================================
// 주차별 탭
// ============================================================
function renderWeekly() {
  const el = document.getElementById('tab-weekly');
  if (!el) return;

  let activeWeek = 0;

  function renderWeekGrid(offsetWeeks) {
    const dates      = getWeekDates(offsetWeeks);
    const periods    = getPeriods();
    const periodList = Object.keys(periods).map(Number).sort((a,b) => a-b);
    const today      = todayStr();

    let html = '<div class="week-grid"><table><thead><tr><th></th>';
    dates.forEach((d, i) => {
      const isToday = dateToStr(d) === today;
      const swapTo = PE.swapOn(userData, dateToStr(d));
      html += `<th class="${isToday ? 'today-col' : ''}">${DOW_KO[i+1]}<br><span class="th-date">${d.getMonth()+1}/${d.getDate()}</span>${swapTo ? `<br><span class="swap-badge">${DOW_KO[DOW_KEY.indexOf(swapTo)]}요일 수업</span>` : ''}</th>`;
    });
    html += '</tr></thead><tbody>';

    for (const p of periodList) {
      html += `<tr><td class="period-col">${p}</td>`;
      dates.forEach((d, i) => {
        const dayKey  = DOW_KEY[d.getDay()];
        const dateStr = dateToStr(d);
        const cell    = daySchedule(dateStr)[p];
        const isToday = dateStr === today;
        const ev      = getCalendarEvent(dateStr, String(p));

        if (ev) {
          html += `<td class="event-cell${isToday ? ' today-col' : ''}">
            <span class="cell-badge badge-${ev.type}">${ev.label}</span>
          </td>`;
        } else if (cell?.class) {
          const { special, step, topic } = lessonCellInfo(dateStr, p, cell);
          html += `<td class="has-class${special ? ' special-cell' : ''}${isToday ? ' today-col' : ''}">
            <span class="cell-class">${cell.class}</span>
            <span class="cell-subject">${cell.subject}</span>
            ${special ? `<span class="special-badge">특별 · ${escapeHtml(special.label)}</span>` : ''}
            ${topic ? `<span class="cell-topic">${topic}</span>` : ''}
            ${special ? '' : `<span class="cell-step">${step}차시</span>`}
          </td>`;
        } else {
          html += `<td class="empty-cell${isToday ? ' today-col' : ''}">·</td>`;
        }
      });
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function fullHTML() {
    const labels = ['이번 주', '다음 주', '다다음 주'];
    let tabs = '<div class="week-tabs">';
    labels.forEach((l, i) => {
      tabs += `<button class="week-tab${i === activeWeek ? ' active' : ''}" onclick="window.weekSwitch(${i})">${l}</button>`;
    });
    tabs += '</div>';
    return tabs + `<div id="week-content">${renderWeekGrid(activeWeek)}</div>`;
  }

  el.innerHTML = fullHTML();

  window.weekSwitch = function(idx) {
    activeWeek = idx;
    document.querySelectorAll('.week-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
    document.getElementById('week-content').innerHTML = renderWeekGrid(idx);
  };
}

// ============================================================
// 진도표 탭
// ============================================================
function renderProgress() {
  const el = document.getElementById('tab-progress');
  if (!el) return;

  const schedule  = currentWeek();
  const classSet  = new Map();

  for (const daySchedule of Object.values(schedule)) {
    for (const cell of Object.values(daySchedule || {})) {
      const key = PE.cellKey(cell);
      if (key) {
        classSet.set(key, { class: cell.class, subject: cell.subject });
      }
    }
  }

  if (!classSet.size) {
    el.innerHTML = `<div class="empty-state">시간표를 먼저 설정해주세요<br><button class="btn-primary" onclick="window.switchTab('settings')">시간표 설정하러 가기</button></div>`;
    return;
  }

  const groups = new Map();
  for (const [key, info] of classSet) {
    if (!groups.has(info.subject)) groups.set(info.subject, []);
    groups.get(info.subject).push({ key, ...info });
  }

  let html = '<div class="progress-grid">';

  const subjectOrder = ['역사', '역사A', '역사B'];
  const sortedGroups = [...groups.entries()].sort(
    (a, b) => subjectOrder.indexOf(a[0]) - subjectOrder.indexOf(b[0])
  );

  let progIdx = 0;

  for (const [subject, items] of sortedGroups) {
    html += `
      <div class="prog-group-header" onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.arrow').classList.toggle('collapsed')">
        <span class="prog-group-title">${subject}</span>
        <div class="prog-group-line"></div>
        <span class="arrow">▼</span>
      </div>
      <div class="prog-group-body">`;

    items.sort((a, b) => a.class.localeCompare(b.class, undefined, { numeric: true }));

    for (const item of items) {
      const idx           = progIdx++;
      const lesson        = nextLesson(item.key) || { date: todayStr(), p: 0 }; // 아직 안 끝난 가장 가까운 수업
      const current       = lesson.p ? lesson.step : nextStep(item.key);
      const completedStep = current - 1;
      const whenLabel     = lesson.p ? lessonLabel(lesson) : '';
      const currTopicRaw  = userData.curriculum[item.key]?.[current]     || '';
      const nextTopicRaw  = userData.curriculum[item.key]?.[current + 1] || '';
      const afterTopicRaw = userData.curriculum[item.key]?.[current + 2] || '';
      const currNote      = userData.lessonNotes?.[item.key]?.[completedStep] || '';

      html += `
        <div class="progress-card" data-key="${item.key}" data-date="${lesson.date}" data-p="${lesson.p}">
          <div class="progress-header">
            <span class="prog-badge">${item.class}</span>
            <span class="prog-step">${current}차시</span>
            ${whenLabel ? `<span class="prog-when" style="font-size:12px;opacity:.6">${whenLabel}</span>` : ''}
            <button class="ledger-btn" onclick="window.openLedger('${escapeHtml(item.key)}')" title="반별 수업 장부">📒 장부</button>
            <button class="edit-btn" onclick="window.toggleProgEditor(${idx})">✏️</button>
          </div>
          <div class="prog-dates">
            <div class="prog-row current-row">
              <span class="r-label">이번</span>
              <span class="r-topic">${currTopicRaw || '주제 미설정'}</span>
            </div>
            <div class="prog-row note-row" id="prog-note-row-${idx}" style="${currNote ? '' : 'display:none'}">
              <span class="r-label">메모</span>
              <span class="r-topic" id="prog-note-display-${idx}">${currNote}</span>
            </div>
            <div class="prog-row next-row">
              <span class="r-label">다음</span>
              <span class="r-topic">${nextTopicRaw || '주제 미설정'}</span>
            </div>
            <div class="prog-row after-row">
              <span class="r-label">다다음</span>
              <span class="r-topic">${afterTopicRaw || '주제 미설정'}</span>
            </div>
          </div>
          ${renderClassNoteBlock(item.key)}
          <div class="step-editor" id="prog-editor-${idx}">
            <div class="step-editor-label">${whenLabel ? `다음 수업(${whenLabel})은 몇 차시?` : '다음 수업은 몇 차시?'}</div>
            <button class="step-btn" onclick="window.adjustProgStep(${idx}, -1)">−</button>
            <span class="step-display" id="prog-step-disp-${idx}">${current}</span>
            <button class="step-btn" onclick="window.adjustProgStep(${idx}, +1)">+</button>
            <span class="topic-label" id="prog-topic-label-${idx}">${current}차시 주제</span>
            <input class="topic-input" id="prog-topic-inp-${idx}" value="${currTopicRaw.replace(/"/g,'&quot;')}" placeholder="수업 주제 입력" />
            <span class="note-label" id="prog-note-label-${idx}">${completedStep}차시 메모</span>
            <textarea class="note-input" id="prog-note-inp-${idx}" placeholder="메모 (선택)">${currNote}</textarea>
            <button class="save-btn" id="prog-save-btn-${idx}" onclick="window.saveProgStep(${idx})">저장</button>
          </div>
        </div>`;
    }
    html += `</div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ============================================================
// 반별 수업 장부 — 학기 전체 수업을 날짜순으로 펼쳐 차시 계산 결과를 보여 준다
// 진도 엔진의 장부(buildLedger)를 그대로 그린다. 📌 = 차시를 직접 고친(고정핀) 줄.
// 여기서 할 수 있는 수정은 특별 수업 표시/해제뿐이다.
// ============================================================
function scheduleKeys_() {
  return PE.allKeys(userData);
}

// 학기 기간의 key 수업 전부: { date, p, ev(학사일정), sp(특별 수업), step(정규 수업 차시), pin(직접 고친 줄) }
function ledgerRows_(key) {
  return ledger(key).map(r => ({ date: r.date, p: r.p, ev: r.event, sp: r.special, step: r.step, pin: r.pin }));
}

let ledgerEditAt = null; // 특별 수업 이름을 입력 중인 줄 'date|p'

window.openLedger = function(key) {
  const prevBody = document.querySelector('#modal-ledger .modal-body');
  const keepScroll = prevBody && prevBody.dataset.key === key ? prevBody.scrollTop : null;
  document.getElementById('modal-ledger')?.remove();

  const rows    = ledgerRows_(key);
  const today   = todayStr();
  const nowMin  = new Date().getHours() * 60 + new Date().getMinutes();
  const periods = getPeriods();
  const isPast  = r => r.date < today || (r.date === today && parseTimeToMin(periods[r.p]?.end) <= nowMin);
  const nextRow = rows.find(r => !isPast(r) && !r.ev && !r.sp);

  const cnt = { reg: 0, sp: 0, ev: 0, done: 0 };
  rows.forEach(r => {
    if (r.ev) cnt.ev++; else if (r.sp) cnt.sp++; else { cnt.reg++; if (isPast(r)) cnt.done = r.step; }
  });

  const [cls, subject] = key.split('_');
  const options = scheduleKeys_().map(k =>
    `<option value="${escapeHtml(k)}"${k === key ? ' selected' : ''}>${escapeHtml(k.replace('_', ' '))}</option>`).join('');

  const body = rows.map(r => {
    const d     = parseDateStr_(r.date);
    const id    = `${r.date}|${r.p}`;
    const cls_  = ['ledger-row', isPast(r) ? 'past' : '', r.date === today ? 'today' : '', r === nextRow ? 'next' : '',
                   r.ev ? 'is-event' : '', r.sp ? 'is-special' : ''].filter(Boolean).join(' ');
    let content, action = '';
    if (r.ev) {
      content = `<span class="cell-badge badge-${r.ev.type}">${escapeHtml(r.ev.label)}</span>`;
    } else if (r.sp) {
      content = `<span class="special-badge">특별 · ${escapeHtml(r.sp.label)}</span>`;
      action  = `<button class="ledger-act" data-ledger-unmark="${id}">되돌리기</button>`;
    } else {
      const topic = userData.curriculum?.[key]?.[r.step] || '';
      content = topic ? escapeHtml(topic) : '<span class="ledger-none">주제 미설정</span>';
      action  = `<button class="ledger-act" data-ledger-mark="${id}">특별</button>`;
    }
    let html = `<tr class="${cls_}" data-ledger-id="${id}">
      <td class="ledger-date">${d.getMonth() + 1}/${d.getDate()} <small>${DOW_KO[d.getDay()]}</small></td>
      <td class="ledger-p">${r.p}</td>
      <td class="ledger-step">${r.step ?? '–'}${r.pin ? ` <span class="ledger-pin" title="직접 고친 차시${r.pin.p === 0 ? ' (옮기기 기준점)' : ''}">📌</span>` : ''}</td>
      <td class="ledger-content">${content}</td>
      <td class="ledger-action">${action}</td>
    </tr>`;
    if (ledgerEditAt === id) {
      html += `<tr class="ledger-edit-row"><td colspan="5">
        <div class="ledger-edit">
          <span>진도 대신 한 것</span>
          <input class="special-input" id="ledger-special-inp" value="자습" placeholder="자습, 영상 시청 등" />
          <button class="special-mark-btn" data-ledger-save="${id}">특별 수업으로</button>
          <button class="ledger-act" data-ledger-cancel="1">취소</button>
        </div>
        <div class="ledger-edit-hint">이 수업은 차시를 세지 않고, 뒤 수업 차시가 하나씩 당겨져.</div>
      </td></tr>`;
    }
    return html;
  }).join('');

  const html = `
    <div class="modal-overlay${prevBody ? ' no-anim' : ''}" id="modal-ledger">
      <div class="modal modal-lg">
        <div class="modal-header">
          <h2>수업 장부</h2>
          <select class="ledger-select" onchange="window.openLedger(this.value)">${options}</select>
          <button class="modal-close" onclick="window.closeLedger()">✕</button>
        </div>
        <div class="modal-body" data-key="${escapeHtml(key)}">
          <p class="modal-hint">${escapeHtml(cls)} ${escapeHtml(subject)} · ${userData.semester.start} ~ ${userData.semester.end}<br>
            정규 ${cnt.reg}회(지금까지 ${cnt.done}차시) · 특별 ${cnt.sp}회 · 휴업 ${cnt.ev}회.
            차시는 저장된 값이 아니라 학기 첫 수업부터 학사일정·시간표·특별 수업을 반영해 매번 센 결과야. 📌는 차시를 직접 고친 줄이고, 그 뒤는 거기서부터 이어서 세.</p>
          ${rows.length ? `<table class="ledger-table">
            <thead><tr><th>날짜</th><th>교시</th><th>차시</th><th>내용</th><th></th></tr></thead>
            <tbody>${body}</tbody>
          </table>` : '<div class="empty-state">이 기간에 수업이 없어요</div>'}
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);

  const modalBody = document.querySelector('#modal-ledger .modal-body');
  if (keepScroll !== null) modalBody.scrollTop = keepScroll;
  else {
    const target = modalBody.querySelector('.ledger-row.next') || modalBody.querySelector('.ledger-row.today');
    target?.scrollIntoView({ block: 'center' });
  }
  document.getElementById('ledger-special-inp')?.select();
};

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.target.id === 'ledger-special-inp') document.querySelector('#modal-ledger [data-ledger-save]')?.click();
  const m = e.target.id?.match?.(/^special-inp-(\d+)$/);
  if (m) window.markSpecialToday(Number(m[1]));
});

window.closeLedger = function() {
  ledgerEditAt = null;
  closeModal('modal-ledger');
  renderCurrentTab(); // 장부에서 특별 수업을 바꿨으면 다른 화면도 새 차시로
  if (pipWindow) renderPipWidget();
};

document.addEventListener('click', async e => {
  const t = e.target.closest?.('#modal-ledger [data-ledger-mark], #modal-ledger [data-ledger-unmark], #modal-ledger [data-ledger-save], #modal-ledger [data-ledger-cancel]');
  if (!t) return;
  const key = document.querySelector('#modal-ledger .modal-body')?.dataset.key;
  if (!key) return;

  if (t.dataset.ledgerMark)   { ledgerEditAt = t.dataset.ledgerMark; window.openLedger(key); return; }
  if (t.dataset.ledgerCancel) { ledgerEditAt = null; window.openLedger(key); return; }

  const id    = t.dataset.ledgerSave || t.dataset.ledgerUnmark;
  const [date, p] = id.split('|');
  const label = t.dataset.ledgerSave ? (document.getElementById('ledger-special-inp')?.value.trim() || '자습') : null;
  t.disabled = true;
  try {
    await setSpecialLesson_(key, date, Number(p), label, label ? '특별수업(장부)' : '특별수업해제(장부)');
    showToast(label ? `특별 수업(${label})으로 표시했어요` : '정규 수업으로 되돌렸어요');
  } catch (err) {
    showToast('저장 실패: ' + err.message, true);
  }
  ledgerEditAt = null;
  window.openLedger(key);
});

window.toggleProgEditor = function(idx) {
  document.getElementById(`prog-editor-${idx}`)?.classList.toggle('open');
};

window.adjustProgStep = function(idx, delta) {
  const disp = document.getElementById(`prog-step-disp-${idx}`);
  if (!disp) return;
  const cur  = parseInt(disp.textContent) || 1;
  const step = Math.max(1, cur + delta);
  disp.textContent = step;

  let key = '';
  document.querySelectorAll('.progress-card').forEach(c => {
    if (c.querySelector(`#prog-editor-${idx}`)) key = c.dataset.key;
  });

  if (key) {
    document.getElementById(`prog-topic-inp-${idx}`).value = userData.curriculum[key]?.[step] || '';
    document.getElementById(`prog-note-inp-${idx}`).value  = userData.lessonNotes?.[key]?.[step - 1] || '';
    const topicLabel = document.getElementById(`prog-topic-label-${idx}`);
    if (topicLabel) topicLabel.textContent = `${step}차시 주제`;
    const noteLabel = document.getElementById(`prog-note-label-${idx}`);
    if (noteLabel) noteLabel.textContent = `${step - 1}차시 메모`;
  }
};

window.saveProgStep = async function(idx) {
  const btn     = document.getElementById(`prog-save-btn-${idx}`);
  const disp    = document.getElementById(`prog-step-disp-${idx}`);
  const input   = document.getElementById(`prog-topic-inp-${idx}`);
  const noteInp = document.getElementById(`prog-note-inp-${idx}`);

  let card = null;
  document.querySelectorAll('.progress-card').forEach(c => {
    if (c.querySelector(`#prog-editor-${idx}`)) card = c;
  });
  if (!card) return;
  const key    = card.dataset.key;
  const lesson = { date: card.dataset.date, p: Number(card.dataset.p) || 0 };

  btn.disabled    = true;
  btn.textContent = '저장 중…';

  try {
    const step = Math.max(1, parseInt(disp.textContent) || 1);
    const later = await saveLessonEdit_(key, lesson, step, input.value.trim(), noteInp.value.trim(), '수동(진도탭)');
    savedToast_(key, later);
    renderProgress();
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
    btn.disabled    = false;
    btn.textContent = '저장';
  }
};

// ============================================================
// 수업 주제 탭
// ============================================================
function renderSubject() {
  const el = document.getElementById('tab-subject');
  if (!el) return;

  const groups = [
    { label: '3학년',   subject: '역사',  classes: ['305','306','307','308'] },
    { label: '2학년 A', subject: '역사A', classes: ['201 A','202 A','203 A'] },
    { label: '2학년 B', subject: '역사B', classes: ['201 B','202 B','203 B','204 B'] },
  ];

  let html = `
    <div class="subj-tab-btns">
      ${groups.map((g, i) => `<button class="subj-tab-btn${i === 0 ? ' active' : ''}" onclick="window.subjTabSwitch(${i})">${g.label}</button>`).join('')}
    </div>
    <div class="subject-columns">`;

  groups.forEach((group, gi) => {
    const repKey     = `${group.classes[0]}_${group.subject}`;
    const curriculum = userData.curriculum[repKey] || {};
    const current    = nextStep(repKey);

    const WINDOW   = 2;
    const minStep  = Math.max(1, current - WINDOW);
    const savedMax = Object.keys(curriculum).map(Number).reduce((a, b) => Math.max(a, b), 0);
    const maxStep  = Math.max(current + WINDOW, savedMax);

    const stepSet = new Set();
    for (let s = minStep; s <= maxStep; s++) stepSet.add(s);
    const visible = [...stepSet].sort((a,b) => a-b);

    const encodedClasses = encodeURIComponent(JSON.stringify(group.classes));

    html += `
      <div class="subj-column${gi === 0 ? ' active' : ''}">
        <div class="subj-col-header">${group.label}</div>
        <table class="subj-table">
          <thead><tr><th>차시</th><th>주제</th><th></th></tr></thead>
          <tbody id="subj-tbody-${gi}">`;

    visible.forEach(step => {
      const topic     = curriculum[step] || '';
      const isCurrent = step === current;
      html += `
            <tr data-step="${step}" class="${isCurrent ? 'subj-current-row' : ''}">
              <td class="subj-step${isCurrent ? ' subj-step-current' : ''}">${isCurrent ? '▶ ' : ''}${step}</td>
              <td><input class="subj-topic-input" data-gi="${gi}" data-step="${step}"
                value="${topic.replace(/"/g,'&quot;')}" placeholder="주제 입력" /></td>
              <td><button class="btn-del"
                data-gi="${gi}"
                data-step="${step}"
                data-subject="${group.subject}"
                data-classes="${encodedClasses}">✕</button></td>
            </tr>`;
    });

    html += `
          </tbody>
        </table>
        <div class="subj-actions">
          <button class="btn-add-period" onclick="window.addSubjRow(${gi})">+ 차시 추가</button>
          <button class="btn-primary subj-save-btn"
            data-gi="${gi}"
            data-subject="${group.subject}"
            data-classes="${encodedClasses}">저장</button>
        </div>
      </div>`;
  });

  html += '</div>';
  el.innerHTML = html;
}

window.subjTabSwitch = function(idx) {
  document.querySelectorAll('.subj-tab-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
  document.querySelectorAll('.subj-column').forEach((c, i) => c.classList.toggle('active', i === idx));
};

window.addSubjRow = function(gi) {
  const tbody    = document.getElementById(`subj-tbody-${gi}`);
  const rows     = tbody.querySelectorAll('tr');
  const lastStep = rows.length > 0
    ? Math.max(...[...rows].map(r => Number(r.dataset.step) || 0))
    : 0;
  const newStep  = lastStep + 1;

  const tr = document.createElement('tr');
  tr.dataset.step = newStep;
  tr.innerHTML = `
    <td class="subj-step">${newStep}</td>
    <td><input class="subj-topic-input" data-gi="${gi}" data-step="${newStep}" value="" placeholder="주제 입력" /></td>
    <td><button class="btn-del" onclick="this.closest('tr').remove()">✕</button></td>`;
  tbody.appendChild(tr);
  tr.querySelector('input').focus();
};

window.deleteSubjRow = async function(gi, step, subject, classes) {
  if (!confirm(`${step}차시를 삭제하시겠어요?`)) return;
  try {
    const patch = {};
    classes.forEach(cls => { patch[`curriculum/${PE.lessonKey(cls, subject)}/${step}`] = null; });
    await commit_(patch, { src: '주제삭제', key: subject, n: `${step}차시 주제 삭제 (${classes.join(', ')})` });
    showToast(`${step}차시 삭제 완료`);
    renderSubject();
  } catch(e) {
    showToast('삭제 실패: ' + e.message, true);
  }
};

window.saveSubject = async function(gi, subject, classes) {
  const tbody  = document.getElementById(`subj-tbody-${gi}`);
  const inputs = tbody.querySelectorAll('.subj-topic-input');
  const newCurriculum = {};

  inputs.forEach(input => {
    const step  = Number(input.dataset.step);
    const topic = input.value.trim();
    if (step > 0) newCurriculum[step] = topic;
  });

  const btn = document.querySelector(`.subj-save-btn[data-gi="${gi}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }

  try {
    // 화면에 보이는 차시만 하나씩 쓴다 (예전엔 반 전체를 덮어써서 화면에 안 보이던 앞 차시 주제가 지워졌다)
    const patch = {};
    classes.forEach(cls => {
      const key = PE.lessonKey(cls, subject);
      for (const [step, topic] of Object.entries(newCurriculum)) patch[`curriculum/${key}/${step}`] = topic || null;
    });
    await commit_(patch, { src: '주제저장', key: subject, n: `${Object.keys(newCurriculum).join(',')}차시 (${classes.join(', ')})` });
    showToast(`${subject} 커리큘럼 저장 완료`);
    renderSubject();
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '저장'; }
  }
};

// ============================================================
// 수업 주제 탭 이벤트 위임
// ============================================================
document.addEventListener('click', function(e) {
  const saveBtn = e.target.closest('.subj-save-btn');
  if (saveBtn) {
    const gi      = Number(saveBtn.dataset.gi);
    const subject = saveBtn.dataset.subject;
    const classes = JSON.parse(decodeURIComponent(saveBtn.dataset.classes));
    window.saveSubject(gi, subject, classes);
    return;
  }

  const delBtn = e.target.closest('.btn-del[data-classes]');
  if (delBtn) {
    const gi      = Number(delBtn.dataset.gi);
    const step    = Number(delBtn.dataset.step);
    const subject = delBtn.dataset.subject;
    const classes = JSON.parse(decodeURIComponent(delBtn.dataset.classes));
    window.deleteSubjRow(gi, step, subject, classes);
    return;
  }

  const cnBtn = e.target.closest('[data-classnote-action]');
  if (cnBtn) {
    const action = cnBtn.dataset.classnoteAction;
    const key    = cnBtn.dataset.classnoteKey;
    const wrap   = cnBtn.closest('.classnote-wrap');
    if (!wrap) return;

    if (action === 'edit') {
      wrap.classList.add('editing');
      wrap.querySelector('.classnote-input')?.focus();
    } else if (action === 'cancel') {
      const input = wrap.querySelector('.classnote-input');
      if (input) input.value = userData.classNotes?.[key]?.text || '';
      wrap.classList.remove('editing');
    } else if (action === 'save') {
      window.saveClassNote(key, wrap);
    }
    return;
  }
});

// ============================================================
// 설정 탭
// ============================================================
function renderSettings() {
  const el = document.getElementById('tab-settings');
  if (!el) return;

  const isAdmin = userProfile?.role === 'admin';

  el.innerHTML = `
    <div class="settings-list">
      <div class="settings-section">
        <div class="settings-title">시간표</div>
        <button class="settings-item" onclick="window.openTimetableEditor()">
          <span>시간표 편집</span><span class="arrow-r">→</span>
        </button>
        <button class="settings-item" onclick="window.openPeriodsEditor()">
          <span>교시 시간 설정</span><span class="arrow-r">→</span>
        </button>
        <button class="settings-item" onclick="window.openDataDiag()">
          <span>데이터 진단 (진도 점검)</span><span class="arrow-r">→</span>
        </button>
      </div>
      <div class="settings-section">
        <div class="settings-title">학기</div>
        <button class="settings-item" onclick="window.openSemesterStarter()">
          <span>새 학기 시작 <span class="settings-sub">지금 ${escapeHtml(userData?.semester?.id || '')} · ${escapeHtml(userData?.semester?.start || '')} ~ ${escapeHtml(userData?.semester?.end || '')}</span></span><span class="arrow-r">→</span>
        </button>
      </div>
      ${isAdmin ? `
      <div class="settings-section">
        <div class="settings-title">학교 공통</div>
        <button class="settings-item" onclick="window.openCalendarEditor()">
          <span>학사일정 관리</span><span class="arrow-r">→</span>
        </button>
      </div>` : ''}
      <div class="settings-section">
        <div class="settings-title">계정</div>
        <button class="settings-item" onclick="window.copyInviteLink()">
          <span>초대 링크 복사</span><span class="arrow-r">→</span>
        </button>
        <button class="settings-item danger" onclick="window.handleSignOut()">
          <span>로그아웃</span>
        </button>
      </div>
      <div class="settings-user">
        <span>${userProfile?.name || currentUser?.displayName}</span>
        <span class="role-badge">${isAdmin ? 'admin' : 'teacher'}</span>
      </div>
    </div>
  `;
}

// ============================================================
// 새 학기 시작 — 지난 학기 시간표·고정핀·특별 수업·주제·메모는 archive/{지난학기} 에 보관하고 새 학기는 1차시부터 센다.
// 계산은 engine 의 planStartSemester 가 하고 여기서는 입력·확인·저장만 한다.
// ============================================================
function suggestNextSemesterId_(id) {
  const m = /^(\d{4})-([12])$/.exec(id || '');
  if (!m) return '';
  return m[2] === '1' ? `${m[1]}-2` : `${Number(m[1]) + 1}-1`;
}

window.openSemesterStarter = function() {
  const sem = userData.semester || {};
  const archived = Object.keys(userData.archive || {}).sort();
  const html = `
    <div class="modal-overlay" id="modal-semester">
      <div class="modal">
        <div class="modal-header">
          <h2>새 학기 시작</h2>
          <button class="modal-close" onclick="window.closeModal('modal-semester')">✕</button>
        </div>
        <div class="modal-body">
          <p class="modal-hint">지금 학기: <code>${escapeHtml(sem.id || '')}</code> ${escapeHtml(sem.start || '')} ~ ${escapeHtml(sem.end || '')}</p>
          <div class="sem-form">
            <label>새 학기 이름 <input type="text" id="sem-id" value="${escapeHtml(suggestNextSemesterId_(sem.id))}" placeholder="예: 2027-1" /></label>
            <label>시작일 <input type="date" id="sem-start" /></label>
            <label>끝날 <input type="date" id="sem-end" /></label>
            <label class="sem-check"><input type="checkbox" id="sem-copy-tt" checked /> 지금 시간표를 새 학기 첫 시간표로 복사 (반이 바뀌면 시작한 뒤 시간표 편집에서 고치기)</label>
          </div>
          <p class="modal-hint">시작하면 지난 학기의 <b>시간표·고정한 차시·특별 수업·하루 바꾸기·수업 주제·수업 메모·학급 메모</b>는 보관함에 그대로 남고,
            새 학기는 빈 상태에서 <b>1차시부터</b> 셉니다. 교시 시간과 학사일정은 그대로예요.</p>
          ${archived.length ? `<p class="modal-hint">보관된 학기: ${archived.map(a => `<code>${escapeHtml(a)}</code>`).join(' ')}</p>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="window.closeModal('modal-semester')">취소</button>
          <button class="btn-primary" onclick="window.startSemester()">새 학기 시작</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.startSemester = async function() {
  const next = {
    id:    document.getElementById('sem-id')?.value.trim(),
    start: document.getElementById('sem-start')?.value,
    end:   document.getElementById('sem-end')?.value,
  };
  const week = document.getElementById('sem-copy-tt')?.checked ? currentWeek() : {};
  const old  = userData.semester || {};
  try {
    const patch = PE.planStartSemester(userData, next, week, { at: nowStamp() }); // 잘못된 입력은 여기서 막는다
    if (!confirm(`${old.id || '지금'} 학기를 보관하고 ${next.id} 학기(${next.start} ~ ${next.end})를 시작할까요?\n\n`
      + `지난 학기 진도·주제·메모는 보관함(archive/${old.id})에 남고 화면에서는 사라집니다.`)) return;
    await commit_(patch, { src: '새학기시작', key: '(전체)', n: `${old.id} → ${next.id} (${next.start}~${next.end})` });
    closeModal('modal-semester');
    showToast(`${next.id} 학기를 시작했어요`);
    renderCurrentTab();
  } catch (e) {
    showToast('새 학기 시작 실패: ' + e.message, true);
  }
};

// ============================================================
// 시간표 편집기 — 저장하면 "적용 시작일"부터 쓰는 새 시간표 버전이 생긴다.
// 지난 날짜는 옛 시간표 그대로라 지난 수업 차시·장부가 바뀌지 않는다.
// ============================================================
window.openTimetableEditor = function() {
  const periods    = getPeriods();
  const periodList = Object.keys(periods).map(Number).sort((a,b) => a-b);
  const schedule   = currentWeek();
  const days       = ['mon','tue','wed','thu','fri'];
  const dayLabels  = ['월','화','수','목','금'];
  const versions   = Object.keys(userData.timetables || {}).sort();
  // 칸에 넣을 수 있는 반 / 과목 목록 (오타로 다른 반이 생기지 않게 고르게 한다)
  const choices    = PE.allKeys(userData).map(k => { const i = k.lastIndexOf('_'); return `${k.slice(0, i)} / ${k.slice(i + 1)}`; });

  let html = `
    <div class="modal-overlay" id="modal-timetable">
      <div class="modal">
        <div class="modal-header">
          <h2>시간표 편집</h2>
          <button class="modal-close" onclick="window.closeModal('modal-timetable')">✕</button>
        </div>
        <div class="modal-body">
          <p class="modal-hint">반과 과목을 각 칸에 입력하세요. 예: <code>308 / 역사</code> — 칸을 누르면 있는 반 목록에서 고를 수 있어요.</p>
          <label class="tt-effective">적용 시작일
            <input type="date" id="tt-effective" value="${semesterToday_()}" min="${userData.semester.start}" max="${userData.semester.end}" />
          </label>
          <p class="modal-hint">이 날짜부터 새 시간표로 세고, 그 전 수업은 원래 시간표 그대로예요.
            ${versions.length ? `지금까지의 시간표: ${versions.map(v => `<code>${v}~</code>`).join(' ')}` : ''}</p>
          <datalist id="tt-choices">${choices.map(c => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>
          <div class="timetable-editor">
            <table>
              <thead><tr><th>교시</th>`;
  dayLabels.forEach(d => { html += `<th>${d}</th>`; });
  html += `</tr></thead><tbody>`;

  for (const p of periodList) {
    html += `<tr><td class="period-col-edit">${p}교시</td>`;
    days.forEach(day => {
      const cell = schedule[day]?.[p];
      const val  = PE.cellKey(cell) ? `${cell.class} / ${cell.subject}` : '';
      html += `<td><input class="cell-input" list="tt-choices" data-period="${p}" data-day="${day}" value="${escapeHtml(val)}" placeholder="반 / 과목" /></td>`;
    });
    html += '</tr>';
  }
  html += `</tbody></table>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="window.closeModal('modal-timetable')">취소</button>
          <button class="btn-primary" onclick="window.saveTimetable()">저장</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
};

window.saveTimetable = async function() {
  const effectiveFrom = document.getElementById('tt-effective')?.value || semesterToday_();
  const week = {};
  document.querySelectorAll('.cell-input').forEach(input => {
    const val = input.value.trim();
    if (!val) return;
    const i = val.indexOf('/');
    const [cls, subject] = i < 0 ? [val, ''] : [val.slice(0, i), val.slice(i + 1)];
    (week[input.dataset.day] ||= {})[input.dataset.period] = { class: cls, subject };
  });

  try {
    const patch = PE.planSetTimetable(week, effectiveFrom); // 반·과목 중 하나만 적은 칸이 있으면 여기서 막는다
    if (effectiveFrom < todayStr() &&
        !confirm(`${effectiveFrom}부터 적용하면 그날부터 오늘까지 지난 수업의 장부·차시가 새 시간표로 다시 세어져요. 계속할까요?`)) return;
    await commit_(patch, { src: '시간표저장', key: '(전체)', n: `${effectiveFrom}부터 새 시간표` });
    closeModal('modal-timetable');
    showToast(`시간표 저장 완료 (${effectiveFrom}부터)`);
    renderCurrentTab();
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
  }
};

// ============================================================
// 교시 시간 편집기
// ============================================================
window.openPeriodsEditor = function() {
  const periods    = getPeriods();
  const periodList = Object.keys(periods).map(Number).sort((a,b) => a-b);

  let html = `
    <div class="modal-overlay" id="modal-periods">
      <div class="modal modal-sm">
        <div class="modal-header">
          <h2>교시 시간 설정</h2>
          <button class="modal-close" onclick="window.closeModal('modal-periods')">✕</button>
        </div>
        <div class="modal-body">
          <table class="periods-table">
            <thead><tr><th>교시</th><th>시작</th><th>종료</th><th></th></tr></thead>
            <tbody>`;
  for (const p of periodList) {
    const t = periods[p];
    html += `<tr data-period="${p}">
      <td>${p}교시</td>
      <td><input type="time" class="time-input" data-period="${p}" data-field="start" value="${t.start}" /></td>
      <td><input type="time" class="time-input" data-period="${p}" data-field="end"   value="${t.end}"   /></td>
      <td><button class="btn-del" onclick="this.closest('tr').remove(); window.reindexPeriods()">✕</button></td>
    </tr>`;
  }
  html += `</tbody></table>
          <button class="btn-add-period" onclick="window.addPeriodRow()">+ 교시 추가</button>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="window.closeModal('modal-periods')">취소</button>
          <button class="btn-primary"   onclick="window.savePeriods()">저장</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
};

window.savePeriods = async function() {
  const inputs  = document.querySelectorAll('.time-input');
  const periods = {};
  inputs.forEach(input => {
    const p     = Number(input.dataset.period);
    const field = input.dataset.field;
    if (!periods[p]) periods[p] = {};
    periods[p][field] = input.value;
  });

  try {
    await commit_({ periods }, { src: '교시시간저장', n: Object.keys(periods).length + '교시' });
    closeModal('modal-periods');
    showToast('교시 시간 저장 완료');
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
  }
};

window.addPeriodRow = function() {
  const tbody = document.querySelector('.periods-table tbody');
  const rows  = tbody.querySelectorAll('tr');
  const newP  = rows.length + 1;

  let newStart = '00:00';
  let newEnd   = '00:45';
  if (rows.length > 0) {
    const lastEnd  = rows[rows.length - 1].querySelector('[data-field="end"]')?.value || '00:00';
    const [h, m]   = lastEnd.split(':').map(Number);
    const startMin = h * 60 + m + 10;
    const endMin   = startMin + 45;
    newStart = `${String(Math.floor(startMin/60)).padStart(2,'0')}:${String(startMin%60).padStart(2,'0')}`;
    newEnd   = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;
  }

  const tr = document.createElement('tr');
  tr.dataset.period = newP;
  tr.innerHTML = `
    <td>${newP}교시</td>
    <td><input type="time" class="time-input" data-period="${newP}" data-field="start" value="${newStart}" /></td>
    <td><input type="time" class="time-input" data-period="${newP}" data-field="end"   value="${newEnd}" /></td>
    <td><button class="btn-del" onclick="this.closest('tr').remove(); window.reindexPeriods()">✕</button></td>`;
  tbody.appendChild(tr);
};

window.reindexPeriods = function() {
  const rows = document.querySelectorAll('.periods-table tbody tr');
  rows.forEach((row, i) => {
    const p = i + 1;
    row.dataset.period = p;
    row.cells[0].textContent = `${p}교시`;
    row.querySelectorAll('.time-input').forEach(input => {
      input.dataset.period = p;
    });
  });
};

// ============================================================
// 데이터 진단 — 자체 점검 결과, 반별 진도·고정핀, 변경 이력, 기기별 빌드
// ============================================================
function visibleStr(str) {
  // 공백류 문자를 눈에 보이는 기호로 바꿔서 렌더링 (공백/탭/전각공백 등 구분)
  const escaped = escapeHtml(str);
  return escaped
    .replace(/ /g, '<span class="diag-space">␣</span>')
    .replace(/　/g, '<span class="diag-space">⭞</span>')
    .replace(/\t/g, '<span class="diag-space">→</span>');
}

window.openDataDiag = function() {
  document.getElementById('modal-datadiag')?.remove();
  const issues = health();
  const keys   = PE.allKeys(userData);
  const me     = deviceInfo();
  const levelLabel = { error: '확인 필요', warn: '참고' };

  const issueHtml = issues.length
    ? `<ul class="diag-issues">${issues.map(i =>
        `<li class="diag-${i.level}"><b>${levelLabel[i.level] || i.level}</b> ${escapeHtml(i.msg)}</li>`).join('')}</ul>`
    : `<p class="modal-hint">✅ 자체 점검에서 문제를 찾지 못했어.</p>`;

  const keyRows = keys.map(k => {
    const rows = ledger(k);
    const n    = nextLesson(k);
    const pins = PE.pinsOf(userData, k);
    const cnt  = rows.reduce((c, r) => (c[r.kind]++, c), { regular: 0, special: 0, event: 0 });
    return `<tr>
      <td><code>${visibleStr(k)}</code></td>
      <td>${n ? `${escapeHtml(lessonLabel(n))} · <b>${n.step}차시</b>` : '학기에 남은 수업 없음'}</td>
      <td>${cnt.regular} / ${cnt.special} / ${cnt.event}</td>
      <td>${pins.map(p => `${p.date}${p.p ? ` ${p.p}교시` : ' 첫 수업'}=${p.step}`).join('<br>') || '-'}</td>
    </tr>`;
  }).join('');

  const logs = Object.values(userData.log || {}).sort((a, b) => (b.t || '').localeCompare(a.t || '')).slice(0, 40);
  const logRows = logs.map(e => `<tr><td>${escapeHtml(e.t || '')}</td><td>${escapeHtml(e.dev || '')}</td>
    <td>${escapeHtml(e.src || '')}</td><td><code>${visibleStr(e.key || '')}</code></td><td>${escapeHtml(e.n || '')}</td></tr>`).join('');
  const devRows = Object.entries(userData.devices || {}).sort((a, b) => (b[1].t || '').localeCompare(a[1].t || ''))
    .map(([id, d]) => `<tr><td>${escapeHtml(d.label || '')}·${escapeHtml(id)}${id === me.id ? ' (이 기기)' : ''}</td><td>${escapeHtml(d.t || '')}</td><td>${escapeHtml(d.build || '')}</td></tr>`).join('');
  const mig = userData.migration;

  const html = `
    <div class="modal-overlay" id="modal-datadiag">
      <div class="modal modal-lg">
        <div class="modal-header">
          <h2>데이터 진단</h2>
          <button class="modal-close" onclick="window.closeModal('modal-datadiag')">✕</button>
        </div>
        <div class="modal-body">
          <h3 class="diag-h">자체 점검</h3>
          ${issueHtml}
          <h3 class="diag-h">반별 진도</h3>
          <p class="modal-hint">학기 ${escapeHtml(userData.semester.start)} ~ ${escapeHtml(userData.semester.end)} ·
            시간표 버전 ${Object.keys(userData.timetables || {}).sort().map(v => `<code>${v}~</code>`).join(' ') || '없음'}<br>
            차시는 학기 첫 수업부터 세고, 직접 고친 자리(고정핀)를 만나면 거기서부터 이어서 세. 공백은 <code>␣</code>로 보여.</p>
          <table class="cal-table">
            <thead><tr><th>반_과목</th><th>다음 수업</th><th>정규 / 특별 / 휴업</th><th>직접 고친 차시(고정핀)</th></tr></thead>
            <tbody>${keyRows || '<tr><td colspan="4">시간표에 수업이 없어</td></tr>'}</tbody>
          </table>
          <h3 class="diag-h">변경 이력 <small>(최근 40건 · 이 화면 빌드 ${escapeHtml(APP_BUILD)} · ${escapeHtml(me.label)}·${escapeHtml(me.id)})</small></h3>
          <table class="cal-table">
            <thead><tr><th>시각</th><th>기기</th><th>구분</th><th>반_과목</th><th>내용</th></tr></thead>
            <tbody>${logRows || '<tr><td colspan="5">아직 이력이 없어</td></tr>'}</tbody>
          </table>
          <h3 class="diag-h">기기별 마지막 접속</h3>
          <p class="modal-hint">빌드가 기기마다 다르면 한쪽이 옛 app.js를 쓰고 있는 거야(캐시). 옛 버전은 v2 진도에 쓰지 못해서 진도가 망가지지는 않아.</p>
          <table class="cal-table">
            <thead><tr><th>기기</th><th>마지막 접속</th><th>빌드</th></tr></thead>
            <tbody>${devRows || '<tr><td colspan="3">아직 기록 없음</td></tr>'}</tbody>
          </table>
          ${mig ? `<h3 class="diag-h">v1에서 옮긴 기록 <small>${escapeHtml(mig.at || '')}</small></h3>
            <ul class="diag-issues">${(mig.report || []).map(r => `<li class="diag-${r.level}">${escapeHtml(r.msg)}</li>`).join('') || '<li>특이사항 없음</li>'}</ul>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="window.closeModal('modal-datadiag')">닫기</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
};

// ============================================================
// 3학년 전환기 시간표 (2026-11-02 ~ 2027-01-08)
// - 학년 지정이 생겨서 3학년 일정은 시간표 교시에 맞추지 않고 문서의 교시 그대로 학년 3으로 등록
//   (성탄절·신정·재량휴업일은 전일 휴업이라 하루종일, 학년 지정 없음)
// - 반별 일정(1/28~29 연만들기·연날리기)은 학사일정이 반 단위를 못 가려서 제외
// - 11/30~12/10 "졸업영상 제작 및 교과수업"은 교과수업이 가능한 기간이라 제외
// - 원서접수·성적산출 기준일 같은 입시 일정은 수업 진행과 무관해 제외
// ============================================================
const _P = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// 휴업은 전 학년, 나머지는 3학년 일정이라 학년 3을 붙인다
const _ev = (date, type, label, periods, grades = type === 'holiday' ? '' : '3') => {
  return periods ? { date, type, label, periods, isAll: false, grades } : { date, type, label, periods: [], isAll: true, grades };
};
const TRANSITION_CALENDAR = [
  // 11월 (「2026학년도 3학년 전환기 시간표」 기준 — 3학년 일정은 문서의 교시 그대로 학년 3, 전 학년 교육은 학년 지정 없음)
  _ev('2026-11-02', 'event',   '특성화고 설명회(교내)', _P(1, 6)),
  _ev('2026-11-03', 'event',   '특성화고 설명회(교내)', _P(1, 4)),
  _ev('2026-11-03', 'event',   'AI 교육(교내)', [5]),
  _ev('2026-11-04', 'event',   '목동 스케이트장(교외체험)', _P(1, 6)),
  _ev('2026-11-06', 'event',   '진로 체험의 날', _P(1, 6), ''),
  _ev('2026-11-09', 'event',   '오목대회(교내)', _P(1, 4)),
  _ev('2026-11-12', 'event',   '노동인권교육', _P(5, 7)),
  _ev('2026-11-16', 'event',   '고고학', [5, 6]),
  _ev('2026-11-18', 'event',   '장애이해교육',                 [1], ''),
  _ev('2026-11-18', 'event',   '학생도박예방교육',             [2], ''),
  _ev('2026-11-18', 'event',   '아동학대예방교육',             [3], ''),
  _ev('2026-11-18', 'event',   '금연교육',                     [4], ''),
  _ev('2026-11-20', 'holiday', '재량휴업일'),
  _ev('2026-11-26', 'event',   '서울식물원(1-4반)/서울퓨처랩(5-8반)', _P(1, 7)),
  // 12월
  _ev('2026-12-02', 'event',   '금융교육', [5, 6]),
  _ev('2026-12-10', 'event',   '뮤지컬 영상 시청(교내)', _P(5, 7)),
  _ev('2026-12-11', 'event',   '서울퓨처랩(1-4반)/서울식물원(5-8반)', _P(1, 6)),
  _ev('2026-12-14', 'event',   '구기대회(교내)', _P(1, 4)),
  _ev('2026-12-15', 'event',   '구기대회(교내)', _P(1, 4)),
  _ev('2026-12-16', 'event',   '구기대회(교내)', _P(1, 4)),
  _ev('2026-12-21', 'event',   '영화 관람(크리스마스 캐롤, 어벤저스)', _P(1, 6)),
  _ev('2026-12-23', 'event',   '크리스마스 쿠키 만들기(교내)', _P(1, 4)),
  _ev('2026-12-24', 'event',   '페인터즈 공연관람(교외체험)', _P(1, 7)),
  _ev('2026-12-25', 'holiday', '성탄절'),
  // 1월
  _ev('2027-01-01', 'holiday', '신정'),
  _ev('2027-01-04', 'event',   '학생인권교육', [1, 2], ''),
  _ev('2027-01-04', 'event',   '약물오남용예방교육', [3], ''),
  _ev('2027-01-04', 'event',   '사이버 중독 예방교육', [4], ''),
  _ev('2027-01-06', 'event',   '졸업식 꽃풍선 만들기(교내)', _P(1, 4)),
  _ev('2027-01-07', 'event',   '졸업식 예행연습 및 롤링페이퍼', _P(1, 7)),
  _ev('2027-01-08', 'event',   '졸업식', _P(1, 6)),
];

// 학사일정 한 행. g.grades: '' = 전 학년, '3' = 3학년만, '23' = 2·3학년 (같은 일정을 학년 칸으로 나눠 저장)
// type 'swap' = 요일 대체: 그 날짜는 g.swapTo 요일 시간표로 수업 (교시·학년 칸은 쓰지 않음)
const SWAP_DAYS = [['mon', '월'], ['tue', '화'], ['wed', '수'], ['thu', '목'], ['fri', '금']];
function calRowHtml(idx, g) {
  const isAll = g.isAll;
  const periods = g.periods || [];
  const grades = g.grades || '';
  const isSwap = g.type === 'swap';
  return `
  <tr id="cal-row-${idx}" class="${isSwap ? 'cal-swap-row' : ''}">
    <td><input class="cal-input" data-idx="${idx}" data-field="date" value="${g.date}" placeholder="YYYY-MM-DD" /></td>
    <td class="cal-allday-cell">
      <div class="cal-swap-pick" style="${isSwap ? '' : 'display:none'}">
        <select class="cal-select" data-idx="${idx}" data-field="swapto">
          ${SWAP_DAYS.map(([k, ko]) => `<option value="${k}" ${g.swapTo === k ? 'selected' : ''}>${ko}요일 시간표로 수업</option>`).join('')}
        </select>
      </div>
      <div class="cal-period-group" data-idx="${idx}" style="${isSwap ? 'display:none' : ''}">
        <label class="allday-toggle">
          <input type="checkbox" class="cal-allday-check" data-idx="${idx}" onchange="window.toggleAlldayCheck(this)" ${isAll ? 'checked' : ''} />
          <span>하루종일</span>
        </label>
        <div class="cal-period-checks" style="${isAll ? 'display:none' : ''}">
          ${[1,2,3,4,5,6,7].map(p => `
            <label class="period-check-label">
              <input type="checkbox" class="cal-period-check" data-idx="${idx}" value="${p}" ${periods.includes(p) ? 'checked' : ''} />
              ${p}
            </label>`).join('')}
        </div>
      </div>
    </td>
    <td class="cal-grade-cell">
      <div class="cal-grade-checks" style="${isSwap ? 'display:none' : ''}">
        ${[1,2,3].map(n => `
          <label class="period-check-label">
            <input type="checkbox" class="cal-grade-check" data-idx="${idx}" value="${n}" ${grades.includes(String(n)) ? 'checked' : ''} />
            ${n}
          </label>`).join('')}
        <small class="cal-grade-hint">${grades ? '' : '전체'}</small>
      </div>
    </td>
    <td>
      <select class="cal-select" data-idx="${idx}" data-field="type" onchange="window.onCalTypeChange(this)">
        <option value="holiday" ${g.type==='holiday'?'selected':''}>휴업</option>
        <option value="event"   ${g.type==='event'  ?'selected':''}>행사</option>
        <option value="exam"    ${g.type==='exam'   ?'selected':''}>시험</option>
        <option value="club"    ${g.type==='club'   ?'selected':''}>동아리</option>
        <option value="noclass" ${g.type==='noclass'?'selected':''}>수업없음</option>
        <option value="swap"    ${isSwap            ?'selected':''}>요일 대체</option>
      </select>
    </td>
    <td><input class="cal-input" data-idx="${idx}" data-field="label" value="${g.label||''}" placeholder="표시 텍스트" /></td>
    <td><button class="btn-del" onclick="document.getElementById('cal-row-${idx}').remove()">✕</button></td>
  </tr>`;
}

// ============================================================
// 학사일정 편집기 (관리자)
// ============================================================
window.openCalendarEditor = function() {
  const calendar = schoolData?.calendar || {};

  // 같은 날짜+종류+텍스트인 항목들을 하나의 행으로 그룹핑
  // 교시 키는 '3' · 'all' · '3@2'(2학년만) · 'all@3' · 'swap'(요일 대체)
  const groupMap = new Map(); // key: date||type||label||학년 -> { date, type, label, periods:[], isAll, grades }
  const swaps = [];
  for (const [date, periods] of Object.entries(calendar)) {
    for (const [period, ev] of Object.entries(periods)) {
      if (period === 'swap') {
        swaps.push({ date, type: 'swap', label: ev.label || '', swapTo: ev.to, periods: [], isAll: false, grades: '' });
        continue;
      }
      const [pk, grade = ''] = period.split('@');
      const key = `${date}||${ev.type}||${ev.label}||${grade}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, { date, type: ev.type, label: ev.label, periods: [], isAll: false, grades: grade });
      }
      const g = groupMap.get(key);
      if (pk === 'all') g.isAll = true;
      else g.periods.push(Number(pk));
    }
  }

  // 학년만 다른 같은 일정(예: 2학년·3학년 둘 다 같은 교시 행사)은 한 행으로 합친다
  const merged = new Map();
  for (const g of groupMap.values()) {
    g.periods.sort((a, b) => a - b);
    const sig = g.grades ? `${g.date}||${g.type}||${g.label}||${g.isAll}||${g.periods}` : `${g.date}||${g.type}||${g.label}||전체||${g.isAll}||${g.periods}`;
    const prev = merged.get(sig);
    if (prev) prev.grades = [...new Set(prev.grades + g.grades)].sort().join('');
    else merged.set(sig, g);
  }

  const groups = [...merged.values(), ...swaps].sort((a,b) => b.date.localeCompare(a.date));

  const rows = groups.map((g, i) => calRowHtml(i, g)).join('');

  const html = `
    <div class="modal-overlay" id="modal-calendar">
      <div class="modal modal-lg">
        <div class="modal-header">
          <h2>학사일정 관리</h2>
          <button class="modal-close" onclick="window.closeModal('modal-calendar')">✕</button>
        </div>
        <div class="modal-body">
          <button class="btn-add-period" onclick="window.addCalRow()" style="margin-bottom:10px;margin-top:0">+ 항목 추가</button>
          <button class="btn-add-period" onclick="window.importTransitionCalendar()" style="margin-bottom:10px;margin-top:0">3학년 전환기 일정 불러오기</button>
          <table class="cal-table">
            <thead><tr><th>날짜</th><th>교시</th><th>학년<small> (비우면 전체)</small></th><th>종류</th><th>표시</th><th></th></tr></thead>
            <tbody id="cal-tbody">${rows}</tbody>
          </table>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="window.closeModal('modal-calendar')">취소</button>
          <button class="btn-primary"   onclick="window.saveCalendar()">저장</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
};

window.toggleAlldayCheck = function(checkbox) {
  const group = checkbox.closest('.cal-period-group');
  const checksDiv = group.querySelector('.cal-period-checks');
  if (checkbox.checked) {
    checksDiv.style.display = 'none';
    checksDiv.querySelectorAll('.cal-period-check').forEach(c => c.checked = false);
  } else {
    checksDiv.style.display = '';
  }
};

// 종류를 '요일 대체'로 바꾸면 교시·학년 칸 대신 요일 고르기를 보여준다
window.onCalTypeChange = function(select) {
  const row = select.closest('tr');
  const isSwap = select.value === 'swap';
  row.classList.toggle('cal-swap-row', isSwap);
  row.querySelector('.cal-swap-pick').style.display = isSwap ? '' : 'none';
  row.querySelector('.cal-period-group').style.display = isSwap ? 'none' : '';
  row.querySelector('.cal-grade-checks').style.display = isSwap ? 'none' : '';
};

window.addCalRow = function(g) {
  const tbody = document.getElementById('cal-tbody');
  const idx   = Date.now() + Math.floor(Math.random() * 1000);
  tbody.insertAdjacentHTML('afterbegin',
    calRowHtml(idx, g || { date: '', type: 'holiday', label: '', periods: [], isAll: false }));

  // 새 행이 잘 보이도록 스크롤
  document.getElementById(`cal-row-${idx}`)?.scrollIntoView({ block: 'nearest' });
};

// 3학년 전환기 시간표(11/2~1/8) 불러오기 — 기존 행은 그대로 두고 없는 것만 추가한다. 저장 버튼을 눌러야 반영됨
window.importTransitionCalendar = function() {
  const existing = new Set();
  document.querySelectorAll('#cal-tbody tr').forEach(row => {
    const d = row.querySelector('[data-field="date"]')?.value.trim();
    const l = row.querySelector('[data-field="label"]')?.value.trim();
    if (d) existing.add(`${d}||${l}`);
  });
  const toAdd = TRANSITION_CALENDAR.filter(g => !existing.has(`${g.date}||${g.label}`));
  [...toAdd].reverse().forEach(g => window.addCalRow(g));
  showToast(toAdd.length
    ? `전환기 일정 ${toAdd.length}건 추가 (기존 ${TRANSITION_CALENDAR.length - toAdd.length}건은 이미 있어 건너뜀) — 확인 후 저장`
    : '이미 모두 들어있어요');
};

window.saveCalendar = async function() {
  const rows     = document.querySelectorAll('#cal-tbody tr');
  const calendar = {};

  rows.forEach(row => {
    const dateInput   = row.querySelector('[data-field="date"]');
    const alldayCheck = row.querySelector('.cal-allday-check');
    const typeSelect  = row.querySelector('[data-field="type"]');
    const labelInput  = row.querySelector('[data-field="label"]');

    const date = dateInput?.value.trim();
    if (!date) return;

    const type  = typeSelect?.value || 'event';
    const label = labelInput?.value.trim() || '';
    const isAll = alldayCheck?.checked;

    if (!calendar[date]) calendar[date] = {};

    // 요일 대체: 그날은 to 요일 시간표로 수업 (원래 요일 수업은 없어짐, 전 학년 공통)
    if (type === 'swap') {
      const to = row.querySelector('[data-field="swapto"]')?.value;
      const toKo = SWAP_DAYS.find(([k]) => k === to)?.[1];
      if (toKo) calendar[date]['swap'] = { type, label: label || `${toKo}요일 수업`, to };
      return;
    }

    // 학년을 고르면 그 학년 수업만 해당 ('3@2' = 2학년만), 비우면 전 학년
    const grades = [...row.querySelectorAll('.cal-grade-check:checked')].map(c => c.value);
    const suffixes = grades.length ? grades.map(g => `@${g}`) : [''];

    if (isAll) {
      suffixes.forEach(s => { calendar[date]['all' + s] = { type, label }; });
    } else {
      const checkedPeriods = [...row.querySelectorAll('.cal-period-check:checked')].map(c => c.value);
      checkedPeriods.forEach(p => {
        suffixes.forEach(s => { calendar[date][p + s] = { type, label }; });
      });
    }
  });

  try {
    if (!DEMO) await set(ref(db, 'school/calendar'), calendar);
    schoolData.calendar = calendar;
    setData_({ ...userData, calendar }); // 학사일정은 v2에 저장하지 않고 계산할 때만 같이 쓴다
    closeModal('modal-calendar');
    showToast('학사일정 저장 완료');
    renderCurrentTab();
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
  }
};

// ============================================================
// 모달 닫기
// ============================================================
window.closeModal = function(id) {
  document.getElementById(id)?.remove();
};

// ============================================================
// 초대 링크
// ============================================================
window.copyInviteLink = function() {
  const link = `${location.origin}${location.pathname}?invite=${currentUser.uid}`;
  navigator.clipboard.writeText(link).then(() => showToast('초대 링크 복사 완료'));
};

function checkInviteParam() {
  const params    = new URLSearchParams(location.search);
  const invitedBy = params.get('invite');
  if (invitedBy) {
    sessionStorage.setItem('invitedBy', invitedBy);
  }
}

// ============================================================
// 인증
// ============================================================
window.handleSignIn = async function() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch(e) {
    console.error(e);
  }
};

window.handleSignOut = async function() {
  await signOut(auth);
};

window.switchTab = switchTab;

// 데모: 로그인·DB 없이 demo/*.json 으로 화면만 띄운다 (저장은 메모리에만)
if (DEMO) {
  currentUser = { uid: 'demo', displayName: '데모' };
  userProfile = { name: '데모', role: 'admin' };
  showApp();
  loadUserData().catch(e => showToast('데모 데이터를 못 읽었어요: ' + e.message, true));
  startPlanner_();
}

onAuthStateChanged(auth, async (user) => {
  if (DEMO) return;
  if (user) {
    currentUser = user;

    const profileSnap = await get(ref(db, `users/${user.uid}/profile`));
    if (!profileSnap.exists()) {
      const invitedBy = sessionStorage.getItem('invitedBy');
      const isAdmin   = user.email === ADMIN_EMAIL;
      const profile   = {
        name: user.displayName,
        email: user.email,
        role: isAdmin ? 'admin' : 'teacher',
        ...(invitedBy ? { invitedBy } : {})
      };
      await set(ref(db, `users/${user.uid}/profile`), profile);
      userProfile = profile;
      sessionStorage.removeItem('invitedBy');
    } else {
      userProfile = profileSnap.val();
    }

    showApp();
    startPlanner_();   // 기다리지 않는다 — 시간표 로딩과 따로 진행
    await loadUserData();

    if (!dateRolloverTimer) {
      dateRolloverTimer = setInterval(checkDateRollover, 5 * 60 * 1000);
    }
  } else {
    stopPlanner_();
    currentUser = null;
    userProfile = null;
    if (dateRolloverTimer) { clearInterval(dateRolloverTimer); dateRolloverTimer = null; }
    showLogin();
  }
});

// 탭이 백그라운드에 있다가 다시 보일 때 / 창에 포커스가 돌아올 때도 확인
// (모바일 브라우저는 백그라운드에서 setInterval을 아예 멈춰버리는 경우가
// 많아서, 5분 주기 타이머만 믿으면 며칠씩 안 열어본 경우를 못 잡음)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkDateRollover();
});
window.addEventListener('focus', checkDateRollover);
// bfcache(뒤로가기/탭 복원)로 며칠 전 화면이 그대로 살아 돌아오는 경우, 네트워크가 다시 붙는 경우
window.addEventListener('pageshow', checkDateRollover);
window.addEventListener('online', checkDateRollover);

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display   = '';

  const pipBtn = document.getElementById('pip-btn');
  if (pipBtn && !('documentPictureInPicture' in window)) pipBtn.style.display = 'none';
}

function showLogin() {
  document.getElementById('login-screen').style.display = '';
  document.getElementById('app-screen').style.display   = 'none';
}

// ============================================================
// 미니창(Document Picture-in-Picture) — 항상 위에 띄우는 오늘 시간표
// 다른 작업을 하면서 오늘 시간표를 겹쳐 볼 수 있도록 별도 창으로 띄운다.
// 크로미움 기반 브라우저(웨일 포함)만 지원, 미지원 브라우저는 버튼 자체를 숨김.
// PiP 창은 OS 입장에서 불투명한 별도 창이라 웹 코드로 창 투명도를 바꿀 수 없다.
// 대신 '간단히' 보기로 지금·다음 교시만 남겨 창을 작게 쓸 수 있게 한다.
// ============================================================
// PiP 창은 별도 document 라 style.css 의 @import 폰트가 적용되지 않는다 → 따로 불러온다
const PIP_FONT_URL = 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap';
const PIP_HEIGHT   = { full: 280, compact: 150 };

const PIP_CSS = `
  html, body { margin:0; padding:0; height:100%; background:#fff; }
  * { box-sizing:border-box; font-family:'Noto Sans KR', 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', sans-serif; }
  #pip-widget { display:flex; flex-direction:column; height:100%; background:#fff; color:#1a1a1a; }
  #pip-head {
    display:flex; align-items:center; justify-content:space-between;
    gap:6px; padding:7px 10px; flex:0 0 auto;
    border-bottom:1px solid #e8e6e0;
  }
  #pip-date {
    font-size:11px; font-weight:700; color:#2d6a4f;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  #pip-date .pip-time { font-family:'Space Mono', ui-monospace, 'Cascadia Mono', Consolas, 'Malgun Gothic', monospace; margin-left:4px; }
  #pip-mode {
    flex-shrink:0; padding:2px 8px; border-radius:6px; cursor:pointer;
    border:1px solid #e8e6e0; background:#fff; color:#666; font-size:10.5px;
  }
  #pip-mode:hover { color:#2d6a4f; border-color:#2d6a4f; }
  #pip-body { flex:1 1 auto; overflow-y:auto; padding:2px 8px 8px; font-size:12px; }
  .pip-row { display:flex; gap:7px; padding:7px 4px; border-bottom:1px solid rgba(0,0,0,.06); align-items:flex-start; border-left:3px solid transparent; }
  .pip-row:last-child { border-bottom:none; }
  .pip-row.current { background:#f0faf4; border-left-color:#2d6a4f; border-radius:0 8px 8px 0; }
  .pip-p { flex:0 0 14px; font-family:'Space Mono', ui-monospace, 'Cascadia Mono', Consolas, 'Malgun Gothic', monospace; font-weight:700; font-size:10px; color:#999; padding-top:1px; }
  .pip-info { flex:1 1 auto; min-width:0; display:flex; flex-wrap:wrap; gap:3px 6px; align-items:baseline; }
  .pip-class {
    font-family:'Space Mono', 'Noto Sans KR', monospace; font-weight:700; font-size:11px;
    color:#2d6a4f; background:#e8f5ee; padding:1px 6px; border-radius:5px;
  }
  .pip-topic { flex-basis:100%; font-size:12px; font-weight:500; color:#1a1a1a; }
  .pip-note  { flex-basis:100%; font-size:10.5px; color:#b5690b; }
  .pip-empty-cell, .pip-empty { color:#999; font-size:11px; }
  .pip-empty { padding:8px 4px; }
  .pip-badge { padding:1px 7px; border-radius:5px; background:#fdf0e3; color:#e07c24; font-size:10px; font-weight:600; }
`;

let pipCompact     = localStorage.getItem('pipCompact') === '1';
let pipScrolledFor = null; // 마지막으로 자동 스크롤한 교시 — 30초 갱신마다 스크롤을 뺏지 않도록

function pipRowsHtml() {
  if (!userData) return `<div class="pip-empty">데이터를 불러오는 중…</div>`;

  const now      = new Date();
  const dowIdx   = now.getDay();
  if (dowIdx === 0 || dowIdx === 6) return `<div class="pip-empty">오늘은 주말이에요 🎉</div>`;

  const periods  = getPeriods();
  const today    = todayStr();
  const schedule = daySchedule(today);
  const periodList = Object.keys(periods).map(Number).sort((a, b) => a - b);
  const curP     = getCurrentPeriod();

  if (!periodList.some(p => schedule[p]?.class)) return `<div class="pip-empty">오늘은 수업이 없어요</div>`;

  // 지금 교시, 쉬는 시간이면 다음 교시
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const focusP = curP ?? periodList.find(p => parseTimeToMin(periods[p].start) > nowMin) ?? null;

  let shown = periodList;
  if (pipCompact) {
    if (focusP === null) return `<div class="pip-empty">오늘 수업이 모두 끝났어요</div>`;
    const hasLesson = p => schedule[p]?.class || getCalendarEvent(today, String(p));
    const nextP = periodList.find(p => p > focusP && hasLesson(p));
    shown = nextP === undefined ? [focusP] : [focusP, nextP];
  }

  return shown.map(p => {
    const cell  = schedule[p];
    const ev    = getCalendarEvent(today, String(p));
    const isCur = p === curP;
    let body;

    if (ev) {
      body = `<span class="pip-badge">${escapeHtml(ev.label)}</span>`;
    } else if (cell?.class) {
      const { key, special, topic } = lessonCellInfo(today, p, cell);
      const note    = userData.classNotes?.[key]?.text || '';
      body = `
        <span class="pip-class">${escapeHtml(cell.class)}</span>
        <span>${escapeHtml(cell.subject)}</span>
        ${special ? `<span class="pip-badge">특별 · ${escapeHtml(special.label)}</span>` : ''}
        ${topic ? `<span class="pip-topic">${escapeHtml(topic)}</span>` : ''}
        ${note  ? `<span class="pip-note">🗒 ${escapeHtml(note)}</span>` : ''}
      `;
    } else {
      body = `<span class="pip-empty-cell">공강</span>`;
    }

    return `
      <div class="pip-row${isCur ? ' current' : ''}${p === focusP ? ' focus' : ''}" data-p="${p}">
        <span class="pip-p">${p}</span>
        <div class="pip-info">${body}</div>
      </div>`;
  }).join('');
}

function renderPipWidget() {
  if (!pipWindow) return;
  const doc = pipWindow.document;
  const now = new Date();

  const dateEl = doc.getElementById('pip-date');
  if (dateEl) {
    dateEl.innerHTML = `${now.getMonth()+1}월 ${now.getDate()}일(${DOW_KO[now.getDay()]})<span class="pip-time">${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}</span>`;
  }
  const bodyEl = doc.getElementById('pip-body');
  if (bodyEl) {
    bodyEl.innerHTML = pipRowsHtml();
    // 지금(또는 다음) 교시가 바뀌었을 때만 그 줄이 보이게 스크롤
    const focusRow = bodyEl.querySelector('.pip-row.focus');
    const focusP   = focusRow?.dataset.p ?? null;
    if (focusRow && focusP !== pipScrolledFor) focusRow.scrollIntoView({ block: 'center' });
    pipScrolledFor = focusP;
  }
}

function setPipCompact(on) {
  pipCompact = on;
  localStorage.setItem('pipCompact', on ? '1' : '0');

  const btn = pipWindow.document.getElementById('pip-mode');
  btn.textContent = on ? '전체' : '간단히';
  btn.title       = on ? '오늘 전체 교시 보기' : '지금·다음 교시만 보기';

  pipScrolledFor = null;
  renderPipWidget();
  // 창 크기 변경은 사용자 클릭 안에서만 허용된다. 너비는 사용자가 맞춘 그대로 둔다.
  try { pipWindow.resizeBy(0, PIP_HEIGHT[on ? 'compact' : 'full'] - pipWindow.innerHeight); } catch (e) {}
}

window.openPipWidget = async function() {
  if (!('documentPictureInPicture' in window)) {
    showToast('이 브라우저는 미니창 기능을 지원하지 않아요', true);
    return;
  }
  if (pipWindow) {
    pipWindow.focus();
    return;
  }

  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 220, height: PIP_HEIGHT[pipCompact ? 'compact' : 'full'],
    });
  } catch (e) {
    showToast('미니창을 열 수 없어요', true);
    return;
  }

  const doc  = pipWindow.document;
  const font = doc.createElement('link');
  font.rel  = 'stylesheet';
  font.href = PIP_FONT_URL;
  doc.head.appendChild(font);

  const style = doc.createElement('style');
  style.textContent = PIP_CSS;
  doc.head.appendChild(style);

  doc.body.innerHTML = `
    <div id="pip-widget">
      <div id="pip-head">
        <span id="pip-date"></span>
        <button id="pip-mode" type="button"></button>
      </div>
      <div id="pip-body"></div>
    </div>
  `;
  doc.getElementById('pip-mode').addEventListener('click', () => setPipCompact(!pipCompact));

  pipScrolledFor = null;
  setPipCompact(pipCompact);
  pipRefreshTimer = setInterval(renderPipWidget, 30000);

  pipWindow.addEventListener('pagehide', () => {
    clearInterval(pipRefreshTimer);
    pipRefreshTimer = null;
    pipWindow = null;
  });
};

// ============================================================
// 토스트
// ============================================================
function showToast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast show${isErr ? ' error' : ''}`;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ============================================================
// 초기화
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

checkInviteParam();
checkCodeUpdate_();
