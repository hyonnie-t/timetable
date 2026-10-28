// 할 일 엔진 테스트 — `npm test`. 하나라도 깨지면 배포되지 않는다 (.github/workflows/static.yml).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../engine/task-engine.js';
import * as PE from '../engine/progress-engine.js';

const TODAY = '2026-10-23';   // 금요일
const NOW = '2026-10-23 09:00:00';
const task = (id, f = {}) => T.shapeTask(id, { title: id, createdAt: '2026-10-01 00:00:00', ...f });

// 2026-10-19(월) 시간표: 월 3교시 · 금 2·4교시 수업
function schoolData(extra = {}) {
  return {
    semester: { id: 'T', start: '2026-08-18', end: '2027-01-08' },
    periods: {
      1: { start: '09:00', end: '09:45' }, 2: { start: '09:55', end: '10:40' },
      3: { start: '10:50', end: '11:35' }, 4: { start: '11:45', end: '12:30' },
      5: { start: '13:20', end: '14:05' },
    },
    timetables: { '2026-08-18': { mon: { 3: { class: '101', subject: '역사' } }, fri: { 2: { class: '102', subject: '역사' }, 4: { class: '103', subject: '역사' } } } },
    ...extra,
  };
}

describe('제목에서 영역 짐작', () => {
  test('말이 맞으면 그 영역', () => {
    assert.equal(T.guessArea('수업 준비 역사 A 제일 빨리 든 날 언제니? 그날 주제32 수업 있는 날로 해줘'), '수업');
    assert.equal(T.guessArea('학생회 임원 회의 자료'), '학생회');
    assert.equal(T.guessArea('서평 쓰기'), '독서');
    assert.equal(T.guessArea('공문 기안'), '학교');
  });
  test('앞선 영역이 먼저 — 대학원 수업 과제는 대학원', () => {
    assert.equal(T.guessArea('대학원 수업 과제'), '대학원');
  });
  test('못 짐작하면 null (고른 영역을 쓴다)', () => {
    assert.equal(T.guessArea('병원 예약'), null);
    assert.equal(T.guessArea(''), null);
    assert.equal(T.guessArea(undefined), null);
  });
});

describe('한 줄 입력 해석', () => {
  test('내일 + 시각 + 걸리는 시간 → 칸', () => {
    const r = T.parseQuickInput('내일 15시 학생회 회의 1시간', TODAY);
    assert.deepEqual(r, { title: '학생회 회의', due: '2026-10-24', slot: { date: '2026-10-24', start: '15:00', min: 60 } });
  });

  test('"까지"가 붙으면 시각이 있어도 마감일만', () => {
    const r = T.parseQuickInput('논문 읽기 10/30까지', TODAY);
    assert.deepEqual(r, { title: '논문 읽기', due: '2026-10-30', slot: null });
    assert.equal(T.parseQuickInput('보고서 내일 17시까지', TODAY).slot, null);
  });

  test('날짜만 있으면 마감일, 기본 걸리는 시간은 60분', () => {
    assert.equal(T.parseQuickInput('11월 5일 서류 제출', TODAY).due, '2026-11-05');
    assert.equal(T.parseQuickInput('모레 15:30 면담', TODAY).slot.min, 60);
    assert.equal(T.parseQuickInput('모레 15:30 면담', TODAY).slot.start, '15:30');
  });

  test('오후·오전 표시와 시각 안의 분', () => {
    assert.equal(T.parseQuickInput('오늘 오후 3시 30분 면담 45분', TODAY).slot.start, '15:30');
    assert.equal(T.parseQuickInput('오늘 오후 3시 30분 면담 45분', TODAY).slot.min, 45);
    assert.equal(T.parseQuickInput('오늘 오전 9시 조회', TODAY).slot.start, '09:00');
    assert.equal(T.parseQuickInput('오늘 3시 회의', TODAY).slot.start, '15:00');   // 표시 없는 1~6시는 오후
    assert.equal(T.parseQuickInput('오늘 8시 회의', TODAY).slot.start, '08:00');
    assert.equal(T.parseQuickInput('오늘 1시간 30분 독서', TODAY).durationMin, 90);
  });

  test('요일: 오늘 요일은 다음 주, 이번 주·다음 주 표시', () => {
    assert.equal(T.parseQuickInput('금요일 보고', TODAY).due, '2026-10-30');   // 오늘이 금요일
    assert.equal(T.parseQuickInput('월요일 보고', TODAY).due, '2026-10-26');
    assert.equal(T.parseQuickInput('일요일 보고', TODAY).due, '2026-10-25');
    assert.equal(T.parseQuickInput('이번주 월요일 보고', TODAY).due, '2026-10-19');
    assert.equal(T.parseQuickInput('다음주 금요일 보고', TODAY).due, '2026-10-30');
    assert.equal(T.parseQuickInput('다음 주 일요일 보고', TODAY).due, '2026-11-01');
  });

  test('이미 지난 월/일은 내년, 없는 날짜는 해석하지 않고 제목에 남긴다', () => {
    assert.equal(T.parseQuickInput('1/5 시험', TODAY).due, '2027-01-05');
    assert.equal(T.parseQuickInput('12/31 정산', TODAY).due, '2026-12-31');
    const bad = T.parseQuickInput('2/30 정산', TODAY);
    assert.equal(bad.due, null);
    assert.equal(bad.title, '2/30 정산');
  });

  test('날짜가 없으면 제목만', () => {
    assert.deepEqual(T.parseQuickInput('  서평   쓰기 ', TODAY), { title: '서평 쓰기', due: null, slot: null });
  });

  test('시각이 자정을 넘기는 칸은 만들지 않는다', () => {
    assert.equal(T.parseQuickInput('오늘 23:30 정리 2시간', TODAY).slot, null);
  });
});

describe('할 일 한 건 검사', () => {
  test('제목 필수, 영역은 모르는 값이면 기타', () => {
    assert.throws(() => T.normalizeTask({ title: '  ' }), /제목/);
    assert.equal(T.normalizeTask({ title: 'a', area: '없는영역' }).area, '기타');
    assert.equal(T.normalizeTask({ title: 'a', area: '대학원' }).area, '대학원');
  });

  test('잘못된 날짜·종류·칸은 조용히 고치지 않고 오류', () => {
    assert.throws(() => T.normalizeTask({ title: 'a', due: '2026-13-01x' }), /마감일/);
    assert.throws(() => T.normalizeTask({ title: 'a', kind: 'daily' }), /종류/);
    assert.throws(() => T.normalizeTask({ title: 'a', slot: { date: TODAY, start: '25:00', min: 30 } }), /시작 시각/);
    assert.throws(() => T.normalizeTask({ title: 'a', slot: { date: TODAY, start: '23:30', min: 60 } }), /자정/);
    assert.throws(() => T.normalizeTask({ title: 'a', link: 'javascript:alert(1)' }), /링크/);
  });

  test('id는 DB 키로 안전한 것만', () => {
    assert.equal(T.isValidId('t1abc'), true);
    for (const bad of ['', 'a/b', 'a.b', 'a b', 'a#b', '$x', 'x'.repeat(65)]) assert.equal(T.isValidId(bad), false, bad);
    assert.equal(T.isValidId(T.newTaskId(1790000000000, () => 0.5)), true);
  });

  test('새 id는 연달아 만들어도 겹치지 않는다', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(T.newTaskId(1790000000000));
    assert.ok(ids.size > 480);   // 같은 밀리초에 무작위 꼬리로 갈라진다
  });
});

