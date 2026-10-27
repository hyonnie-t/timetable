// ============================================================
// 진도 엔진 v2 — 화면·DB·현재 시각과 상관없는 순수 계산만 한다
// ============================================================
// 원칙: "저장하는 건 사실뿐이고, 차시는 언제나 계산한다"
//
// 저장하는 사실 (data):
//   semester     { id, start, end }                   학기 기간
//   periods      { 1: { start:'09:00', end:'09:45' } } 교시 시간
//   timetables   { 적용시작일: { mon: { 3: { class, subject } }, ... } }
//                시간표는 버전으로 쌓는다. 새 시간표는 적용 시작일부터만 쓰이고 지난 날짜는 절대 바뀌지 않는다.
//   dayOverrides { 날짜: { 교시: { class, subject } } }    그날 하루만 바꾼 시간표
//   calendar     { 날짜: { 교시|'all': { type, label } } } 학사일정 (그 교시 수업 없음)
//   specials     { 날짜: { 교시: { key, label } } }       특별 수업 (수업은 했지만 진도에 안 셈)
//   pins         { 반_과목: { '날짜_교시': { step } } }   고정핀: "이 수업은 step차시였다/이다"
//
// 차시 계산: 학기 첫날부터 그 반 수업을 순서대로 센다. 고정핀을 만나면 그 자리(또는 그 뒤 첫 정규 수업)를
// 핀의 차시로 맞추고 거기서부터 다시 센다. 핀은 특정 수업 자리에 붙어 있으므로
//   - 시간표·학사일정·특별 수업을 나중에 고쳐도 "핀 ~ 그 수업 사이"만 다시 세어진다 (보정 땜질 불필요)
//   - 앱을 안 열거나 기기를 여러 개 써도 결과가 같다 (저장된 카운터가 없음)
// 교시 0은 "그날 첫 수업 전"을 뜻한다 (v1 기준점을 옮겨 올 때 쓴다).
//
// 브라우저(app.js)와 node 테스트가 같은 파일을 쓴다. DOM·Firebase·Date.now() 를 쓰지 않는다.
// ============================================================

export const ENGINE_VERSION = 2;
export const DOW_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_KO_ = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' };

// ------------------------------------------------------------
// 날짜 (문자열 'YYYY-MM-DD' 만 다룬다 — 시간대에 따라 하루 밀리는 일이 없게 UTC로 계산)
// ------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s) {
  return typeof s === 'string' && DATE_RE.test(s);
}

