// 달력 시간표 — 「할 일」 탭 오른쪽(좁으면 따로 보기)에 붙는 하루/주 칸.
// 수업·학사일정은 회색 고정 블록, 할 일은 영역 색 블록. 끌어서 옮기고, 아래 끝을 끌어 길이를 바꾸고,
// 목록의 달력 버튼이나 마감 칩을 끌어다 놓으면 그 시간 칸(slot)이 된다. 15분 단위.
// 저장은 하지 않는다 — 바뀐 칸을 onSetSlot 으로 planner.js 에 넘기고, 겹침 검사는 task-engine 의 slotConflict 가 한다.
import { addDays, timeToMin } from './engine/progress-engine.js';
import * as T from './engine/task-engine.js';

const HOUR_PX = 56;          // 한 시간 높이
const SNAP = 15;             // 분 단위
const MOVE_PX = 6;           // 이만큼 움직여야 "끌기"로 본다 (그보다 적으면 눌렀다 뗀 것)
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
const pad = n => String(n).padStart(2, '0');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = min => T.minToTime(min);
const parts = s => s.split('-').map(Number);
const dowOf = s => { const [y, m, d] = parts(s); return new Date(y, m - 1, d).getDay(); };

export function reasonText(c) {
  if (c.ok) return '';
  if (c.reason === 'class') return `수업·일정(${c.with.label})과 겹쳐요`;
  if (c.reason === 'task') return `다른 할 일(${c.with.title})과 겹쳐요`;
  return '아침 시작 시간 전이거나 자정을 넘겨요 — 자정 전에 끝나게 해 주세요';
}

export function weekDates(date, weekend = false) {
  const i = dowOf(date);
  const mon = addDays(date, i === 0 ? -6 : 1 - i);
  return Array.from({ length: weekend ? 7 : 5 }, (_, k) => addDays(mon, k));
}