describe('쓰기 계획(patch)', () => {
  test('추가 → 완료 → 되돌리기를 메모리에 반영하면 같은 상태로 돌아온다', () => {
    let p = {};
    const add = T.planAddTask({ title: '고사원안 검토', area: '수업', due: '2026-10-28' }, { id: 'ta', now: NOW });
    p = PE.applyPatch(p, add);
    assert.equal(p.tasks.ta.status, 'open');
    const t = T.listTasks(p)[0];
    p = PE.applyPatch(p, T.planComplete(t, { now: NOW }));
    assert.equal(p.tasks.ta.status, 'done');
    assert.equal(p.tasks.ta.doneAt, NOW);
    p = PE.applyPatch(p, T.planUndoComplete(T.listTasks(p)[0], { now: NOW }));
    assert.equal(p.tasks.ta.status, 'open');
    assert.equal('doneAt' in p.tasks.ta, false);   // null 은 지워진다(Firebase와 같게)
  });

  test('필드 단위로 쓴다 — 다른 필드는 건드리지 않는다', () => {
    const patch = T.planComplete(task('ta', { title: 'x' }), { now: NOW });
    assert.deepEqual(Object.keys(patch).sort(), ['tasks/ta/doneAt', 'tasks/ta/status', 'tasks/ta/updatedAt']);
  });

  test('이미 끝난 것을 또 완료해도 아무것도 쓰지 않는다 (두 기기가 동시에 눌러도 안전)', () => {
    assert.deepEqual(T.planComplete(task('ta', { status: 'done' }), { now: NOW }), {});
    assert.deepEqual(T.planUndoComplete(task('ta'), { now: NOW }), {});
  });

  test('미루기는 마감을 옮기고 지난 칸·오늘 표시를 비운다', () => {
    const t = task('ta', { due: '2026-10-20', today: '2026-10-22', slot: { date: '2026-10-22', start: '10:00', min: 30 } });
    const p = PE.applyPatch({ tasks: { ta: { title: 'ta', status: 'open', due: t.due, today: t.today, slot: t.slot } } }, T.planPostpone(t, '2026-10-30', { now: NOW }));
    assert.equal(p.tasks.ta.due, '2026-10-30');
    assert.equal(p.tasks.ta.today, undefined);
    assert.equal(p.tasks.ta.slot, undefined);
  });

  test('수정도 같은 검사를 거친다', () => {
    const t = task('ta', { title: 'a' });
    assert.throws(() => T.planEditTask(t, { title: '' }, { now: NOW }), /제목/);
    const patch = T.planEditTask(t, { title: '새 제목', link: '' }, { now: NOW });
    assert.equal(patch['tasks/ta/title'], '새 제목');
    assert.equal(patch['tasks/ta/link'], null);
    assert.equal('tasks/ta/due' in patch, false);
  });

  test('planner 밖 경로는 DB에 보내지 못한다', () => {
    assert.doesNotThrow(() => T.assertPlannerPatch({ 'tasks/ta': {}, 'tasks/ta/status': 'done', 'settings/reviewedOn': TODAY, 'rules/r1/skip/2026-10-23': true, 'log/l1': {} }));
    for (const bad of ['semester', 'timetables', 'v2/semester', 'curriculum/x', 'tasks', 'tasks/a/b/c', '../x', 'profile', 'archive/2026-2', 'users/x/v2']) {
      assert.throws(() => T.assertPlannerPatch({ [bad]: 1 }), /planner/, bad);
    }
  });

  test('새 학기 시작 patch 는 planner 경로를 건드리지 않고, planner patch 는 진도 경로를 건드리지 않는다', () => {
    const data = { ...schoolData(), curriculum: { '101_역사': { 1: 'a' } } };
    const sem = PE.planStartSemester(data, { id: '2027-1', start: '2027-03-02', end: '2027-07-20' }, { mon: { 1: { class: '101', subject: '역사' } } }, { at: NOW });
    for (const k of Object.keys(sem)) assert.ok(!/^(tasks|rules|settings|planner)(\/|$)/.test(k), k);
    assert.throws(() => T.assertPlannerPatch(sem), /planner/);
  });
});

describe('분류', () => {
  const tasks = [
    task('w', { kind: 'watch', title: '종목' }),
    task('today1', { today: TODAY }),
    task('slotToday', { slot: { date: TODAY, start: '13:20', min: 45 } }),
    task('dueToday', { due: TODAY }),
    task('over', { due: '2026-10-20' }),
    task('overSlot', { slot: { date: '2026-10-22', start: '13:20', min: 45 } }),
    task('overToday', { today: '2026-10-22' }),
    task('week', { due: '2026-10-30' }),
    task('weekEdge', { due: '2026-10-30' }),
    task('later', { due: '2026-10-31' }),
    task('none', {}),
    task('done', { status: 'done', due: '2026-10-01', doneAt: NOW }),
    task('arch', { status: 'archived' }),
  ];
  const c = T.classify(tasks, TODAY);
  const ids = k => c[k].map(t => t.id).sort();

  test('묶음', () => {
    assert.deepEqual(ids('watch'), ['w']);
    assert.deepEqual(ids('today'), ['dueToday', 'slotToday', 'today1']);
    assert.deepEqual(ids('overdue'), ['over', 'overSlot', 'overToday']);
    assert.deepEqual(ids('week'), ['week', 'weekEdge']);
    assert.deepEqual(ids('later'), ['later']);
    assert.deepEqual(ids('undated'), ['none']);
    assert.deepEqual(ids('done'), ['done']);
    assert.deepEqual(ids('archived'), ['arch']);
  });

  test('한 건은 정확히 한 묶음에만 들어간다', () => {
    const all = Object.values(c).flat().map(t => t.id);
    assert.equal(all.length, tasks.length);
    assert.equal(new Set(all).size, tasks.length);
  });

  test('오늘로 고른 마감 지난 일은 오늘 묶음, 다음 날 안 끝났으면 다시 마감 지남', () => {
    const t = task('x', { due: '2026-10-20', today: TODAY });
    assert.deepEqual(T.classify([t], TODAY).today.map(v => v.id), ['x']);
    assert.deepEqual(T.classify([t], '2026-10-24').overdue.map(v => v.id), ['x']);
  });

  test('마감 순으로 정렬', () => {
    const s = T.classify([task('b', { due: '2026-10-29' }), task('a', { due: '2026-10-25' })], TODAY).week;
    assert.deepEqual(s.map(t => t.id), ['a', 'b']);
  });
});

describe('매일 정리', () => {
  const tasks = [task('over', { due: '2026-10-20' }), task('ok', { due: '2026-10-30' })];

  test('마감 지난 것이 있고 오늘 정리를 안 했으면 그 목록', () => {
    assert.deepEqual(T.reviewList(tasks, TODAY, {}).map(t => t.id), ['over']);
  });

  test('오늘 정리를 마쳤으면 비어 있다, 다음 날엔 다시', () => {
    assert.deepEqual(T.reviewList(tasks, TODAY, { reviewedOn: TODAY }), []);
    assert.equal(T.reviewList(tasks, '2026-10-24', { reviewedOn: TODAY }).length, 1);
  });

  test('결정 → patch', () => {
    const t = tasks[0];
    assert.equal(T.planReviewAction(t, 'today', { today: TODAY, now: NOW })['tasks/over/today'], TODAY);
    assert.equal(T.planReviewAction(t, 'postpone', { date: '2026-11-02', now: NOW })['tasks/over/due'], '2026-11-02');
    assert.equal(T.planReviewAction(t, 'archive', { now: NOW })['tasks/over/status'], 'archived');
    assert.throws(() => T.planReviewAction(t, 'later', { now: NOW }), /알 수 없는/);
    assert.deepEqual(T.planMarkReviewed(TODAY), { 'settings/reviewedOn': TODAY });
  });

  test('정리하고 나면 마감 지남이 비어 목록에 다시 뜨지 않는다 (미루기)', () => {
    let p = { tasks: { over: { title: 'o', status: 'open', due: '2026-10-20' } } };
    p = PE.applyPatch(p, T.planReviewAction(T.listTasks(p)[0], 'postpone', { date: '2026-10-27', now: NOW }));
    assert.equal(T.classify(T.listTasks(p), TODAY).overdue.length, 0);
  });
});