function toUtc_(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc_(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(s, n) {
  return fromUtc_(toUtc_(s) + n * 86400000);
}

export function weekdayKey(s) {
  return DOW_KEY[new Date(toUtc_(s)).getUTCDay()];
}

// 주차별 화면의 기준 월요일 — 토·일요일에는 지나간 주가 아니라 다가오는 주의 월요일을 준다
// (일요일 저녁에 "이번 주 월요일" 수업이 지난주 것으로 보이던 문제. 주중에는 그 주 월요일)
export function weekMondayOf(dateStr, offsetWeeks = 0) {
  const dow = new Date(toUtc_(dateStr)).getUTCDay();
  const toMon = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;   // 일: 내일, 토: 모레, 주중: 그 주 월요일
  return addDays(dateStr, toMon + offsetWeeks * 7);
}

export function timeToMin(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

// ------------------------------------------------------------
// 교시 시간 — 평소엔 data.periods, 시험 기간처럼 그날만 바뀌는 날은 아래 표를 쓴다
// ------------------------------------------------------------
const EXAM_2026_2_BASE = {
  1: { start: '09:00', end: '09:45' },
  2: { start: '10:00', end: '10:45' },
  3: { start: '10:55', end: '11:40' },
  4: { start: '11:50', end: '12:30' },
  5: { start: '13:20', end: '14:05' },
  6: { start: '14:15', end: '15:00' },
  7: { start: '15:10', end: '15:55' },
};
// 2026 2학기 기말고사 주간(3학년) 시정표. 3교시만 수요일 11:00~11:40
export const PERIOD_OVERRIDES = {
  '2026-10-28': { ...EXAM_2026_2_BASE, 3: { start: '11:00', end: '11:40' } },
  '2026-10-29': EXAM_2026_2_BASE,
  '2026-10-30': EXAM_2026_2_BASE,
};

// 요일별 마지막 교시 — 월·수·금은 6교시까지만 있다.
// 단, 그날 시간표(요일 바꾸기·하루 바꾸기 포함)에 그 뒤 교시 수업이 있으면 남긴다.
export const LAST_PERIOD_BY_DAY = { mon: 6, wed: 6, fri: 6 };

export function periodsOn(data, date) {
  const base = PERIOD_OVERRIDES[date] || data?.periods || {};
  const last = isDateStr(date) ? LAST_PERIOD_BY_DAY[weekdayKey(date)] : undefined;
  if (!last) return base;
  const sched = data?.timetables || data?.dayOverrides ? scheduleOn(data, date) : {};
  const out = {};
  for (const [p, t] of Object.entries(base)) if (Number(p) <= last || cellKey(sched[p])) out[p] = t;
  return out;
}

// ------------------------------------------------------------
// 반·과목 이름 — 띄어쓰기·전각 공백 차이로 다른 반이 되지 않게 정리한다
// ------------------------------------------------------------
export function normalizeName(s) {
  return String(s ?? '').normalize('NFC').replace(/[\s\u3000]+/g, ' ').trim();
}

export function lessonKey(cls, subject) {
  return `${normalizeName(cls)}_${normalizeName(subject)}`;
}

// 시간표 칸 → 반_과목 (반·과목이 둘 다 있어야 수업)
export function cellKey(cell) {
  if (!cell) return null;
  const c = normalizeName(cell.class), s = normalizeName(cell.subject);
  return c && s ? `${c}_${s}` : null;
}

// ------------------------------------------------------------
// 하루 시간표
// ------------------------------------------------------------
function sortedVersions_(data) {
  return Object.keys(data.timetables || {}).filter(isDateStr).sort();
}

// date에 적용되는 시간표 버전의 시작일 (없으면 null)
export function timetableVersionOn(data, date, versions = sortedVersions_(data)) {
  let found = null;
  for (const v of versions) { if (v <= date) found = v; else break; }
  return found;
}

// 요일 대체 — 학사일정 { 날짜: { swap: { to:'fri', ... } } }. 그날은 to 요일 시간표로 수업한다 (원래 요일 수업은 없어짐, 전 학년 공통)
export function swapOn(data, date) {
  const to = data.calendar?.[date]?.swap?.to;
  return DOW_KEY.includes(to) ? to : null;
}

// date의 { 교시: cell } — 하루 바꾸기가 있으면 그것, 없으면 그날 적용되는 시간표 버전의 요일(요일 대체가 있으면 그 요일)
export function scheduleOn(data, date, versions) {
  const ov = data.dayOverrides?.[date];
  if (ov) return ov;
  const v = timetableVersionOn(data, date, versions);
  return v ? (data.timetables[v]?.[swapOn(data, date) || weekdayKey(date)] || {}) : {};
}

// 반 이름의 학년 ('305' → '3', '201 A' → '2'). 알 수 없으면 null
export function gradeOf(cls) {
  const m = /^(\d)/.exec(normalizeName(cls));
  return m ? m[1] : null;
}

// 학사일정 키: '3' | 'all' (전 학년) 또는 '3@2' | 'all@2' (2학년만). cls(수업 반)를 주면 그 학년에 해당하는 일정만 본다.
// cls 없이 부르면 학년 지정 일정은 무시한다.
export function calendarEvent(data, date, p, cls) {
  const day = data.calendar?.[date];
  if (!day) return null;
  const g = gradeOf(cls);
  const pk = String(p);
  return (g && day[`${pk}@${g}`]) || day[pk] || (g && day[`all@${g}`]) || day.all || null;
}

export function specialAt(data, date, p, key) {
  const sp = data.specials?.[date]?.[p];
  return sp && normalizeName(sp.key) === key ? sp : null;
}

// date에 key 수업이 있는 칸들 (교시 순) — kind: 'regular' 정규 | 'event' 학사일정으로 빠짐 | 'special' 특별 수업
export function slotsOn(data, key, date, versions) {
  const sched = scheduleOn(data, date, versions);
  return Object.keys(sched)
    .map(Number)
    .filter(p => cellKey(sched[p]) === key)
    .sort((a, b) => a - b)
    .map(p => {
      const event = calendarEvent(data, date, p, sched[p].class);
      const special = event ? null : specialAt(data, date, p, key);
      return { date, p, kind: event ? 'event' : special ? 'special' : 'regular', event, special };
    });
}

// ------------------------------------------------------------
// 고정핀
// ------------------------------------------------------------
export function pinId(date, p) {
  return `${date}_${Number(p)}`;
}

export function parsePinId(id) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d+)$/.exec(id);
  return m ? { date: m[1], p: Number(m[2]) } : null;
}

function cmpPos_(a, b) {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.p - b.p;
}

// key의 핀을 위치 순으로 [{ id, date, p, step }]
export function pinsOf(data, key) {
  return Object.entries(data.pins?.[key] || {})
    .map(([id, v]) => ({ id, ...parsePinId(id), step: Number(v?.step) }))
    .filter(x => x.date && Number.isInteger(x.step) && x.step >= 1)
    .sort(cmpPos_);
}

// ------------------------------------------------------------
// 장부 — 학기 전체 key 수업을 한 번에 센다. 다른 계산은 모두 이것을 쓴다.
// rows: [{ date, p, kind, event, special, step(정규 수업만), pin(이 줄에서 적용된 핀), expected(핀이 없었다면 될 차시) }]
// ------------------------------------------------------------
export function buildLedger(data, key, { to } = {}) {
  const sem = data.semester;
  if (!sem || !isDateStr(sem.start) || !isDateStr(sem.end)) throw new Error('semester.start/end 가 필요합니다');
  const end = to && to < sem.end ? to : sem.end;
  const versions = sortedVersions_(data);
  const pins = pinsOf(data, key);
  const rows = [];
  let next = 1, pi = 0, pending = null;

  for (let d = sem.start; d <= end; d = addDays(d, 1)) {
    for (const slot of slotsOn(data, key, d, versions)) {
      while (pi < pins.length && cmpPos_(pins[pi], slot) <= 0) pending = pins[pi++];
      const row = { ...slot, step: null, pin: null, expected: null };
      if (slot.kind === 'regular') {
        if (pending) {
          row.expected = next;
          row.pin = pending;
          next = pending.step;
          pending = null;
        }
        row.step = next++;
      }
      rows.push(row);
    }
  }
  return rows;
}

// date p교시 수업의 차시 (정규 수업이 아니면 null)
export function stepAt(data, key, date, p, ledger = buildLedger(data, key)) {
  const r = ledger.find(x => x.date === date && x.p === Number(p));
  return r?.step ?? null;
}

// fromDate~toDate(둘 다 포함) 정규 수업 수
export function countRegular(data, key, fromDate, toDate, ledger = buildLedger(data, key)) {
  return ledger.filter(r => r.kind === 'regular' && r.date >= fromDate && r.date <= toDate).length;
}

// 아직 끝나지 않은 가장 가까운 정규 수업 (진행 중 포함). now = { date, min(자정부터 분) }
export function nextLesson(data, key, now, ledger = buildLedger(data, key)) {
  const periods = periodsOn(data, now.date);
  return ledger.find(r => r.kind === 'regular'
    && (r.date > now.date || (r.date === now.date && timeToMin(periods[r.p]?.end) > now.min))) || null;
}

// 지금 기준 "다음 수업" 차시. 학기에 남은 수업이 없으면 마지막 차시 + 1
export function nextStep(data, key, now, ledger = buildLedger(data, key)) {
  const n = nextLesson(data, key, now, ledger);
  if (n) return n.step;
  const last = [...ledger].reverse().find(r => r.kind === 'regular');
  return last ? last.step + 1 : 1;
}

// 시험까지(오늘 포함) 남은 정규 수업 수 — includeStart: 시험 첫날 수업도 세는지
export function remainingUntil(data, key, today, examStart, includeStart, ledger = buildLedger(data, key)) {
  const end = includeStart ? examStart : addDays(examStart, -1);
  return end < today ? 0 : countRegular(data, key, today, end, ledger);
}

// 시간표(모든 버전·하루 바꾸기)에 나오는 반_과목 목록
export function allKeys(data) {
  const keys = new Set();
  const add = day => Object.values(day || {}).forEach(c => { const k = cellKey(c); if (k) keys.add(k); });
  Object.values(data.timetables || {}).forEach(week => Object.values(week || {}).forEach(add));
  Object.values(data.dayOverrides || {}).forEach(add);
  return [...keys].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
}

// ------------------------------------------------------------
// 고치기 — DB에 쓸 내용(patch)만 만든다. 경로는 v2 데이터 뿌리 기준 'pins/반_과목/핀id' 형태.
// 실제 쓰기는 app 쪽에서 update() 한 번으로 한다.
// ------------------------------------------------------------

// "date p교시 수업 = step차시"
// 이미 그 차시로 계산되면 아무것도 안 쓴다. laterPins: 이 수업 뒤에 있는 핀 (그 뒤 차시는 그 핀을 따른다는 안내용)
export function planSetStep(data, key, date, p, step) {
  step = Number(step);
  if (!Number.isInteger(step) || step < 1) throw new Error('차시는 1 이상의 정수여야 합니다');
  const ledger = buildLedger(data, key);
  const row = ledger.find(r => r.date === date && r.p === Number(p));
  if (!row) throw new Error(`${date} ${p}교시에 ${key} 수업이 없습니다`);
  if (row.kind !== 'regular') throw new Error('학사일정·특별 수업 칸에는 차시를 정할 수 없습니다');
  const laterPins = pinsOf(data, key).filter(x => cmpPos_(x, row) > 0);
  const id = pinId(date, p);
  if (row.step === step) return { patch: {}, changed: false, laterPins };
  return { patch: { [`pins/${key}/${id}`]: { step } }, changed: true, from: row.step, to: step, laterPins };
}

export function planClearPin(key, id) {
  return { [`pins/${key}/${id}`]: null };
}

// label === null 이면 특별 수업 해제. 핀을 건드릴 필요가 없다.
export function planSetSpecial(data, key, date, p, label) {
  const slot = slotsOn(data, key, date).find(s => s.p === Number(p));
  if (!slot) throw new Error(`${date} ${p}교시에 ${key} 수업이 없습니다`);
  return { [`specials/${date}/${Number(p)}`]: label === null ? null : { key, label: String(label) } };
}

// 새 시간표를 effectiveFrom 부터 적용. 칸 이름은 정리해서 저장한다.
export function planSetTimetable(week, effectiveFrom) {
  if (!isDateStr(effectiveFrom)) throw new Error('적용 시작일이 필요합니다');
  const clean = {};
  for (const [day, cells] of Object.entries(week || {})) {
    if (!DOW_KEY.includes(day)) continue;
    clean[day] = {};
    for (const [p, cell] of Object.entries(cells || {})) {
      const c = normalizeName(cell?.class), s = normalizeName(cell?.subject);
      if (c && s) clean[day][p] = { class: c, subject: s };
      else if (c || s) throw new Error(`${DOW_KO_[day]} ${p}교시: 반과 과목을 둘 다 적어야 합니다 (예: 308 / 역사)`);
    }
  }
  return { [`timetables/${effectiveFrom}`]: clean };
}

// patch를 메모리 데이터에 반영한 새 객체 (원본은 그대로). 화면을 DB 응답 전에 먼저 바꿀 때·테스트에서 쓴다.
export function applyPatch(data, patch) {
  const out = structuredClone(data);
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('/');
    const last = parts.pop();
    let node = out;
    const trail = [];
    for (const k of parts) {
      if (node[k] == null || typeof node[k] !== 'object') {
        if (value === null) { node = null; break; }
        node[k] = {};
      }
      trail.push([node, k]);
      node = node[k];
    }
    if (!node) continue;
    if (value === null) {
      delete node[last];
      // 비어 버린 상위 객체 정리 (Firebase도 빈 객체는 남기지 않는다)
      for (let i = trail.length - 1; i >= 0; i--) {
        const [parent, k] = trail[i];
        if (Object.keys(parent[k]).length) break;
        delete parent[k];
      }
    } else {
      node[last] = structuredClone(value);
    }
  }
  return out;
}

