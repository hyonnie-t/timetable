import {
  auth, db, googleProvider,
  ref, get, set, update, onValue,
  signInWithPopup, signOut, onAuthStateChanged
} from './firebase.js';

// ============================================================
// 상수
// ============================================================
const DOW_KO  = ['일','월','화','수','목','금','토'];
const DOW_KEY = ['sun','mon','tue','wed','thu','fri','sat'];
const ADMIN_EMAIL = '0000.yhshin@gmail.com';
const CURRENT_SEMESTER = '2026-2'; // 학기 바뀔 때 여기만 수정
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
// 학기 progress 헬퍼
// ============================================================
// 현재 학기의 progress 객체를 반환 (없으면 빈 객체)
function semProgress() {
  return userData?.progress?.[CURRENT_SEMESTER] || {};
}

// ============================================================
// 교시 유틸
// ============================================================
function getPeriods() {
  return userData?.timetable?.periods || {
    1: { start: '09:00', end: '09:45' },
    2: { start: '09:55', end: '10:40' },
    3: { start: '10:50', end: '11:35' },
    4: { start: '11:45', end: '12:30' },
    5: { start: '13:20', end: '14:05' },
    6: { start: '14:15', end: '15:00' },
    7: { start: '15:10', end: '15:55' },
  };
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
// 학사일정 헬퍼
// ============================================================
function getCalendarEvent(dateStr, periodStr) {
  const dayEvents = schoolData?.calendar?.[dateStr] || {};
  return dayEvents[periodStr] || dayEvents['all'] || null;
}

// cls/subject 수업이 fromStr~toStr(둘 다 포함) 사이에 학사일정 이벤트 없이 몇 번 있는지 카운트
function countKeyLessonsBetween(cls, subject, fromStr, toStr) {
  if (fromStr > toStr) return 0;
  let count = 0;
  const cursor = new Date(fromStr);
  const toDate = new Date(toStr);
  cursor.setHours(0,0,0,0);
  toDate.setHours(0,0,0,0);
  while (cursor <= toDate) {
    const dateStr     = dateToStr(cursor);
    const dayKey      = DOW_KEY[cursor.getDay()];
    const daySchedule = userData?.timetable?.schedule?.[dayKey] || {};
    for (const [periodStr, cell] of Object.entries(daySchedule)) {
      if (cell?.class === cls && cell?.subject === subject) {
        const ev = getCalendarEvent(dateStr, periodStr);
        if (!ev) count++;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

// 기말고사까지(오늘 포함) 남은 역사 수업 차시 — 학사일정 예외 자동 반영
function remainingLessonsUntilExam(cls, g) {
  const end = g.includeStart ? g.start : addDaysStr(g.start, -1);
  return countKeyLessonsBetween(cls, g.subject, todayStr(), end);
}

// dateStr 기준으로 delta일 이동한 날짜 문자열
function addDaysStr(dateStr, delta) {
  const d = parseDateStr_(dateStr); // new Date('YYYY-MM-DD')는 UTC 자정이라 시간대에 따라 하루 밀릴 수 있음
  d.setDate(d.getDate() + delta);
  return dateToStr(d);
}

// ============================================================
// 진도 계산 — 저장하지 않고 매번 계산한다
// ============================================================
// DB의 progress[학기][반_과목] = { current, lastUpdated } 는 "기준점" 하나뿐이다.
//   뜻: lastUpdated 날이 끝났을 때까지 current 차시를 마쳤다.
// 어떤 수업이 몇 차시인지는 기준점 + 그 사이 시간표 수업 수(학사일정으로 빠진 교시 제외)로
// 그때그때 계산한다. 그래서 날마다 +1 해서 저장하는 일이 없고,
//   - 앱을 안 열어도, 여러 기기를 써도, 수업 전/후 어느 때 고쳐도 하루가 빠지거나 겹치지 않고
//   - 학사일정을 나중에 고치면 지난 차시까지 저절로 맞춰진다.
// 기준점은 사람이 차시를 직접 고칠 때와 시간표를 바꿀 때만 바뀐다.
// (예전 앱이 쓰던 자동 +1 저장도 같은 뜻이라, 옛 데이터·옛 기기와 그대로 호환된다)

function parseDateStr_(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// dateStr에 key 수업이 실제로 있는 교시 번호들 (학사일정으로 빠진 교시 제외, 오름차순)
function lessonPeriodsOn(key, dateStr) {
  const daySchedule = userData?.timetable?.schedule?.[DOW_KEY[parseDateStr_(dateStr).getDay()]] || {};
  return Object.entries(daySchedule)
    .filter(([p, cell]) => cell?.class && `${cell.class}_${cell.subject}` === key && !getCalendarEvent(dateStr, p))
    .map(([p]) => Number(p))
    .sort((a, b) => a - b);
}

// fromStr~toStr(둘 다 포함) 사이 key 수업 수
function countLessons(key, fromStr, toStr) {
  let count = 0;
  for (let d = fromStr; d <= toStr; d = addDaysStr(d, 1)) count += lessonPeriodsOn(key, d).length;
  return count;
}

// dateStr 날이 시작되기 전까지 마친 차시 수
function doneBefore(key, dateStr) {
  const entry = semProgress()[key];
  if (!entry) return 0;
  const done = entry.current ?? 0;
  const lu   = entry.lastUpdated || addDaysStr(todayStr(), -1);
  return dateStr > lu
    ? done + countLessons(key, addDaysStr(lu, 1), addDaysStr(dateStr, -1))
    : done - countLessons(key, dateStr, lu);
}

// dateStr p교시 수업이 몇 차시인지
function lessonStep(key, dateStr, p) {
  const earlier = lessonPeriodsOn(key, dateStr).filter(q => q < Number(p)).length;
  return doneBefore(key, dateStr) + earlier + 1;
}

// "dateStr p교시 수업 = step차시"가 되게 하는 기준점
function anchorForLesson(key, dateStr, p, step) {
  const earlier = lessonPeriodsOn(key, dateStr).filter(q => q < Number(p)).length;
  return { current: step - 1 - earlier, lastUpdated: addDaysStr(dateStr, -1) };
}

// 아직 안 끝난 가장 가까운 key 수업 (지금 진행 중인 수업 포함). 없으면 null
function nextLesson(key) {
  const today   = todayStr();
  const now     = new Date();
  const nowMin  = now.getHours() * 60 + now.getMinutes();
  const periods = getPeriods();
  for (let i = 0, d = today; i < 120; i++, d = addDaysStr(d, 1)) {
    const ps = lessonPeriodsOn(key, d).filter(p => d !== today || parseTimeToMin(periods[p]?.end) > nowMin);
    if (ps.length) return { date: d, p: ps[0] };
  }
  return null;
}

// 지금 기준 "다음 수업" 차시 (진도표·수업 주제 탭 표시용)
function nextStep(key) {
  const n = nextLesson(key);
  return n ? lessonStep(key, n.date, n.p) : doneBefore(key, todayStr()) + 1;
}

function lessonLabel(n) {
  if (!n) return '';
  const d = parseDateStr_(n.date);
  return `${n.date === todayStr() ? '오늘' : `${d.getMonth() + 1}/${d.getDate()}(${DOW_KO[d.getDay()]})`} ${n.p}교시`;
}

// 진도 이력(progressLog)은 본 저장과 분리해서 쓴다 — 이력 쓰기가 막히거나 실패해도
// 진도·주제 저장이 같이 실패하면 안 되므로, 본 저장이 끝난 뒤 따로 시도하고 실패는 무시한다.
async function updateWithLog_(updates) {
  const main = {}, log = {};
  for (const [k, v] of Object.entries(updates)) (k.includes('/progressLog/') ? log : main)[k] = v;
  if (Object.keys(main).length) await update(ref(db), main);
  if (Object.keys(log).length) {
    try { await update(ref(db), log); }
    catch (e) { console.warn('진도 이력 저장 실패 (DB 규칙 확인)', e); }
  }
}

// ============================================================
// 진도 변경 이력 (진단용) — 설정 > 데이터 진단 하단 표에서 확인
// 누가·언제·어느 기기에서 진도 기준점(current·lastUpdated)을 바꿨는지 남긴다.
// 진도 계산 자체에는 영향 없음.
// 저장 위치: users/{uid}/progressLog/{학기}/{이력id}, 기기 접속 기록은 .../_dev/{기기id}
// ============================================================
const APP_BUILD = '2026-10-15-derived1';   // 낡은 app.js가 캐시된 기기를 가려내는 용도 — 배포할 때 바꾼다
const PROGRESS_LOG_MAX = 60;
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

function semLog_() {
  if (!userData.progressLog) userData.progressLog = {};
  if (!userData.progressLog[CURRENT_SEMESTER]) userData.progressLog[CURRENT_SEMESTER] = {};
  return userData.progressLog[CURRENT_SEMESTER];
}

// updates(멀티패스 update 객체)에 이력 한 줄을 얹고 메모리에도 넣는다. 실패해도 본 작업은 막지 않는다.
function addProgressLog_(updates, src, key, f = {}, id) {
  try {
    const dev = deviceInfo();
    const entry = {
      t: nowStamp(), dev: `${dev.label}·${dev.id}`, build: APP_BUILD, src, key,
      from: f.from ?? '', to: f.to ?? '', luFrom: f.luFrom || '', luTo: f.luTo || '', n: f.n || ''
    };
    const eid = id || `${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    updates[`users/${currentUser.uid}/progressLog/${CURRENT_SEMESTER}/${eid}`] = entry;
    semLog_()[eid] = entry;
  } catch (e) { console.error('진도 이력 기록 실패', e); }
}

// 이력이 너무 쌓이지 않게 오래된 것부터 지운다 + 이 기기의 마지막 접속(빌드 포함)을 남긴다
function maintainProgressLog_(out) {
  try {
    const logs = semLog_();
    const ids = Object.keys(logs).filter(k => k !== '_dev');
    if (ids.length > PROGRESS_LOG_MAX) {
      ids.sort((a, b) => (logs[a].t || '').localeCompare(logs[b].t || ''))
         .slice(0, ids.length - PROGRESS_LOG_MAX)
         .forEach(id => {
           out[`users/${currentUser.uid}/progressLog/${CURRENT_SEMESTER}/${id}`] = null;
           delete logs[id];
         });
    }
    if (Date.now() - lastDeviceBeatAt > 5 * 60 * 1000) {
      lastDeviceBeatAt = Date.now();
      const dev = deviceInfo();
      const beat = { label: dev.label, t: nowStamp(), build: APP_BUILD };
      out[`users/${currentUser.uid}/progressLog/${CURRENT_SEMESTER}/_dev/${dev.id}`] = beat;
      if (!logs._dev) logs._dev = {};
      logs._dev[dev.id] = beat;
    }
  } catch (e) { console.error('진도 이력 정리 실패', e); }
}

// ============================================================
// 데이터 로드
// ============================================================
async function loadUserData() {
  if (!currentUser) return;

  const [userSnap, schoolSnap] = await Promise.all([
    get(ref(db, `users/${currentUser.uid}`)),
    get(ref(db, 'school'))
  ]);

  userData   = userSnap.val()   || { timetable: { periods: {}, schedule: {} }, progress: {}, curriculum: {}, lessonNotes: {}, classNotes: {} };
  schoolData = schoolSnap.val() || { calendar: {} };

  if (!userData.timetable)   userData.timetable   = { periods: {}, schedule: {} };
  if (!userData.progress)    userData.progress    = {};
  if (!userData.progress[CURRENT_SEMESTER]) userData.progress[CURRENT_SEMESTER] = {};
  if (!userData.curriculum)  userData.curriculum  = {};
  if (!userData.lessonNotes) userData.lessonNotes = {};
  if (!userData.classNotes)  userData.classNotes  = {};

  // 진도는 화면을 그릴 때 계산하므로 여기서 저장할 것이 없다 (기기 접속 기록·이력 정리만)
  const logUpdates = {};
  maintainProgressLog_(logUpdates);
  lastKnownDateStr = todayStr();
  lastRefreshAt    = Date.now();
  renderCurrentTab();
  if (Object.keys(logUpdates).length) updateWithLog_(logUpdates).catch(e => console.warn('이력 저장 실패', e));
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
  if (!currentUser || !userData || refreshing || isEditingNow()) return;
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

async function fetchCodeSig_(fresh) {
  const res = await fetch('app.js', fresh ? { cache: 'no-store' } : undefined);
  if (!res.ok) throw new Error('app.js ' + res.status);
  return textSig_(await res.text());
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
// 탭 전환
// ============================================================
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  ['today','weekly','progress','subject','settings'].forEach(t => {
    const el = document.getElementById(`tab-${t}`);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  renderCurrentTab();
}

function renderCurrentTab() {
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
    const path = `users/${currentUser.uid}/classNotes/${key}`;
    if (!userData.classNotes) userData.classNotes = {};

    if (newText) {
      const updatedAt = Date.now();
      await update(ref(db), { [path]: { text: newText, updatedAt } });
      userData.classNotes[key] = { text: newText, updatedAt };
    } else {
      await update(ref(db), { [path]: null });
      delete userData.classNotes[key];
    }

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
  const schedule = userData.timetable?.schedule?.[dayKey] || {};
  const periods  = getPeriods();
  const today    = todayStr();

  el.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `
    <div class="date-label">TODAY</div>
    <div class="header-row">
      <span class="date-main">${now.getMonth()+1}월 ${now.getDate()}일</span>
      <span class="date-sub">(${DOW_KO[dowIdx]})</span>
    </div>
    <div class="update-time">${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} 기준</div>
  `;
  el.appendChild(header);

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
      const key     = `${cls}_${subject}`;
      const current = lessonStep(key, today, curP);
      const topic   = userData.curriculum[key]?.[current] || '';
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
      const key     = `${cls}_${subject}`;
      const current = lessonStep(key, today, nextP);
      const topic   = userData.curriculum[key]?.[current] || '';
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
    } else if (cell?.class) {
      const { class: cls, subject } = cell;
      const key           = `${cls}_${subject}`;
      const current       = lessonStep(key, today, p);          // 이 수업의 차시
      const completedStep = current - 1;                        // 메모는 직전 차시(어디까지 나갔는지)
      const topic         = userData.curriculum[key]?.[current] || '';
      const note          = userData.lessonNotes?.[key]?.[completedStep] || '';

      card.className = `period-card has-class${isCur ? ' current' : ''}`;
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
          </div>
        </div>
        <button class="edit-btn" onclick="window.toggleEditor(${p})">✏️</button>
      `;
    } else {
      card.className = 'period-card empty';
      card.innerHTML = `
        <div class="period-num">${p}<span class="period-time">${formatPeriodTime(p).replace('~','\n')}</span></div>
        <div class="period-divider"></div>
        <div class="period-body">
          <span class="empty-label">공강</span>
        </div>
      `;
    }
    list.appendChild(card);
  }
  el.appendChild(list);
}

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
// lesson = {date, p}: "그 수업 = step차시"로 기준점을 옮긴다. 수업 전에 고치든 후에 고치든 뜻이 같다.
// 차시 숫자를 안 바꿨으면 기준점은 건드리지 않고 주제·메모만 저장한다.
async function saveLessonEdit_(key, lesson, step, newTopic, newNote, src) {
  const prevStep = lessonStep(key, lesson.date, lesson.p);
  const stepChanged = step !== prevStep;
  const updates = {};
  let anchor = null;
  if (stepChanged) {
    const before = semProgress()[key] || {};
    anchor = anchorForLesson(key, lesson.date, lesson.p, step);
    updates[`users/${currentUser.uid}/progress/${CURRENT_SEMESTER}/${key}`] = anchor;
    addProgressLog_(updates, src, key, {
      from: before.current ?? '', to: anchor.current, luFrom: before.lastUpdated || '', luTo: anchor.lastUpdated,
      n: `${lessonLabel(lesson)} 수업을 ${prevStep}차시 → ${step}차시로 고침`
    });
  }
  if (newTopic) updates[`users/${currentUser.uid}/curriculum/${key}/${step}`] = newTopic;
  updates[`users/${currentUser.uid}/lessonNotes/${key}/${step - 1}`] = newNote || null;

  await updateWithLog_(updates);

  if (anchor) userData.progress[CURRENT_SEMESTER][key] = anchor;
  if (!userData.curriculum[key]) userData.curriculum[key] = {};
  if (newTopic) userData.curriculum[key][step] = newTopic;
  if (!userData.lessonNotes[key]) userData.lessonNotes[key] = {};
  if (newNote) userData.lessonNotes[key][step - 1] = newNote;
  else delete userData.lessonNotes[key][step - 1];
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
    await saveLessonEdit_(key, { date: todayStr(), p }, step, input.value.trim(), noteInp.value.trim(), '수동(오늘탭)');
    showToast(`${key} 저장 완료`);
    renderCurrentTab(); // 같은 반의 다른 교시·배너도 새 기준으로 다시 계산
    if (pipWindow) renderPipWidget();
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
    btn.disabled    = false;
    btn.textContent = '저장';
  }
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
      html += `<th class="${isToday ? 'today-col' : ''}">${DOW_KO[i+1]}<br><span class="th-date">${d.getMonth()+1}/${d.getDate()}</span></th>`;
    });
    html += '</tr></thead><tbody>';

    for (const p of periodList) {
      html += `<tr><td class="period-col">${p}</td>`;
      dates.forEach((d, i) => {
        const dayKey  = DOW_KEY[d.getDay()];
        const cell    = userData.timetable?.schedule?.[dayKey]?.[p];
        const isToday = dateToStr(d) === today;
        const dateStr = dateToStr(d);
        const ev      = getCalendarEvent(dateStr, String(p));

        if (ev) {
          html += `<td class="event-cell${isToday ? ' today-col' : ''}">
            <span class="cell-badge badge-${ev.type}">${ev.label}</span>
          </td>`;
        } else if (cell?.class) {
          const key   = `${cell.class}_${cell.subject}`;
          const step  = lessonStep(key, dateStr, p);

          const topic = userData.curriculum[key]?.[step] || '';
          html += `<td class="has-class${isToday ? ' today-col' : ''}">
            <span class="cell-class">${cell.class}</span>
            <span class="cell-subject">${cell.subject}</span>
            ${topic ? `<span class="cell-topic">${topic}</span>` : ''}
            <span class="cell-step">${step}차시</span>
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

  const schedule  = userData.timetable?.schedule || {};
  const classSet  = new Map();

  for (const daySchedule of Object.values(schedule)) {
    for (const cell of Object.values(daySchedule)) {
      if (cell?.class && cell?.subject) {
        const key = `${cell.class}_${cell.subject}`;
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
      const current       = lessonStep(item.key, lesson.date, lesson.p);
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
    await saveLessonEdit_(key, lesson, step, input.value.trim(), noteInp.value.trim(), '수동(진도탭)');
    showToast(`${key} 저장 완료`);
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
    const dbUpdates = {};
    classes.forEach(cls => {
      const key = `${cls}_${subject}`;
      dbUpdates[`users/${currentUser.uid}/curriculum/${key}/${step}`] = null;
      if (userData.curriculum[key]) delete userData.curriculum[key][step];
    });
    await update(ref(db), dbUpdates);
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
    const dbUpdates = {};
    classes.forEach(cls => {
      const key = `${cls}_${subject}`;
      dbUpdates[`users/${currentUser.uid}/curriculum/${key}`] = newCurriculum;
      userData.curriculum[key] = { ...newCurriculum };
    });
    await update(ref(db), dbUpdates);
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
          <span>데이터 진단 (반 이름 확인)</span><span class="arrow-r">→</span>
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
// 시간표 편집기
// ============================================================
window.openTimetableEditor = function() {
  const periods    = getPeriods();
  const periodList = Object.keys(periods).map(Number).sort((a,b) => a-b);
  const schedule   = userData.timetable?.schedule || {};
  const days       = ['mon','tue','wed','thu','fri'];
  const dayLabels  = ['월','화','수','목','금'];

  let html = `
    <div class="modal-overlay" id="modal-timetable">
      <div class="modal">
        <div class="modal-header">
          <h2>시간표 편집</h2>
          <button class="modal-close" onclick="window.closeModal('modal-timetable')">✕</button>
        </div>
        <div class="modal-body">
          <p class="modal-hint">반과 과목을 각 칸에 입력하세요. 예: <code>308 / 역사</code></p>
          <div class="timetable-editor">
            <table>
              <thead><tr><th>교시</th>`;
  dayLabels.forEach(d => { html += `<th>${d}</th>`; });
  html += `</tr></thead><tbody>`;

  for (const p of periodList) {
    html += `<tr><td class="period-col-edit">${p}교시</td>`;
    days.forEach(day => {
      const cell = schedule[day]?.[p];
      const val  = cell ? `${cell.class} / ${cell.subject}` : '';
      html += `<td><input class="cell-input" data-period="${p}" data-day="${day}" value="${val}" placeholder="반 / 과목" /></td>`;
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
  const inputs   = document.querySelectorAll('.cell-input');
  const schedule = {};
  const progress = semProgress();
  const yesterday = addDaysStr(todayStr(), -1);

  // 차시는 시간표로 계산하므로, 시간표를 바꾸면 지난 수업까지 다시 계산돼 차시가 틀어진다.
  // → 바꾸기 전에 지금(옛 시간표) 기준으로 "어제까지 마친 차시"를 기준점으로 고정해 두고,
  //   새 시간표는 오늘부터만 적용되게 한다.
  const anchors = {};
  for (const key of Object.keys(progress)) {
    anchors[key] = { current: doneBefore(key, todayStr()), lastUpdated: yesterday };
  }

  inputs.forEach(input => {
    const p   = Number(input.dataset.period);
    const day = input.dataset.day;
    const val = input.value.trim();

    if (!schedule[day]) schedule[day] = {};

    if (val) {
      const parts   = val.split('/').map(s => s.trim());
      const cls     = parts[0] || '';
      const subject = parts[1] || '';
      if (cls && subject) {
        schedule[day][p] = { class: cls, subject };
        const key = `${cls}_${subject}`;
        // 새 반은 "어제까지 0차시" → 오늘 이후 첫 수업이 1차시
        if (!anchors[key]) anchors[key] = { current: 0, lastUpdated: yesterday };
      }
    }
  });

  try {
    const dbUpdates = {};
    dbUpdates[`users/${currentUser.uid}/timetable/schedule`] = schedule;
    for (const [key, a] of Object.entries(anchors)) {
      dbUpdates[`users/${currentUser.uid}/progress/${CURRENT_SEMESTER}/${key}`] = a;
    }
    addProgressLog_(dbUpdates, '시간표저장', '(전체)', {
      n: '옛 시간표 기준 어제까지 마친 차시로 기준점 고정: ' + Object.entries(anchors)
        .map(([k, v]) => `${k}=${v.current}`).join(', ')
    });
    await updateWithLog_(dbUpdates);
    userData.timetable.schedule = schedule;
    Object.assign(userData.progress[CURRENT_SEMESTER], anchors);

    closeModal('modal-timetable');
    showToast('시간표 저장 완료');
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
    await set(ref(db, `users/${currentUser.uid}/timetable/periods`), periods);
    userData.timetable.periods = periods;
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
// 데이터 진단 — 시간표 셀 문자열과 progress 키를 있는 그대로 대조
// (반 이름 표기가 칸마다 미묘하게 달라서 진도가 갈라지는 문제 확인용)
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
  const schedule  = userData.timetable?.schedule || {};
  const progress  = semProgress();
  const dayLabels = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금' };

  // 시간표에서 실제 쓰이고 있는 (반, 과목) 셀 전부 수집
  const cells = [];
  for (const [day, daySchedule] of Object.entries(schedule)) {
    for (const [period, cell] of Object.entries(daySchedule)) {
      if (cell?.class && cell?.subject) {
        cells.push({ day, period: Number(period), class: cell.class, subject: cell.subject, key: `${cell.class}_${cell.subject}` });
      }
    }
  }
  cells.sort((a, b) => a.class.localeCompare(b.class, undefined, { numeric: true }) || a.period - b.period);

  const scheduleKeys = new Set(cells.map(c => c.key));
  const progressKeys = new Set(Object.keys(progress));

  const missingProgress = [...scheduleKeys].filter(k => !progressKeys.has(k)); // 시간표엔 있는데 progress엔 없음
  const orphanProgress  = [...progressKeys].filter(k => !scheduleKeys.has(k)); // progress엔 있는데 지금 시간표엔 없음 (옛 표기 흔적일 수 있음)

  let html = `
    <div class="modal-overlay" id="modal-datadiag">
      <div class="modal modal-lg">
        <div class="modal-header">
          <h2>데이터 진단</h2>
          <button class="modal-close" onclick="window.closeModal('modal-datadiag')">✕</button>
        </div>
        <div class="modal-body">
          <p class="modal-hint">공백은 <code>␣</code>(반각) / <code>⭞</code>(전각) 기호로 표시돼. 같은 반인데 칸마다 문자열이 다르면 진도가 따로 카운트돼.</p>`;

  if (missingProgress.length || orphanProgress.length) {
    html += `<p class="modal-hint" style="color:#d33">⚠ 아래처럼 불일치가 있어:</p><ul style="margin:0 0 12px;padding-left:18px;font-size:13px;line-height:1.6">`;
    missingProgress.forEach(k => {
      html += `<li>시간표엔 <code>${visibleStr(k)}</code> 셀이 있는데 progress 기록이 없음 (진도 0으로 안 잡혀 있을 수 있음)</li>`;
    });
    orphanProgress.forEach(k => {
      html += `<li>progress에 <code>${visibleStr(k)}</code> 기록이 남아있는데 지금 시간표엔 이 조합이 없음 (예전 표기 흔적일 가능성)</li>`;
    });
    html += `</ul>`;
  } else {
    html += `<p class="modal-hint">시간표 셀과 progress 키가 1:1로 일치해. 표기 문제는 아닌 걸로 보여.</p>`;
  }

  html += `
          <table class="cal-table">
            <thead><tr><th>요일</th><th>교시</th><th>반(문자열)</th><th>과목(문자열)</th><th>progress key</th><th>기준점 current</th><th>기준점 lastUpdated</th><th>다음 수업 차시</th></tr></thead>
            <tbody>`;
  cells.forEach(c => {
    const prog = progress[c.key];
    html += `<tr>
      <td>${dayLabels[c.day] || c.day}</td>
      <td>${c.period}</td>
      <td><code>${visibleStr(c.class)}</code></td>
      <td><code>${visibleStr(c.subject)}</code></td>
      <td><code>${visibleStr(c.key)}</code></td>
      <td>${prog ? prog.current : '<span style="color:#d33">없음</span>'}</td>
      <td>${prog ? (prog.lastUpdated || '') : ''}</td>
      <td>${nextStep(c.key)}</td>
    </tr>`;
  });
  html += `</tbody></table>`;

  // 진도 변경 이력 — "차시가 안 넘어갔을 때" 원인 추적용
  const semLog   = semLog_();
  const devs     = semLog._dev || {};
  const entries  = Object.entries(semLog).filter(([k]) => k !== '_dev').map(([, v]) => v)
    .sort((a, b) => (b.t || '').localeCompare(a.t || '')).slice(0, 40);
  const me       = deviceInfo();
  const devRows  = Object.entries(devs).sort((a, b) => (b[1].t || '').localeCompare(a[1].t || ''))
    .map(([id, d]) => `<tr><td>${escapeHtml(d.label || '')}·${escapeHtml(id)}${id === me.id ? ' (이 기기)' : ''}</td><td>${escapeHtml(d.t || '')}</td><td>${escapeHtml(d.build || '')}</td></tr>`).join('');
  const rowsHtml = entries.map(e => {
    const cnt = (e.from !== '' || e.to !== '') ? `${e.from === '' ? '-' : e.from} → ${e.to === '' ? '-' : e.to}` : '';
    const lu  = (e.luFrom || e.luTo) ? `${escapeHtml(e.luFrom || '-')} → ${escapeHtml(e.luTo || '-')}` : '';
    return `<tr><td>${escapeHtml(e.t || '')}</td><td>${escapeHtml(e.dev || '')}</td><td>${escapeHtml(e.src || '')}</td>
      <td><code>${visibleStr(e.key || '')}</code></td><td>${cnt}</td><td>${lu}</td><td>${escapeHtml(e.n || '')}</td></tr>`;
  }).join('');
  html += `
          <h3 style="margin:18px 0 6px;font-size:14px">진도 변경 이력 <small style="font-weight:400">(최근 40건, 최신순 · 이 화면 빌드 ${escapeHtml(APP_BUILD)} · ${escapeHtml(me.label)}·${escapeHtml(me.id)})</small></h3>
          <p class="modal-hint">차시는 기준점(current·lastUpdated) + 그 뒤 시간표 수업 수로 매번 계산해. 기준점이 바뀌는 건 <b>수동</b>(직접 고침)과 <b>시간표저장</b>뿐이야. <b>자동</b>·<b>어제미집계</b>는 예전 방식(2026-10-15 이전) 기록이야.</p>
          <table class="cal-table">
            <thead><tr><th>시각</th><th>기기</th><th>구분</th><th>반_과목</th><th>current</th><th>lastUpdated</th><th>메모</th></tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="7">아직 이력이 없어</td></tr>'}</tbody>
          </table>
          <h3 style="margin:18px 0 6px;font-size:14px">기기별 마지막 접속</h3>
          <p class="modal-hint">빌드가 기기마다 다르면 한쪽이 옛 app.js를 쓰고 있는 거야(캐시). 한 기기의 접속 시각이 오래됐으면 그 기기는 낡은 데이터를 들고 있을 수 있어.</p>
          <table class="cal-table">
            <thead><tr><th>기기</th><th>마지막 접속</th><th>빌드</th></tr></thead>
            <tbody>${devRows || '<tr><td colspan="3">아직 기록 없음</td></tr>'}</tbody>
          </table>
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
// - 3학년 역사 수업 교시(월3·화5·수1,2,4,6·금1,2)와 겹치는 일정만, 그 교시만 등록
//   (2학년 수업이 있는 교시는 수업을 해야 하므로 넣지 않음. 성탄절·신정·재량휴업일은 전일 휴업이라 하루종일)
// - 11/30~12/10 "졸업영상 제작 및 교과수업"은 교과수업이 가능한 기간이라 제외
// - 원서접수·성적산출 기준일 같은 입시 일정은 수업 진행과 무관해 제외
// ============================================================
const _P = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const _ev = (date, type, label, periods) =>
  periods ? { date, type, label, periods, isAll: false } : { date, type, label, periods: [], isAll: true };
const TRANSITION_CALENDAR = [
  // 11월
  _ev('2026-11-02', 'event',   '특성화고 설명회(교내)', [3]),
  _ev('2026-11-03', 'event',   'AI 교육(교내)', [5]),
  _ev('2026-11-04', 'event',   '목동 스케이트장(교외체험)', [1, 2, 4, 6]),
  _ev('2026-11-06', 'event',   '진로 체험의 날', [1, 2]),
  _ev('2026-11-09', 'event',   '오목대회(교내)', [3]),
  _ev('2026-11-11', 'club',    '동아리', [6]),
  _ev('2026-11-18', 'event',   '장애이해교육',                 [1]),
  _ev('2026-11-18', 'event',   '학생도박예방교육',             [2]),
  _ev('2026-11-18', 'event',   '금연교육',                     [4]),
  _ev('2026-11-20', 'holiday', '재량휴업일'),
  // 12월
  _ev('2026-12-02', 'event',   '금융교육', [6]),
  _ev('2026-12-11', 'event',   '서울퓨처랩(1-4반)/서울식물원(5-8반)', [1, 2]),
  _ev('2026-12-14', 'event',   '구기대회(교내)', [3]),
  _ev('2026-12-16', 'event',   '구기대회(교내)', [1, 2, 4]),
  _ev('2026-12-21', 'event',   '영화 관람(크리스마스 캐롤, 어벤저스)', [3]),
  _ev('2026-12-23', 'event',   '크리스마스 쿠키 만들기(교내)', [1, 2, 4]),
  _ev('2026-12-25', 'holiday', '성탄절'),
  // 1월
  _ev('2027-01-01', 'holiday', '신정'),
  _ev('2027-01-04', 'event',   '약물오남용예방교육', [3]),
  _ev('2027-01-06', 'event',   '졸업식 꽃풍선 만들기(교내)', [1, 2, 4]),
  _ev('2027-01-08', 'event',   '졸업식', [1, 2]),
];

function calRowHtml(idx, g) {
  const isAll = g.isAll;
  const periods = g.periods || [];
  return `
  <tr id="cal-row-${idx}">
    <td><input class="cal-input" data-idx="${idx}" data-field="date" value="${g.date}" placeholder="YYYY-MM-DD" /></td>
    <td class="cal-allday-cell">
      <div class="cal-period-group" data-idx="${idx}">
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
    <td>
      <select class="cal-select" data-idx="${idx}" data-field="type">
        <option value="holiday" ${g.type==='holiday'?'selected':''}>휴업</option>
        <option value="event"   ${g.type==='event'  ?'selected':''}>행사</option>
        <option value="exam"    ${g.type==='exam'   ?'selected':''}>시험</option>
        <option value="club"    ${g.type==='club'   ?'selected':''}>동아리</option>
        <option value="noclass" ${g.type==='noclass'?'selected':''}>수업없음</option>
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
  const groupMap = new Map(); // key: date||type||label -> { date, type, label, periods:[], isAll }
  for (const [date, periods] of Object.entries(calendar)) {
    for (const [period, ev] of Object.entries(periods)) {
      const key = `${date}||${ev.type}||${ev.label}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, { date, type: ev.type, label: ev.label, periods: [], isAll: false });
      }
      const g = groupMap.get(key);
      if (period === 'all') g.isAll = true;
      else g.periods.push(Number(period));
    }
  }

  const groups = [...groupMap.values()].sort((a,b) => b.date.localeCompare(a.date));

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
            <thead><tr><th>날짜</th><th>교시</th><th>종류</th><th>표시</th><th></th></tr></thead>
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

    if (isAll) {
      calendar[date]['all'] = { type, label };
    } else {
      const checkedPeriods = [...row.querySelectorAll('.cal-period-check:checked')].map(c => c.value);
      checkedPeriods.forEach(p => {
        calendar[date][p] = { type, label };
      });
    }
  });

  try {
    await set(ref(db, 'school/calendar'), calendar);
    schoolData.calendar = calendar;
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

onAuthStateChanged(auth, async (user) => {
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
    await loadUserData();

    if (!dateRolloverTimer) {
      dateRolloverTimer = setInterval(checkDateRollover, 5 * 60 * 1000);
    }
  } else {
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
// 미니창(Document Picture-in-Picture) — 항상 위 + 밝기 조절
// 다른 작업을 하면서 오늘 시간표를 겹쳐 볼 수 있도록 별도 창으로 띄운다.
// 크로미움 기반 브라우저(웨일 포함)만 지원, 미지원 브라우저는 버튼 자체를 숨김.
// PiP 창은 OS 입장에서 불투명한 별도 창이라 웹 코드로 창 투명도를 바꿀 수 없다.
// 그래서 슬라이더는 투명도가 아니라 배경 밝기(회색 ↔ 흰색)를 조절한다.
// ============================================================
const PIP_CSS = `
  html, body { margin:0; padding:0; height:100%; background:transparent; }
  * { box-sizing:border-box; font-family:'Noto Sans KR', 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', -apple-system, sans-serif; }
  #pip-widget {
    display:flex; flex-direction:column; height:100%;
    background: var(--pip-bg, #f4f4f4);
    color:#1a1a1a; border-radius:14px; overflow:hidden;
    border:1px solid rgba(255,255,255,.7);
    box-shadow: 0 10px 28px rgba(0,0,0,.18);
  }
  #pip-head {
    display:flex; align-items:center; justify-content:space-between;
    gap:6px; padding:8px 10px; flex:0 0 auto;
    border-bottom:1px solid rgba(0,0,0,.08);
  }
  #pip-date {
    font-family:'Space Mono', 'Courier New', monospace;
    font-size:10px; font-weight:700; letter-spacing:.5px;
    color:#2d6a4f; text-transform:uppercase;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  #pip-opacity { width:50px; accent-color:#2d6a4f; flex-shrink:0; }
  #pip-body { flex:1 1 auto; overflow-y:auto; padding:2px 8px 8px; font-size:12px; }
  .pip-row { display:flex; gap:7px; padding:7px 4px; border-bottom:1px solid rgba(0,0,0,.06); align-items:flex-start; border-left:3px solid transparent; }
  .pip-row:last-child { border-bottom:none; }
  .pip-row.current { background:rgba(45,106,79,.1); border-left-color:#2d6a4f; border-radius:0 8px 8px 0; }
  .pip-p { flex:0 0 14px; font-family:'Space Mono', monospace; font-weight:700; font-size:10px; color:#aaa; padding-top:1px; }
  .pip-info { flex:1 1 auto; min-width:0; display:flex; flex-wrap:wrap; gap:3px 6px; align-items:baseline; }
  .pip-class {
    font-family:'Space Mono', monospace; font-weight:700; font-size:11px;
    color:#2d6a4f; background:#e8f5ee; padding:1px 6px; border-radius:5px;
  }
  .pip-topic { flex-basis:100%; font-size:12px; font-weight:500; color:#1a1a1a; }
  .pip-note  { flex-basis:100%; font-size:10.5px; color:#b5690b; }
  .pip-empty-cell, .pip-empty { color:#aaa; font-size:11px; }
  .pip-badge { padding:1px 7px; border-radius:5px; background:#fdf0e3; color:#e07c24; font-size:10px; font-weight:600; }
`;

// 슬라이더 값(0.1~0.95) → 배경 회색~흰색
function pipBgFromLevel(v) {
  const t = Math.min(1, Math.max(0, (parseFloat(v) - 0.1) / 0.85));
  const c = Math.round(205 + 50 * t);
  return `rgb(${c},${c},${c})`;
}

function pipRowsHtml() {
  if (!userData) return `<div class="pip-empty">데이터를 불러오는 중…</div>`;

  const now      = new Date();
  const dowIdx   = now.getDay();
  if (dowIdx === 0 || dowIdx === 6) return `<div class="pip-empty">오늘은 주말이에요 🎉</div>`;

  const dayKey   = DOW_KEY[dowIdx];
  const schedule = userData.timetable?.schedule?.[dayKey] || {};
  const periods  = getPeriods();
  const today    = todayStr();
  const periodList = Object.keys(periods).map(Number).sort((a, b) => a - b);
  const curP     = getCurrentPeriod();

  if (!periodList.some(p => schedule[p]?.class)) return `<div class="pip-empty">오늘은 수업이 없어요</div>`;

  return periodList.map(p => {
    const cell  = schedule[p];
    const ev    = getCalendarEvent(today, String(p));
    const isCur = p === curP;
    let body;

    if (ev) {
      body = `<span class="pip-badge">${escapeHtml(ev.label)}</span>`;
    } else if (cell?.class) {
      const key     = `${cell.class}_${cell.subject}`;
      const current = lessonStep(key, today, p);
      const topic   = userData.curriculum?.[key]?.[current] || '';
      const note    = userData.classNotes?.[key]?.text || '';
      body = `
        <span class="pip-class">${escapeHtml(cell.class)}</span>
        <span>${escapeHtml(cell.subject)}</span>
        ${topic ? `<span class="pip-topic">${escapeHtml(topic)}</span>` : ''}
        ${note  ? `<span class="pip-note">🗒 ${escapeHtml(note)}</span>` : ''}
      `;
    } else {
      body = `<span class="pip-empty-cell">공강</span>`;
    }

    return `
      <div class="pip-row${isCur ? ' current' : ''}">
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
    dateEl.textContent = `${now.getMonth()+1}월 ${now.getDate()}일(${DOW_KO[now.getDay()]}) ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  }
  const bodyEl = doc.getElementById('pip-body');
  if (bodyEl) bodyEl.innerHTML = pipRowsHtml();
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
    pipWindow = await window.documentPictureInPicture.requestWindow({ width: 210, height: 260 });
  } catch (e) {
    showToast('미니창을 열 수 없어요', true);
    return;
  }

  const style = pipWindow.document.createElement('style');
  style.textContent = PIP_CSS;
  pipWindow.document.head.appendChild(style);

  const savedAlpha = localStorage.getItem('pipAlpha') || '0.62';

  pipWindow.document.body.innerHTML = `
    <div id="pip-widget" style="--pip-bg:${pipBgFromLevel(savedAlpha)}">
      <div id="pip-head">
        <span id="pip-date"></span>
        <input id="pip-opacity" type="range" min="0.1" max="0.95" step="0.05" value="${savedAlpha}" title="밝기" />
      </div>
      <div id="pip-body"></div>
    </div>
  `;

  pipWindow.document.getElementById('pip-opacity').addEventListener('input', (e) => {
    pipWindow.document.getElementById('pip-widget').style.setProperty('--pip-bg', pipBgFromLevel(e.target.value));
    localStorage.setItem('pipAlpha', e.target.value);
  });

  renderPipWidget();
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