export function createCalendar({ root, getTasks, getData, getSettings, today, onSetSlot, onOpen, onDone, onEmpty, toast }) {
  let date = today();
  let mode = 'day';
  let startMin = 420, endMin = 1320;
  let busy = false;          // 끌고 있는 동안은 다시 그리지 않는다 (끌던 블록이 사라지지 않게)
  let pending = false;
  let firstScroll = true;
  let late = false;          // 밤(22시~자정) 칸 펼침

  const dataOf = () => getData() || {};
  const findTask = id => getTasks().find(t => t.id === id);
  const yOf = min => (min - startMin) * HOUR_PX / 60;
  const snap = min => Math.round(min / SNAP) * SNAP;
  const snapDown = min => Math.floor(min / SNAP) * SNAP;

  function datesShown() {
    if (mode === 'day') return [date];
    const wk5 = weekDates(date, false);
    const wk7 = weekDates(date, true);
    const hasWeekend = getTasks().some(t => t.status === 'open' && t.slot && (t.slot.date === wk7[5] || t.slot.date === wk7[6]));
    return hasWeekend ? wk7 : wk5;
  }

  function check(task, d, start, min) {
    return T.slotConflict(dataOf(), getTasks(), d, hhmm(start), min, { ignoreId: task?.id ?? null, settings: getSettings() });
  }

  // 그날 끝낸 일 — 칸에 놓았던 건 그 칸에, 칸이 없던 건 끝낸 시각 앞 30분에 흐리게 보여 "오늘 뭐 했나"를 돌아보게 한다
  function doneBlocks(tasks, d) {
    const list = [];
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      let start, min, label;
      if (t.slot?.date === d) { start = timeToMin(t.slot.start); min = t.slot.min; label = `${t.slot.start}–${hhmm(start + min)}`; }
      else if (!t.slot && String(t.doneAt || '').startsWith(d)) {
        const end = timeToMin(String(t.doneAt).slice(11, 16));
        min = 30; start = Math.max(startMin, end - min); label = `${hhmm(end)}에 끝냄`;
        if (end < startMin || end > endMin) continue;
      } else continue;
      if (start + min > endMin) min = endMin - start;
      if (min <= 0 || start < startMin) continue;
      list.push({ t, start, min, label });
    }
    // 겹치는 건 나란히 (가로 칸 나누기)
    list.sort((a, b) => a.start - b.start);
    const laneEnd = [];
    for (const b of list) {
      let i = laneEnd.findIndex(e => e <= b.start);
      if (i < 0) { i = laneEnd.length; laneEnd.push(0); }
      laneEnd[i] = b.start + b.min; b.lane = i;
    }
    list.forEach(b => { b.lanes = Math.max(1, laneEnd.length); });
    return list;
  }

  // ---------- 그리기 ----------
  function render() {
    if (busy) { pending = true; return; }
    pending = false;
    const cfg = T.resolveSettings(getSettings());
    const dates = datesShown();
    const tasks = getTasks();
    const open = tasks.filter(t => t.status === 'open');
    // 22시 넘어 일하는 날은 예외 — 밤 칸을 펴면 자정까지, 그 시간에 놓인 일이 있으면 저절로 펴진다
    const dayEndMin = timeToMin(cfg.dayEnd);
    const hasLate = open.some(t => t.slot && dates.includes(t.slot.date) && timeToMin(t.slot.start) + t.slot.min > dayEndMin);
    const lateOn = late || hasLate;
    startMin = timeToMin(cfg.dayStart); endMin = lateOn ? T.LATE_LIMIT : dayEndMin;
    const td = today();
    const H = Math.round((endMin - startMin) * HOUR_PX / 60);
    const cols = `grid-template-columns: 42px repeat(${dates.length}, minmax(0, 1fr))`;
    const prev = root.querySelector('.pl-cal-scroll');
    const keepTop = prev ? prev.scrollTop : null;

    const label = mode === 'day'
      ? `${parts(date)[1]}/${parts(date)[2]} (${DOW_KO[dowOf(date)]})`
      : `${parts(dates[0])[1]}/${parts(dates[0])[2]} ~ ${parts(dates.at(-1))[1]}/${parts(dates.at(-1))[2]}`;

    // 머리줄: 요일·날짜 + 그날 마감인데 칸이 없는 일(끌어서 놓을 수 있다)
    const heads = dates.map(d => {
      const due = open.filter(t => t.kind !== 'watch' && !t.slot && t.due === d);
      const shown = due.slice(0, mode === 'day' ? 6 : 2);
      return `<div class="pl-ch${d === td ? ' today' : ''}">
        <div class="pl-ch-d"><b>${parts(d)[2]}</b> ${DOW_KO[dowOf(d)]}</div>
        ${shown.map(t => `<button type="button" class="pl-chip-due pl-r-${esc(t.area)}" data-id="${esc(t.id)}" title="${esc(t.title)} — 끌어서 시간 칸에 놓기">${esc(t.title)}</button>`).join('')}
        ${due.length > shown.length ? `<span class="pl-chip-more">+${due.length - shown.length}</span>` : ''}
      </div>`;
    }).join('');

    // 끌어 놓을 일 — 목록이 안 보이는 좁은 화면에서도 여기서 바로 시간표로 끌 수 있게 (머리줄에 이미 보이는 건 뺀다)
    const trayAll = open.filter(t => t.kind !== 'watch' && !t.slot && !dates.includes(t.due))
      .sort((a, b) => (b.today === td) - (a.today === td) || (a.due || '9999').localeCompare(b.due || '9999') || (a.createdAt || '').localeCompare(b.createdAt || ''));
    const tray = trayAll.length ? `<div class="pl-cal-tray" aria-label="시간표에 놓을 일">
      <span class="pl-tray-t">끌어 놓기</span>
      ${trayAll.slice(0, 8).map(t => `<button type="button" class="pl-chip-due pl-tray-chip pl-r-${esc(t.area)}" data-id="${esc(t.id)}" title="${esc(t.title)} — 끌어서 시간 칸에 놓기">${esc(t.title)}</button>`).join('')}
      ${trayAll.length > 8 ? `<span class="pl-chip-more">+${trayAll.length - 8}</span>` : ''}
    </div>` : '';

    const hourLabels = [];
    for (let m = Math.ceil(startMin / 60) * 60; m < endMin; m += 60) hourLabels.push(`<span style="top:${yOf(m)}px">${pad(m / 60)}</span>`);

    const colHtml = dates.map(d => {
      const blocks = T.busyBlocks(dataOf(), d).map(b => {
        const top = Math.max(0, yOf(b.start)), h = Math.max(10, yOf(b.end) - yOf(b.start));
        return `<div class="pl-blk pl-blk-${b.kind}" style="top:${top}px;height:${h}px" title="${esc(b.label)} ${hhmm(b.start)}–${hhmm(b.end)}"><b>${b.p}</b> ${esc(b.label)}</div>`;
      }).join('');
      const done = doneBlocks(tasks, d).map(b => {
        const top = yOf(b.start), h = Math.max(14, b.min * HOUR_PX / 60);
        const w = 100 / b.lanes;
        return `<div class="pl-blk pl-blk-done pl-r-${esc(b.t.area)}" data-done-open="${esc(b.t.id)}" tabindex="0" role="button" style="top:${top}px;height:${h}px;left:calc(${b.lane * w}% + 2px);width:calc(${w}% - 4px);right:auto"
          title="✓ ${esc(b.t.title)} — ${esc(b.label)} (눌러서 시간 고치기·완료 취소)"><div class="pl-blk-t">✓ ${esc(b.t.title)}</div></div>`;
      }).join('');
      const mine = open.filter(t => t.slot?.date === d).map(t => {
        const s = timeToMin(t.slot.start);
        const top = yOf(s), h = Math.max(14, t.slot.min * HOUR_PX / 60);
        return `<div class="pl-blk pl-blk-task pl-r-${esc(t.area)}" data-id="${esc(t.id)}" tabindex="0" role="button"
          style="top:${top}px;height:${h}px" title="${esc(t.title)} ${t.slot.start}–${hhmm(s + t.slot.min)}">
          <button type="button" class="pl-blk-chk" data-done="${esc(t.id)}" aria-label="완료" title="완료"></button>
          <div class="pl-blk-t">${esc(t.title)}</div>
          ${h >= 34 ? `<div class="pl-blk-m">${t.slot.start}–${hhmm(s + t.slot.min)}</div>` : ''}
          <span class="pl-rs" aria-hidden="true"></span>
        </div>`;
      }).join('');
      let now = '';
      if (d === td) {
        const n = new Date(), nm = n.getHours() * 60 + n.getMinutes();
        if (nm >= startMin && nm <= endMin) now = `<div class="pl-now" style="top:${yOf(nm)}px"></div>`;
      }
      const off = ((60 - startMin % 60) % 60) * HOUR_PX / 60;
      return `<div class="pl-col${d === td ? ' today' : ''}" data-date="${d}" style="height:${H}px;background-position:0 ${off}px">${blocks}${done}${mine}${now}</div>`;
    }).join('');

    root.innerHTML = `
      <div class="pl-cal-bar">
        <button type="button" class="pl-cal-nav" data-cal="prev" aria-label="이전">‹</button>
        <button type="button" class="pl-cal-nav pl-cal-today" data-cal="today">오늘</button>
        <button type="button" class="pl-cal-nav" data-cal="next" aria-label="다음">›</button>
        <div class="pl-cal-label">${label}</div>
        <button type="button" class="pl-cal-nav pl-cal-late${lateOn ? ' on' : ''}" data-cal="late" aria-pressed="${lateOn}" title="${hasLate ? '밤 시간에 놓인 일이 있어요' : '22시 넘어서도 일할 때 펼쳐요'}"${hasLate ? ' disabled' : ''}>밤 ${lateOn ? '▴' : '▾'}</button>
        <div class="pl-cal-mode" role="group" aria-label="보기 방식">
          <button type="button" data-cal="mode" data-mode="day" class="${mode === 'day' ? 'on' : ''}">하루</button>
          <button type="button" data-cal="mode" data-mode="week" class="${mode === 'week' ? 'on' : ''}">주</button>
        </div>
      </div>
      ${tray}
      <div class="pl-cal-heads" style="${cols}"><div></div>${heads}</div>
      <div class="pl-cal-scroll"><div class="pl-cal-grid" style="${cols}">
        <div class="pl-hours" style="height:${H}px">${hourLabels.join('')}</div>${colHtml}
      </div></div>
      <div class="pl-cal-help">빈 칸을 누르면 할 일을 놓아요 · 블록을 끌면 옮기고, 아래 끝을 끌면 길이가 바뀌어요 · 회색은 수업(겹쳐 놓을 수 없어요) · 흐린 ✓ 칸은 끝낸 일</div>`;

    const sc = root.querySelector('.pl-cal-scroll');
    if (keepTop != null && !firstScroll) sc.scrollTop = keepTop;
    else {
      const n = new Date();
      const target = date === td ? Math.max(startMin, n.getHours() * 60 - 60) : Math.max(startMin, 8 * 60);
      sc.scrollTop = yOf(target);
      firstScroll = false;
    }
  }

  // ---------- 눌림·끌기 ----------
  const colAt = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest?.('.pl-col');
    if (el && root.contains(el)) return el;
    // 요소가 없는 곳(머리줄 위 등)이면 x 가 가장 가까운 칸으로
    const cols = [...root.querySelectorAll('.pl-col')];
    return cols.find(c => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right; }) || null;
  };
  const minutesIn = (col, y) => startMin + (y - col.getBoundingClientRect().top) / HOUR_PX * 60;

  function edgeScroll(y) {
    const sc = root.querySelector('.pl-cal-scroll');
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    if (y < r.top + 36) sc.scrollTop -= 14; else if (y > r.bottom - 36) sc.scrollTop += 14;
  }

  function endBusy() { busy = false; if (pending) render(); }

  // 이미 놓인 블록: 옮기기('move') / 길이 바꾸기('resize'). 안 움직이고 뗐으면 고치기 창.
  function startBlock(e, blk, kind) {
    const t = findTask(blk.dataset.id);
    if (!t?.slot || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const s0 = { date: t.slot.date, start: timeToMin(t.slot.start), min: t.slot.min };
    let cur = { ...s0 }, moved = false, bad = false;
    const x0 = e.clientX, y0 = e.clientY;
    const ownCol = blk.closest('.pl-col');
    try { blk.setPointerCapture(e.pointerId); } catch (_) { /* 캡처가 안 돼도 이어진다 */ }
    busy = true;

    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < MOVE_PX) return;
      moved = true;
      blk.classList.add('dragging');
      edgeScroll(ev.clientY);
      const dy = (ev.clientY - y0) * 60 / HOUR_PX;
      if (kind === 'resize') {
        cur.min = Math.max(SNAP, snap(s0.min + dy));
        if (cur.start + cur.min > endMin) cur.min = endMin - cur.start;
        blk.style.height = `${Math.max(14, cur.min * HOUR_PX / 60)}px`;
      } else {
        cur.start = Math.min(Math.max(snap(s0.start + dy), startMin), endMin - cur.min);
        const col = colAt(ev.clientX, ev.clientY);
        if (col) {
          cur.date = col.dataset.date;
          blk.style.transform = `translateX(${col.getBoundingClientRect().left - ownCol.getBoundingClientRect().left}px)`;
        }
        blk.style.top = `${yOf(cur.start)}px`;
      }
      bad = !check(t, cur.date, cur.start, cur.min).ok;
      blk.classList.toggle('bad', bad);
    };
    const end = ev => {
      blk.removeEventListener('pointermove', move);
      blk.removeEventListener('pointerup', end);
      blk.removeEventListener('pointercancel', end);
      blk.classList.remove('dragging');
      endBusy();
      if (ev.type === 'pointercancel') { render(); return; }
      if (!moved) { onOpen(t); return; }
      const c = check(t, cur.date, cur.start, cur.min);
      if (!c.ok) { toast(`${reasonText(c)} — 원래 자리로 돌렸어요`, true); render(); return; }
      if (cur.date === s0.date && cur.start === s0.start && cur.min === s0.min) { render(); return; }
      onSetSlot(t, { date: cur.date, start: hhmm(cur.start), min: cur.min });
    };
    blk.addEventListener('pointermove', move);
    blk.addEventListener('pointerup', end);
    blk.addEventListener('pointercancel', end);
  }

  // 목록의 달력 버튼·마감 칩에서 시작하는 끌기 — 달력이 보일 때만. 움직이지 않으면 onClick(눌렀다 뗌)을 부른다.
  function startPlaceDrag(e, task, min, onClick, src) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const visible = root.offsetParent !== null;
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false, ghost = null, preview = null, cur = null;
    try { src.setPointerCapture?.(e.pointerId); } catch (_) { /* 계속 */ }

    const clear = () => { preview?.remove(); preview = null; };
    const move = ev => {
      if (!visible) return;
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < MOVE_PX) return;
      if (!moved) {
        moved = true; busy = true;
        ghost = document.createElement('div');
        ghost.className = 'pl-ghost';
        ghost.textContent = task.title;
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
      edgeScroll(ev.clientY);
      const col = colAt(ev.clientX, ev.clientY);
      clear(); cur = null;
      if (!col) return;
      const sm = Math.min(Math.max(snapDown(minutesIn(col, ev.clientY)), startMin), endMin - min);
      cur = { date: col.dataset.date, start: sm, min };
      const ok = check(task, cur.date, cur.start, cur.min).ok;
      preview = document.createElement('div');
      preview.className = `pl-blk pl-blk-task pl-blk-preview${ok ? '' : ' bad'}`;
      preview.style.top = `${yOf(sm)}px`;
      preview.style.height = `${min * HOUR_PX / 60}px`;
      preview.innerHTML = `<div class="pl-blk-t">${hhmm(sm)} ${esc(task.title)}</div>`;
      col.appendChild(preview);
    };
    const end = ev => {
      src.removeEventListener('pointermove', move);
      src.removeEventListener('pointerup', end);
      src.removeEventListener('pointercancel', end);
      ghost?.remove(); clear();
      if (moved) busy = false;
      if (ev.type === 'pointercancel') { if (pending) render(); return; }
      if (!moved) { onClick?.(); return; }
      if (!cur) { if (pending) render(); return; }
      const c = check(task, cur.date, cur.start, cur.min);
      if (!c.ok) { toast(`${reasonText(c)} — 다른 곳에 놓아 주세요`, true); if (pending) render(); return; }
      onSetSlot(task, { date: cur.date, start: hhmm(cur.start), min: cur.min });
      if (pending) render();
    };
    src.addEventListener('pointermove', move);
    src.addEventListener('pointerup', end);
    src.addEventListener('pointercancel', end);
  }

  // ---------- 이벤트 ----------
  root.addEventListener('pointerdown', e => {
    const chip = e.target.closest('.pl-chip-due');
    if (chip) { const t = findTask(chip.dataset.id); if (t) { e.preventDefault(); startPlaceDrag(e, t, 60, () => onOpen(t), chip); } return; }
    if (e.target.closest('.pl-blk-chk')) { e.stopPropagation(); return; }   // 완료 버튼은 끌기가 아니라 누르기만
    const blk = e.target.closest('.pl-blk-task');
    if (blk && !blk.classList.contains('pl-blk-preview')) { startBlock(e, blk, e.target.closest('.pl-rs') ? 'resize' : 'move'); return; }
    const col = e.target.closest('.pl-col');
    if (col && !e.target.closest('.pl-blk') && !(e.pointerType === 'mouse' && e.button !== 0)) {
      const x0 = e.clientX, y0 = e.clientY;
      const up = ev => {
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > MOVE_PX) return;
        onEmpty(col.dataset.date, Math.min(Math.max(snapDown(minutesIn(col, ev.clientY)), startMin), endMin - SNAP));
      };
      const cancel = () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); };   // 스크롤하려고 끈 것
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    }
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('[data-done-open]')) { const t = findTask(e.target.dataset.doneOpen); if (t) onOpen(t); return; }
    if (e.key === 'Enter' && e.target.matches('.pl-blk-task')) { const t = findTask(e.target.dataset.id); if (t) onOpen(t); }
  });
  root.addEventListener('click', e => {
    const dn = e.target.closest('.pl-blk-chk');
    if (dn) { const t = findTask(dn.dataset.done); if (t) onDone(t); return; }
    const dOpen = e.target.closest('[data-done-open]');   // 끝낸 일의 흐린 칸 — 눌러서 시간을 고치거나 완료를 취소
    if (dOpen) { const t = findTask(dOpen.dataset.doneOpen); if (t) onOpen(t); return; }
    const b = e.target.closest('[data-cal]');
    if (!b) return;
    const step = mode === 'day' ? 1 : 7;
    if (b.dataset.cal === 'prev') date = addDays(date, -step);
    else if (b.dataset.cal === 'next') date = addDays(date, step);
    else if (b.dataset.cal === 'today') date = today();
    else if (b.dataset.cal === 'late') late = !late;
    else if (b.dataset.cal === 'mode') mode = b.dataset.mode === 'week' ? 'week' : 'day';
    firstScroll = true;
    render();
  });

  return {
    render,
    startPlaceDrag,
    isVisible: () => root.offsetParent !== null,
    setDate(d) { date = d; firstScroll = true; render(); },
    get date() { return date; },
  };
}
