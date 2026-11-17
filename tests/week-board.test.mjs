// «이번 주 한 화면» (2026-11-17) — 영역×요일 칸과 마지막 기록. `npm test`
// 칸에 드는 날이 할 일 탭(classify)과 같은지, 기록이 완료·오늘 몫 끝만 세는지, ✓ → 되돌리기가 처음과 같은지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../engine/task-engine.js';
import { applyPatch, addDays } from '../engine/progress-engine.js';

const TODAY = '2026-11-17';   // 화요일
const MON = '2026-11-16';
const mk = (id, f = {}) => T.shapeTask(id, T.normalizeTask({ title: `일 ${id}`, area: '학교', ...f }, { now: 'n0' }));
const plannerOf = ts => ({ tasks: Object.fromEntries(ts.map(t => { const { id, ...v } = t; return [id, v]; })) });
const rowOf = (b, area) => b.rows.find(r => r.area === area);
const ids = cell => cell.map(i => `${i.id}:${i.state}`);

const SAMPLE = () => [
  mk('a', { today: TODAY }),
  mk('b', { slot: { date: '2026-11-19', start: '13:00', min: 30 }, due: '2026-11-25' }),   // 칸이 마감보다 먼저
  mk('c', { due: '2026-11-10' }),                                  // 지난 주부터 밀림
  mk('d', { due: MON }),                                           // 이번 주 월요일에 밀림
  mk('e', { due: '2026-11-22' }),                                  // 일요일
  mk('e2', { due: '2026-11-23' }),                                 // 다음 주
  { ...mk('f', { due: '2026-11-20' }), status: 'done', doneAt: `${MON} 08:00:00` },   // 끝낸 날 칸에
  mk('g', { kind: 'watch', area: '투자' }),
  mk('h', { daily: true, area: '독서' }),
  { ...mk('i', { daily: true, area: '독서' }), dailyDone: MON },
  { ...mk('j', { daily: true, area: '대학원' }), dailyDone: TODAY },
  mk('u', { area: '학생회' }),                                      // 날짜 없음
  { ...mk('z', { area: '연수' }), status: 'archived', doneAt: '2026-11-01 09:00:00' },
];

test('weekStartOf: 월요일 시작 — 일요일은 그 전 월요일', () => {
  assert.equal(T.weekStartOf(TODAY), MON);
  assert.equal(T.weekStartOf('2026-11-22'), MON);
  assert.equal(T.weekStartOf(MON), MON);
});

test('weekBoard: 요일 칸 — 열린 일은 놓인 날, 끝낸 일은 끝낸 날', () => {
  const b = T.weekBoard(SAMPLE(), TODAY);
  assert.deepEqual(b.days, Array.from({ length: 7 }, (_, i) => addDays(MON, i)));
  const r = rowOf(b, '학교');
  assert.deepEqual(ids(r.cells[0]), ['d:over', 'f:done']);
  assert.deepEqual(ids(r.cells[1]), ['a:open']);
  assert.deepEqual(ids(r.cells[3]), ['b:open']);
  assert.equal(r.cells[3][0].start, '13:00');
  assert.deepEqual(ids(r.cells[6]), ['e:open']);
  assert.equal(r.carryN, 1);      // c
  assert.equal(r.openN, 6);       // a b c d e e2
  assert.equal(r.weekDone, 1);
});

test('weekBoard: 오늘 칸은 할 일 탭 «오늘» 묶음, 지난 칸의 over 는 «마감 지남» 묶음과 같은 일', () => {
  const ts = SAMPLE();
  const b = T.weekBoard(ts, TODAY);
  const c = T.classify(ts, TODAY);
  const cellIds = (i, pick) => b.rows.flatMap(r => r.cells[i]).filter(pick).map(x => x.id).sort();
  assert.deepEqual(cellIds(1, x => x.state === 'open' || x.state === 'daily-done'), c.today.map(t => t.id).concat('j').sort());
  const overInWeek = b.rows.flatMap(r => r.cells.flat()).filter(x => x.state === 'over').map(x => x.id).sort();
  const carried = b.rows.reduce((n, r) => n + r.carryN, 0);
  assert.equal(overInWeek.length + carried, c.overdue.length);
  assert.deepEqual(overInWeek, ['d']);
});

