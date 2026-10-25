// 할 일 엔진 — 화면·DB와 상관없는 순수 함수만 모았다 (테스트: tests/task-engine.test.mjs)
//
// 저장 위치는 users/{uid}/planner/ — 진도 데이터(v2)와 따로 둔다.
//   tasks/{id}   할 일 한 건
//   rules/{id}   반복 규칙 (날짜가 되면 tasks 로 펼친다)
//   settings     { todayCap, dayStart, dayEnd, reviewedOn }
//   log/{id}     변경 이력
//
// plan*() 은 "planner 뿌리 기준 경로 → 값" patch 를 돌려준다 (null = 삭제).
// patch 는 progress-engine 의 applyPatch 로 메모리에도 같은 방식으로 반영할 수 있고,
// 실제로 DB에 쓰기 전에 assertPlannerPatch() 로 planner 밖을 건드리지 않는지 검사한다.
import { isDateStr, addDays, weekdayKey, timeToMin, scheduleOn, calendarEvent, cellKey, DOW_KEY, allKeys, buildLedger, gradeOf } from './progress-engine.js';

export const AREAS = ['수업', '학생회', '학교', '대학원', '독서', '연수', '투자', '기타'];
export const KINDS = ['once', 'watch'];
export const DEFAULT_SETTINGS = { todayCap: 5, dayStart: '07:00', dayEnd: '22:00' };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TITLE = 200;
const MAX_NOTE = 6000;
const MAX_LINK = 500;
const MAX_DUETEXT = 20;

export function isTimeStr(s) { return typeof s === 'string' && TIME_RE.test(s); }

export function minToTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// 설정
// ------------------------------------------------------------
export function resolveSettings(raw = {}) {
  const cap = Number(raw?.todayCap);
  const s = {
    todayCap: Number.isInteger(cap) && cap >= 1 && cap <= 20 ? cap : DEFAULT_SETTINGS.todayCap,
    dayStart: isTimeStr(raw?.dayStart) ? raw.dayStart : DEFAULT_SETTINGS.dayStart,
    dayEnd: isTimeStr(raw?.dayEnd) ? raw.dayEnd : DEFAULT_SETTINGS.dayEnd,
    reviewedOn: isDateStr(raw?.reviewedOn) ? raw.reviewedOn : null,
  };
  // 시작이 끝보다 늦으면 기본값으로
  if (timeToMin(s.dayStart) >= timeToMin(s.dayEnd)) { s.dayStart = DEFAULT_SETTINGS.dayStart; s.dayEnd = DEFAULT_SETTINGS.dayEnd; }
  return s;
}

// ------------------------------------------------------------
// 할 일 한 건 — 검사와 정리. 잘못된 값은 조용히 고치지 않고 오류를 던진다 (area만 모르는 값이면 '기타')
// ------------------------------------------------------------
export function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

// 새 id — 시각 + 무작위. 같은 기기에서 연달아 만들어도 겹치지 않게 무작위 꼬리를 붙인다
export function newTaskId(nowMs = Date.now(), rand = Math.random) {
  return `t${nowMs.toString(36)}${Math.floor(rand() * 36 ** 3).toString(36).padStart(3, '0')}`;
}

function cleanSlot_(slot) {
  if (slot == null) return null;
  if (!isDateStr(slot.date)) throw new Error('칸에 놓을 날짜가 올바르지 않습니다');
  if (!isTimeStr(slot.start)) throw new Error('칸 시작 시각이 올바르지 않습니다 (예: 10:50)');
  const min = Number(slot.min);
  if (!Number.isInteger(min) || min < 5 || min > 600) throw new Error('걸리는 시간은 5분~10시간 사이의 정수(분)여야 합니다');
  if (timeToMin(slot.start) + min > 24 * 60) throw new Error('칸이 자정을 넘습니다');
  return { date: slot.date, start: slot.start, min };
}

