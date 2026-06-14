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
const ADMIN_EMAIL = '0000yhshin@gmail.com';

// ============================================================
// 상태
// ============================================================
let currentUser  = null;
let userProfile  = null;
let userData     = null;
let schoolData   = null;
let currentTab   = 'today';
let todayRefreshTimer = null;

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

// ============================================================
// [수정] 특정 날짜(targetDateStr) 시점의 예상 차시 오프셋 계산
// "오늘" 이후 ~ targetDateStr 전날까지 해당 반+과목 실제 수업 횟수
// 학사일정으로 취소된 수업은 제외
// ============================================================
function getOffsetUpToDate(cls, subject, targetDateStr) {
  // 기준: lastUpdated 당일은 current에 반영된 수업
  // - targetDate가 미래/오늘: lastUpdated 다음날 ~ targetDate 전날까지 카운트 (+)
  // - targetDate가 과거:      targetDate 다음날 ~ lastUpdated까지 카운트 (-)
  const schedule    = userData?.timetable?.schedule || {};
  const progressKey = `${cls}_${subject}`;
  const lastUpdated = userData?.progress[progressKey]?.lastUpdated || todayStr();

  const lastDate   = new Date(lastUpdated);
  const targetDate = new Date(targetDateStr);

  let count  = 0;
  let cursor, end, sign;

  if (targetDate > lastDate) {
    // 미래 방향: lastUpdated 다음날 ~ targetDate 전날
    cursor = new Date(lastDate); cursor.setDate(cursor.getDate() + 1);
    end    = new Date(targetDate);
    sign   = 1;
  } else if (targetDate < lastDate) {
    // 과거 방향: targetDate 다음날 ~ lastUpdated
    cursor = new Date(targetDate); cursor.setDate(cursor.getDate() + 1);
    end    = new Date(lastDate); end.setDate(end.getDate() + 1); // lastUpdated 당일 포함
    sign   = -1;
  } else {
    return 0; // 같은 날이면 오프셋 없음
  }

  while (cursor < end) {
    const dateStr     = dateToStr(cursor);
    const dayKey      = DOW_KEY[cursor.getDay()];
    const daySchedule = schedule[dayKey] || {};

    for (const [periodStr, cell] of Object.entries(daySchedule)) {
      if (cell?.class === cls && cell?.subject === subject) {
        const ev = getCalendarEvent(dateStr, periodStr);
        if (!ev) count++;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return sign * count;
}

// ============================================================
// 진도 자동 계산 (어제까지만)
// ============================================================
async function autoUpdateProgress() {
  if (!currentUser || !userData) return;

  const schedule  = userData.timetable?.schedule || {};
  const progress  = userData.progress || {};
  const periods   = getPeriods();
  const now       = new Date();
  const today     = todayStr();

  const updates = {};

  const allKeys = Object.keys(progress);
  if (!allKeys.length) return;

  let startDateStr = allKeys.reduce((acc, key) => {
    const d = progress[key]?.lastUpdated || today;
    return d < acc ? d : acc;
  }, today);

  const startDate = new Date(startDateStr);
  const cursor    = new Date(startDate);

  while (cursor <= now) {
    const dateStr = dateToStr(cursor);

    if (dateStr === today) {
      cursor.setDate(cursor.getDate() + 1);
      continue;
    }

    const dayKey      = DOW_KEY[cursor.getDay()];
    const daySchedule = schedule[dayKey] || {};

    for (const [periodStr, cell] of Object.entries(daySchedule)) {
      if (!cell?.class || !cell?.subject) continue;
      const progressKey = `${cell.class}_${cell.subject}`;
      if (!progress[progressKey]) continue;

      const lastUpdated = progress[progressKey]?.lastUpdated || startDateStr;
      if (dateStr <= lastUpdated) continue;

      const ev = getCalendarEvent(dateStr, periodStr);
      if (ev) continue;

      const cur = updates[progressKey]?.current ?? progress[progressKey]?.current ?? 1;
      updates[progressKey] = {
        current: cur + 1,
        lastUpdated: dateStr
      };
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  if (Object.keys(updates).length > 0) {
    const dbUpdates = {};
    for (const [key, val] of Object.entries(updates)) {
      dbUpdates[`users/${currentUser.uid}/progress/${key}`] = val;
      if (!userData.progress[key]) userData.progress[key] = {};
      userData.progress[key].current     = val.current;
      userData.progress[key].lastUpdated = val.lastUpdated;
    }
    await update(ref(db), dbUpdates);
  }
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

  userData   = userSnap.val()   || { timetable: { periods: {}, schedule: {} }, progress: {}, curriculum: {} };
  schoolData = schoolSnap.val() || { calendar: {} };

  if (!userData.timetable)  userData.timetable  = { periods: {}, schedule: {} };
  if (!userData.progress)   userData.progress   = {};
  if (!userData.curriculum) userData.curriculum  = {};

  await autoUpdateProgress();
  renderCurrentTab();
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
      const current = userData.progress[key]?.current || '?';
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
      const current = userData.progress[key]?.current || '?';
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
      const key     = `${cls}_${subject}`;
      const current = userData.progress[key]?.current ?? 1;
      const topic   = userData.curriculum[key]?.[current] || '';

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
          <div class="step-editor" id="editor-${p}">
            <button class="step-btn" onclick="window.adjustStep(${p}, -1)">−</button>
            <span class="step-display" id="step-disp-${p}">${current}</span>
            <button class="step-btn" onclick="window.adjustStep(${p}, +1)">+</button>
            <input class="topic-input" id="topic-inp-${p}" value="${topic}" placeholder="수업 주제 입력" />
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
  const next = Math.max(1, cur + delta);
  disp.textContent = next;

  let key = '';
  document.querySelectorAll('.period-card').forEach(c => {
    if (c.querySelector(`#editor-${p}`)) key = c.dataset.key;
  });

  if (key && userData.curriculum[key]?.[next]) {
    document.getElementById(`topic-inp-${p}`).value = userData.curriculum[key][next];
  }
};

window.saveStep = async function(p) {
  const btn   = document.getElementById(`save-btn-${p}`);
  const disp  = document.getElementById(`step-disp-${p}`);
  const input = document.getElementById(`topic-inp-${p}`);

  let key = '';
  document.querySelectorAll('.period-card').forEach(c => {
    if (c.querySelector(`#editor-${p}`)) key = c.dataset.key;
  });
  if (!key) return;

  const newStep  = parseInt(disp.textContent) || 1;
  const newTopic = input.value.trim();

  btn.disabled    = true;
  btn.textContent = '저장 중…';

  try {
    const updates = {};
    updates[`users/${currentUser.uid}/progress/${key}`] = {
      current: newStep,
      lastUpdated: todayStr()
    };
    if (newTopic) {
      updates[`users/${currentUser.uid}/curriculum/${key}/${newStep}`] = newTopic;
    }
    await update(ref(db), updates);

    if (!userData.progress[key]) userData.progress[key] = {};
    userData.progress[key].current     = newStep;
    userData.progress[key].lastUpdated = todayStr();
    if (!userData.curriculum[key]) userData.curriculum[key] = {};
    if (newTopic) userData.curriculum[key][newStep] = newTopic;

    document.getElementById(`topic-display-${p}`).textContent = newTopic || '주제 미설정';
    document.getElementById(`step-display-${p}`).textContent  = `${newStep}차시`;
    document.getElementById(`editor-${p}`).classList.remove('open');
    showToast(`${key} 저장 완료`);
  } catch(e) {
    showToast('저장 실패: ' + e.message, true);
  } finally {
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

  // [수정] offsetWeeks를 받아 해당 주 그리드 렌더링
  // 각 셀의 차시는 현재 progress + 그 주 이전까지의 누적 수업 수로 계산
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
          const key = `${cell.class}_${cell.subject}`;
          const base = userData.progress[key]?.current ?? 1;

          // [수정] 오늘 이후 ~ 해당 날짜 전날까지 실제 수업 횟수를 오프셋으로 사용
          const offset  = getOffsetUpToDate(cell.class, cell.subject, dateStr);
          const current = base + offset;
          const topic   = userData.curriculum[key]?.[current] || '';

          html += `<td class="has-class${isToday ? ' today-col' : ''}">
            <span class="cell-class">${cell.class}</span>
            <span class="cell-subject">${cell.subject}</span>
            ${topic ? `<span class="cell-topic">${topic}</span>` : ''}
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

  const schedule = userData.timetable?.schedule || {};
  const classSet = new Map();

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
      const current   = userData.progress[item.key]?.current ?? 1;
      const currTopic = userData.curriculum[item.key]?.[current] || '주제 미설정';
      const nextTopic = userData.curriculum[item.key]?.[current + 1] || '';
      const afterTopic= userData.curriculum[item.key]?.[current + 2] || '';

      html += `
        <div class="progress-card">
          <div class="progress-header">
            <span class="prog-badge">${item.class}</span>
            <span class="prog-step">${current}차시</span>
          </div>
          <div class="prog-dates">
            <div class="prog-row current-row">
              <span class="r-label">이번</span>
              <span class="r-topic">${currTopic}</span>
            </div>
            ${nextTopic ? `<div class="prog-row next-row">
              <span class="r-label">다음</span>
              <span class="r-topic">${nextTopic}</span>
            </div>` : ''}
            ${afterTopic ? `<div class="prog-row after-row">
              <span class="r-label">다다음</span>
              <span class="r-topic">${afterTopic}</span>
            </div>` : ''}
          </div>
        </div>`;
    }
    html += `</div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ============================================================
// 수업 주제 탭 — 반응형 (모바일: 탭, PC: 3열)
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
    const current    = userData.progress[repKey]?.current ?? 1;

    // [수정] 저장된 최대 차시와 current+WINDOW 중 큰 값을 maxStep으로 사용
    // → 저장 후 다시 렌더해도 추가된 행이 사라지지 않음
    const WINDOW   = 2;
    const minStep  = Math.max(1, current - WINDOW);
    const savedMax = Object.keys(curriculum).map(Number).reduce((a, b) => Math.max(a, b), 0);
    const maxStep  = Math.max(current + WINDOW, savedMax);

    const stepSet  = new Set();
    for (let s = minStep; s <= maxStep; s++) stepSet.add(s);
    const visible  = [...stepSet].sort((a,b) => a-b);

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
// 수업 주제 탭 이벤트 위임 (저장 / 삭제 버튼)
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
        if (!userData.progress[key]) {
          userData.progress[key] = { current: 1, lastUpdated: todayStr() };
        }
      }
    }
  });

  try {
    const dbUpdates = {};
    dbUpdates[`users/${currentUser.uid}/timetable/schedule`] = schedule;
    for (const [key, val] of Object.entries(userData.progress)) {
      dbUpdates[`users/${currentUser.uid}/progress/${key}`] = val;
    }
    await update(ref(db), dbUpdates);
    userData.timetable.schedule = schedule;

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
// 학사일정 편집기 (관리자)
// ============================================================
window.openCalendarEditor = function() {
  const calendar = schoolData?.calendar || {};
  const entries  = [];

  for (const [date, periods] of Object.entries(calendar)) {
    for (const [period, ev] of Object.entries(periods)) {
      entries.push({ date, period, ...ev });
    }
  }
  entries.sort((a,b) => b.date.localeCompare(a.date));

  let rows = entries.map((e, i) => {
    const isAll = e.period === 'all';
    return `
    <tr id="cal-row-${i}">
      <td><input class="cal-input" data-idx="${i}" data-field="date" value="${e.date}" placeholder="YYYY-MM-DD" /></td>
      <td class="cal-allday-cell">
        <label class="allday-toggle">
          <input type="checkbox" class="cal-allday-check" data-idx="${i}" onchange="window.toggleAlldayCheck(this)" ${isAll ? 'checked' : ''} />
          <span>하루종일</span>
        </label>
        <input class="cal-input cal-period-input" data-idx="${i}" data-field="period"
          value="${isAll ? '' : e.period}"
          placeholder="교시"
          style="${isAll ? 'display:none' : ''}" />
      </td>
      <td>
        <select class="cal-select" data-idx="${i}" data-field="type">
          <option value="holiday" ${e.type==='holiday'?'selected':''}>휴업</option>
          <option value="event"   ${e.type==='event'  ?'selected':''}>행사</option>
          <option value="exam"    ${e.type==='exam'   ?'selected':''}>시험</option>
          <option value="club"    ${e.type==='club'   ?'selected':''}>동아리</option>
          <option value="noclass" ${e.type==='noclass'?'selected':''}>수업없음</option>
        </select>
      </td>
      <td><input class="cal-input" data-idx="${i}" data-field="label" value="${e.label||''}" placeholder="표시 텍스트" /></td>
      <td><button class="btn-del" onclick="document.getElementById('cal-row-${i}').remove()">✕</button></td>
    </tr>`;
  }).join('');

  const html = `
    <div class="modal-overlay" id="modal-calendar">
      <div class="modal modal-lg">
        <div class="modal-header">
          <h2>학사일정 관리</h2>
          <button class="modal-close" onclick="window.closeModal('modal-calendar')">✕</button>
        </div>
        <div class="modal-body">
          <button class="btn-add-period" onclick="window.addCalRow()" style="margin-bottom:10px;margin-top:0">+ 항목 추가</button>
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
  const periodInput = checkbox.closest('td').querySelector('.cal-period-input');
  if (checkbox.checked) {
    periodInput.style.display = 'none';
    periodInput.value = '';
  } else {
    periodInput.style.display = '';
  }
};

window.addCalRow = function() {
  const tbody = document.getElementById('cal-tbody');
  const idx   = Date.now();
  tbody.insertAdjacentHTML('beforeend', `
    <tr id="cal-row-${idx}">
      <td><input class="cal-input" data-idx="${idx}" data-field="date" value="" placeholder="YYYY-MM-DD" /></td>
      <td class="cal-allday-cell">
        <label class="allday-toggle">
          <input type="checkbox" class="cal-allday-check" data-idx="${idx}" onchange="window.toggleAlldayCheck(this)" />
          <span>하루종일</span>
        </label>
        <input class="cal-input cal-period-input" data-idx="${idx}" data-field="period" value="" placeholder="교시" />
      </td>
      <td>
        <select class="cal-select" data-idx="${idx}" data-field="type">
          <option value="holiday">휴업</option>
          <option value="event">행사</option>
          <option value="exam">시험</option>
          <option value="club">동아리</option>
          <option value="noclass">수업없음</option>
        </select>
      </td>
      <td><input class="cal-input" data-idx="${idx}" data-field="label" value="" placeholder="표시 텍스트" /></td>
      <td><button class="btn-del" onclick="document.getElementById('cal-row-${idx}').remove()">✕</button></td>
    </tr>`);
};

window.saveCalendar = async function() {
  const rows     = document.querySelectorAll('#cal-tbody tr');
  const calendar = {};

  rows.forEach(row => {
    const dateInput   = row.querySelector('[data-field="date"]');
    const alldayCheck = row.querySelector('.cal-allday-check');
    const periodInput = row.querySelector('.cal-period-input');
    const typeSelect  = row.querySelector('[data-field="type"]');
    const labelInput  = row.querySelector('[data-field="label"]');

    const date  = dateInput?.value.trim();
    if (!date) return;

    const isAll     = alldayCheck?.checked;
    const periodKey = isAll ? 'all' : (periodInput?.value.trim() || 'all');
    const type      = typeSelect?.value || 'event';
    const label     = labelInput?.value.trim() || '';

    if (!calendar[date]) calendar[date] = {};
    calendar[date][periodKey] = { type, label };
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
  } else {
    currentUser = null;
    userProfile = null;
    showLogin();
  }
});

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display   = '';
}

function showLogin() {
  document.getElementById('login-screen').style.display = '';
  document.getElementById('app-screen').style.display   = 'none';
}

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
checkInviteParam();