test('weekBoard: 매일 하는 일 — 오늘 칸에 뜨고, 어제 끝낸 몫은 그 날 칸에 기록으로', () => {
  const b = T.weekBoard(SAMPLE(), TODAY);
  const r = rowOf(b, '독서');
  assert.deepEqual(ids(r.cells[1]), ['h:open', 'i:open']);
  assert.deepEqual(ids(r.cells[0]), ['i:rec']);
  assert.equal(r.last, MON);
  assert.equal(r.lastDays, 1);
  assert.deepEqual(ids(rowOf(b, '대학원').cells[1]), ['j:daily-done']);
  assert.equal(rowOf(b, '대학원').lastDays, 0);
});

test('weekBoard: 마지막 기록 — 완료·오늘 몫 끝만 세고, 열린 일이 있는데 7일 넘게 없으면 stale', () => {
  const b = T.weekBoard(SAMPLE(), TODAY);
  assert.equal(rowOf(b, '학교').last, MON);
  assert.equal(rowOf(b, '학교').stale, false);
  const sc = rowOf(b, '학생회');
  assert.equal(sc.last, null); assert.equal(sc.undatedN, 1); assert.equal(sc.stale, true);
  const ys = rowOf(b, '연수');           // 보관한 일도 끝낸 적이 있으면 기록으로 — 열린 일이 없으니 stale 은 아님
  assert.equal(ys.last, '2026-11-01'); assert.equal(ys.lastDays, 16); assert.equal(ys.stale, false);
  assert.equal(rowOf(b, '투자'), undefined);   // 지켜보기만 있는 영역은 줄 없음
  assert.equal(rowOf(b, '기타'), undefined);
  assert.equal(T.lastRecordText(null), '기록 없음');
  assert.equal(T.lastRecordText(0), '오늘 기록');
  assert.equal(T.lastRecordText(3), '3일 전 마지막 기록');
});

test('weekBoard: 목록 «마감 지남»인 일은 어느 조합이든 지난 날 칸(또는 밀림)에 over 로 — 검토 2026-11-17', () => {
  const ts = [
    mk('p', { today: MON, due: '2026-11-25' }),                                        // 어제 오늘 표시, 마감은 다음 주
    mk('q', { due: '2026-11-10', slot: { date: '2026-11-24', start: '09:00', min: 30 } }), // 마감 지남, 칸은 다음 주
    mk('r', { due: MON, slot: { date: '2026-11-19', start: '09:00', min: 30 } }),       // 마감 지남, 칸은 이번 주
    { ...mk('s', { daily: true, due: MON }), dailyDone: MON },                         // 마감 지난 매일 일(마지막 날 몫은 끝냄)
    mk('w', { area: '연수', due: '2026-11-30', wait: { state: 'waiting', who: '회신', since: MON } }),
  ];
  const c = T.classify(ts, TODAY);
  assert.deepEqual(c.overdue.map(t => t.id).sort(), ['p', 'q', 'r', 's']);
  const b = T.weekBoard(ts, TODAY);
  const r = rowOf(b, '학교');
  assert.deepEqual(ids(r.cells[0]).sort(), ['p:over', 'r:over', 's:over']);
  assert.equal(r.carryN, 1);   // q
  assert.deepEqual(ids(r.cells[3]), []);
  for (const wk of ['2026-11-23', '2026-11-09']) {
    const o = T.weekBoard(ts, TODAY, wk);
    assert.ok(!o.rows.flatMap(x => x.cells.flat()).some(i => i.state === 'open' && ['p', 'q', 'r', 's'].includes(i.id)));
  }
  assert.equal(rowOf(b, '연수').stale, false);   // 기다림뿐인 영역은 «오래 손 안 댐»으로 재촉하지 않는다
  assert.equal(rowOf(T.weekBoard(ts.filter(t => t.id !== 's'), TODAY), '학교').stale, true);   // 내 차례 일이 있고 기록이 없으면 재촉
});