export function normalizeTask(raw, { now = '' } = {}) {
  const title = String(raw?.title ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('할 일 제목이 필요합니다');
  if (title.length > MAX_TITLE) throw new Error(`제목은 ${MAX_TITLE}자까지입니다`);
  const kind = raw.kind ?? 'once';
  if (!KINDS.includes(kind)) throw new Error(`종류는 ${KINDS.join('/')} 중 하나여야 합니다`);
  for (const k of ['due', 'today']) if (raw[k] != null && !isDateStr(raw[k])) throw new Error(`${k === 'due' ? '마감일' : '오늘 날짜'}이 올바르지 않습니다`);
  const t = {
    title,
    area: AREAS.includes(raw.area) ? raw.area : '기타',
    kind,
    due: raw.due ?? null,
    today: raw.today ?? null,
    slot: cleanSlot_(raw.slot),
    status: 'open',
    createdAt: raw.createdAt || now,
    updatedAt: now,
    src: raw.src || 'app',
  };
  const link = String(raw.link ?? '').trim();
  if (link) {
    if (!/^https?:\/\//i.test(link)) throw new Error('링크는 http:// 또는 https:// 로 시작해야 합니다');
    t.link = link.slice(0, MAX_LINK);
  }
  const note = String(raw.note ?? '').trim();
  if (note) t.note = note.slice(0, MAX_NOTE);
  if (raw.ruleId) t.ruleId = String(raw.ruleId);
  if (isDateStr(raw.prepDue)) t.prepDue = raw.prepDue;   // 수업 준비가 자동으로 정한 마감 (효니가 고쳤는지 가려내는 용도)
  // 애매한 기간("한 달 내")으로 정한 마감 — due 는 그 기간의 끝날짜, dueText 는 화면에 보일 말
  const dueText = String(raw.dueText ?? '').trim();
  if (dueText && t.due) t.dueText = dueText.slice(0, MAX_DUETEXT);
  return t;
}

// 칸 없이 null 필드는 DB에 남지 않으므로(Firebase), 화면용으로 항상 같은 모양을 얻는다
export function shapeTask(id, v) {
  return {
    id, title: '', area: '기타', kind: 'once', due: null, today: null, slot: null,
    status: 'open', createdAt: '', updatedAt: '', ...v,
  };
}

export function listTasks(planner) {
  return Object.entries(planner?.tasks || {}).map(([id, v]) => shapeTask(id, v));
}

// ------------------------------------------------------------
// 쓰기 계획 — 한 번에 한 건, 필드 단위 (여러 기기가 서로 다른 필드를 고쳐도 덮어쓰지 않게)
// ------------------------------------------------------------
function taskPatch_(id, fields, now) {
  if (!isValidId(id)) throw new Error('할 일 id가 올바르지 않습니다');
  const out = {};
  for (const [k, v] of Object.entries({ ...fields, updatedAt: now })) out[`tasks/${id}/${k}`] = v ?? null;
  return out;
}

export function planAddTask(input, { id, now }) {
  if (!isValidId(id)) throw new Error('할 일 id가 올바르지 않습니다');
  return { [`tasks/${id}`]: normalizeTask(input, { now }) };
}

// 제목·영역·마감·메모 같은 고칠 수 있는 필드만 받아 같은 검사를 거친다
export function planEditTask(task, changes, { now }) {
  const merged = normalizeTask({ ...task, ...changes }, { now });
  const fields = {};
  for (const k of ['title', 'area', 'kind', 'due', 'dueText', 'today', 'slot', 'link', 'note']) {
    if (!(k in changes)) continue;
    fields[k] = merged[k] ?? null;
  }
  return taskPatch_(task.id, fields, now);
}

export function planComplete(task, { now }) {
  if (task.status === 'done') return {};
  return taskPatch_(task.id, { status: 'done', doneAt: now }, now);
}

export function planUndoComplete(task, { now }) {
  if (task.status !== 'done') return {};
  return taskPatch_(task.id, { status: 'open', doneAt: null }, now);
}

export function planArchive(task, { now }) {
  return taskPatch_(task.id, { status: 'archived', archivedAt: now }, now);
}

export function planRestore(task, { now }) {
  return taskPatch_(task.id, { status: 'open', archivedAt: null }, now);
}

export function planDelete(task) {
  if (!isValidId(task.id)) throw new Error('할 일 id가 올바르지 않습니다');
  return { [`tasks/${task.id}`]: null };
}

// 날짜를 미룬다 — 마감을 옮기고 지난 칸·오늘 표시는 비운다
export function planPostpone(task, newDate, { now }) {
  if (!isDateStr(newDate)) throw new Error('미룰 날짜가 올바르지 않습니다');
  return taskPatch_(task.id, { due: newDate, dueText: null, today: null, slot: null }, now);
}

// 칸 놓기/빼기 (검사는 slotConflict 로 먼저 한다)
export function planSetSlot(task, slot, { now }) {
  const clean = cleanSlot_(slot);
  return taskPatch_(task.id, { slot: clean, today: clean ? null : task.today ?? null }, now);
}

// ------------------------------------------------------------
// 오늘 할 일 — 상한
// ------------------------------------------------------------
// 오늘 하려고 "골라 둔" 건수 (마감만 오늘인 것은 고른 게 아니라 세지 않는다)
export function chosenFor(tasks, date) {
  return tasks.filter(t => t.status === 'open' && t.kind !== 'watch' && (t.today === date || t.slot?.date === date));
}

// task 를 date 의 오늘 할 일로 고를 수 있나. 상한을 넘으면 빼야 할 후보(chosen)를 같이 돌려준다
export function checkTodayAdd(tasks, task, date, settings = DEFAULT_SETTINGS) {
  const cap = resolveSettings(settings).todayCap;
  const chosen = chosenFor(tasks, date).filter(t => t.id !== task.id);
  if (chosen.length >= cap) return { ok: false, reason: 'cap', cap, chosen };
  return { ok: true, cap, chosen };
}

export function planSetToday(task, date, { now }) {
  if (date != null && !isDateStr(date)) throw new Error('날짜가 올바르지 않습니다');
  return taskPatch_(task.id, { today: date }, now);
}

// ------------------------------------------------------------
// 분류 — 할 일 목록의 묶음
//   watch   지켜보기(기한 없이 두고 보는 것) — 다른 묶음에 섞지 않는다
//   today   오늘 고른 것 + 오늘 칸에 놓은 것 + 마감이 오늘인 것
//   overdue 마감·칸·오늘 표시가 지났는데 안 끝난 것  ← 매일 결정해야 하는 것
//   week    앞으로 7일 안
//   later   그 뒤
//   undated 날짜 없음 (방치되기 쉬운 것)
// ------------------------------------------------------------
function byDue_(a, b) {
  return (a.due || a.slot?.date || '9999').localeCompare(b.due || b.slot?.date || '9999')
    || (a.slot?.start || '').localeCompare(b.slot?.start || '')
    || (a.createdAt || '').localeCompare(b.createdAt || '');
}

// 날짜 없음·지켜보기는 효니가 끌어서 정한 순서(order)가 먼저, 순서를 안 정한 건 그 뒤에 만든 순서로
function byOrder_(a, b) {
  const x = Number.isFinite(a.order) ? a.order : Infinity, y = Number.isFinite(b.order) ? b.order : Infinity;
  return x === y ? byDue_(a, b) : x < y ? -1 : 1;
}

// 한 묶음을 끌어서 바꾼 새 순서(tasks 배열 순서 그대로)를 저장하는 patch — 값이 달라진 것만 쓴다
export function planReorder(tasks, { now }) {
  const patch = {};
  tasks.forEach((t, i) => {
    const order = (i + 1) * 1000;
    if (t.order !== order) Object.assign(patch, taskPatch_(t.id, { order }, now));
  });
  return patch;
}

export function classify(tasks, today) {
  const out = { watch: [], today: [], overdue: [], week: [], later: [], undated: [], done: [], archived: [] };
  const weekEnd = addDays(today, 7);
  for (const t of tasks) {
    if (t.status === 'archived') { out.archived.push(t); continue; }
    if (t.status === 'done') { out.done.push(t); continue; }
    if (t.kind === 'watch') { out.watch.push(t); continue; }
    if (t.today === today || t.slot?.date === today || t.due === today) { out.today.push(t); continue; }
    const when = t.slot?.date || t.due || null;
    if ((t.due && t.due < today) || (t.slot && t.slot.date < today) || (t.today && t.today < today)) { out.overdue.push(t); continue; }
    if (!when) { out.undated.push(t); continue; }
    if (when <= weekEnd) out.week.push(t); else out.later.push(t);
  }
  for (const k of ['today', 'overdue', 'week', 'later']) out[k].sort(byDue_);
  for (const k of ['watch', 'undated']) out[k].sort(byOrder_);
  out.done.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  return out;
}

// 오늘 처음 열었을 때 결정해야 하는 것 — 마감 지난 일이 있고 오늘 정리를 아직 안 했으면 그 목록
export function reviewList(tasks, today, settings = {}) {
  if (resolveSettings(settings).reviewedOn === today) return [];
  return classify(tasks, today).overdue;
}

// 정리 창에서 고른 결정 → patch.  action: 'today' | 'postpone' | 'archive'
export function planReviewAction(task, action, { today, date, now }) {
  if (action === 'today') return taskPatch_(task.id, { today, slot: null }, now);
  if (action === 'postpone') return planPostpone(task, date, { now });
  if (action === 'archive') return planArchive(task, { now });
  throw new Error(`알 수 없는 결정: ${action}`);
}

export function planMarkReviewed(today) {
  if (!isDateStr(today)) throw new Error('날짜가 올바르지 않습니다');
  return { 'settings/reviewedOn': today };
}

// ------------------------------------------------------------
// 하루 칸 — 수업이 이미 차지한 시간과 빈 시간
// ------------------------------------------------------------
// date 의 수업·학사일정 블록 [{ p, start, end, kind: 'class'|'event', label }] (분 단위, 시각 순)
// 휴업일(holiday)은 수업이 없으니 블록을 만들지 않는다. 그 밖의 행사는 그 교시를 막는다.
export function busyBlocks(data, date) {
  const periods = data?.periods || {};
  const sched = scheduleOn(data, date);
  const blocks = [];
  for (const p of Object.keys(periods).map(Number).filter(n => n > 0).sort((a, b) => a - b)) {
    const t = periods[p];
    if (!t?.start || !t?.end) continue;
    const cell = sched[p];
    const ev = calendarEvent(data, date, p, cell?.class);
    let kind = null, label = '';
    if (ev) {
      if (ev.type === 'holiday') continue;
      kind = 'event'; label = ev.label || '';
    } else if (cellKey(cell)) {
      kind = 'class'; label = `${cell.class} ${cell.subject}`;
    }
    if (kind) blocks.push({ p, start: timeToMin(t.start), end: timeToMin(t.end), kind, label });
  }
  return blocks;
}

const overlap_ = (aS, aE, bS, bE) => aS < bE && bS < aE;

// task 를 date 의 start(HH:MM)부터 min 분 놓으면 어떤가
//   { ok:true } | { ok:false, reason:'range'|'class'|'task', with }
export function slotConflict(data, tasks, date, start, min, { ignoreId = null, settings = DEFAULT_SETTINGS } = {}) {
  const s = resolveSettings(settings);
  const a = timeToMin(start), b = a + min;
  if (a < timeToMin(s.dayStart) || b > timeToMin(s.dayEnd)) return { ok: false, reason: 'range' };
  for (const blk of busyBlocks(data, date)) {
    if (overlap_(a, b, blk.start, blk.end)) return { ok: false, reason: 'class', with: blk };
  }
  for (const t of tasks) {
    if (t.id === ignoreId || t.status !== 'open' || t.slot?.date !== date) continue;
    const ts = timeToMin(t.slot.start);
    if (overlap_(a, b, ts, ts + t.slot.min)) return { ok: false, reason: 'task', with: t };
  }
  return { ok: true };
}

// date 에서 아직 비어 있는 시간 [{ start, end }] (분). minLen 보다 짧은 틈은 뺀다
export function freeIntervals(data, tasks, date, { settings = DEFAULT_SETTINGS, ignoreId = null, minLen = 15 } = {}) {
  const s = resolveSettings(settings);
  const taken = busyBlocks(data, date).map(b => [b.start, b.end]);
  for (const t of tasks) {
    if (t.id === ignoreId || t.status !== 'open' || t.slot?.date !== date) continue;
    const a = timeToMin(t.slot.start);
    taken.push([a, a + t.slot.min]);
  }
  taken.sort((x, y) => x[0] - y[0]);
  const free = [];
  let cur = timeToMin(s.dayStart);
  const end = timeToMin(s.dayEnd);
  for (const [a, b] of taken) {
    if (a > cur) free.push({ start: cur, end: Math.min(a, end) });
    cur = Math.max(cur, b);
    if (cur >= end) break;
  }
  if (cur < end) free.push({ start: cur, end });
  return free.filter(f => f.end - f.start >= minLen);
}

// ------------------------------------------------------------
// 반복 규칙
//   { title, area, every: 'weekly', dow: 'mon' }                 매주 월요일
//   { title, area, every: 'monthly', dow: 'mon', nth: 1 }        매월 첫째 월요일 (nth 5 = 마지막 주)
//   { title, area, every: 'monthly', day: 15 }                   매월 15일 (없는 날이면 그 달 마지막 날)
// 펼친 할 일의 id 는 규칙+날짜로 정해져(r_규칙_날짜) 여러 기기가 동시에 펼쳐도 한 건만 생긴다.
// ------------------------------------------------------------
export function normalizeRule(raw) {
  const title = String(raw?.title ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('반복 할 일 제목이 필요합니다');
  const every = raw.every;
  const r = { title: title.slice(0, MAX_TITLE), area: AREAS.includes(raw.area) ? raw.area : '기타', every, active: raw.active !== false };
  if (every === 'weekly') {
    if (!DOW_KEY.includes(raw.dow)) throw new Error('요일이 올바르지 않습니다 (mon~sun)');
    r.dow = raw.dow;
    const iv = Number(raw.interval ?? 1);
    if (!Number.isInteger(iv) || iv < 1 || iv > 8) throw new Error('몇 주마다인지는 1~8 이어야 합니다');
    if (iv > 1) {
      if (!isDateStr(raw.start)) throw new Error('격주 이상은 기준이 되는 첫 날짜가 필요합니다');
      r.interval = iv; r.start = raw.start;
    }
  } else if (every === 'monthly') {
    if (raw.day != null) {
      const d = Number(raw.day);
      if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error('날짜는 1~31 이어야 합니다');
      r.day = d;
    } else {
      const n = Number(raw.nth);
      if (!DOW_KEY.includes(raw.dow) || !Number.isInteger(n) || n < 1 || n > 5) throw new Error('매월 몇째 무슨 요일인지 정해야 합니다');
      r.dow = raw.dow; r.nth = n;
    }
  } else {
    throw new Error('반복은 weekly 또는 monthly 입니다');
  }
  if (raw.until != null) {
    if (!isDateStr(raw.until)) throw new Error('반복 끝날이 올바르지 않습니다');
    r.until = raw.until;
  }
  return r;
}

function daysInMonth_(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

function ruleHits_(rule, date) {
  if (rule.until && date > rule.until) return false;
  if (rule.every === 'weekly') {
    if (weekdayKey(date) !== rule.dow) return false;
    if (!(rule.interval > 1)) return true;
    const days = Math.round((Date.parse(`${mondayOf_(date)}T00:00:00Z`) - Date.parse(`${mondayOf_(rule.start)}T00:00:00Z`)) / 86400000);
    return days >= 0 && (days / 7) % rule.interval === 0;   // 기준 주부터 N주마다
  }
  const [y, m, d] = date.split('-').map(Number);
  if (rule.day != null) return d === Math.min(rule.day, daysInMonth_(y, m));
  if (weekdayKey(date) !== rule.dow) return false;
  const nth = Math.ceil(d / 7);
  if (rule.nth === 5) return d + 7 > daysInMonth_(y, m);   // 마지막 주
  return nth === rule.nth;
}

export function ruleTaskId(ruleId, date) { return `r_${ruleId}_${date.replace(/-/g, '')}`; }

// from~to(포함) 에 규칙이 해당하는 날짜들
export function expandRules(rules, from, to) {
  const out = [];
  for (const [ruleId, rule] of Object.entries(rules || {})) {
    if (rule.active === false) continue;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (ruleHits_(rule, d)) out.push({ ruleId, date: d, title: rule.title, area: rule.area });
    }
  }
  return out;
}

// 오늘부터 horizonDays 일 안에서 아직 할 일로 안 만들어진 반복 건의 patch.
// 사용자가 지운 건 다시 만들지 않도록, 지운 날짜를 skipped/ 에 남기는 건 planner.js 의 몫이 아니라
// 여기서 처리한다: 규칙 쪽 skip 목록(rule.skip)에 든 날짜는 펼치지 않는다.
export function planMaterialize(planner, today, { horizonDays = 14, now }) {
  const patch = {};
  for (const o of expandRules(planner?.rules, today, addDays(today, horizonDays))) {
    if (planner.rules[o.ruleId].skip?.[o.date]) continue;
    const id = ruleTaskId(o.ruleId, o.date);
    if (planner?.tasks?.[id]) continue;
    patch[`tasks/${id}`] = normalizeTask({ title: o.title, area: o.area, due: o.date, ruleId: o.ruleId, src: 'rule' }, { now });
  }
  return patch;
}

export function planAddRule(input, { id }) {
  if (!isValidId(id)) throw new Error('규칙 id가 올바르지 않습니다');
  return { [`rules/${id}`]: normalizeRule(input) };
}

const RULE_FIELDS = ['title', 'area', 'every', 'dow', 'nth', 'day', 'until', 'interval', 'start', 'active'];

// 규칙 고치기 — 칸마다 써서 skip(지운 날짜 목록)은 그대로 남긴다. 이미 만들어진 앞날의 열린 반복 건은 새 규칙에 안 맞으면 지운다.
export function planEditRule(planner, ruleId, input, { today }) {
  const old = planner?.rules?.[ruleId];
  if (!old || !isValidId(ruleId)) throw new Error('규칙을 찾을 수 없습니다');
  const next = normalizeRule({ ...input, active: input.active ?? old.active });
  const patch = {};
  for (const k of RULE_FIELDS) patch[`rules/${ruleId}/${k}`] = next[k] ?? null;
  const stale = new Set(expandRules({ [ruleId]: next }, today, addDays(today, 400)).map(o => o.date));
  for (const [id, t] of Object.entries(planner.tasks || {})) {
    if (t.ruleId === ruleId && t.status === 'open' && t.due >= today && !stale.has(t.due)) patch[`tasks/${id}`] = null;
  }
  return patch;
}

// 규칙 지우기 — 앞날의 열린 반복 건도 함께 지운다 (끝낸 건·지난 건은 기록으로 남는다)
export function planDeleteRule(planner, ruleId, { today }) {
  if (!isValidId(ruleId)) throw new Error('규칙 id가 올바르지 않습니다');
  const patch = { [`rules/${ruleId}`]: null };
  for (const [id, t] of Object.entries(planner?.tasks || {})) {
    if (t.ruleId === ruleId && t.status === 'open' && t.due >= today) patch[`tasks/${id}`] = null;
  }
  return patch;
}

// 반복에서 생긴 할 일을 지울 때: 같은 날짜로 다시 만들어지지 않게 skip 에 적는다
export function planSkipRuleDate(ruleId, date) {
  if (!isValidId(ruleId) || !isDateStr(date)) throw new Error('규칙 id 또는 날짜가 올바르지 않습니다');
  return { [`rules/${ruleId}/skip/${date}`]: true };
}

// ------------------------------------------------------------
// 수업 준비 — 진도표에서 자동으로 만든다
//   같은 과목·학년에 주제 목록이 똑같은 반들을 한 묶음으로 보고, 묶음 안에서 그 차시를 가장 먼저 가르치는 날의
//   전날(주말이면 금요일)을 마감으로 한 할 일을 첫 수업 7일 전부터 만든다.
//   id 는 묶음+차시로 정해져(p{묶음}_{차시}) 여러 기기가 동시에 돌려도 한 건이다.
//   지운 건 prepSkip/{id} 에 남겨 다시 만들지 않고, 끝낸·보관한 건 건드리지 않는다.
//   마감을 효니가 직접 고친 건(prepDue 와 다른 due) 진도가 밀려도 그대로 둔다.
// ------------------------------------------------------------
export const PREP_EXCLUDE = /글쓰기|복습|마지막 정리|독서/;
const DOW_KO = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' };

function hash_(s) {
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36);
}

export function prepTaskId(groupId, step) { return `p${groupId}_${step}`; }

function prevSchoolDay_(date) {
  let d = addDays(date, -1);
  while (['sat', 'sun'].includes(weekdayKey(d))) d = addDays(d, -1);
  return d;
}

const dateLabel_ = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}(${DOW_KO[weekdayKey(d)]})`;

// 진도표 묶음 [{ id, subject, keys, topics }] — curriculum 이 비어 있는 반은 뺀다
export function prepGroups(data) {
  const groups = new Map();
  for (const key of allKeys(data)) {
    const topics = data.curriculum?.[key];
    if (!topics || !Object.values(topics).some(Boolean)) continue;
    const i = key.indexOf('_');
    const cls = key.slice(0, i), subject = key.slice(i + 1);
    const sig = `${subject}|${gradeOf(cls)}|${JSON.stringify(Object.entries(topics).filter(([, v]) => v))}`;
    if (!groups.has(sig)) groups.set(sig, { subject, keys: [], topics });
    groups.get(sig).keys.push(key);
  }
  return [...groups.values()].map(g => ({ ...g, id: hash_(`${g.subject}|${g.keys[0]}`) }));
}

export function planPrepSync(planner, data, today, { horizonDays = 7, now } = {}) {
  const patch = {};
  if (!data?.semester || !isDateStr(today)) return patch;
  const limit = addDays(today, horizonDays);
  for (const g of prepGroups(data)) {
    // 반별로 각 차시를 처음 가르치는 날
    const firsts = new Map();   // step → [{ key, date, p }] (반마다 가장 이른 정규 수업)
    for (const key of g.keys) {
      let rows;
      try { rows = buildLedger(data, key); } catch (_) { continue; }
      const seen = new Map();
      for (const r of rows) {
        if (r.kind === 'regular' && !seen.has(r.step)) seen.set(r.step, { key, date: r.date, p: r.p });
      }
      for (const [step, v] of seen) {
        if (!firsts.has(step)) firsts.set(step, []);
        firsts.get(step).push(v);
      }
    }
    for (const [step, list] of firsts) {
      const topic = String(g.topics[step] ?? '').trim();
      if (!topic || PREP_EXCLUDE.test(topic)) continue;
      list.sort((a, b) => a.date.localeCompare(b.date) || a.p - b.p);
      const first = list[0];
      if (first.date <= today) continue;
      const due = prevSchoolDay_(first.date) < today ? today : prevSchoolDay_(first.date);
      const id = prepTaskId(g.id, step);
      if (planner?.prepSkip?.[id]) continue;
      const clsOf = k => k.slice(0, k.indexOf('_'));
      const note = `첫 수업 ${dateLabel_(first.date)} ${first.p}교시 ${clsOf(first.key)}\n` +
        list.slice(1).map(v => `· ${clsOf(v.key)} ${dateLabel_(v.date)} ${v.p}교시`).join('\n');
      const old = planner?.tasks?.[id];
      if (!old) {
        if (first.date > limit) continue;   // 아직 먼 수업은 7일 안으로 들어올 때 만든다
        patch[`tasks/${id}`] = normalizeTask({
          title: `수업 준비 · ${g.subject} ${step}차시 ${topic}`, area: '수업', due, prepDue: due, note: note.trim(), src: 'prep',
        }, { now });
      } else if (old.status === 'open' && old.prepDue && old.due === old.prepDue && old.due !== due) {
        Object.assign(patch, taskPatch_(id, { due, prepDue: due, note: note.trim() }, now));
      }
    }
  }
  return patch;
}

// ------------------------------------------------------------
// 애매한 기간 — "한 달 내", "이번 주 중", "10월 중" 처럼 날짜를 못 박지 않은 마감
//   그 기간의 끝날짜를 due 로, 말 그대로를 dueText 로 저장한다 → 마감 지남·이번 주 같은 묶음 계산은 그대로 쓴다.
// ------------------------------------------------------------
export const FUZZY_PRESETS = ['오늘', '내일', '이번 주 중', '다음 주 중', '2주 내', '이번 달 중', '다음 달 중', '한 달 내', '3개월 내', '올해 안'];

function monthEnd_(y, m) { return `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth_(y, m)).padStart(2, '0')}`; }

// n개월 뒤 같은 날 (그 달에 없는 날이면 말일)
function addMonths_(date, n) {
  const [y0, m0, d0] = date.split('-').map(Number);
  const idx = y0 * 12 + (m0 - 1) + n;
  const y = Math.floor(idx / 12), m = idx % 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d0, daysInMonth_(y, m))).padStart(2, '0')}`;
}

