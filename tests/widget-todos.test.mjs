// 바탕화면 위젯 «오늘 할 일» 묶음·펫 dn (2026-11-17). `npm test`
// 위젯 목록이 할 일 탭(«⚠ 마감 지남» → «오늘»)과 같은 일·같은 순서인지, dn 이 끝낸 일만 세는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../engine/task-engine.js';
import { applyPatch } from '../engine/progress-engine.js';
import { petPayload } from '../engine/desk-pet.js';

const TODAY = '2026-11-17';
const mk = (id, f = {}) => T.shapeTask(id, T.normalizeTask({ title: `일 ${id}`, area: '학교', ...f }, { now: 'n0' }));
const plannerOf = (...ts) => ({ tasks: Object.fromEntries(ts.map(t => { const { id, ...v } = t; return [id, v]; })) });
const get = (planner, id) => T.shapeTask(id, planner.tasks[id]);

const SAMPLE = () => [
  mk('a', { today: TODAY }),
  mk('b', { slot: { date: TODAY, start: '13:00', min: 30 } }),
  mk('c', { due: '2026-11-10' }),                                // 마감 지남
  mk('d', { slot: { date: '2026-11-14', start: '09:00', min: 30 } }), // 칸이 지난 날
  mk('e', { due: '2026-11-30' }),                                // 오늘 아님
  { ...mk('f', { today: TODAY }), status: 'done', doneAt: `${TODAY} 08:00:00` },
  mk('g', { kind: 'watch' }),
  mk('h', { daily: true }),
  { ...mk('i', { daily: true }), dailyDone: TODAY },
];

test('widgetTodoItems: 할 일 탭과 같은 기준·순서 — 마감 지남 묶음 다음 오늘 묶음', () => {
  const ts = SAMPLE();
  const c = T.classify(ts, TODAY);
  const items = T.widgetTodoItems(ts, TODAY);
  const want = [...c.overdue, ...c.today].filter(t => !(T.isDailyTask(t) && t.dailyDone === TODAY)).map(t => t.id);
  assert.deepEqual(items.map(i => i.id), want);
  assert.deepEqual(items.filter(i => i.over).map(i => i.id), ['c', 'd']);
  assert.equal(items.find(i => i.id === 'c').overDate, '2026-11-10');
  assert.equal(items.find(i => i.id === 'd').overDate, '2026-11-14');
  assert.equal(items.find(i => i.id === 'd').start, '', '지난 날의 칸 시각은 오늘 시각처럼 보이지 않는다');
  assert.equal(items.find(i => i.id === 'b').start, '13:00');
  assert.equal(items.find(i => i.id === 'h').daily, true);
  assert.ok(!items.some(i => ['e', 'f', 'g', 'i'].includes(i.id)), '오늘 아님·끝냄·지켜보기·오늘 몫 끝은 빠진다');
});

test('widgetTodoItems: 오늘 부분은 todayItems 와 같은 일(순서만 탭 기준)', () => {
  const ts = SAMPLE();
  const todayIds = T.widgetTodoItems(ts, TODAY).filter(i => !i.over).map(i => i.id).sort();
  assert.deepEqual(todayIds, T.todayItems(ts, TODAY).map(i => i.id).sort());
});

test('widgetTodoItems: 마감 지남 수는 overdue 와 같다(위젯 ⚠ 숫자·펫 o 가 같은 말을 함)', () => {
  const ts = SAMPLE();
  assert.equal(T.widgetTodoItems(ts, TODAY).filter(i => i.over).length, T.classify(ts, TODAY).overdue.length);
});

test('widgetTodoItems: ✓(완료) → 목록에서 빠지고, 되돌리면 같은 자리로', () => {
  let p = plannerOf(...SAMPLE());
  const before = T.widgetTodoItems(T.listTasks(p), TODAY).map(i => i.id);
  const t = get(p, 'c');
  p = applyPatch(p, T.planComplete(t, { now: `${TODAY} 10:00:00` }));
  assert.ok(!T.widgetTodoItems(T.listTasks(p), TODAY).some(i => i.id === 'c'));
  p = applyPatch(p, T.planUndoComplete(get(p, 'c'), { now: `${TODAY} 10:00:05` }));
  assert.deepEqual(T.widgetTodoItems(T.listTasks(p), TODAY).map(i => i.id), before);
});

