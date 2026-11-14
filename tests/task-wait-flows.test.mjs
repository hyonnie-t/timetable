// 기다림(wait) × 기존 흐름 — 연결 점검 PR 1 (2026-11-15). `npm test`
// 기다림 표시가 완료·되돌리기·나누기·미루기·칸 놓기·되돌리기 복구·작은 창 목록에서 빠지거나 어긋나지 않는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../engine/task-engine.js';
import { applyPatch } from '../engine/progress-engine.js';

const TODAY = '2026-11-16';
const W = { state: 'waiting', who: '부장님 결재', since: '2026-11-10' };
const mk = (id, f = {}) => T.shapeTask(id, T.normalizeTask({ title: `일 ${id}`, area: '학교', ...f }, { now: 'n0' }));
const tasksOf = planner => T.listTasks(planner);
const plannerOf = (...ts) => ({ tasks: Object.fromEntries(ts.map(t => { const { id, ...v } = t; return [id, v]; })) });
const get = (planner, id) => T.shapeTask(id, planner.tasks[id]);

test('waitMark: 목록과 같은 한 줄, 끝낸 일·내 차례·지켜보기는 null', () => {
  const t = mk('a', { wait: W });
  assert.deepEqual(T.waitMark(t, TODAY), { state: 'waiting', icon: '⏳', who: '부장님 결재', days: 6, long: true, text: '⏳ 부장님 결재 · 6일째' });
  assert.equal(T.waitMark({ ...t, wait: { state: 'blocked', since: TODAY } }, TODAY).text, '🚧 막힘 · 오늘부터');
  assert.equal(T.waitMark({ ...t, wait: { state: 'blocked' } }, TODAY).text, '🚧 막힘');
  assert.equal(T.waitMark({ ...t, status: 'done' }, TODAY), null);
  assert.equal(T.waitMark(mk('b'), TODAY), null);
  assert.equal(T.waitMark({ ...t, kind: 'watch' }, TODAY), null);
  assert.equal(T.waitMark(t, '')?.who, '부장님 결재');   // 날짜 없이 불러도 who 는 나온다 (검색용)
});

test('완료 → 되돌리기: 기다림 값이 그대로 남고, 끝낸 동안은 표시·거르기에서 빠진다', () => {
  const t = mk('a', { wait: W, today: TODAY });
  let p = plannerOf(t);
  p = applyPatch(p, T.planComplete(get(p, 'a'), { now: 'n1' }));
  const done = get(p, 'a');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.wait, W);
  assert.equal(T.waitMark(done, TODAY), null);
  assert.equal(T.matchesWait(done, 'waiting'), false);
  assert.equal(T.matchesWait(done, 'mine'), false);
  assert.equal(T.todayItems(tasksOf(p), TODAY).length, 0);
  p = applyPatch(p, T.planUndoComplete(done, { now: 'n2' }));
  const back = get(p, 'a');
  assert.deepEqual(back.wait, W);
  assert.equal(T.matchesWait(back, 'waiting'), true);
  assert.equal(T.todayItems(tasksOf(p), TODAY)[0].wait.state, 'waiting');
});

test('보관 → 되살리기도 기다림을 지킨다', () => {
  let p = plannerOf(mk('a', { wait: W }));
  p = applyPatch(p, T.planArchive(get(p, 'a'), { now: 'n1' }));
  assert.equal(T.matchesWait(get(p, 'a'), 'waiting'), false);
  p = applyPatch(p, T.planRestore(get(p, 'a'), { now: 'n2' }));
  assert.deepEqual(get(p, 'a').wait, W);
});

test('나누기: 뒷부분은 «내 차례»로 시작, 앞부분은 기다림 유지, 되돌리면 처음과 같다', () => {
  const t = mk('a', { wait: W, due: '2026-11-20' });
  const p0 = plannerOf(t);
  const r = T.planSplitTask(get(p0, 'a'), { id: 'tnew001', now: 'n1' });
  const p1 = applyPatch(p0, r.patch);
  assert.deepEqual(get(p1, 'a').wait, W);
  assert.equal(get(p1, 'tnew001').wait, undefined);
  assert.equal(T.waitState(get(p1, 'tnew001')), 'mine');
  T.assertPlannerPatch(r.patch);
  const p2 = applyPatch(p1, r.undo);
  assert.equal(p2.tasks.tnew001, undefined);
  assert.deepEqual(get(p2, 'a').wait, W);
});

