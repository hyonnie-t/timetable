// 지금·다음 교시 한 기준 + 11-18 단축 시정 — 연결 점검 PR 4 (2026-11-15). `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../engine/progress-engine.js';

const P = {
  1: { start: '09:00', end: '09:45' }, 2: { start: '09:55', end: '10:40' }, 3: { start: '10:50', end: '11:35' },
  4: { start: '11:45', end: '12:30' }, 5: { start: '13:30', end: '14:15' }, 6: { start: '14:25', end: '15:10' }, 7: { start: '15:20', end: '16:05' },
};
const m = s => E.timeToMin(s);

test('periodAt: 시작 분부터 끝 분 «전»까지 — 끝 분에는 쉬는 시간', () => {
  assert.equal(E.periodAt(P, m('08:59')), null);
  assert.equal(E.periodAt(P, m('09:00')), 1);
  assert.equal(E.periodAt(P, m('09:44')), 1);
  assert.equal(E.periodAt(P, m('09:45')), null);
  assert.equal(E.periodAt(P, m('09:55')), 2);
  assert.equal(E.periodAt({}, m('09:00')), null);
});

test('isPeriodOver 는 nextLesson·진도 장부와 같은 기준(끝 분이면 지남)', () => {
  assert.equal(E.isPeriodOver(P[1], m('09:44')), false);
  assert.equal(E.isPeriodOver(P[1], m('09:45')), true);
  assert.equal(E.isPeriodOver(undefined, m('09:45')), false);
  // 지금 교시와 지난 교시가 겹치지 않는다
  for (let t = m('08:30'); t <= m('16:30'); t++) {
    const cur = E.periodAt(P, t);
    if (cur != null) assert.equal(E.isPeriodOver(P[cur], t), false, `분 ${t}`);
  }
});

test('nextPeriodAfter: 빈 칸은 건너뛰고 수업 있는 다음 교시', () => {
  const sched = { 1: { class: '101' }, 2: { class: '', subject: '' }, 3: {}, 4: { class: '103' } };
  const busy = p => !!sched[p]?.class;
  assert.equal(E.nextPeriodAfter(P, m('09:10'), busy), 4);   // 전에는 2교시(빈 칸)에서 멈춰 NEXT 가 안 보였다
  assert.equal(E.nextPeriodAfter(P, m('09:10')), 2);
  assert.equal(E.nextPeriodAfter(P, m('12:00'), busy), null);
  assert.equal(E.nextPeriodAfter(P, m('11:45'), busy), null);   // 시작한 교시는 «다음»이 아니다
});

test('2026-11-18(수) 수능 전날 40분 수업 — 1~6교시, 7교시 없음, 4교시 12:10 끝', () => {
  const on = E.periodsOn({ periods: P }, '2026-11-18');
  assert.deepEqual(Object.keys(on), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(on[1], { start: '09:00', end: '09:40' });
  assert.deepEqual(on[4], { start: '11:30', end: '12:10' });
  assert.equal(E.periodAt(on, m('09:42')), null);   // 평소엔 1교시, 이날은 쉬는 시간
  assert.equal(E.periodAt(on, m('11:30')), 4);
  assert.equal(E.nextPeriodAfter(on, m('12:10')), 5);
  // 앞뒤 날은 평소 시간
  assert.deepEqual(E.periodsOn({ periods: P }, '2026-11-17')[1], P[1]);
  assert.deepEqual(E.periodsOn({ periods: P }, '2026-11-19')[4], P[4]);
});