// ------------------------------------------------------------
// 자체 점검 — 틀리면 조용히 넘어가지 말고 화면에 띄우기 위한 목록
// level: 'error' 진도가 틀릴 수 있음 | 'warn' 확인 필요
// ------------------------------------------------------------
export function checkHealth(data, { today } = {}) {
  const issues = [];
  const add = (level, code, msg) => issues.push({ level, code, msg });
  const sem = data.semester;

  if (!sem || !isDateStr(sem.start) || !isDateStr(sem.end)) {
    add('error', 'no-semester', '학기 기간(semester)이 없습니다');
    return issues;
  }
  const versions = sortedVersions_(data);
  if (!versions.length) add('error', 'no-timetable', '시간표가 없습니다');
  else if (versions[0] > sem.start) add('warn', 'timetable-late', `학기 첫날(${sem.start})부터 ${versions[0]} 전까지는 시간표가 없어 수업을 세지 않습니다`);
  // 새 학기를 미리 시작해 둔 경우(학기 시작 전)는 오늘 시간표가 없는 게 정상
  if (today && today >= sem.start && versions.length && !timetableVersionOn(data, today, versions)) add('error', 'no-timetable-today', '오늘에 해당하는 시간표 버전이 없습니다');

  // 반쪽짜리 칸 (반만 있거나 과목만 있음)
  const halfCells = (label, day) => Object.entries(day || {}).forEach(([p, c]) => {
    const has = [normalizeName(c?.class), normalizeName(c?.subject)].filter(Boolean).length;
    if (has === 1) add('error', 'half-cell', `${label} ${p}교시: 반이나 과목 하나가 비었습니다 (수업으로 세지 않음)`);
  });
  for (const v of versions) for (const [day, cells] of Object.entries(data.timetables[v] || {})) halfCells(`시간표(${v}~) ${day}`, cells);
  for (const [d, cells] of Object.entries(data.dayOverrides || {})) halfCells(`${d} 하루 바꾸기`, cells);

  // 띄어쓰기·대소문자만 다른 반 이름 (오타로 다른 반이 생긴 경우)
  const keys = allKeys(data);
  const squash = k => k.replace(/\s/g, '').toLowerCase();
  const seen = new Map();
  for (const k of keys) {
    const s = squash(k);
    if (seen.has(s)) add('warn', 'similar-keys', `"${seen.get(s)}" 와 "${k}" 가 같은 반인지 확인하세요 (진도가 따로 계산됩니다)`);
    else seen.set(s, k);
  }

  // 시간표에 없는 반의 핀 · 수업 없는 자리의 핀 · 차시가 되돌아가거나 겹치는 핀
  const keySet = new Set(keys);
  for (const k of Object.keys(data.pins || {})) {
    if (!keySet.has(k)) { add('warn', 'orphan-pin', `시간표에 없는 "${k}" 의 진도 기록이 남아 있습니다`); continue; }
    const ledger = buildLedger(data, k);
    for (const pin of pinsOf(data, k)) {
      if (pin.p === 0) continue;
      if (!ledger.some(r => r.date === pin.date && r.p === pin.p)) {
        add('warn', 'pin-no-lesson', `${k}: ${pin.date} ${pin.p}교시에 고정한 차시가 있는데 그 자리에 수업이 없습니다 (그 뒤 첫 수업에 적용됨)`);
      }
    }
    let prev = 0;
    for (const r of ledger) {
      if (r.kind !== 'regular') continue;
      if (r.pin && r.step <= prev) add('warn', 'step-backwards', `${k}: ${r.date} ${r.p}교시가 ${r.step}차시로 고정돼 앞 수업(${prev}차시)보다 같거나 작습니다`);
      prev = r.step;
    }
  }

  // 특별 수업 표시가 그 자리 수업과 안 맞음
  for (const [d, byP] of Object.entries(data.specials || {})) {
    for (const [p, sp] of Object.entries(byP || {})) {
      if (!sp) continue; // DB가 배열로 돌려줄 때 생기는 빈 칸
      const k = normalizeName(sp.key);
      if (!slotsOn(data, k, d, versions).some(s => s.p === Number(p))) {
        add('warn', 'orphan-special', `${d} ${p}교시 특별 수업(${sp?.label || ''}) 표시가 그 자리 수업(${k})과 맞지 않아 무시됩니다`);
      }
    }
  }
  return issues;
}