test('미루기·칸 놓기·칸 빼기·오늘 표시는 기다림을 건드리지 않는다', () => {
  const t = mk('a', { wait: W });
  for (const patch of [
    T.planPostpone(t, '2026-11-25', { now: 'n' }),
    T.planSetSlot(t, { date: TODAY, start: '10:00', min: 30 }, { now: 'n' }),
    T.planSetSlot({ ...t, slot: { date: TODAY, start: '10:00', min: 30 } }, null, { now: 'n' }),
    T.planSetToday(t, TODAY, { now: 'n' }),
    T.planReviewAction(t, 'today', { today: TODAY, now: 'n' }),
  ]) {
    assert.equal('tasks/a/wait' in patch, false);
    const after = get(applyPatch(plannerOf(t), patch), 'a');
    assert.deepEqual(after.wait, W);
  }
});

test('planRestoreWait: 받았음 → 되돌리기 = 처음 (since 까지)', () => {
  const t = mk('a', { wait: W });
  const p1 = applyPatch(plannerOf(t), T.planSetWait(t, null, { today: TODAY, now: 'n1' }));
  assert.equal(get(p1, 'a').wait, undefined);
  const p2 = applyPatch(p1, T.planRestoreWait(get(p1, 'a'), W, { now: 'n2' }));
  assert.deepEqual(get(p2, 'a').wait, W);
  // 지켜보기로 바뀐 뒤에는 되살리지 않는다
  assert.equal(T.planRestoreWait({ ...t, kind: 'watch' }, W, { now: 'n' })['tasks/a/wait'], null);
});

test('todayItems: 목록 «오늘» 묶음과 같은 일, 시각 순, 기다림·매일 표시', () => {
  const ts = [
    mk('a', { today: TODAY }),
    mk('b', { slot: { date: TODAY, start: '13:00', min: 30 }, wait: { state: 'blocked', who: '교육청' } }),
    mk('c', { slot: { date: TODAY, start: '09:00', min: 30 } }),
    mk('d', { due: TODAY, wait: W }),
    mk('e', { due: '2026-11-30' }),   // 오늘 아님
    { ...mk('f', { today: TODAY }), status: 'done' },
  ];
  const items = T.todayItems(ts, TODAY);
  assert.deepEqual(items.map(i => i.id), T.classify(ts, TODAY).today
    .sort((x, y) => (x.slot?.date === TODAY ? x.slot.start : '99:99').localeCompare(y.slot?.date === TODAY ? y.slot.start : '99:99')).map(t => t.id));
  assert.deepEqual(items.slice(0, 2).map(i => i.id), ['c', 'b']);
  assert.equal(items.find(i => i.id === 'b').wait.icon, '🚧');
  assert.equal(items.find(i => i.id === 'd').wait.text, '⏳ 부장님 결재 · 6일째');
  assert.equal(items.find(i => i.id === 'a').wait, null);
  assert.equal(items.find(i => i.id === 'c').start, '09:00');
});

test('todayItems: 매일 하는 일 — 오늘 몫을 끝냈으면 마감 당일이어도 작은 창에서 빠진다(목록 동그라미와 같은 기준)', () => {
  const daily = mk('a', { daily: true, due: TODAY });
  assert.equal(T.isDailyTask(daily), true);
  assert.deepEqual(T.todayItems([daily], TODAY).map(i => [i.id, i.daily]), [['a', true]]);
  const doneToday = { ...daily, dailyDone: TODAY };
  // 목록은 마감이 오늘이라 «오늘»에 남아 «매일 · 오늘 몫 끝»으로 보인다 — 작은 창은 끝낸 몫을 숨긴다
  assert.equal(T.classify([doneToday], TODAY).today.length, 1);
  assert.equal(T.todayItems([doneToday], TODAY).length, 0);
  // 마감이 오늘이 아니면 원래도 빠졌다 (전과 같음)
  assert.equal(T.todayItems([{ ...mk('b', { daily: true }), dailyDone: TODAY }], TODAY).length, 0);
  assert.equal(T.isDailyTask({ ...daily, status: 'done' }), false);
  assert.equal(T.isDailyTask({ ...daily, kind: 'watch' }), false);
});

test('matchesWait: 거를 때 끝낸 일·보관은 빠지고, 거르지 않으면 모두 보인다', () => {
  const ts = [mk('a', { wait: W }), { ...mk('b', { wait: W }), status: 'done' }, { ...mk('c'), status: 'archived' }, mk('d')];
  assert.deepEqual(ts.filter(t => T.matchesWait(t, 'waiting')).map(t => t.id), ['a']);
  assert.deepEqual(ts.filter(t => T.matchesWait(t, 'mine')).map(t => t.id), ['d']);
  assert.equal(ts.filter(t => T.matchesWait(t, '')).length, 4);
});