test('doneTodayCount: 오늘 완료 + 매일 «오늘 몫 끝»만 센다', () => {
  const ts = [
    { ...mk('a'), status: 'done', doneAt: `${TODAY} 09:00:00` },
    { ...mk('b'), status: 'done', doneAt: '2026-11-16 18:00:00' },   // 어제 끝냄
    { ...mk('c', { daily: true }), dailyDone: TODAY },
    { ...mk('d', { daily: true }), dailyDone: '2026-11-16' },
    { ...mk('e'), status: 'archived', archivedAt: `${TODAY} 09:00:00` },   // 보관은 안 셈
    mk('f', { due: '2026-11-20' }),
  ];
  assert.equal(T.doneTodayCount(ts, TODAY), 2);
  assert.equal(T.doneTodayCount([], TODAY), 0);
});

test('doneTodayCount: 완료 → +1, 되돌리기 → 처음, 미루기는 그대로', () => {
  let p = plannerOf(mk('a', { today: TODAY }), mk('b', { due: TODAY }), mk('h', { daily: true }));
  const n0 = T.doneTodayCount(T.listTasks(p), TODAY);
  p = applyPatch(p, T.planComplete(get(p, 'a'), { now: `${TODAY} 10:00:00` }));
  assert.equal(T.doneTodayCount(T.listTasks(p), TODAY), n0 + 1);
  p = applyPatch(p, T.planDailyDone(get(p, 'h'), TODAY, { now: `${TODAY} 10:01:00` }));
  assert.equal(T.doneTodayCount(T.listTasks(p), TODAY), n0 + 2);
  p = applyPatch(p, T.planDailyUndo(get(p, 'h'), TODAY, { now: `${TODAY} 10:02:00` }));
  p = applyPatch(p, T.planUndoComplete(get(p, 'a'), { now: `${TODAY} 10:03:00` }));
  assert.equal(T.doneTodayCount(T.listTasks(p), TODAY), n0);
  p = applyPatch(p, T.planPostpone(get(p, 'b'), '2026-11-20', { now: `${TODAY} 10:04:00` }));
  assert.equal(T.doneTodayCount(T.listTasks(p), TODAY), n0);
});

test('petPayload dn: 넘긴 값 그대로(없으면 0), 기존 키는 그대로', () => {
  const base = petPayload({ nowMin: 600 });
  assert.equal(base.dn, 0);
  assert.deepEqual(Object.keys(base), ['v', 'q', 'cur', 'n', 'nl', 'done', 'wk', 't', 'ts', 'tt', 'o', 'dn']);
  assert.equal(petPayload({ nowMin: 600, doneToday: 3 }).dn, 3);
  assert.equal(petPayload({ nowMin: 600, doneToday: -1 }).dn, 0);
  assert.equal(petPayload({ nowMin: 600, doneToday: 'x' }).dn, 0);
  const { dn, ...rest } = petPayload({ nowMin: 600, doneToday: 5, overdue: 2 });
  const { dn: _d, ...restOld } = petPayload({ nowMin: 600, overdue: 2 });
  assert.deepEqual(rest, restOld, 'dn 을 넘겨도 다른 키 값은 바뀌지 않는다');
});

test('창 제목 길이: 가장 긴 값을 넣어도 1024자 안', () => {
  const long = '가'.repeat(300);
  const P = { 1: { start: '09:00', end: '09:45' }, 2: { start: '10:00', end: '10:45' } };
  const C = { 1: { kind: 'event', short: long }, 2: { kind: 'event', short: long } };
  const r = petPayload({ nowMin: 545, periods: P, cells: C, curP: 1, items: [{ title: long, start: '23:59' }], overdue: 999, doneToday: 999 });
  const title = `오늘 시간표 ·pet=${JSON.stringify(r)}`;
  assert.ok(title.length < 1024, `제목 ${title.length}자`);
});
