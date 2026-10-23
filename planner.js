// 할 일 탭 — 관리자 전용. app.js 가 로그인 뒤에 따로 불러온다(import() ) → 이 파일에 문제가 생겨도 시간표는 그대로 뜬다.
// 저장은 users/{uid}/planner/ 아래만 (진도 데이터 v2 와 분리). 계산은 모두 engine/task-engine.js 가 한다.
// 데이터가 바뀌는 길은 commit() 하나뿐이고, 그 안에서 assertPlannerPatch 로 planner 밖 경로 쓰기를 막는다.
import { db, ref, update, onValue } from './firebase.js';
import { applyPatch, addDays, DOW_KEY } from './engine/progress-engine.js';
import * as T from './engine/task-engine.js';
import { createCalendar, reasonText } from './planner-cal.js';
// 움직이는 아이콘(Lucian Icons, MIT) — 프로젝트 안에 복사해 쓴다 (외부 로드 없음)
import './icons/lucian/calendar.js';
import './icons/lucian/list.js';
import './icons/lucian/flag.js';
import './icons/lucian/clock.js';
import './icons/lucian/plus.js';

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
const LOG_MAX = 80;
const UNDO_MS = 6000;
const SECTIONS = [
  ['overdue', '⚠ 마감 지남', '오늘 결정해야 하는 일'],
  ['today', '오늘', ''],
  ['week', '이번 주', '앞으로 7일 안'],
  ['later', '나중', ''],
  ['undated', '날짜 없음', '⋮⋮ 를 끌어서 우선순위를 정하세요'],
  ['watch', '지켜보기', '기한 없이 두고 보는 것 · ⋮⋮ 로 순서 변경'],
];

// 긴 묶음은 처음에 이만큼만 보여 주고 "더 보기"로 펼친다 (없는 묶음은 전부 보인다)
const SEC_LIMIT = { later: 5 };
// 효니가 끌어서 순서를 정하는 묶음 (나머지는 마감순이라 끌 수 없다)
const DRAGGABLE = ['undated', 'watch'];

// ------------------------------------------------------------
// 날짜·문자열 도구
// ------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
function todayStr() { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; }
function nowStamp() { const n = new Date(); return `${todayStr()} ${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`; }
function parts(s) { return s.split('-').map(Number); }
function dowOf(s) { const [y, m, d] = parts(s); return new Date(y, m - 1, d).getDay(); }
function fmtMD(s) { const [, m, d] = parts(s); return `${m}/${d}(${DOW_KO[dowOf(s)]})`; }
function daysBetween(a, b) { const u = s => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d); }; return Math.round((u(b) - u(a)) / 86400000); }
function nextWorkday(s) { let d = addDays(s, 1); while ([0, 6].includes(dowOf(d))) d = addDays(d, 1); return d; }
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function dueLabel(t, today) {
  const d = t.slot?.date || t.due;
  if (!d) return '';
  const n = daysBetween(today, d);
  let s;
  if (n === 0) s = '오늘';
  else if (n === 1) s = '내일';
  else if (n === -1) s = '어제';
  else if (n < 0) s = `${-n}일 지남`;
  else if (n <= 14) s = `D-${n} ${fmtMD(d)}`;
  else s = fmtMD(d);
  if (t.slot) s += ` ${t.slot.start} (${t.slot.min}분)`;
  else if (t.dueText) s = `${t.dueText} (${s})`;   // 애매한 기간으로 정한 마감: "한 달 내 (D-31 11/23(월))"
  return s;
}

function store_(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* 저장소가 막힌 환경 */ } return null; }

// 화면 확인용 — 데모에서만 쓰는 예시 (오늘 날짜 기준)
function demoSeed(today) {
  const d = n => addDays(today, n);
  const mk = (title, area, f = {}) => ({ title, area, kind: 'once', status: 'open', createdAt: `${d(-20)} 09:00:00`, updatedAt: `${d(-20)} 09:00:00`, ...f });
  return {
    tasks: {
      d1: mk('고사원안 검토', '수업', { due: d(5) }),
      d2: mk('학생회 안건 정리', '학생회', { today }),
      d3: mk('ESG 경영 녹화 강의 듣기', '대학원', { due: today }),
      d4: mk('도서관 서평 쓰기 대회 제출', '독서', { due: d(9), link: 'https://example.com' }),
      d5: mk('임승휘 논문 읽기', '대학원', { due: d(-3) }),
      d6: mk('2학년 수행 결시자 응시 기회', '수업', { due: d(-1) }),
      d7: mk('학생회 포스터 정리', '학생회'),
      d8: mk('투자 종목 점검', '투자', { kind: 'watch' }),
      d9: mk('자치 활동 기재록', '학생회', { due: d(30) }),
      d10: mk('법정의무연수 수강', '연수', { status: 'done', doneAt: `${today} 08:00:00`, due: d(-2) }),
    },
    rules: {},
    settings: {},
  };
}