describe('오늘 상한', () => {
  const mk = n => Array.from({ length: n }, (_, i) => task(`c${i}`, { today: TODAY }));

  test('상한 미만이면 고를 수 있다', () => {
    assert.equal(T.checkTodayAdd(mk(4), task('n'), TODAY).ok, true);
  });

  test('상한(기본 5)에 닿으면 막고, 뺄 후보를 돌려준다', () => {
    const r = T.checkTodayAdd(mk(5), task('n'), TODAY);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cap');
    assert.equal(r.chosen.length, 5);
  });

  test('마감만 오늘인 것·지켜보기·끝난 것은 세지 않고, 이미 고른 것을 다시 고르는 건 허용', () => {
    const tasks = [...mk(4), task('due', { due: TODAY }), task('w', { kind: 'watch', today: TODAY }), task('d', { status: 'done', today: TODAY })];
    assert.equal(T.checkTodayAdd(tasks, task('n'), TODAY).ok, true);
    assert.equal(T.checkTodayAdd(mk(5), mk(5)[0], TODAY).ok, true);
  });

  test('칸에 놓은 것도 오늘 고른 것으로 센다', () => {
    const tasks = [...mk(4), task('s', { slot: { date: TODAY, start: '16:00', min: 30 } })];
    assert.equal(T.checkTodayAdd(tasks, task('n'), TODAY).ok, false);
  });

  test('설정으로 상한을 바꾸고, 이상한 값은 기본값', () => {
    assert.equal(T.checkTodayAdd(mk(3), task('n'), TODAY, { todayCap: 3 }).ok, false);
    assert.equal(T.resolveSettings({ todayCap: 0 }).todayCap, 5);
    assert.equal(T.resolveSettings({ todayCap: 99 }).todayCap, 5);
    assert.equal(T.resolveSettings({ todayCap: 'x' }).todayCap, 5);
  });
});

describe('하루 칸 — 수업과 겹침', () => {
  const d = schoolData();   // 금요일: 2교시 09:55~10:40, 4교시 11:45~12:30

  test('수업 블록 (시각 순, 수업 없는 교시는 없음)', () => {
    const b = T.busyBlocks(d, TODAY);
    assert.deepEqual(b.map(x => [x.p, x.start, x.end, x.kind]), [[2, 595, 640, 'class'], [4, 705, 750, 'class']]);
    assert.equal(b[0].label, '102 역사');
    assert.deepEqual([b[0].cls, b[0].subject], ['102', '역사']);   // 달력이 차시·주제를 찾는 데 쓴다
  });

  test('휴업일은 블록이 없고, 행사 교시는 막힌다', () => {
    const hol = schoolData({ calendar: { [TODAY]: { all: { type: 'holiday', label: '재량휴업' } } } });
    assert.deepEqual(T.busyBlocks(hol, TODAY), []);
    const ev = schoolData({ calendar: { [TODAY]: { 2: { type: 'event', label: '학생 상담' } } } });
    assert.deepEqual(T.busyBlocks(ev, TODAY).map(x => [x.p, x.kind, x.label]), [[2, 'event', '학생 상담'], [4, 'class', '103 역사']]);
  });

  test('수업없음(noclass) 교시는 블록이 없어 할 일을 놓을 수 있다', () => {
    const nc = schoolData({ calendar: { [TODAY]: { 2: { type: 'noclass', label: '수업 없음' } } } });
    assert.deepEqual(T.busyBlocks(nc, TODAY).map(x => x.p), [4]);
    assert.equal(T.slotConflict(nc, [], TODAY, '09:55', 45).ok, true);
  });

  test('하루만 바꾼 시간표(dayOverrides)를 따른다', () => {
    const o = schoolData({ dayOverrides: { [TODAY]: { 1: { class: '105', subject: '역사' } } } });
    assert.deepEqual(T.busyBlocks(o, TODAY).map(x => x.p), [1]);
  });

  test('수업과 겹치면 못 놓고, 맞닿는 건 된다', () => {
    assert.equal(T.slotConflict(d, [], TODAY, '10:00', 30).reason, 'class');
    assert.equal(T.slotConflict(d, [], TODAY, '10:40', 30).ok, true);   // 2교시가 끝나는 시각
    assert.equal(T.slotConflict(d, [], TODAY, '10:10', 30).reason, 'class');
    assert.equal(T.slotConflict(d, [], TODAY, '10:40', 70).reason, 'class');   // 11:50 — 4교시(11:45) 침범
    assert.equal(T.slotConflict(d, [], TODAY, '10:40', 65).ok, true);          // 11:45 — 4교시와 맞닿음
  });

  test('이미 놓은 다른 할 일과 겹치면 못 놓고, 자기 자신은 무시', () => {
    const other = task('o', { slot: { date: TODAY, start: '13:00', min: 60 } });
    assert.equal(T.slotConflict(d, [other], TODAY, '13:30', 30).reason, 'task');
    assert.equal(T.slotConflict(d, [other], TODAY, '13:30', 30, { ignoreId: 'o' }).ok, true);
    assert.equal(T.slotConflict(d, [other], TODAY, '14:00', 30).ok, true);
    const done = task('o2', { status: 'done', slot: { date: TODAY, start: '13:00', min: 60 } });
    assert.equal(T.slotConflict(d, [done], TODAY, '13:30', 30).ok, true);
    const other2 = task('o3', { slot: { date: '2026-10-26', start: '13:00', min: 60 } });
    assert.equal(T.slotConflict(d, [other2], TODAY, '13:30', 30).ok, true);   // 다른 날
  });

  test('하루 시작 전은 못 놓고, 22시 넘어 자정까지는 예외로 놓을 수 있다', () => {
    assert.equal(T.slotConflict(d, [], TODAY, '06:30', 30).reason, 'range');
    assert.equal(T.slotConflict(d, [], TODAY, '21:30', 60).ok, true);
    assert.equal(T.slotConflict(d, [], TODAY, '23:00', 60).ok, true);
    assert.equal(T.slotConflict(d, [], TODAY, '23:30', 60).reason, 'range');
    assert.equal(T.slotConflict(d, [], TODAY, '21:00', 60).ok, true);
    assert.equal(T.slotConflict(d, [], TODAY, '06:30', 30, { settings: { dayStart: '06:00' } }).ok, true);
  });

  test('빈 시간 — 수업과 놓은 할 일을 뺀다, 짧은 틈은 뺀다', () => {
    const free = T.freeIntervals(d, [task('o', { slot: { date: TODAY, start: '13:00', min: 60 } })], TODAY);
    assert.deepEqual(free, [
      { start: 420, end: 595 },   // 07:00~09:55
      { start: 640, end: 705 },   // 10:40~11:45
      { start: 750, end: 780 },   // 12:30~13:00
      { start: 840, end: 1320 },  // 14:00~22:00
    ]);
    const tight = T.freeIntervals(d, [task('o', { slot: { date: TODAY, start: '10:40', min: 55 } })], TODAY);
    assert.ok(!tight.some(f => f.start === 640));   // 10분 남은 틈(11:35~11:45)도 15분 미만이라 없다
  });

  test('시간표가 없는 날·주말은 하루 전체가 빈다', () => {
    assert.deepEqual(T.freeIntervals(d, [], '2026-10-24'), [{ start: 420, end: 1320 }]);
  });
});

