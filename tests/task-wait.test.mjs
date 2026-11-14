// 기다림 표시(wait) 테스트 — `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../engine/task-engine.js';

const base = { id: 'a1', title: '결재 올리기', area: '학교', kind: 'once', status: 'open' };

test('옛 할 일은 기다림이 없고 «내 차례»', () => {
  const t = T.normalizeTask(base, { now: 'n' });
  assert.equal(t.wait, undefined);
  assert.equal(T.waitState(t), 'mine');
});

test('틀린 기다림 값은 버리고, 지켜보기에는 붙지 않는다', () => {
  assert.equal(T.normalizeTask({ ...base, wait: { state: 'x' } }).wait, undefined);
  assert.equal(T.normalizeTask({ ...base, kind: 'watch', wait: { state: 'waiting', since: '2026-11-10' } }).wait, undefined);
  assert.deepEqual(T.normalizeTask({ ...base, wait: { state: 'blocked', who: '  부장님   결재 ', since: 'bad' } }).wait, { state: 'blocked', who: '부장님 결재' });
});

test('planSetWait 는 오늘을 since 로 넣고, 같은 상태면 since 를 지킨다', () => {
  const p = T.planSetWait(base, 'waiting', { who: '교육청 회신', today: '2026-11-14', now: 'n' });
  assert.deepEqual(p['tasks/a1/wait'], { state: 'waiting', who: '교육청 회신', since: '2026-11-14' });
  const t2 = { ...base, wait: { state: 'waiting', who: 'A', since: '2026-11-10' } };
  assert.equal(T.planSetWait(t2, 'waiting', { who: 'B', today: '2026-11-14', now: 'n' })['tasks/a1/wait'].since, '2026-11-10');
  assert.equal(T.planSetWait(t2, 'blocked', { today: '2026-11-14', now: 'n' })['tasks/a1/wait'].since, '2026-11-14');
  assert.equal(T.planSetWait(t2, null, { today: '2026-11-14', now: 'n' })['tasks/a1/wait'], null);
  T.assertPlannerPatch(p);
});

test('날수와 3일 넘음', () => {
  const t = { ...base, wait: { state: 'waiting', since: '2026-11-10' } };
  assert.equal(T.waitDays(t, '2026-11-14'), 4);
  assert.equal(T.isWaitLong(t, '2026-11-14'), true);
  assert.equal(T.isWaitLong(t, '2026-11-13'), false);
});

test('칩 건수와 거르기', () => {
  const list = [base, { ...base, id: 'b', wait: { state: 'waiting' } }, { ...base, id: 'c', wait: { state: 'blocked' } },
    { ...base, id: 'd', kind: 'watch' }, { ...base, id: 'e', status: 'done', wait: { state: 'waiting' } }];
  assert.deepEqual(T.waitCounts(list), { all: 4, mine: 1, waiting: 1, blocked: 1 });
  assert.equal(list.filter(t => T.matchesWait(t, 'mine')).length, 1);
  assert.equal(list.filter(t => T.matchesWait(t, 'waiting')).length, 2);   // 끝낸 일도 걸러진다 (목록 쪽에서 묶음별로 나뉜다)
});

test('planEditTask: wait 를 고치고, 지켜보기로 바꾸면 지운다', () => {
  const t = { ...base, wait: { state: 'waiting', since: '2026-11-10' } };
  assert.equal(T.planEditTask(t, { kind: 'watch' }, { now: 'n' })['tasks/a1/wait'], null);
  const p = T.planEditTask(base, { wait: { state: 'blocked', who: '디케 사무국', since: '2026-11-14' } }, { now: 'n' });
  assert.deepEqual(p['tasks/a1/wait'], { state: 'blocked', who: '디케 사무국', since: '2026-11-14' });
  assert.equal('tasks/a1/wait' in T.planEditTask(base, { title: '새 제목' }, { now: 'n' }), false);
});