// ------------------------------------------------------------
// 만들기 — app.js 가 부른다
//   uid, demo, getSchoolData()(시간표 데이터: 수업과 겹침 검사용), toast(msg, isErr)
// ------------------------------------------------------------
export function createPlanner({ uid, demo = false, getSchoolData = () => null, toast = () => {} }) {
  let store = demo ? demoSeed(todayStr()) : { tasks: {}, rules: {}, settings: {} };
  let loaded = demo;
  let loadError = '';
  let unsub = null;
  let filterArea = store_('plannerArea') || '';
  let addArea = store_('plannerAddArea') || '수업';
  let undo = null;               // { id, timer }
  let reviewDismissed = false;   // 이번 화면(새로고침 전)에서 "나중에"를 누름
  let materializedOn = '';
  let prepOn = '';
  let showClosed = false;
  const expanded = new Set();    // "더 보기"를 누른 묶음

  let view = store_('plannerView') === 'cal' ? 'cal' : 'list';   // 좁은 화면에서 목록/달력 중 보이는 쪽 (넓으면 둘 다 보인다)
  let cal = null;

  const subs = new Set();        // 미니창처럼 바깥에서 데이터가 바뀌면 알려 달라는 곳
  const notify = () => subs.forEach(f => { try { f(); } catch (_) { /* 구독자 오류가 저장을 막지 않게 */ } });

  const root = () => document.getElementById('tab-tasks');
  const settings = () => T.resolveSettings(store.settings);
  const tasks = () => T.listTasks(store);
  const byId = id => tasks().find(t => t.id === id);

  // ---------- 저장: 이 함수 하나만 DB에 쓴다 ----------
  async function commit(patch, action) {
    const full = { ...patch };
    if (!Object.keys(full).length) return false;
    full[`log/${Date.now()}_${Math.random().toString(36).slice(2, 5)}`] = { t: nowStamp(), a: action };
    const logIds = Object.keys(store.log || {});
    if (logIds.length > LOG_MAX) {
      logIds.sort((a, b) => (store.log[a].t || '').localeCompare(store.log[b].t || ''))
        .slice(0, logIds.length - LOG_MAX).forEach(id => { full[`log/${id}`] = null; });
    }
    T.assertPlannerPatch(full);
    if (demo) { store = applyPatch(store, full); renderAll(); notify(); return true; }
    const abs = {};
    for (const [k, v] of Object.entries(full)) abs[`users/${uid}/planner/${k}`] = v;
    await update(ref(db), abs);      // 내 기기에는 바로 반영되고(onValue), 다른 기기로도 퍼진다
    return true;
  }

  async function run(fn, action, okMsg) {
    try {
      const patch = fn();
      if (await commit(patch, action) && okMsg) toast(okMsg);
    } catch (e) {
      console.error(e);
      toast(`저장하지 못했어요: ${e.message}`, true);
      cal?.render();      // 끌다 만 블록을 원래 자리로
    }
  }

  // ---------- 틀(한 번만 만든다 — 입력 중인 글이 다시 그리다 사라지지 않게 목록만 갈아 끼운다) ----------
  function ensureShell() {
    const el = root();
    if (!el || el.querySelector('.pl-shell')) return;
    el.innerHTML = `
      <div class="pl-shell" data-view="${view}">
        <div class="pl-view-switch" role="group" aria-label="보기">
          <button type="button" data-act="view" data-v="list" class="${view === 'list' ? 'on' : ''}"><lucian-list size="20"></lucian-list> 목록</button>
          <button type="button" data-act="view" data-v="cal" class="${view === 'cal' ? 'on' : ''}"><lucian-calendar size="20"></lucian-calendar> 시간표</button>
        </div>
        <div class="pl-layout">
          <div class="pl-left">
            <div class="pl-head">
              <div><div class="pl-title-main">할 일</div><div class="pl-date" id="pl-date"></div></div>
              <div class="pl-head-r">
                <div class="pl-counter" id="pl-counter"></div>
                <button type="button" class="btn-secondary pl-rules-btn" data-act="rules" title="매주·격주·매월 반복되는 할 일">🔁 반복</button>
              </div>
            </div>
            <form class="pl-add" id="pl-add" autocomplete="off">
              <input class="pl-add-input" id="pl-add-input" type="text" maxlength="200"
                     placeholder="예) 내일 15시 회의 1시간 · 논문 읽기 10/30까지 · 서평 한 달 내" />
              <select class="pl-add-area" id="pl-add-area" aria-label="영역">
                ${T.AREAS.map(a => `<option value="${a}"${a === addArea ? ' selected' : ''}>${a}</option>`).join('')}
              </select>
              <button class="btn-primary pl-add-btn" type="submit"><lucian-plus size="18" tone="line"></lucian-plus> 추가</button>
            </form>
            <div class="pl-hint" id="pl-hint"></div>
            <div class="pl-filter" id="pl-filter"></div>
            <div class="pl-lists" id="pl-lists"></div>
          </div>
          <aside class="pl-cal" id="pl-cal" aria-label="시간표 달력"></aside>
        </div>
      </div>`;
    cal = createCalendar({
      root: el.querySelector('#pl-cal'),
      getTasks: tasks,
      getData: getSchoolData,
      getSettings: () => store.settings,
      today: todayStr,
      onSetSlot: setSlot,
      onOpen: openEdit,
      onEmpty: (date, start) => openPlaceModal({ date, start }),
      toast,
    });
    el.querySelector('#pl-add').addEventListener('submit', e => { e.preventDefault(); addFromInput(); });
    el.querySelector('#pl-add-input').addEventListener('input', updateHint);
    el.querySelector('#pl-add-area').addEventListener('change', e => { addArea = e.target.value; store_('plannerAddArea', addArea); });
    el.addEventListener('click', onClick);
    el.addEventListener('pointerdown', e => {
      const g = e.target.closest('.pl-grip');
      if (g) { startDrag(e, g.closest('li')); return; }
      const pb = e.target.closest('.pl-place');
      if (pb) {
        const t = byId(pb.closest('[data-id]')?.dataset.id);
        if (t) cal.startPlaceDrag(e, t, t.slot?.min || 60, () => openPlaceModal({ task: t }), pb);
      }
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.pl-main[data-act]')) e.target.click(); });
  }

  function updateHint() {
    const input = root()?.querySelector('#pl-add-input');
    const hint = root()?.querySelector('#pl-hint');
    if (!input || !hint) return;
    const p = T.parseQuickInput(input.value, todayStr());
    if (!input.value.trim()) { hint.textContent = ''; return; }
    const bits = [];
    if (p.slot) bits.push(`${fmtMD(p.slot.date)} ${p.slot.start}부터 ${p.slot.min}분`);
    else if (p.dueText) bits.push(`${p.dueText} → ${fmtMD(p.due)}까지`);
    else if (p.due) bits.push(`마감 ${fmtMD(p.due)}`);
    else bits.push('날짜 없음');
    hint.textContent = `→ ${p.title || '(제목을 적어 주세요)'} · ${bits.join(' · ')}`;
  }

  // ---------- 추가 ----------
  function addFromInput() {
    const input = root()?.querySelector('#pl-add-input');
    if (!input) return;
    const today = todayStr();
    const p = T.parseQuickInput(input.value, today);
    if (!p.title) { toast('할 일 제목을 적어 주세요', true); return; }
    let slot = p.slot, note = '';
    if (slot) {
      const c = T.slotConflict(getSchoolData() || {}, tasks(), slot.date, slot.start, slot.min, { settings: store.settings });
      if (!c.ok) {
        note = c.reason === 'class' ? `수업(${c.with.label})과 겹쳐서`
          : c.reason === 'task' ? `다른 할 일(${c.with.title})과 겹쳐서`
            : '하루 칸(범위) 밖이라서';
        slot = null;
      } else if (slot.date === today && !T.checkTodayAdd(tasks(), { id: '' }, today, store.settings).ok) {
        note = `오늘 할 일이 ${settings().todayCap}개라서`;
        slot = null;
      }
    }
    const id = T.newTaskId();
    const area = root().querySelector('#pl-add-area').value;
    run(() => T.planAddTask({ title: p.title, area, due: p.due, dueText: p.dueText, slot }, { id, now: nowStamp() }), 'add',
      note ? `${note} 칸은 비우고 저장했어요` : '추가했어요');
    input.value = '';
    updateHint();
  }

  // ---------- 그리기 ----------
  function rowHtml(t, today, section) {
    const label = dueLabel(t, today);
    const pinned = t.today === today || t.slot?.date === today;
    const over = section === 'overdue';
    const note = (t.note || '').replace(/\s+/g, ' ').trim();
    return `
      <li class="pl-row pl-r-${esc(t.area)}${over ? ' pl-over' : ''}${t.status === 'done' ? ' pl-done' : ''}" data-id="${esc(t.id)}">
        ${t.status === 'open' && DRAGGABLE.includes(section)
        ? `<span class="pl-grip" title="끌어서 순서 바꾸기" aria-label="끌어서 순서 바꾸기">⋮⋮</span>` : ''}
        ${t.status === 'open'
        ? `<button class="pl-check" data-act="done" aria-label="완료로 표시" title="완료"></button>`
        : `<span class="pl-check pl-check-off" aria-hidden="true">${t.status === 'done' ? '✓' : '▣'}</span>`}
        <div class="pl-main" data-act="edit" role="button" tabindex="0">
          <span class="pl-title">${esc(t.title)}</span>
          ${note ? `<span class="pl-note">${esc(note)}</span>` : ''}
          <span class="pl-meta">
            <span class="pl-area pl-a-${esc(t.area)}">${esc(t.area)}</span>
            ${label ? `<span class="pl-due${over ? ' pl-due-over' : ''}${label === '오늘' ? ' pl-due-today' : ''}${t.dueText && !t.slot ? ' pl-due-fuzzy' : ''}">${t.dueText && !t.slot ? '<lucian-clock size="14" tone="line"></lucian-clock> ' : ''}${esc(label)}</span>` : ''}
            ${t.ruleId ? '<span class="pl-tag">반복</span>' : ''}
            ${t.link ? `<a class="pl-link" href="${esc(t.link)}" target="_blank" rel="noopener" title="원본 열기">원본 ↗</a>` : ''}
          </span>
        </div>
        ${t.status === 'open' && t.kind !== 'watch'
        ? `<button class="pl-place${t.slot ? ' on' : ''}" data-act="place" aria-label="시간 칸에 놓기" title="누르면 시간 칸을 고르고, 끌어서 시간표에 놓을 수도 있어요"><lucian-calendar size="20"></lucian-calendar></button>` : ''}
        ${t.status === 'open' && t.kind !== 'watch'
        ? `<button class="pl-pin${pinned ? ' on' : ''}" data-act="pin" aria-label="오늘 할 일로" title="${pinned ? '오늘 할 일에서 빼기' : '오늘 할 일로'}">${pinned ? '★' : '☆'}</button>`
        : ''}
        ${t.status !== 'open' ? `<button class="pl-restore btn-secondary" data-act="${t.status === 'done' ? 'undo' : 'restore'}">${t.status === 'done' ? '되돌리기' : '복원'}</button>` : ''}
      </li>`;
  }

  function renderLists() {
    const lists = root()?.querySelector('#pl-lists');
    if (!lists) return;
    if (loadError) { lists.innerHTML = `<div class="pl-empty pl-error">할 일을 불러오지 못했어요: ${esc(loadError)}</div>`; return; }
    if (!loaded) { lists.innerHTML = `<div class="pl-empty">불러오는 중…</div>`; return; }

    const today = todayStr();
    const all = tasks();
    const visible = filterArea ? all.filter(t => t.area === filterArea) : all;
    const c = T.classify(visible, today);
    const cap = settings().todayCap;
    const chosen = T.chosenFor(all, today).length;

    root().querySelector('#pl-date').textContent = `${fmtMD(today).replace('(', ' · ').replace(')', '요일')}`;
    root().querySelector('#pl-counter').innerHTML =
      `<span class="pl-count${chosen >= cap ? ' full' : ''}">오늘 ${chosen}/${cap}</span>`
      + (c.overdue.length ? ` <span class="pl-count over"><lucian-flag size="14" tone="line"></lucian-flag> 마감 지남 ${T.classify(all, today).overdue.length}</span>` : '');

    // 영역 필터 (건수는 필터와 상관없이 열린 할 일 기준)
    const open = all.filter(t => t.status === 'open');
    root().querySelector('#pl-filter').innerHTML =
      [['', '전체', open.length], ...T.AREAS.map(a => [a, a, open.filter(t => t.area === a).length])]
        .filter(([a, , n]) => a === '' || n > 0 || a === filterArea)
        .map(([a, name, n]) => `<button class="pl-chip${filterArea === a ? ' on' : ''}" data-act="filter" data-area="${esc(a)}">${esc(name)} <b>${n}</b></button>`)
        .join('');

    let html = '';
    for (const [key, name, sub0] of SECTIONS) {
      const items = c[key];
      if (!items.length && key !== 'today') continue;
      // 오늘 묶음에는 마감이 오늘이라 저절로 들어온 일도 있어서, 위 "오늘 N/5"(내가 고른 것)와 건수가 다를 수 있다
      const forced = key === 'today' ? items.filter(t => t.today !== today && t.slot?.date !== today).length : 0;
      const sub = forced ? `마감이 오늘인 ${forced}건 포함` : sub0;
      html += `<section class="pl-sec pl-sec-${key}">
        <h3 class="pl-sec-title">${name} <span class="pl-sec-n">${items.length}</span>${sub ? `<small>${sub}</small>` : ''}</h3>
        ${items.length
          ? `<ul class="pl-ul">${(expanded.has(key) ? items : items.slice(0, SEC_LIMIT[key] ?? items.length)).map(t => rowHtml(t, today, key)).join('')}</ul>`
          + (!expanded.has(key) && items.length > (SEC_LIMIT[key] ?? Infinity)
            ? `<button class="pl-more" data-act="more" data-sec="${key}">${items.length - SEC_LIMIT[key]}개 더 보기</button>` : '')
          : `<div class="pl-empty-sec">☆를 눌러 오늘 할 일을 골라 보세요 (최대 ${cap}개)</div>`}
      </section>`;
    }
    const closed = [...c.done.slice(0, 10), ...c.archived.slice(0, 5)];
    if (closed.length) {
      html += `<section class="pl-sec pl-sec-closed">
        <button class="pl-closed-toggle" data-act="toggle-closed">${showClosed ? '▾' : '▸'} 끝낸 일·보관 <span class="pl-sec-n">${c.done.length + c.archived.length}</span></button>
        ${showClosed ? `<ul class="pl-ul">${closed.map(t => rowHtml(t, today, 'closed')).join('')}</ul>` : ''}
      </section>`;
    }
    if (!visible.length) html = `<div class="pl-empty pl-empty-art"><img src="images/planner_empty.webp" alt="" width="140" height="140"><div>${all.length ? '이 영역에는 할 일이 없어요' : '할 일이 없어요. 위에서 추가해 보세요'}</div></div>`;
    lists.innerHTML = html;
  }

  function renderAll() {
    ensureShell();
    renderLists();
    if (loaded && !loadError) cal.render();
    syncReview();
  }

  // ---------- 클릭 한 곳에서 처리 ----------
  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || e.target.closest('a.pl-link')) return;
    const act = btn.dataset.act;
    const row = btn.closest('[data-id]');
    const t = row ? byId(row.dataset.id) : null;
    const now = nowStamp();
    const today = todayStr();

    if (act === 'view') {
      view = btn.dataset.v === 'cal' ? 'cal' : 'list';
      store_('plannerView', view);
      root().querySelector('.pl-shell').dataset.view = view;
      root().querySelectorAll('[data-act=view]').forEach(b => b.classList.toggle('on', b.dataset.v === view));
      if (view === 'cal') cal.setDate(cal.date);   // 숨겨져 있던 달력은 보일 때 다시 그려 맞는 시각으로 스크롤
    } else if (act === 'place') { if (e.detail === 0 && t) openPlaceModal({ task: t }); }   // 마우스·터치는 pointerdown 쪽에서 처리, 키보드만 여기
    else if (act === 'filter') { filterArea = btn.dataset.area || ''; store_('plannerArea', filterArea); renderLists(); }
    else if (act === 'toggle-closed') { showClosed = !showClosed; renderLists(); }
    else if (act === 'more') { expanded.add(btn.dataset.sec); renderLists(); }
    else if (act === 'rules') openRules();
    else if (!t) return;
    else if (act === 'done') {
      run(() => T.planComplete(t, { now }), 'done');
      showUndo(t);
    } else if (act === 'undo') run(() => T.planUndoComplete(t, { now }), 'undo', '되돌렸어요');
    else if (act === 'restore') run(() => T.planRestore(t, { now }), 'restore', '복원했어요');
    else if (act === 'edit') openEdit(t);
    else if (act === 'pin') togglePin(t, today, now);
  }

  // 날짜 없음·지켜보기: ⋮⋮ 를 잡아 끌어서 순서를 정한다 (마우스·손가락 모두). 놓으면 묶음 전체의 새 순서를 저장한다.
  function startDrag(e, li) {
    const ul = li?.parentElement;
    if (!ul || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    // 줄을 옮기면 손잡이가 DOM 에서 떨어져 캡처가 풀리므로, 안 움직이는 목록(ul)이 포인터를 붙든다
    const grip = ul;
    try { grip.setPointerCapture(e.pointerId); } catch (_) { /* 캡처가 안 돼도 창 이벤트로 이어진다 */ }
    li.classList.add('pl-dragging');
    const move = ev => {
      const y = ev.clientY;
      if (y < 70) window.scrollBy(0, -14); else if (y > window.innerHeight - 70) window.scrollBy(0, 14);
      const others = [...ul.children].filter(x => x !== li);
      const next = others.find(x => { const r = x.getBoundingClientRect(); return y < r.top + r.height / 2; });
      if (next) { if (li.nextElementSibling !== next) ul.insertBefore(li, next); } else if (ul.lastElementChild !== li) ul.appendChild(li);
    };
    const end = ev => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      li.classList.remove('pl-dragging');
      if (ev.type === 'pointercancel') { renderLists(); return; }
      const ordered = [...ul.children].map(x => byId(x.dataset.id)).filter(Boolean);
      run(() => T.planReorder(ordered, { now: nowStamp() }), 'reorder');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // 오늘 할 일에서 뺀다 — 칸에 놓았으면 칸도 비운다. (칸 비우기가 today 를 그대로 두므로 today 지우기를 나중에 합친다)
  function unpinPatch(t, today, now) {
    return {
      ...(t.slot?.date === today ? T.planSetSlot(t, null, { now }) : {}),
      ...(t.today === today ? T.planSetToday(t, null, { now }) : {}),
    };
  }

  function togglePin(t, today, now) {
    const pinned = t.today === today || t.slot?.date === today;
    if (pinned) { run(() => unpinPatch(t, today, now), 'unpin'); return; }
    const chk = T.checkTodayAdd(tasks(), t, today, store.settings);
    if (chk.ok) run(() => T.planSetToday(t, today, { now }), 'pin');
    else openCapModal(t, chk);
  }

  // ---------- 되돌리기 줄 ----------
  function showUndo(t) {
    hideUndo();
    const bar = document.createElement('div');
    bar.className = 'pl-undo';
    bar.id = 'pl-undo';
    bar.innerHTML = `<span>“${esc(t.title.length > 24 ? t.title.slice(0, 24) + '…' : t.title)}” 완료</span><button type="button">되돌리기</button>`;
    bar.querySelector('button').addEventListener('click', () => {
      run(() => T.planUndoComplete({ ...t, status: 'done' }, { now: nowStamp() }), 'undo');
      hideUndo();
    });
    document.body.appendChild(bar);
    undo = { timer: setTimeout(hideUndo, UNDO_MS) };
  }
  function hideUndo() {
    if (undo) { clearTimeout(undo.timer); undo = null; }
    document.getElementById('pl-undo')?.remove();
  }

  // ---------- 모달 ----------
  function openModal(id, html, { small = true } = {}) {
    document.getElementById(id)?.remove();
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.id = id;
    ov.innerHTML = `<div class="modal${small ? ' modal-sm' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    ov.addEventListener('mousedown', e => { if (e.target === ov) ov.dataset.down = '1'; else delete ov.dataset.down; });
    ov.addEventListener('click', e => { if (e.target === ov && ov.dataset.down) closeModal(id); });
    ov.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(id); });
    document.body.appendChild(ov);
    return ov;
  }
  function closeModal(id) { document.getElementById(id)?.remove(); }
  const onKey = e => { if (e.key === 'Escape') ['pl-modal-edit', 'pl-modal-cap', 'pl-modal-place', 'pl-modal-rules'].forEach(closeModal); };
  document.addEventListener('keydown', onKey);

  function openCapModal(t, chk) {
    const ov = openModal('pl-modal-cap', `
      <div class="modal-header"><h2>오늘 할 일이 ${chk.cap}개예요</h2><button class="modal-close" data-close aria-label="닫기">✕</button></div>
      <div class="modal-body">
        <p class="modal-hint">“${esc(t.title)}”를 오늘 하려면 아래에서 하나를 빼 주세요. 뺀 일은 사라지지 않고 원래 마감일 목록으로 돌아가요.</p>
        <ul class="pl-ul">
          ${chk.chosen.map(c => `<li class="pl-row" data-id="${esc(c.id)}"><div class="pl-main"><span class="pl-title">${esc(c.title)}</span><span class="pl-meta"><span class="pl-area pl-a-${esc(c.area)}">${esc(c.area)}</span></span></div><button class="btn-secondary" data-swap="${esc(c.id)}">이걸 빼고 넣기</button></li>`).join('')}
        </ul>
      </div>`);
    ov.addEventListener('click', e => {
      const b = e.target.closest('[data-swap]');
      if (!b) return;
      const out = byId(b.dataset.swap);
      const now = nowStamp(), today = todayStr();
      closeModal('pl-modal-cap');
      run(() => ({ ...unpinPatch(out, today, now), ...T.planSetToday(t, today, { now }) }), 'swap');
    });
  }

  // ---------- 반복 규칙 ----------
  const DOW_LABEL = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' };
  const NTH_LABEL = { 1: '첫째', 2: '둘째', 3: '셋째', 4: '넷째', 5: '마지막' };
  function ruleText(r) {
    if (r.every === 'weekly') return r.interval > 1 ? `${r.interval}주마다 ${DOW_LABEL[r.dow]}요일 (${fmtMD(r.start)}부터)` : `매주 ${DOW_LABEL[r.dow]}요일`;
    return r.day != null ? `매월 ${r.day}일` : `매월 ${NTH_LABEL[r.nth]} ${DOW_LABEL[r.dow]}요일`;
  }

  // editId 가 있으면 그 규칙을 고치는 양식, 없으면 새 규칙 양식을 아래에 둔다
  function openRules(editId = null) {
    const rules = Object.entries(store.rules || {}).filter(([, r]) => r && r.title);
    const cur = editId ? store.rules?.[editId] : null;
    const kindOf = r => !r ? 'weekly' : r.every === 'weekly' ? (r.interval > 1 ? 'biweekly' : 'weekly') : (r.day != null ? 'day' : 'nth');
    const kind0 = kindOf(cur);
    const ov = openModal('pl-modal-rules', `
      <div class="modal-header"><h2>반복 할 일</h2><button class="modal-close" data-close aria-label="닫기">✕</button></div>
      <div class="modal-body">
        <p class="modal-hint">정해 두면 앞으로 2주 치가 자동으로 할 일에 들어와요. 끝내거나 지워도 같은 날짜로 다시 생기지 않아요.</p>
        ${rules.length ? `<ul class="pl-ul pl-rule-list">${rules.map(([id, r]) => `
          <li class="pl-row pl-r-${esc(r.area)}${r.active === false ? ' pl-done' : ''}">
            <div class="pl-main"><span class="pl-title">${esc(r.title)}</span>
              <span class="pl-meta"><span class="pl-area pl-a-${esc(r.area)}">${esc(r.area)}</span><span class="pl-due">${esc(ruleText(r))}</span>${r.until ? `<span class="pl-tag">~${esc(fmtMD(r.until))}</span>` : ''}${r.active === false ? '<span class="pl-tag">꺼 둠</span>' : ''}</span></div>
            <button class="btn-secondary" data-rule-act="edit" data-id="${esc(id)}">고치기</button>
            <button class="btn-secondary" data-rule-act="toggle" data-id="${esc(id)}">${r.active === false ? '켜기' : '끄기'}</button>
            <button class="btn-del" data-rule-act="del" data-id="${esc(id)}">삭제</button>
          </li>`).join('')}</ul>` : '<div class="pl-empty-sec">아직 반복 할 일이 없어요</div>'}
        <h3 class="pl-rule-h">${cur ? '반복 고치기' : '새 반복 만들기'}</h3>
        <label class="pl-f">제목<input id="pl-r-title" type="text" maxlength="200" value="${esc(cur?.title || '')}" placeholder="예) 블로그 글쓰기 · 수업 준비 · 상설동아리 출결"></label>
        <div class="pl-f-row">
          <label class="pl-f">영역<select id="pl-r-area">${T.AREAS.map(a => `<option${a === (cur?.area || addArea) ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
          <label class="pl-f">주기<select id="pl-r-kind">
            <option value="weekly"${kind0 === 'weekly' ? ' selected' : ''}>매주</option>
            <option value="biweekly"${kind0 === 'biweekly' ? ' selected' : ''}>격주 (2주마다)</option>
            <option value="nth"${kind0 === 'nth' ? ' selected' : ''}>매월 몇째 주 무슨 요일</option>
            <option value="day"${kind0 === 'day' ? ' selected' : ''}>매월 며칠</option>
          </select></label>
        </div>
        <div class="pl-f-row">
          <label class="pl-f" data-k="dow">요일<select id="pl-r-dow">${Object.entries(DOW_LABEL).map(([k, v]) => `<option value="${k}"${k === (cur?.dow || 'mon') ? ' selected' : ''}>${v}요일</option>`).join('')}</select></label>
          <label class="pl-f" data-k="nth">몇째<select id="pl-r-nth">${Object.entries(NTH_LABEL).map(([k, v]) => `<option value="${k}"${Number(k) === (cur?.nth || 1) ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="pl-f" data-k="day">날짜(일)<input id="pl-r-day" type="number" min="1" max="31" value="${cur?.day ?? 1}"></label>
          <label class="pl-f" data-k="start">첫 날짜<input id="pl-r-start" type="date" value="${esc(cur?.start || '')}"></label>
          <label class="pl-f">끝나는 날 (선택)<input id="pl-r-until" type="date" value="${esc(cur?.until || '')}"></label>
        </div>
        <div class="pl-e-err" id="pl-r-err"></div>
      </div>
      <div class="modal-footer pl-e-foot">
        ${cur ? '<button class="btn-secondary" id="pl-r-cancel" type="button">고치기 취소</button>' : ''}
        <span class="pl-spacer"></span>
        <button class="btn-primary" id="pl-r-save" type="button">${cur ? '저장' : '반복 추가'}</button>
      </div>`, { small: false });
    const $ = s => ov.querySelector(s);
    const sync = () => {
      const k = $('#pl-r-kind').value;
      const show = { dow: k === 'weekly' || k === 'nth', nth: k === 'nth', day: k === 'day', start: k === 'biweekly' };
      Object.entries(show).forEach(([n, v]) => { ov.querySelector(`[data-k=${n}]`).style.display = v ? '' : 'none'; });
    };
    $('#pl-r-kind').addEventListener('change', sync);
    sync();
    const after = async fn => { await run(fn, 'rule'); materializedOn = ''; maybeMaterialize(); closeModal('pl-modal-rules'); openRules(); };
    $('#pl-r-cancel')?.addEventListener('click', () => { closeModal('pl-modal-rules'); openRules(); });
    $('#pl-r-save').addEventListener('click', () => {
      const k = $('#pl-r-kind').value, today = todayStr();
      const input = { title: $('#pl-r-title').value, area: $('#pl-r-area').value, until: $('#pl-r-until').value || null };
      if (k === 'weekly') Object.assign(input, { every: 'weekly', dow: $('#pl-r-dow').value });
      else if (k === 'biweekly') {
        const st = $('#pl-r-start').value;
        Object.assign(input, { every: 'weekly', interval: 2, start: st, dow: st ? DOW_KEY[new Date(`${st}T00:00:00Z`).getUTCDay()] : 'mon' });
      } else if (k === 'nth') Object.assign(input, { every: 'monthly', dow: $('#pl-r-dow').value, nth: Number($('#pl-r-nth').value) });
      else Object.assign(input, { every: 'monthly', day: Number($('#pl-r-day').value) });
      let patchFn;
      try {
        const patch = cur ? T.planEditRule(store, editId, input, { today }) : T.planAddRule(input, { id: T.newTaskId() });
        patchFn = () => patch;
      } catch (e) { $('#pl-r-err').textContent = e.message; return; }
      after(patchFn);
    });
    ov.addEventListener('click', e => {
      const b = e.target.closest('[data-rule-act]');
      if (!b) return;
      const id = b.dataset.id, r = store.rules?.[id];
      if (!r) return;
      if (b.dataset.ruleAct === 'edit') { closeModal('pl-modal-rules'); openRules(id); }
      else if (b.dataset.ruleAct === 'toggle') after(() => (r.active === false
        ? T.planEditRule(store, id, { ...r, active: true }, { today: todayStr() })
        : { [`rules/${id}/active`]: false }));
      else if (b.dataset.ruleAct === 'del') {
        if (!confirm(`“${r.title}” 반복을 지울까요? 앞으로 예정된 반복 건도 함께 지워져요. (끝낸 건은 남아요)`)) return;
        after(() => T.planDeleteRule(store, id, { today: todayStr() }));
      }
    });
  }

  function openEdit(t) {
    const ov = openModal('pl-modal-edit', `
      <div class="modal-header"><h2>할 일 고치기</h2><button class="modal-close" data-close aria-label="닫기">✕</button></div>
      <div class="modal-body">
        <label class="pl-f">제목<input id="pl-e-title" type="text" maxlength="200" value="${esc(t.title)}"></label>
        <div class="pl-f-row">
          <label class="pl-f">영역<select id="pl-e-area">${T.AREAS.map(a => `<option${a === t.area ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
          <label class="pl-f">종류<select id="pl-e-kind"><option value="once"${t.kind === 'once' ? ' selected' : ''}>할 일</option><option value="watch"${t.kind === 'watch' ? ' selected' : ''}>지켜보기</option></select></label>
          <label class="pl-f">마감일<input id="pl-e-due" type="date" value="${esc(t.due || '')}"></label>
          <label class="pl-f">또는 기간으로
            <select id="pl-e-fuzzy">
              <option value="">날짜를 직접 고름</option>
              ${[...new Set([...(t.dueText ? [t.dueText] : []), ...T.FUZZY_PRESETS])].map(p => `<option${p === t.dueText ? ' selected' : ''}>${esc(p)}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="pl-f">링크${t.link ? ` <a class="pl-open-link" href="${esc(t.link)}" target="_blank" rel="noopener">원본 열기 ↗</a>` : ''}<input id="pl-e-link" type="url" placeholder="https://" value="${esc(t.link || '')}"></label>
        <label class="pl-f">메모<textarea id="pl-e-note" rows="8" maxlength="6000" placeholder="진행 상황, 해야 할 세부 내용을 적어 두세요">${esc(t.note || '')}</textarea></label>
        ${t.slot ? `<div class="pl-f pl-slot-line">칸: ${esc(fmtMD(t.slot.date))} ${esc(t.slot.start)} (${t.slot.min}분) <button type="button" class="btn-secondary" id="pl-e-clearslot">칸 비우기</button></div>` : ''}
        <div class="pl-e-err" id="pl-e-err"></div>
      </div>
      <div class="modal-footer pl-e-foot">
        <button class="btn-del" id="pl-e-del" type="button">삭제</button>
        <span class="pl-spacer"></span>
        ${t.status === 'open' ? `<button class="btn-secondary" id="pl-e-arch" type="button">보관</button>` : ''}
        <button class="btn-primary" id="pl-e-save" type="button">저장</button>
      </div>`);
    const $ = s => ov.querySelector(s);
    // 기간을 고르면 그 끝날짜가 마감일 칸에 들어가고, 마감일을 직접 고치면 기간 선택은 풀린다
    $('#pl-e-fuzzy').addEventListener('change', e => {
      const f = e.target.value && T.resolveFuzzy(e.target.value, todayStr());
      if (f) $('#pl-e-due').value = f.due;
    });
    $('#pl-e-due').addEventListener('input', () => { $('#pl-e-fuzzy').value = ''; });
    $('#pl-e-save').addEventListener('click', () => {
      const due = $('#pl-e-due').value || null;
      const changes = {
        title: $('#pl-e-title').value, area: $('#pl-e-area').value, kind: $('#pl-e-kind').value,
        due, dueText: due ? ($('#pl-e-fuzzy').value || null) : null, link: $('#pl-e-link').value.trim(), note: $('#pl-e-note').value.trim(),
      };
      let patch;
      try { patch = T.planEditTask(t, changes, { now: nowStamp() }); }
      catch (e) { $('#pl-e-err').textContent = e.message; return; }
      closeModal('pl-modal-edit');
      run(() => patch, 'edit', '저장했어요');
    });
    $('#pl-e-arch')?.addEventListener('click', () => { closeModal('pl-modal-edit'); run(() => T.planArchive(t, { now: nowStamp() }), 'archive', '보관했어요'); });
    $('#pl-e-clearslot')?.addEventListener('click', () => { closeModal('pl-modal-edit'); run(() => T.planSetSlot(t, null, { now: nowStamp() }), 'clearslot', '칸을 비웠어요'); });
    $('#pl-e-del').addEventListener('click', () => {
      if (!confirm(`“${t.title}”를 완전히 지울까요? (보관은 나중에 복원할 수 있어요)`)) return;
      closeModal('pl-modal-edit');
      run(() => {
        const patch = T.planDelete(t);
        if (t.ruleId && t.due) Object.assign(patch, T.planSkipRuleDate(t.ruleId, t.due));   // 반복 건은 같은 날짜로 다시 만들지 않는다
        if (t.src === 'prep') patch[`prepSkip/${t.id}`] = true;                                // 수업 준비도 지운 건 다시 만들지 않는다
        return patch;
      }, 'delete', '지웠어요');
    });
  }

  // ---------- 시간 칸 놓기 ----------
  // 달력에서 끌어 놓거나 놓기 창에서 정한 칸을 저장한다. 오늘 칸에 새로 놓으면 "오늘 할 일"이 하나 늘어나므로 상한을 먼저 본다.
  function setSlot(t, slot, okMsg = '시간 칸에 놓았어요') {
    const today = todayStr();
    if (slot.date === today && !(t.today === today || t.slot?.date === today)) {
      const chk = T.checkTodayAdd(tasks(), t, today, store.settings);
      if (!chk.ok) { toast(`오늘 할 일이 ${chk.cap}개예요. 하나를 빼야 오늘 칸에 놓을 수 있어요`, true); cal?.render(); return; }
    }
    run(() => T.planSetSlot(t, slot, { now: nowStamp() }), 'slot', okMsg);
  }

  const MIN_CHOICES = [15, 30, 45, 60, 90, 120, 180];
  const fmtRange = f => `${T.minToTime(f.start)}–${T.minToTime(f.end)}`;

  // 그날 첫 빈 시간 (오늘이면 지금 이후) — 놓기 창의 처음 값
  function suggestStart(date, min, ignoreId) {
    const free = T.freeIntervals(getSchoolData() || {}, tasks(), date, { settings: store.settings, ignoreId });
    const n = new Date();
    const floor = date === todayStr() ? Math.ceil((n.getHours() * 60 + n.getMinutes()) / 15) * 15 : 0;
    for (const f of free) {
      const s = Math.max(f.start, floor);
      if (f.end - s >= min) return s;
    }
    return null;
  }

  // opts: { task } 목록에서 / { date, start } 달력의 빈 칸에서
  function openPlaceModal(opts = {}) {
    const today = todayStr();
    const fixed = opts.task || null;
    const pool = tasks().filter(t => t.status === 'open' && t.kind !== 'watch')
      .sort((a, b) => (a.slot ? 1 : 0) - (b.slot ? 1 : 0) || (a.due || '9999').localeCompare(b.due || '9999'));
    const first = fixed || null;
    const min0 = first?.slot?.min || 60;
    const date0 = opts.date || first?.slot?.date || (first?.due && first.due >= today ? first.due : today);
    let start0 = opts.start ?? suggestStart(date0, min0, first?.id);
    if (start0 == null) start0 = 9 * 60;
    const mins = MIN_CHOICES.includes(min0) ? MIN_CHOICES : [...MIN_CHOICES, min0].sort((a, b) => a - b);
    const minLabel = m => (m % 60 === 0 ? `${m / 60}시간` : m > 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);

    const ov = openModal('pl-modal-place', `
      <div class="modal-header"><h2><lucian-calendar size="22"></lucian-calendar> 시간 칸에 놓기</h2><button class="modal-close" data-close aria-label="닫기">✕</button></div>
      <div class="modal-body">
        <label class="pl-f">할 일
          <select id="pl-p-task">
            ${fixed ? '' : '<option value="__new">＋ 새 할 일 만들기</option>'}
            ${pool.map(t => `<option value="${esc(t.id)}"${first && first.id === t.id ? ' selected' : ''}>${esc(t.title)}${t.slot ? ` · 지금 ${fmtMD(t.slot.date)} ${t.slot.start}` : t.due ? ` · ${t.dueText || fmtMD(t.due)}` : ''}</option>`).join('')}
          </select>
        </label>
        <label class="pl-f" id="pl-p-newwrap"${fixed ? ' hidden' : ''}>새 할 일 이름<input id="pl-p-new" type="text" maxlength="200" placeholder="예) 학생회 회의 준비"></label>
        <div class="pl-f-row">
          <label class="pl-f">날짜<input id="pl-p-date" type="date" value="${date0}"></label>
          <label class="pl-f">시작<input id="pl-p-start" type="time" step="900" value="${T.minToTime(start0)}"></label>
          <label class="pl-f">걸리는 시간<select id="pl-p-min">${mins.map(m => `<option value="${m}"${m === min0 ? ' selected' : ''}>${minLabel(m)}</option>`).join('')}</select></label>
        </div>
        <div class="pl-p-free" id="pl-p-free"></div>
        <div class="pl-e-err" id="pl-p-msg"></div>
      </div>
      <div class="modal-footer pl-e-foot">
        <button class="btn-secondary" id="pl-p-clear" type="button" hidden>칸 비우기</button>
        <span class="pl-spacer"></span>
        <button class="btn-primary" id="pl-p-save" type="button">놓기</button>
      </div>`);
    const $ = s => ov.querySelector(s);
    const picked = () => { const v = $('#pl-p-task').value; return v === '__new' ? null : byId(v); };
    const slotNow = () => ({ date: $('#pl-p-date').value, start: $('#pl-p-start').value, min: Number($('#pl-p-min').value) });

    function refresh() {
      const t = picked();
      $('#pl-p-newwrap').hidden = !!t;
      $('#pl-p-clear').hidden = !t?.slot;
      const s = slotNow();
      const msg = $('#pl-p-msg');
      msg.textContent = '';
      if (!s.date || !s.start) { msg.textContent = '날짜와 시작 시각을 정해 주세요'; return false; }
      const free = T.freeIntervals(getSchoolData() || {}, tasks(), s.date, { settings: store.settings, ignoreId: t?.id });
      $('#pl-p-free').textContent = free.length ? `이날 빈 시간: ${free.slice(0, 5).map(fmtRange).join(' · ')}` : '이날은 빈 시간이 없어요';
      const c = T.slotConflict(getSchoolData() || {}, tasks(), s.date, s.start, s.min, { ignoreId: t?.id, settings: store.settings });
      if (!c.ok) { msg.textContent = reasonText(c); return false; }
      return true;
    }
    ['#pl-p-task', '#pl-p-date', '#pl-p-start', '#pl-p-min'].forEach(sel => $(sel).addEventListener('change', () => {
      if (sel === '#pl-p-task' && picked()?.slot) { const sl = picked().slot; $('#pl-p-date').value = sl.date; $('#pl-p-start').value = sl.start; $('#pl-p-min').value = String(sl.min); }
      refresh();
    }));
    refresh();

    $('#pl-p-clear').addEventListener('click', () => { const t = picked(); closeModal('pl-modal-place'); if (t) run(() => T.planSetSlot(t, null, { now: nowStamp() }), 'clearslot', '칸을 비웠어요'); });
    $('#pl-p-save').addEventListener('click', () => {
      if (!refresh()) return;
      const s = slotNow();
      const t = picked();
      if (t) { closeModal('pl-modal-place'); setSlot(t, s); return; }
      const title = $('#pl-p-new').value.trim();
      if (!title) { $('#pl-p-msg').textContent = '새 할 일 이름을 적어 주세요'; return; }
      if (s.date === today && !T.checkTodayAdd(tasks(), { id: '' }, today, store.settings).ok) { $('#pl-p-msg').textContent = `오늘 할 일이 ${settings().todayCap}개예요. 다른 날로 하거나 하나를 먼저 빼 주세요`; return; }
      closeModal('pl-modal-place');
      run(() => T.planAddTask({ title, area: addArea, due: s.date, slot: s }, { id: T.newTaskId(), now: nowStamp() }), 'add', '추가하고 칸에 놓았어요');
    });
  }

  // ---------- 매일 정리 — 마감 지난 일을 하나씩 결정해야 닫힌다 ----------
  function skippedCount(today) {
    try { const v = JSON.parse(store_('plannerSkip') || 'null'); return v && v.date === today ? v.n : 0; } catch (e) { return 0; }
  }

  function reviewBody(list, today) {
    const cap = settings().todayCap;
    const chosen = T.chosenFor(tasks(), today).length;
    const tomorrow = nextWorkday(today);
    return `
      <p class="modal-hint">마감이 지난 일이 ${list.length}건 있어요. 하나씩 오늘 하기 / 날짜 미루기 / 보관 중에서 정해 주세요. (오늘 할 일 ${chosen}/${cap})</p>
      <ul class="pl-ul pl-review">
        ${list.map(t => `
          <li class="pl-row pl-over" data-id="${esc(t.id)}">
            <div class="pl-main">
              <span class="pl-title">${esc(t.title)}</span>
              <span class="pl-meta"><span class="pl-area pl-a-${esc(t.area)}">${esc(t.area)}</span><span class="pl-due pl-due-over">${esc(dueLabel(t, today))}</span></span>
              <div class="pl-rv-actions">
                <button class="btn-primary" data-rv="today">오늘 하기</button>
                <span class="pl-rv-postpone"><input type="date" value="${tomorrow}" min="${addDays(today, 1)}"><button class="btn-secondary" data-rv="postpone">이 날로 미루기</button></span>
                <button class="btn-secondary" data-rv="archive">보관</button>
              </div>
            </div>
          </li>`).join('')}
      </ul>`;
  }

  function syncReview() {
    const today = todayStr();
    const existing = document.getElementById('pl-modal-review');
    if (!loaded || loadError) return;
    const list = T.reviewList(tasks(), today, store.settings);
    if (!list.length) {
      if (existing) closeModal('pl-modal-review');
      // 끝까지 정리했으면 오늘은 다시 묻지 않는다 (이미 비어 있던 날도 한 번 적어 둔다)
      if (store.settings?.reviewedOn !== today && !demo) run(() => T.planMarkReviewed(today), 'reviewed');
      else if (store.settings?.reviewedOn !== today && demo) store = applyPatch(store, T.planMarkReviewed(today));
      return;
    }
    if (existing) { existing.querySelector('.modal-body').innerHTML = reviewBody(list, today); return; }
    if (reviewDismissed || document.querySelector('#pl-modal-edit, #pl-modal-cap, #pl-modal-place')) return;
    if (document.getElementById('tab-tasks')?.style.display === 'none') return;   // 할 일 탭이 아닐 땐 띄우지 않는다
    const canSkip = skippedCount(today) < 1;
    const ov = openModal('pl-modal-review', `
      <div class="modal-header"><h2>오늘 먼저 정리해요</h2>${canSkip ? '<button class="modal-close pl-skip" data-skip aria-label="나중에">나중에</button>' : ''}</div>
      <div class="modal-body">${reviewBody(list, today)}</div>`, { small: false });
    ov.addEventListener('click', e => {
      if (e.target.closest('[data-skip]')) {
        reviewDismissed = true;
        store_('plannerSkip', JSON.stringify({ date: today, n: skippedCount(today) + 1 }));
        closeModal('pl-modal-review');
        return;
      }
      const b = e.target.closest('[data-rv]');
      if (!b) return;
      const row = b.closest('[data-id]');
      const t = byId(row.dataset.id);
      const now = nowStamp();
      if (!t) return;
      if (b.dataset.rv === 'today') {
        const chk = T.checkTodayAdd(tasks(), t, today, store.settings);
        if (!chk.ok) { toast(`오늘 할 일이 ${chk.cap}개예요. 다른 일을 미루거나 보관해야 넣을 수 있어요`, true); return; }
        run(() => T.planReviewAction(t, 'today', { today, now }), 'review-today');
      } else if (b.dataset.rv === 'postpone') {
        const date = row.querySelector('input[type=date]').value;
        if (!date || date <= today) { toast('내일 이후 날짜를 골라 주세요', true); return; }
        run(() => T.planReviewAction(t, 'postpone', { today, date, now }), 'review-postpone');
      } else if (b.dataset.rv === 'archive') {
        run(() => T.planReviewAction(t, 'archive', { today, now }), 'review-archive');
      }
    });
  }

  // ---------- 반복 규칙 펼치기 (하루 한 번) ----------
  // 같은 규칙·날짜는 같은 id 라 여러 기기가 동시에 해도 한 건이다. 이미 있는 건은 건드리지 않는다.
  function maybeMaterialize() {
    const today = todayStr();
    if (!loaded) return;
    const patch = {};
    if (materializedOn !== today) {
      materializedOn = today;
      Object.assign(patch, T.planMaterialize(store, today, { now: nowStamp() }));
    }
    // 수업 준비는 진도 데이터가 도착한 뒤에야 만들 수 있어서, 도착할 때까지 하루 안에 다시 시도한다
    const sd = getSchoolData();
    if (sd?.semester && prepOn !== today) {
      prepOn = today;
      try { Object.assign(patch, T.planPrepSync(store, sd, today, { now: nowStamp() })); }
      catch (e) { console.error('수업 준비를 만들지 못했어요', e); }
    }
    if (Object.keys(patch).length) run(() => patch, 'materialize');
  }

  // ---------- 바깥에 내놓는 것 ----------
  if (!demo) {
    unsub = onValue(ref(db, `users/${uid}/planner`), snap => {
      store = snap.val() || { tasks: {}, rules: {}, settings: {} };
      loaded = true; loadError = '';
      maybeMaterialize();
      if (root()?.querySelector('.pl-shell')) renderAll();
      notify();
    }, err => {
      loadError = err?.message || String(err);
      if (root()?.querySelector('.pl-shell')) renderLists();
    });
  }

  return {
    // 할 일 탭이 보일 때마다 app.js 가 부른다
    render() {
      reviewDismissed = reviewDismissed && skippedCount(todayStr()) > 0;
      renderAll();
      maybeMaterialize();
    },
    // 오늘 수업 탭 맨 위 한 줄용 (4단계에서 사용)
    summary() {
      const today = todayStr();
      maybeMaterialize();   // 오늘 수업 탭이 그려질 때 진도 데이터가 이미 와 있으므로 수업 준비도 여기서 챙긴다
      const c = T.classify(tasks(), today);
      return { chosen: T.chosenFor(tasks(), today).length, cap: settings().todayCap, overdue: c.overdue.length, loaded };
    },
    // 미니창용: 오늘 고른 일(칸에 놓은 건 시각 순, 나머지는 그 뒤). 끝낸 일은 빠진다.
    todayItems() {
      const today = todayStr();
      return T.chosenFor(tasks(), today)
        .sort((a, b) => (a.slot?.date === today ? a.slot.start : '99:99').localeCompare(b.slot?.date === today ? b.slot.start : '99:99'))
        .map(t => ({ id: t.id, title: t.title, area: t.area, start: t.slot?.date === today ? t.slot.start : '' }));
    },
    completeTask(id) {
      const t = byId(id);
      if (t) run(() => T.planComplete(t, { now: nowStamp() }), 'done');
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    destroy() {
      subs.clear();
      if (unsub) unsub();
      document.removeEventListener('keydown', onKey);
      hideUndo();
      ['pl-modal-edit', 'pl-modal-cap', 'pl-modal-place', 'pl-modal-review', 'pl-modal-rules'].forEach(closeModal);
      if (root()) root().innerHTML = '';
    },
  };
}