describe('반복 규칙', () => {
  test('매주 요일', () => {
    const rules = { r1: T.normalizeRule({ title: '동아리 출결', area: '학교', every: 'weekly', dow: 'wed' }) };
    assert.deepEqual(T.expandRules(rules, '2026-10-23', '2026-11-12').map(o => o.date), ['2026-10-28', '2026-11-04', '2026-11-11']);
  });

  test('매월 첫째 월요일·마지막 금요일', () => {
    const first = { r: T.normalizeRule({ title: '회의', every: 'monthly', dow: 'mon', nth: 1 }) };
    assert.deepEqual(T.expandRules(first, '2026-10-01', '2026-12-31').map(o => o.date), ['2026-10-05', '2026-11-02', '2026-12-07']);
    const last = { r: T.normalizeRule({ title: '보고', every: 'monthly', dow: 'fri', nth: 5 }) };
    assert.deepEqual(T.expandRules(last, '2026-10-01', '2026-12-31').map(o => o.date), ['2026-10-30', '2026-11-27', '2026-12-25']);
  });

  test('매월 N일 — 없는 날은 그 달 마지막 날, 끝날 이후는 없음', () => {
    const r = { r: T.normalizeRule({ title: '정산', every: 'monthly', day: 31, until: '2027-01-31' }) };
    assert.deepEqual(T.expandRules(r, '2026-11-01', '2027-03-31').map(o => o.date), ['2026-11-30', '2026-12-31', '2027-01-31']);
  });

  test('잘못된 규칙은 오류, 꺼 둔 규칙은 펼치지 않는다', () => {
    assert.throws(() => T.normalizeRule({ title: 'a', every: 'daily' }), /weekly/);
    assert.throws(() => T.normalizeRule({ title: 'a', every: 'weekly', dow: 'xyz' }), /요일/);
    assert.throws(() => T.normalizeRule({ title: 'a', every: 'monthly', day: 40 }), /1~31/);
    assert.throws(() => T.normalizeRule({ title: 'a', every: 'monthly', dow: 'mon' }), /몇째/);
    assert.deepEqual(T.expandRules({ r: { ...T.normalizeRule({ title: 'a', every: 'weekly', dow: 'mon' }), active: false } }, '2026-10-01', '2026-12-31'), []);
  });

  test('펼치기는 여러 번·여러 기기에서 해도 한 건만 만들어진다', () => {
    let planner = { rules: { r1: T.normalizeRule({ title: '회의', area: '학생회', every: 'weekly', dow: 'mon' }) } };
    const first = T.planMaterialize(planner, TODAY, { now: NOW });
    assert.deepEqual(Object.keys(first), ['tasks/r_r1_20261026', 'tasks/r_r1_20261102']);
    planner = PE.applyPatch(planner, first);
    assert.deepEqual(T.planMaterialize(planner, TODAY, { now: NOW }), {});   // 두 번째는 할 일 없음
    assert.equal(planner.tasks.r_r1_20261026.due, '2026-10-26');
    assert.equal(planner.tasks.r_r1_20261026.ruleId, 'r1');
    T.assertPlannerPatch(first);
  });

  test('지워서 skip 에 적은 날짜는 다시 만들지 않는다', () => {
    let planner = { rules: { r1: T.normalizeRule({ title: '회의', every: 'weekly', dow: 'mon' }) } };
    planner = PE.applyPatch(planner, T.planSkipRuleDate('r1', '2026-10-26'));
    assert.deepEqual(Object.keys(T.planMaterialize(planner, TODAY, { now: NOW })), ['tasks/r_r1_20261102']);
  });

  test('격주 — 기준 주부터 2주마다, 기준 주 이전은 없다', () => {
    const r = { r: T.normalizeRule({ title: '블로그', every: 'weekly', dow: 'sun', interval: 2, start: '2026-10-25' }) };
    assert.deepEqual(T.expandRules(r, '2026-10-01', '2026-12-06').map(o => o.date), ['2026-10-25', '2026-11-08', '2026-11-22', '2026-12-06']);
    assert.throws(() => T.normalizeRule({ title: 'a', every: 'weekly', dow: 'mon', interval: 2 }), /첫 날짜/);
    assert.throws(() => T.normalizeRule({ title: 'a', every: 'weekly', dow: 'mon', interval: 0 }), /1~8/);
  });

  test('규칙 고치기·지우기 — 앞날 열린 건만 정리하고 skip·끝낸 건은 둔다', () => {
    let planner = { rules: { r1: T.normalizeRule({ title: '회의', area: '학생회', every: 'weekly', dow: 'mon' }) } };
    planner = PE.applyPatch(planner, T.planSkipRuleDate('r1', '2026-10-26'));
    planner = PE.applyPatch(planner, { 'tasks/r_r1_20261019': { title: '회의', status: 'done', due: '2026-10-19', ruleId: 'r1' }, 'tasks/r_r1_20261102': { title: '회의', status: 'open', due: '2026-11-02', ruleId: 'r1' } });
    const edit = T.planEditRule(planner, 'r1', { title: '회의', every: 'weekly', dow: 'tue' }, { today: TODAY });
    assert.equal(edit['rules/r1/dow'], 'tue');
    assert.equal(edit['rules/r1/nth'], null);
    assert.equal(edit['tasks/r_r1_20261102'], null);         // 월요일 건은 화요일 규칙에 안 맞아 지움
    assert.ok(!('tasks/r_r1_20261019' in edit));              // 지난·끝낸 건은 그대로
    T.assertPlannerPatch(edit);
    const after = PE.applyPatch(planner, edit);
    assert.equal(after.rules.r1.skip['2026-10-26'], true);    // skip 목록 보존
    const del = T.planDeleteRule(planner, 'r1', { today: TODAY });
    assert.deepEqual(Object.keys(del).sort(), ['rules/r1', 'tasks/r_r1_20261102']);
    T.assertPlannerPatch(del);
    assert.throws(() => T.planEditRule(planner, 'nope', { title: 'a', every: 'weekly', dow: 'mon' }, { today: TODAY }), /찾을 수/);
  });

  test('규칙에서 생긴 건 마감 날에 오늘 묶음으로 들어온다', () => {
    const planner = { rules: { r1: T.normalizeRule({ title: '회의', every: 'weekly', dow: 'mon' }) } };
    const p = PE.applyPatch(planner, T.planMaterialize(planner, '2026-10-26', { now: NOW }));
    assert.equal(T.classify(T.listTasks(p), '2026-10-26').today.length, 1);
  });
});