// ------------------------------------------------------------
// v1 → v2 옮기기 (계산만. 실제 DB 쓰기는 효니 확인 뒤 별도로)
// v1 기준점 { current, lastUpdated } 의 뜻: "lastUpdated 날이 끝났을 때 current차시까지 마침"
//   → v2 핀 "lastUpdated 다음 날 첫 수업 전(교시 0) = current+1차시" 와 앞으로의 계산이 똑같다.
// v1은 시간표가 한 벌뿐이라 학기 중 시간표가 바뀐 적이 있으면 그 이전 날짜의 장부 줄은 정확히 복원할 수 없다.
// (앞으로의 차시는 핀이 고정하므로 영향 없음 — report에 적는다)
// ------------------------------------------------------------
export function migrateFromV1(v1, { semesterId, semester, calendar = {}, today }) {
  const report = [];
  const note = (level, msg) => report.push({ level, msg });
  const normCells = cells => {
    const out = {};
    for (const [p, c] of Object.entries(cells || {})) {
      const cls = normalizeName(c?.class), sub = normalizeName(c?.subject);
      if (cls && sub) out[p] = { class: cls, subject: sub };
    }
    return out;
  };
  // 같은 반으로 정리되는 옛 키 여러 개를 합칠 때 충돌을 알린다
  const remapKeys = (obj, label, pick) => {
    const out = {}, from = {};
    for (const [raw, v] of Object.entries(obj || {})) {
      const i = raw.lastIndexOf('_');
      const k = i > 0 ? lessonKey(raw.slice(0, i), raw.slice(i + 1)) : normalizeName(raw);
      if (k !== raw) note('info', `${label}: "${raw}" → "${k}" 로 이름 정리`);
      if (k in out) {
        note('warn', `${label}: "${from[k]}" 와 "${raw}" 가 같은 "${k}" 로 합쳐집니다 — 확인 필요`);
        out[k] = pick ? pick(out[k], v) : { ...out[k], ...v };
      } else out[k] = v;
      from[k] = raw;
    }
    return out;
  };

  const week = {};
  for (const [day, cells] of Object.entries(v1.timetable?.schedule || {})) week[day] = normCells(cells);
  const dayOverrides = {};
  for (const [d, cells] of Object.entries(v1.dayOverrides || {})) dayOverrides[d] = normCells(cells);
  const specials = {};
  for (const [d, byP] of Object.entries(v1.specialLessons || {})) {
    for (const [p, sp] of Object.entries(byP || {})) {
      const i = String(sp?.key || '').lastIndexOf('_');
      const k = i > 0 ? lessonKey(sp.key.slice(0, i), sp.key.slice(i + 1)) : normalizeName(sp?.key);
      (specials[d] ||= {})[p] = { key: k, label: sp?.label || '' };
    }
  }

  const progress = remapKeys(v1.progress?.[semesterId], '진도', (a, b) =>
    (b?.lastUpdated || '') > (a?.lastUpdated || '') ? b : a);
  const pins = {};
  for (const [k, entry] of Object.entries(progress)) {
    const current = Number(entry?.current ?? 0);
    let lu = entry?.lastUpdated;
    if (!isDateStr(lu)) {
      // v1은 lastUpdated가 없으면 "어제"로 보고 계산해서 차시가 영원히 그대로였다 — 지금 보이는 값을 오늘 기준으로 고정
      if (!isDateStr(today)) throw new Error('lastUpdated 없는 기록이 있어 today 가 필요합니다');
      lu = addDays(today, -1);
      note('error', `진도 "${k}": lastUpdated 가 없어 v1에서 차시가 넘어가지 않던 기록입니다. 오늘 기준 ${current + 1}차시로 옮겼으니 실제 진도를 확인하세요`);
    }
    pins[k] = { [pinId(addDays(lu, 1), 0)]: { step: current + 1, from: 'v1' } };
  }

  const data = {
    engineVersion: ENGINE_VERSION,
    semester: { id: semesterId, ...semester },
    periods: v1.timetable?.periods || {},
    timetables: { [semester.start]: week },
    dayOverrides,
    specials,
    pins,
    curriculum: remapKeys(v1.curriculum, '주제'),
    lessonNotes: remapKeys(v1.lessonNotes, '메모'),
    classNotes: v1.classNotes || {},
  };

  // 장부 앞부분(기준점 이전)도 v1 화면과 같게: v1은 기준점에서 거꾸로 세어 학기 첫 수업 차시를 정했다.
  //  - 그 값이 1보다 크면 학기 첫날에 핀을 하나 더 둔다.
  //  - 1보다 작으면 시간표상 수업이 차시보다 많다는 뜻(오리엔테이션·빠진 학사일정 등). v1 장부에서 0차시 이하로
  //    보이던 학기 초 수업을 특별 수업 '진도 외(옮기기)'로 표시해, 장부가 v1과 같고 차시가 되돌아가지 않게 한다.
  //    어떤 수업인지 report에 하나하나 적는다 (효니 확인용).
  for (const [k, byId] of Object.entries(pins)) {
    const [id, { step }] = Object.entries(byId)[0];
    const lu = addDays(parsePinId(id).date, -1);
    if (lu < semester.start) continue;
    const withCal = { ...data, calendar };
    const regular = buildLedger({ ...withCal, pins: {} }, k, { to: lu }).filter(r => r.kind === 'regular');
    const startStep = step - regular.length;
    if (startStep > 1) byId[pinId(semester.start, 0)] = { step: startStep, from: 'v1' };
    else if (startStep < 1) {
      const extra = regular.slice(0, 1 - startStep);
      for (const r of extra) (data.specials[r.date] ||= {})[r.p] = { key: k, label: '진도 외(옮기기)' };
      note('warn', `진도 "${k}": ${semester.start}~${lu} 시간표상 수업이 ${regular.length}번인데 기록은 ${step - 1}차시까지라, `
        + `학기 초 ${extra.map(r => `${r.date} ${r.p}교시`).join(', ')} 수업을 '진도 외'로 표시했습니다 (지금 앱 장부에서 0차시 이하로 보이던 수업). 실제로 진도를 안 나간 수업인지 확인하세요`);
    }
  }

  note('info', `시간표는 한 벌(${semester.start}부터 적용)로 옮겼습니다. 학기 중 시간표를 바꾼 적이 있다면 그 이전 장부 줄은 지금 시간표로 보입니다 (앞으로의 차시에는 영향 없음)`);
  return { data, report };
}