// 말("한 달 내", "3개월 내", "2주 내", "10월 중", FUZZY_PRESETS) → { due, dueText } | null
export function resolveFuzzy(label, today) {
  const t = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!isDateStr(today)) return null;
  const [y, m] = today.split('-').map(Number);
  let due = null, k;
  if (t === '오늘') due = today;
  else if (t === '내일') due = addDays(today, 1);
  else if (t === '이번 주 중') { const fri = addDays(mondayOf_(today), 4); due = fri >= today ? fri : addDays(mondayOf_(today), 6); }
  else if (t === '다음 주 중') due = addDays(mondayOf_(today), 7 + 4);
  else if (t === '이번 달 중') due = monthEnd_(y, m);
  else if (t === '다음 달 중') due = monthEnd_(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
  else if (t === '올해 안') due = `${y}-12-31`;
  else if (t === '한 달 내') due = addMonths_(today, 1);
  else if ((k = /^(\d{1,2}) ?주 내$/.exec(t)) && Number(k[1]) >= 1) due = addDays(today, 7 * Number(k[1]));
  else if ((k = /^(\d{1,2}) ?개월 내$/.exec(t)) && Number(k[1]) >= 1) due = addMonths_(today, Number(k[1]));
  else if ((k = /^(\d{1,2})월 중$/.exec(t)) && Number(k[1]) >= 1 && Number(k[1]) <= 12) {
    due = monthEnd_(y, Number(k[1]));
    if (due < today) due = monthEnd_(y + 1, Number(k[1]));
  }
  return due ? { due, dueText: t } : null;
}