describe('데이터 모양', () => {
  test('DB가 빈 값을 안 돌려줘도 화면용 모양은 항상 같다', () => {
    assert.deepEqual(T.listTasks(undefined), []);
    assert.deepEqual(T.listTasks({}), []);
    const t = T.listTasks({ tasks: { a: { title: 'x', status: 'open' } } })[0];
    assert.equal(t.slot, null);
    assert.equal(t.today, null);
    assert.equal(t.area, '기타');
  });

  test('칸 놓기/빼기', () => {
    const t = task('a', { today: TODAY });
    const on = T.planSetSlot(t, { date: TODAY, start: '13:20', min: 45 }, { now: NOW });
    assert.deepEqual(on['tasks/a/slot'], { date: TODAY, start: '13:20', min: 45 });
    assert.equal(on['tasks/a/today'], null);   // 칸이 곧 오늘 표시
    const off = T.planSetSlot(task('a', { today: TODAY, slot: { date: TODAY, start: '13:20', min: 45 } }), null, { now: NOW });
    assert.equal(off['tasks/a/slot'], null);
    assert.throws(() => T.planSetSlot(t, { date: TODAY, start: '13:20', min: 2 }, { now: NOW }), /5분/);
  });

  test('오늘 할 일에서 뺄 때: 칸을 비워도 today 는 그대로라서 today 지우기를 따로 합쳐야 한다 (planner.js unpinPatch)', () => {
    const t = task('a', { today: TODAY, slot: { date: TODAY, start: '13:20', min: 45 } });
    const slotOff = T.planSetSlot(t, null, { now: NOW });
    assert.equal(slotOff['tasks/a/today'], TODAY);   // 칸만 비우면 today 가 남는다
    const merged = { ...slotOff, ...T.planSetToday(t, null, { now: NOW }) };   // 뒤에 합친 쪽이 이긴다
    assert.equal(merged['tasks/a/today'], null);
    assert.equal(merged['tasks/a/slot'], null);
  });
});

describe('날짜 없음 순서(끌어서 정하기)', () => {
  test('순서를 정한 건 먼저, 안 정한 건 그 뒤에 만든 순서로', () => {
    const s = T.classify([task('c', { createdAt: '2026-10-03' }), task('b', { order: 2000 }), task('a', { order: 1000 }), task('d', { createdAt: '2026-10-02' })], TODAY).undated;
    assert.deepEqual(s.map(v => v.id), ['a', 'b', 'd', 'c']);
  });
  test('planReorder 는 값이 달라진 것만 쓰고 허용된 경로만 만든다', () => {
    const list = [task('a', { order: 1000 }), task('b', { order: 3000 }), task('c')];
    const p = T.planReorder([list[1], list[0], list[2]], { now: NOW });   // b, a, c
    assert.deepEqual(Object.keys(p).filter(k => k.endsWith('/order')).sort(), ['tasks/a/order', 'tasks/b/order', 'tasks/c/order']);
    assert.equal(p['tasks/b/order'], 1000);
    assert.equal(p['tasks/a/order'], 2000);
    assert.doesNotThrow(() => T.assertPlannerPatch(p));
    assert.deepEqual(T.planReorder([task('x', { order: 1000 })], { now: NOW }), {});
  });
  test('마감이 있는 묶음은 order 가 있어도 마감순', () => {
    const w = T.classify([task('b', { due: '2026-10-29', order: 1 }), task('a', { due: '2026-10-25', order: 9 })], TODAY).week;
    assert.deepEqual(w.map(v => v.id), ['a', 'b']);
  });
});

// ---- 애매한 기간 ----

test('애매한 기간: 프리셋이 모두 끝날짜로 풀린다', () => {
  for (const p of T.FUZZY_PRESETS) {
    const f = T.resolveFuzzy(p, '2026-10-23');   // 금요일
    assert.ok(f && /^\d{4}-\d{2}-\d{2}$/.test(f.due) && f.due >= '2026-10-23', p);
    assert.equal(f.dueText, p);
  }
});

test('애매한 기간: 날짜 계산', () => {
  const d = l => T.resolveFuzzy(l, '2026-10-23').due;
  assert.equal(d('이번 주 중'), '2026-10-23');
  assert.equal(d('다음 주 중'), '2026-10-30');
  assert.equal(d('이번 달 중'), '2026-10-31');
  assert.equal(d('다음 달 중'), '2026-11-30');
  assert.equal(d('한 달 내'), '2026-11-23');
  assert.equal(d('3개월 내'), '2027-01-23');
  assert.equal(d('올해 안'), '2026-12-31');
  assert.equal(d('2주 내'), '2026-11-06');
  assert.equal(d('3월 중'), '2027-03-31');
  assert.equal(T.resolveFuzzy('1월 31일', '2026-10-23'), null);
  assert.equal(T.resolveFuzzy('2026-01-31 한 달 내', '2026-01-31'), null);
  assert.equal(T.resolveFuzzy('한 달 내', '2026-01-31').due, '2026-02-28');
});

test('애매한 기간: 한 줄 입력', () => {
  const p = T.parseQuickInput('논문 읽기 한 달 내', '2026-10-23');
  assert.equal(p.title, '논문 읽기'); assert.equal(p.due, '2026-11-23'); assert.equal(p.dueText, '한 달 내');
  const q = T.parseQuickInput('이번 달 안에 서평 쓰기', '2026-10-23');
  assert.equal(q.title, '서평 쓰기'); assert.equal(q.due, '2026-10-31'); assert.equal(q.dueText, '이번 달 중');
  const r = T.parseQuickInput('보고서 3개월 이내', '2026-10-23');
  assert.equal(r.dueText, '3개월 내');
  // 요일과 섞이지 않는다
  const w = T.parseQuickInput('다음주 금요일 보고서', '2026-10-23');
  assert.equal(w.due, '2026-10-30'); assert.equal(w.dueText, undefined); assert.equal(w.title, '보고서');
  assert.equal(T.parseQuickInput('10월 중 연수', '2026-10-23').dueText, '10월 중');
});

test('애매한 기간: 저장 모양', () => {
  const t = T.normalizeTask({ title: 'x', due: '2026-11-23', dueText: '한 달 내' }, { now: 'n' });
  assert.equal(t.dueText, '한 달 내');
  assert.equal(T.normalizeTask({ title: 'x', dueText: '한 달 내' }, { now: 'n' }).dueText, undefined);
  const patch = T.planEditTask({ id: 'a1', title: 'x', area: '기타', kind: 'once', due: '2026-11-23', dueText: '한 달 내', slot: null }, { due: '2026-12-01', dueText: null }, { now: 'n' });
  assert.equal(patch['tasks/a1/dueText'], null);
  assert.doesNotThrow(() => T.assertPlannerPatch(patch));
});