test('weekBoard: 임의 조합 — over 칸 + 밀림 = 목록 «마감 지남», 오늘 칸 = 목록 «오늘»', () => {
  const dates = [null, '2026-11-05', '2026-11-12', MON, TODAY, '2026-11-19', '2026-11-27'];
  let n = 0, seed = 7;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  const ts = [];
  for (let i = 0; i < 300; i++) {
    const due = dates[rnd(7)], td = dates[rnd(7)], sd = dates[rnd(7)];
    const daily = rnd(5) === 0;
    const t = mk(`x${n++}`, { due, today: td, slot: sd ? { date: sd, start: '10:00', min: 30 } : null, daily });
    if (daily && rnd(2)) t.dailyDone = dates[1 + rnd(4)];
    ts.push(t);
  }
  const c = T.classify(ts, TODAY);
  const b = T.weekBoard(ts, TODAY);
  const prev = T.weekBoard(ts, TODAY, '2026-11-09'), prev2 = T.weekBoard(ts, TODAY, '2026-11-02');
  const overIds = bb => bb.rows.flatMap(r => r.cells.flat()).filter(i => i.state === 'over').map(i => i.id);
  // 하나만 일부러 다르다: 마감 전인 매일 일이 오늘 몫을 끝냈으면 목록 묶음이 어디든 이 화면은 오늘 칸 ✓
  const doneToday = t => T.isDailyTask(t) && t.dailyDone === TODAY && (!t.due || t.due >= TODAY);
  const wantOver = c.overdue.filter(t => !doneToday(t)).map(t => t.id).sort();
  assert.deepEqual([...overIds(b), ...overIds(prev), ...overIds(prev2)].sort(), wantOver);
  assert.equal(overIds(b).length + b.rows.reduce((s, r) => s + r.carryN, 0), wantOver.length);
  const todayIds = b.rows.flatMap(r => r.cells[1]).filter(i => i.state === 'open' || i.state === 'daily-done').map(i => i.id).sort();
  const wantToday = [...new Set([...c.today.map(t => t.id), ...ts.filter(doneToday).map(t => t.id)])].sort();
  assert.deepEqual(todayIds, wantToday);
});

test('weekBoard: 다른 주 — 지난 주를 보면 그 주에 끝낸 일·밀린 일이 그 날 칸에', () => {
  const b = T.weekBoard(SAMPLE(), TODAY, '2026-11-09');
  const r = rowOf(b, '학교');
  assert.deepEqual(ids(r.cells[1]), ['c:over']);
  assert.equal(r.carryN, 0);
  assert.equal(r.weekDone, 0);
  const next = T.weekBoard(SAMPLE(), TODAY, '2026-11-23');
  assert.deepEqual(ids(rowOf(next, '학교').cells[0]), ['e2:open']);
  assert.deepEqual(ids(rowOf(next, '학교').cells[2]), []);   // b 는 칸 날짜(11/19)에만, 마감(11/25)에는 안 뜸
});

test('왕복: ✓ → 되돌리기 = 처음 판 (완료·오늘 몫 끝)', () => {
  const ts = SAMPLE();
  const before = T.weekBoard(ts, TODAY);
  let p = plannerOf(ts);
  const list = () => T.listTasks(p);
  const a = list().find(t => t.id === 'a');
  p = applyPatch(p, T.planComplete(a, { now: `${TODAY} 10:00:00` }));
  const mid = T.weekBoard(list(), TODAY);
  assert.deepEqual(ids(rowOf(mid, '학교').cells[1]), ['a:done']);
  assert.equal(rowOf(mid, '학교').lastDays, 0);
  p = applyPatch(p, T.planUndoComplete(list().find(t => t.id === 'a'), { now: 'n0' }));
  const h = list().find(t => t.id === 'h');
  p = applyPatch(p, T.planDailyDone(h, TODAY, { now: 'n0' }));
  assert.deepEqual(ids(rowOf(T.weekBoard(list(), TODAY), '독서').cells[1]), ['i:open', 'h:daily-done']);
  p = applyPatch(p, T.planDailyUndo(list().find(t => t.id === 'h'), TODAY, { now: 'n0' }));
  assert.deepEqual(T.weekBoard(list(), TODAY), before);
});