// ------------------------------------------------------------
// 한 줄 입력 해석 — "내일 15시 학생회 회의 1시간", "논문 읽기 10/30까지", "다음주 금요일 보고서"
//   날짜만 있으면 마감일, 시각이 있으면 그날 그 시각의 칸(기본 60분, 마감도 그날)
//   "까지"가 붙으면 시각이 있어도 마감일만. 해석 못 한 부분은 제목에 그대로 남는다.
// ------------------------------------------------------------
const DOW_KO_IDX = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

function dowIndex_(dateStr) { return DOW_KEY.indexOf(weekdayKey(dateStr)); }

// 월요일 시작 주의 월요일
function mondayOf_(dateStr) {
  const i = dowIndex_(dateStr);
  return addDays(dateStr, i === 0 ? -6 : 1 - i);
}

function mdToDate_(m, d, today) {
  if (m < 1 || m > 12 || d < 1) return null;
  const y = Number(today.slice(0, 4));
  for (const yy of [y, y + 1]) {
    if (d > daysInMonth_(yy, m)) return null;
    const s = `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (s >= today) return s;   // 이미 지난 날짜면 내년
  }
  return null;
}

export function parseQuickInput(text, today) {
  let s = ` ${String(text ?? '').normalize('NFC').trim()} `;
  let date = null, startMin = null, dur = null, until = false;
  // 패턴에 맞고 fn 이 false 를 돌려주지 않으면 그 부분을 제목에서 떼어 낸다 (해석 못 한 값은 제목에 남긴다)
  const eat = (re, fn) => { const m = re.exec(s); if (!m || fn(m) === false) return false; s = s.replace(re, ' '); return true; };

  until = eat(/까지/, () => true);

  // 걸리는 시간: 1시간 30분 / 2시간 / 45분
  eat(/(\d+)\s*시간(?:\s*(\d+)\s*분)?/, m => { dur = Number(m[1]) * 60 + Number(m[2] || 0); });
  // 시각: 오후 3시 30분 / 15시 / 15:30
  const setTime = (h, mi, marker) => {
    if (marker === '오후' && h < 12) h += 12;
    else if (marker === '오전' && h === 12) h = 0;
    else if (!marker && h >= 1 && h <= 6) h += 12;    // "3시"는 보통 오후
    if (h > 23 || mi > 59) return false;
    startMin = h * 60 + mi;
    return true;
  };
  // 숫자와 "시" 사이는 붙여 쓴 것만 시각으로 읽는다 ("1/5 시험"의 "5 시"는 시각이 아니다)
  eat(/(오전|오후)?\s*(\d{1,2})시(?![간험])(?:\s*(\d{1,2})\s*분)?/, m => setTime(Number(m[2]), Number(m[3] || 0), m[1]));
  if (startMin == null) eat(/(?<![\d/])(\d{1,2}):(\d{2})(?!\d)/, m => setTime(Number(m[1]), Number(m[2]), null));
  if (dur == null) eat(/(\d+)\s*분/, m => { dur = Number(m[1]); });

  // 날짜 (한 가지만 읽는다)
  const setDate = d => { date = d; return d != null; };
  const found =
    eat(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/, m => setDate(mdToDate_(Number(m[1]), Number(m[2]), today)))
    || eat(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/, m => setDate(mdToDate_(Number(m[1]), Number(m[2]), today)))
    || eat(/모레/, () => setDate(addDays(today, 2)))
    || eat(/내일/, () => setDate(addDays(today, 1)))
    || eat(/오늘/, () => setDate(today));
  if (!found) {
    eat(/(다음\s*주|이번\s*주)?\s*([월화수목금토일])요일/, m => {
      const want = DOW_KO_IDX[m[2]];
      if (m[1]) {
        const off = want === 0 ? 6 : want - 1;
        return setDate(addDays(mondayOf_(today), off + (m[1].startsWith('다음') ? 7 : 0)));
      }
      return setDate(addDays(today, (want - dowIndex_(today) + 7) % 7 || 7));   // 오늘 요일이면 다음 주
    });
  }

  // 애매한 기간 — 날짜를 못 읽었을 때만. 끝말(중/내/안에)이 꼭 있어야 읽는다 ("다음주 금요일"과 안 섞이게)
  let fuzzy = null;
  if (!date) {
    const END = '\\s*(?:중|안에?|내|이내)(?:에|으로)?';
    const tryF = (re, mk) => eat(re, m => { const f = resolveFuzzy(mk(m), today); if (f) fuzzy = f; return !!f; });
    tryF(new RegExp(`(이번|다음)\\s*(주|달)${END}`), m => `${m[1]} ${m[2]} 중`)
      || tryF(new RegExp(`(한|\\d{1,2})\\s*(주|달|개월)${END}`), m => (m[1] === '한' ? (m[2] === '주' ? '1주 내' : '한 달 내') : `${m[1]}${m[2] === '주' ? '주' : '개월'} 내`))
      || tryF(new RegExp(`(\\d{1,2})\\s*월${END}`), m => `${m[1]}월 중`)
      || tryF(new RegExp(`올해${END}|연말`), () => '올해 안');
  }

  const title = s.replace(/\s+/g, ' ').trim();
  const out = { title, due: null, slot: null };
  if (fuzzy) { out.due = fuzzy.due; out.dueText = fuzzy.dueText; }
  if (date) {
    out.due = date;
    if (startMin != null && !until) {
      const min = dur || 60;
      if (startMin + min <= 24 * 60) out.slot = { date, start: minToTime(startMin), min };
    }
  }
  if (dur && !out.slot) out.durationMin = dur;   // 칸 없이 걸리는 시간만 말한 경우 — 나중에 칸에 놓을 때 쓴다
  return out;
}

// 제목에서 영역 짐작 — 맞는 말이 없으면 null (그때는 고른 영역을 그대로 쓴다)
// 앞에 있는 영역이 먼저다: "대학원 수업 과제"는 수업이 아니라 대학원.
const AREA_HINTS = [
  ['학생회', /학생회|학생자치|자치회|임원|부회장|전교회장/],
  ['대학원', /대학원|논문|학회|학위|지도교수|리포트|보고서\s*제출|발표\s*자료|녹화\s*강의|원우/],
  ['독서', /독서|서평|책\s*읽|도서/],
  ['연수', /연수|워크숍|워크샵|직무연수|이수/],
  ['투자', /투자|주식|ETF|매수|매도|코인|종목/i],
  ['수업', /수업|차시|수행평가|활동지|학습지|채점|주제\s*\d+|시험|출제|평가|학급|단원|교과|진도|결시/],
  ['학교', /공문|기안|품의|출장|결재|업무계획|회의|담임|생기부|생활기록부|나이스|NEIS|성적|학부모|상담|행정/i],
];

// 오늘 직접 적어 넣은 할 일 — 목록 맨 위 "방금 추가"에 모은다 (반복·수업 준비처럼 저절로 생긴 건 뺀다)
export function isFresh(t, today) {
  return t.status === 'open' && t.kind !== 'watch' && !t.ruleId && !t.prepDue && (t.src || 'app') === 'app'
    && String(t.createdAt || '').startsWith(today);
}

export function guessArea(title) {
  const s = String(title ?? '').normalize('NFC');
  const hit = AREA_HINTS.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

// ------------------------------------------------------------
// 쓰기 경로 검사 — planner 밖(v2 진도 데이터 등)을 건드리는 patch 는 DB에 보내지 않는다
// ------------------------------------------------------------
const PATCH_PATH_RE = /^(?:tasks\/[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z]{1,20})?|rules\/[A-Za-z0-9_-]{1,64}(?:\/(?:[A-Za-z]{1,20}|skip\/\d{4}-\d{2}-\d{2}))?|settings(?:\/[A-Za-z]{1,20})?|prepSkip\/[A-Za-z0-9_-]{1,64}|log\/[A-Za-z0-9_-]{1,64})$/;

export function assertPlannerPatch(patch) {
  for (const path of Object.keys(patch)) {
    if (!PATCH_PATH_RE.test(path)) throw new Error(`planner 밖이거나 올바르지 않은 경로입니다: ${path}`);
  }
  return patch;
}