describe('수업 준비 자동 만들기', () => {
  // 201 A·202 A 는 같은 진도표. 201 A 는 월 3교시(10/19 = 12차시), 202 A 는 화 2교시(10/20 = 11차시)
  const prepData = () => ({
    semester: { id: 'T', start: '2026-08-18', end: '2027-01-08' },
    periods: { 2: { start: '09:55', end: '10:40' }, 3: { start: '10:50', end: '11:35' } },
    timetables: { '2026-08-18': { mon: { 3: { class: '201 A', subject: '역사A' } }, tue: { 2: { class: '202 A', subject: '역사A' } } } },
    pins: { '201 A_역사A': { '2026-10-19_3': { step: 12 } }, '202 A_역사A': { '2026-10-20_2': { step: 11 } } },
    curriculum: {
      '201 A_역사A': { 12: '프랑스 혁명(1)', 13: '나폴레옹', 14: '글쓰기' },
      '202 A_역사A': { 12: '프랑스 혁명(1)', 13: '나폴레옹', 14: '글쓰기' },
    },
  });
  const gid = d => T.prepGroups(d)[0].id;

  test('같은 진도표 반은 한 묶음, 가장 먼저 가르치는 반의 전날이 마감', () => {
    const d = prepData();
    assert.equal(T.prepGroups(d).length, 1);
    const patch = T.planPrepSync({}, d, TODAY, { now: NOW });
    const id = T.prepTaskId(gid(d), 13);
    assert.deepEqual(Object.keys(patch), [`tasks/${id}`]);   // 12차시는 이미 가르침, 14차시는 7일 밖
    const t = patch[`tasks/${id}`];
    assert.equal(t.title, '수업 준비 · 역사A 13차시 나폴레옹');
    assert.equal(t.due, '2026-10-23'); assert.equal(t.prepDue, '2026-10-23'); assert.equal(t.src, 'prep'); assert.equal(t.area, '수업');
    assert.match(t.note, /첫 수업 10\/26\(월\) 3교시 201 A/);
    assert.match(t.note, /202 A 11\/3\(화\) 2교시/);
    assert.doesNotThrow(() => T.assertPlannerPatch(patch));
  });

  test('첫 수업이 7일 밖이면 아직 만들지 않는다', () => {
    const d = prepData();
    for (const k of Object.keys(d.curriculum)) d.curriculum[k][14] = '산업혁명';
    assert.equal(Object.keys(T.planPrepSync({}, d, TODAY, { now: NOW })).length, 1);
    assert.equal(Object.keys(T.planPrepSync({}, d, TODAY, { now: NOW, horizonDays: 30 })).length, 2);
  });

  test('글쓰기·복습·마지막 정리·독서는 만들지 않는다', () => {
    const d = prepData();
    const ids = Object.keys(T.planPrepSync({}, d, TODAY, { now: NOW, horizonDays: 30 }));
    assert.equal(ids.length, 1);
    for (const w of ['복습', '마지막 정리', '독서3']) assert.ok(T.PREP_EXCLUDE.test(w));
  });

  test('두 번 돌려도 그대로, 지운 건 안 만들고, 끝낸 건 안 건드린다', () => {
    const d = prepData();
    const patch = T.planPrepSync({}, d, TODAY, { now: NOW });
    const planner = PE.applyPatch({ tasks: {} }, patch);
    assert.deepEqual(T.planPrepSync(planner, d, TODAY, { now: NOW }), {});
    const id = T.prepTaskId(gid(d), 13);
    assert.deepEqual(T.planPrepSync({ prepSkip: { [id]: true } }, d, TODAY, { now: NOW }), {});
    const done = PE.applyPatch(planner, T.planComplete(T.shapeTask(id, planner.tasks[id]), { now: NOW }));
    d.timetables['2026-08-18'].mon[3] = { class: '201 A', subject: '역사A' };
    assert.deepEqual(T.planPrepSync(done, d, TODAY, { now: NOW }), {});
  });

  test('수업일이 밀리면 자동 마감만 따라가고, 직접 고친 마감은 둔다', () => {
    const d = prepData();
    const planner = PE.applyPatch({ tasks: {} }, T.planPrepSync({}, d, TODAY, { now: NOW }));
    const id = T.prepTaskId(gid(d), 13);
    d.calendar = { '2026-10-26': { all: { type: 'event', label: '행사' } } };   // 10/26 수업 없음 → 13차시는 201 A 11/2(월), 202 A 11/3(화)
    const moved = T.planPrepSync(planner, d, TODAY, { now: NOW });
    assert.equal(moved[`tasks/${id}/due`], '2026-10-30');   // 첫 수업이 11/2(월)로 밀려 전날은 주말이라 금요일

    const edited = PE.applyPatch(planner, { [`tasks/${id}/due`]: '2026-10-24' });
    assert.deepEqual(T.planPrepSync(edited, d, TODAY, { now: NOW }), {});
  });
});

describe('기간에 오늘·내일, 방금 추가', () => {
  test('오늘·내일을 기간으로 고를 수 있다', () => {
    assert.deepEqual(T.resolveFuzzy('오늘', '2026-10-25'), { due: '2026-10-25', dueText: '오늘' });
    assert.deepEqual(T.resolveFuzzy('내일', '2026-10-25'), { due: '2026-10-26', dueText: '내일' });
    assert.ok(T.FUZZY_PRESETS.includes('오늘') && T.FUZZY_PRESETS.includes('내일'));
  });
  test('오늘 직접 적은 일만 방금 추가로 본다 (반복·수업 준비·끝낸 일 제외)', () => {
    const base = { status: 'open', kind: 'once', src: 'app', createdAt: '2026-10-25 09:00:00' };
    assert.equal(T.isFresh(base, '2026-10-25'), true);
    assert.equal(T.isFresh({ ...base, createdAt: '2026-10-24 09:00:00' }, '2026-10-25'), false);
    assert.equal(T.isFresh({ ...base, ruleId: 'r1' }, '2026-10-25'), false);
    assert.equal(T.isFresh({ ...base, src: 'prep', prepDue: '2026-10-26' }, '2026-10-25'), false);
    assert.equal(T.isFresh({ ...base, status: 'done' }, '2026-10-25'), false);
    assert.equal(T.isFresh({ ...base, kind: 'watch' }, '2026-10-25'), false);
  });
});

describe('여러 줄 붙여넣기 (splitBulkLines)', () => {
  test('글머리표·번호·체크박스를 떼고 빈 줄은 버린다', () => {
    const text = '- 논문 읽기 10/30까지\n\n2. 고사원안 검토\n- [ ] 서평 쓰기\n   \n• 회의 내일 15시\r\n(3) 자치 활동 기재록';
    assert.deepEqual(T.splitBulkLines(text),
      ['논문 읽기 10/30까지', '고사원안 검토', '서평 쓰기', '회의 내일 15시', '자치 활동 기재록']);
  });
  test('제목이 숫자로 시작해도 번호로 오해하지 않는다', () => {
    assert.deepEqual(T.splitBulkLines('2학년 수행 결시자 응시 기회\n10/30 고사원안 제출'),
      ['2학년 수행 결시자 응시 기회', '10/30 고사원안 제출']);
  });
  test('한 줄이면 그대로, 최대 50줄', () => {
    assert.deepEqual(T.splitBulkLines('학생회 안건 정리'), ['학생회 안건 정리']);
    assert.equal(T.splitBulkLines(Array.from({ length: 60 }, (_, i) => `일 ${i}`).join('\n')).length, 50);
    assert.deepEqual(T.splitBulkLines(''), []);
  });
  test('줄마다 parseQuickInput 으로 날짜가 읽힌다', () => {
    const [a, b] = T.splitBulkLines('- 논문 읽기 10/30까지\n- 회의 내일 15시 1시간').map(l => T.parseQuickInput(l, TODAY));
    assert.equal(a.due, '2026-10-30');
    assert.equal(b.slot.date, '2026-10-24');
  });
});

