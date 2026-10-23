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
  });

  test('휴업일은 블록이 없고, 행사 교시는 막힌다', () => {
    const hol = schoolData({ calendar: { [TODAY]: { all: { type: 'holiday', label: '재량휴업' } } } });
    assert.deepEqual(T.busyBlocks(hol, TODAY), []);
    const ev = schoolData({ calendar: { [TODAY]: { 2: { type: 'event', label: '학생 상담' } } } });
    assert.deepEqual(T.busyBlocks(ev, TODAY).map(x => [x.p, x.kind, x.label]), [[2, 'event', '학생 상담'], [4, 'class', '103 역사']]);
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

  test('하루 범위(07~22시) 밖은 못 놓는다', () => {
    assert.equal(T.slotConflict(d, [], TODAY, '06:30', 30).reason, 'range');
    assert.equal(T.slotConflict(d, [], TODAY, '21:30', 60).reason, 'range');
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