// ------------------------------------------------------------
// 새 학기 시작 — 지난 학기 기록은 archive/{지난학기id} 에 그대로 보관하고, 계산에 쓰는 자리는 비운다.
//   - semester 교체, 시간표는 새 학기 첫날(start)부터 쓰는 한 벌(week)로 새로 시작
//   - pins·specials·dayOverrides 는 보관만 하고 비운다 → 새 학기 차시는 1부터
//   - curriculum·lessonNotes·classNotes 도 보관하고 비운다 (2026-10-19 효니 결정)
//   - periods·log·devices 는 그대로 (학기와 상관없음). 학사일정은 학교 공용(school/calendar)이라 건드리지 않는다.
// at: 보관 시각 문자열 (순수 함수라 호출하는 쪽이 넣는다)
// ------------------------------------------------------------
export const SEMESTER_SCOPED = ['timetables', 'dayOverrides', 'specials', 'pins', 'curriculum', 'lessonNotes', 'classNotes'];
const DB_KEY_RE = /^[^.#$\[\]\/\s]+$/;

export function planStartSemester(data, { id, start, end } = {}, week = {}, { at = '' } = {}) {
  id = normalizeName(id);
  if (!id || !DB_KEY_RE.test(id)) throw new Error('학기 이름이 필요합니다 (예: 2027-1, 띄어쓰기·. # $ [ ] / 없이)');
  if (!isDateStr(start) || !isDateStr(end)) throw new Error('학기 시작일과 끝날이 필요합니다');
  if (start >= end) throw new Error('학기 끝날은 시작일보다 뒤여야 합니다');
  const old = data.semester;
  if (old && isDateStr(old.start)) {
    if (normalizeName(old.id) === id) throw new Error(`지금 학기와 이름(${id})이 같습니다`);
    if (start <= old.start) throw new Error(`새 학기 시작일은 지금 학기 시작일(${old.start})보다 뒤여야 합니다`);
  }
  if (data.archive?.[id]) throw new Error(`보관함에 이미 ${id} 학기가 있습니다`);

  const patch = {};
  if (old && isDateStr(old.start)) {
    const oldId = normalizeName(old.id) || old.start;
    if (data.archive?.[oldId]) throw new Error(`보관함에 이미 ${oldId} 학기가 있어 덮어쓸 수 없습니다`);
    const box = { semester: structuredClone(old), archivedAt: at };
    for (const k of SEMESTER_SCOPED) if (data[k] != null) box[k] = structuredClone(data[k]);
    patch[`archive/${oldId}`] = box;
  }
  for (const k of SEMESTER_SCOPED) patch[k] = null;
  patch.semester = { id, start, end };
  // 새 시간표 한 벌 (칸 정리·검사는 시간표 저장과 같게). 타임테이블 뿌리를 통째로 바꾼다.
  const tt = planSetTimetable(week, start)[`timetables/${start}`];
  patch.timetables = { [start]: tt };
  return patch;
}