// 코발트 레드 책 읽기처럼 마감은 남았지만 사실상 매일 하는 일 (2026-10-25 효니 요청)
describe('매일 하는 일 (daily)', () => {
  const daily = (f = {}) => task('d', { daily: true, due: '2026-10-28', ...f });
  const ids = list => list.map(t => t.id);

  test('저장: daily 는 할 일(once)에만, dailyDone 은 그대로 보존', () => {
    const t = T.normalizeTask({ title: '책 읽기', daily: true, due: '2026-10-28', dailyDone: '2026-10-22' }, { now: NOW });
    assert.equal(t.daily, true);
    assert.equal(t.dailyDone, '2026-10-22');
    assert.equal(T.normalizeTask({ title: '지켜보기', kind: 'watch', daily: true }, { now: NOW }).daily, undefined);
    assert.equal(T.normalizeTask({ title: '그냥', due: '2026-10-28' }, { now: NOW }).daily, undefined);
  });

  test('마감 전이고 오늘 몫이 남았으면 오늘 묶음 (마감이 며칠 남아도)', () => {
    const c = T.classify([daily(), task('p', { due: '2026-10-28' })], TODAY);
    assert.deepEqual(ids(c.today), ['d']);
    assert.deepEqual(ids(c.week), ['p']);   // 같은 마감의 보통 할 일은 이번 주
  });

  test('오늘 몫을 끝내면 그날은 이번 주로 빠지고, 다음 날 다시 오늘', () => {
    const done = daily({ dailyDone: TODAY });
    assert.deepEqual(ids(T.classify([done], TODAY).today), []);
    assert.deepEqual(ids(T.classify([done], TODAY).week), ['d']);
    assert.deepEqual(ids(T.classify([done], '2026-10-24').today), ['d']);
  });

  test('마감이 지나면 오늘이 아니라 마감 지남, 마감 당일은 오늘', () => {
    assert.deepEqual(ids(T.classify([daily()], '2026-10-29').overdue), ['d']);
    assert.deepEqual(ids(T.classify([daily({ dailyDone: '2026-10-28' })], '2026-10-28').today), ['d']);
  });

  test('마감 없는 매일은 끝낼 때까지 날마다 오늘', () => {
    const t = daily({ due: null });
    assert.deepEqual(ids(T.classify([t], TODAY).today), ['d']);
    assert.deepEqual(ids(T.classify([t], '2027-03-01').today), ['d']);
  });

  test('완전히 끝내거나 보관하면 매일이어도 오늘에서 빠진다', () => {
    assert.equal(T.classify([daily({ status: 'done' })], TODAY).today.length, 0);
    assert.equal(T.classify([daily({ status: 'archived' })], TODAY).today.length, 0);
  });

  test('오늘 상한에 센다 — 오늘 몫을 끝내면 자리가 난다', () => {
    const list = [daily(), task('a', { today: TODAY }), task('b', { today: TODAY })];
    assert.equal(T.chosenFor(list, TODAY).length, 3);
    assert.equal(T.checkTodayAdd(list, task('n'), TODAY, { todayCap: 3 }).ok, false);
    const rested = [daily({ dailyDone: TODAY }), ...list.slice(1)];
    assert.equal(T.chosenFor(rested, TODAY).length, 2);
    assert.equal(T.checkTodayAdd(rested, task('n'), TODAY, { todayCap: 3 }).ok, true);
    assert.equal(T.chosenFor(rested, '2026-10-24').length, 1);   // 내일은 다시 센다
  });

  test('오늘 몫 끝 / 되돌리기 patch — planner 경로 안, 끝낸 것(status)은 건드리지 않는다', () => {
    const p = T.planDailyDone(daily(), TODAY, { now: NOW });
    assert.deepEqual(p, { 'tasks/d/dailyDone': TODAY, 'tasks/d/updatedAt': NOW });
    assert.doesNotThrow(() => T.assertPlannerPatch(p));
    assert.deepEqual(T.planDailyUndo(daily({ dailyDone: TODAY }), TODAY, { now: NOW }), { 'tasks/d/dailyDone': null, 'tasks/d/updatedAt': NOW });
    assert.deepEqual(T.planDailyUndo(daily({ dailyDone: '2026-10-22' }), TODAY, { now: NOW }), {});   // 다른 날 기록은 그대로
    assert.throws(() => T.planDailyDone(task('x'), TODAY, { now: NOW }), /매일/);
    assert.throws(() => T.planDailyDone(daily(), '내일', { now: NOW }), /날짜/);
  });

  test('고치기: 매일을 켜고 끄기 (끄면 오늘 몫 기록도 지운다)', () => {
    const on = T.planEditTask(task('d', { due: '2026-10-28' }), { daily: true }, { now: NOW });
    assert.equal(on['tasks/d/daily'], true);
    const off = T.planEditTask(daily({ dailyDone: TODAY }), { daily: false }, { now: NOW });
    assert.equal(off['tasks/d/daily'], null);
    assert.equal(off['tasks/d/dailyDone'], null);
    const keep = T.planEditTask(daily({ dailyDone: TODAY }), { title: '제목만' }, { now: NOW });
    assert.equal('tasks/d/dailyDone' in keep, false);
  });

  test('한 줄 입력: "매일"을 읽고, 하루짜리 칸은 만들지 않는다', () => {
    const a = T.parseQuickInput('코발트 레드 읽기 10/28까지 매일', TODAY);
    assert.equal(a.title, '코발트 레드 읽기');
    assert.equal(a.due, '2026-10-28');
    assert.equal(a.daily, true);
    const b = T.parseQuickInput('매일 20시 독서 10/28', TODAY);
    assert.equal(b.daily, true);
    assert.equal(b.slot, null);
    assert.equal(b.due, '2026-10-28');
    const c = T.parseQuickInput('매일 책 읽기 한 달 내', TODAY);
    assert.equal(c.daily, true);
    assert.equal(c.dueText, '한 달 내');
    assert.equal(T.parseQuickInput('매일 책 읽기', TODAY).due, null);
  });

  test('한 줄 입력: 낱말의 일부인 "매일"은 그대로 둔다', () => {
    const p = T.parseQuickInput('매일경제 스크랩 10/28', TODAY);
    assert.equal(p.daily, undefined);
    assert.equal(p.title, '매일경제 스크랩');
    assert.equal(T.parseQuickInput('매일같이 확인 10/28', TODAY).daily, undefined);
  });
});

describe('이번만 초과 (extra)', () => {
  const full = () => ['a', 'b', 'c'].map(id => task(id, { today: TODAY }));

  test('초과로 넣은 일은 상한에 세지 않고 따로 센다', () => {
    const over = task('x', { today: TODAY, extra: TODAY });
    const list = [...full(), over];
    assert.equal(T.chosenFor(list, TODAY).length, 3);
    assert.deepEqual(T.extraFor(list, TODAY).map(t => t.id), ['x']);
    assert.equal(T.checkTodayAdd(list, task('n'), TODAY, { todayCap: 3 }).ok, false);   // 상한은 그대로 찬 상태
    assert.equal(T.classify(list, TODAY).today.length, 4);                              // 오늘 묶음에는 보인다
  });

  test('다른 날에는 초과가 아니다', () => {
    const over = task('x', { today: TODAY, extra: TODAY });
    assert.equal(T.extraFor([over], '2026-10-24').length, 0);
  });

  test('planSetToday — extra 로 넣고, 빼거나 일반으로 넣으면 지운다', () => {
    const t = task('x');
    assert.deepEqual(T.planSetToday(t, TODAY, { now: NOW, extra: true }), { 'tasks/x/today': TODAY, 'tasks/x/extra': TODAY, 'tasks/x/updatedAt': NOW });
    assert.equal(T.planSetToday(t, null, { now: NOW, extra: true })['tasks/x/extra'], null);
    assert.equal(T.planSetToday(t, TODAY, { now: NOW })['tasks/x/extra'], null);
    assert.doesNotThrow(() => T.assertPlannerPatch(T.planSetToday(t, TODAY, { now: NOW, extra: true })));
  });

  test('초과 일을 지우면 초과 건수도 준다', () => {
    const over = task('x', { today: TODAY, extra: TODAY });
    assert.equal(T.extraFor([over], TODAY).length, 1);
    assert.equal(T.extraFor([], TODAY).length, 0);
  });
});

describe('일찍 끝낸 일의 칸 줄이기', () => {
  const slotTask = () => task('s1', { slot: { date: TODAY, start: '10:00', min: 60 } });
  test('칸이 끝나기 전에 끝내면 끝낸 시각까지로 줄인다 (5분 올림)', () => {
    const p = T.planComplete(slotTask(), { now: `${TODAY} 10:32:00` });
    assert.equal(p['tasks/s1/status'], 'done');
    assert.deepEqual(p['tasks/s1/slot'], { date: TODAY, start: '10:00', min: 35 });
  });
  test('칸이 끝난 뒤에 끝내면 그대로 둔다', () => {
    const p = T.planComplete(slotTask(), { now: `${TODAY} 11:20:00` });
    assert.ok(!('tasks/s1/slot' in p));
  });
  test('시작 전에 끝내도 최소 5분은 남긴다', () => {
    const p = T.planComplete(slotTask(), { now: `${TODAY} 09:40:00` });
    assert.equal(p['tasks/s1/slot'].min, 5);
  });
  test('다른 날 칸이나 칸 없는 일은 건드리지 않는다', () => {
    const other = task('s2', { slot: { date: '2026-10-24', start: '10:00', min: 60 } });
    assert.ok(!('tasks/s2/slot' in T.planComplete(other, { now: `${TODAY} 10:10:00` })));
    assert.ok(!('tasks/s3/slot' in T.planComplete(task('s3'), { now: `${TODAY} 10:10:00` })));
  });
});

describe('한 건 나누기 (planSplitTask)', () => {
  const base = () => task('a1', { title: '논문 읽기', area: '대학원', due: '2026-10-30', dueText: '이번 주', daily: true, link: 'https://x.kr', note: '메모', today: TODAY });
  test('새 건은 마감·기간·오늘·영역·매일·링크·메모를 따르고 제목에 번호가 붙는다', () => {
    const r = T.planSplitTask(base(), { id: 'a2', now: NOW });
    assert.equal(r.patch['tasks/a1/title'], '논문 읽기 (1)');
    const n = r.patch['tasks/a2'];
    assert.equal(n.title, '논문 읽기 (2)');
    assert.deepEqual([n.area, n.due, n.dueText, n.today, n.daily, n.link, n.note, n.slot, n.status], ['대학원', '2026-10-30', '이번 주', TODAY, true, 'https://x.kr', '메모', null, 'open']);
  });
  test('이미 번호가 있으면 다음 번호, 원래 제목은 그대로', () => {
    const r = T.planSplitTask(task('b1', { title: '서평 (2)' }), { id: 'b2', now: NOW });
    assert.ok(!('tasks/b1/title' in r.patch) || r.patch['tasks/b1/title'] === '서평 (2)');
    assert.equal(r.patch['tasks/b2'].title, '서평 (3)');
  });
  test('칸에 놓인 일은 원래 칸을 firstMin 으로 줄이고 새 건은 칸이 없다', () => {
    const t = task('c1', { slot: { date: TODAY, start: '10:00', min: 90 } });
    const r = T.planSplitTask(t, { id: 'c2', now: NOW, firstMin: 45 });
    assert.deepEqual(r.patch['tasks/c1/slot'], { date: TODAY, start: '10:00', min: 45 });
    assert.equal(r.patch['tasks/c2'].slot, null);
  });
  test('firstMin 이 칸 이상이거나 5분 단위가 아니면 오류', () => {
    const t = task('c1', { slot: { date: TODAY, start: '10:00', min: 60 } });
    for (const m of [60, 0, 7, null]) assert.throws(() => T.planSplitTask(t, { id: 'c2', now: NOW, firstMin: m }));
  });
  test('끝난 일·지켜보기는 나눌 수 없다', () => {
    assert.throws(() => T.planSplitTask(task('d1', { status: 'done' }), { id: 'd2', now: NOW }));
    assert.throws(() => T.planSplitTask(task('d1', { kind: 'watch' }), { id: 'd2', now: NOW }));
  });
  test('되돌리기 patch 는 새 건을 지우고 제목·칸을 원래대로', () => {
    const t = task('e1', { title: '회의록', slot: { date: TODAY, start: '10:00', min: 60 } });
    const r = T.planSplitTask(t, { id: 'e2', now: NOW, firstMin: 30 });
    const after = PE.applyPatch({ tasks: { e1: { ...t } } }, r.patch);
    assert.equal(Object.keys(after.tasks).length, 2);
    const back = PE.applyPatch(after, r.undo);
    assert.deepEqual(Object.keys(back.tasks), ['e1']);
    assert.equal(back.tasks.e1.title, '회의록');
    assert.deepEqual(back.tasks.e1.slot, t.slot);
  });
  test('planner 밖을 건드리지 않는다', () => {
    const r = T.planSplitTask(base(), { id: 'a2', now: NOW });
    T.assertPlannerPatch(r.patch); T.assertPlannerPatch(r.undo);
  });
});

describe('한 건 나누기 — 보고에서 나온 경계', () => {
  test('keepToday/keepDaily false 면 새 건은 오늘 표시·매일을 따르지 않는다', () => {
    const t = task('f1', { today: TODAY, daily: true, due: '2026-10-30' });
    const n = T.planSplitTask(t, { id: 'f2', now: NOW, keepToday: false, keepDaily: false }).patch['tasks/f2'];
    assert.equal(n.today, null);
    assert.ok(!n.daily);
    assert.equal(n.due, '2026-10-30');
  });
  test('번호가 세 자리여도 다음 번호로 이어진다', () => {
    assert.equal(T.splitTitles('x (99)').second, 'x (100)');
    assert.equal(T.splitTitles('x (100)').second, 'x (101)');
  });
  test('제목이 너무 길면 나눌 수 없다', () => {
    assert.throws(() => T.planSplitTask(task('g1', { title: 'ㄱ'.repeat(198) }), { id: 'g2', now: NOW }));
  });
});

describe('쿨메신저 받은편지함', () => {
  const planner = { inbox: {
    b: { title: ' 급식   자료 ', from: '강혜림', dueText: '12월 전', due: '2026-12-01', at: '2026-10-27 11:00:00' },
    a: { title: '부담임 회신', from: '조준희', at: '2026-10-27 10:00:00' },
    x: { from: '제목 없음' },
  } };
  test('제목이 있는 후보만 시간순으로 읽는다', () => {
    const l = T.listInbox(planner);
    assert.deepEqual(l.map(i => i.id), ['a', 'b']);
    assert.equal(l[1].title, '급식 자료');
  });
  test('담기는 할 일을 만들고 후보를 지운다', () => {
    const item = T.listInbox(planner)[1];
    const p = T.planInboxAccept(item, { now: NOW });
    assert.equal(p['tasks/c_b'].title, '급식 자료');
    assert.equal(p['tasks/c_b'].src, 'coolmessenger');
    assert.equal(p['inbox/b'], null);
    assert.doesNotThrow(() => T.assertPlannerPatch(p));
  });
  test('이미 담긴 후보는 할 일을 다시 만들지 않는다', () => {
    const item = T.listInbox(planner)[1];
    assert.deepEqual(T.planInboxAccept(item, { now: NOW, existing: [{ id: 'c_b' }] }), { 'inbox/b': null });
  });
  test('없는 날짜·보이지 않는 글자는 걸러진다', () => {
    const l = T.listInbox({ inbox: {
      d1: { title: '날짜 이상', due: '2026-02-30' },
      d2: { title: '​‮' },
      d3: { title: 'a b‮c', from: 'x​y' },
    } });
    assert.deepEqual(l.map(i => i.id), ['d1', 'd3']);
    assert.equal(l[0].due, null);
    assert.equal(l[1].title, 'a b c');
  });
  test('무시는 후보만 지운다', () => {
    const p = T.planInboxDismiss({ id: 'a' });
    assert.deepEqual(p, { 'inbox/a': null });
    assert.doesNotThrow(() => T.assertPlannerPatch(p));
  });
});
