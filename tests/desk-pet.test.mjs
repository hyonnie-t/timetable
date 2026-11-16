// 바탕화면 펫 신호(engine/desk-pet.js) — 2026-11-16. `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { petPayload, PET_TITLE_MAX } from '../engine/desk-pet.js';
import { timeToMin } from '../engine/progress-engine.js';

const P = {
  1: { start: '09:00', end: '09:45' }, 2: { start: '09:55', end: '10:40' }, 3: { start: '10:50', end: '11:35' },
  4: { start: '11:45', end: '12:30' },
};
const C = { 1: { kind: 'lesson', short: '2-1' }, 2: { kind: 'free', short: '·' }, 3: { kind: 'event', short: '체육대회(교내)' }, 4: { kind: 'lesson', short: '2-3' } };
const m = s => timeToMin(s);

test('수업 중이면 q=1 과 지금 수업, 다음은 빈 칸을 건너뛴 교시', () => {
  const r = petPayload({ nowMin: m('09:10'), periods: P, cells: C, curP: 1 });
  assert.equal(r.q, 1);
  assert.equal(r.cur, '1교시 2-1');
  assert.equal(r.n, '10:50');
  assert.equal(r.nl, '3교시 체육대회(교내)');
  assert.equal(r.done, 0);
});

test('공강 교시에는 조용하지 않다(q=0)', () => {
  const r = petPayload({ nowMin: m('10:00'), periods: P, cells: C, curP: 2 });
  assert.equal(r.q, 0);
  assert.equal(r.cur, '');
  assert.equal(r.n, '10:50');
});

test('마지막 수업이 끝나면 done=1, 다음 없음', () => {
  const r = petPayload({ nowMin: m('12:40'), periods: P, cells: C, curP: null });
  assert.deepEqual([r.q, r.n, r.nl, r.done], [0, '', '', 1]);
});

test('마지막 수업 중이면 done 은 0 (끝나야 1)', () => {
  const r = petPayload({ nowMin: m('12:00'), periods: P, cells: C, curP: 4 });
  assert.deepEqual([r.q, r.n, r.done], [1, '', 0]);
});

test('수업 없는 날·주말은 수업 칸이 비고 할 일은 그대로', () => {
  const free = { 1: { kind: 'free' }, 2: { kind: 'free' }, 3: { kind: 'free' }, 4: { kind: 'free' } };
  const items = [{ title: '가', start: '' }];
  const a = petPayload({ nowMin: m('09:10'), periods: P, cells: free, curP: 1, items });
  assert.deepEqual([a.q, a.n, a.done, a.t], [0, '', 0, 1]);
  const b = petPayload({ nowMin: m('09:10'), weekend: true, periods: P, cells: C, curP: 1, items, overdue: 2 });
  assert.deepEqual([b.wk, b.q, b.n, b.t, b.o], [1, 0, '', 1, 2]);
});

test('다음 할 일: 지금 이후 칸 중 가장 이른 것, 지난 칸·칸 없는 일은 빼고 개수엔 넣는다', () => {
  const items = [{ title: '늦은 일', start: '15:00' }, { title: '지난 일', start: '08:00' }, { title: '칸 없음', start: '' }, { title: '이른 일', start: '13:00' }];
  const r = petPayload({ nowMin: m('12:00'), periods: P, cells: C, curP: null, items });
  assert.equal(r.t, 4);
  assert.equal(r.ts, '13:00');
  assert.equal(r.tt, '이른 일');
  const none = petPayload({ nowMin: m('16:00'), periods: P, cells: C, items });
  assert.deepEqual([none.ts, none.tt], ['', '']);
});

test('긴 제목은 줄이고 줄바꿈은 한 칸으로', () => {
  const long = '가'.repeat(50);
  const r = petPayload({ nowMin: 0, items: [{ title: long, start: '09:00' }, { title: 'x', start: '' }] });
  assert.equal(r.tt.length, PET_TITLE_MAX);
  assert.ok(r.tt.endsWith('…'));
  const r2 = petPayload({ nowMin: 0, items: [{ title: '줄\n바꿈  제목', start: '09:00' }] });
  assert.equal(r2.tt, '줄 바꿈 제목');
});

test('창 제목에 실어도 JSON 으로 다시 읽힌다(따옴표·역슬래시 포함)', () => {
  const r = petPayload({ nowMin: 0, items: [{ title: '“인용” "따옴표" \\ 끝', start: '09:00' }] });
  const title = `오늘 시간표 ·pet=${JSON.stringify(r)}`;
  assert.deepEqual(JSON.parse(title.slice('오늘 시간표 ·pet='.length)), r);
  assert.ok(!title.includes('·m='), 'ps1 의 틀 두께 신호와 섞이지 않는다');
  assert.ok(!title.endsWith('·move') && !title.endsWith('·size'));
});

test('글 안의 «·» 는 바꿔서 ps1 틀 두께 신호(·m=)로 잘못 읽히지 않는다', () => {
  const r = petPayload({ nowMin: m('09:10'), periods: P, cells: { ...C, 3: { kind: 'event', short: '행사·m=1,2,3,4' } }, curP: 1,
    items: [{ title: '회의 ·m=9,9,9,9', start: '23:00' }] });
  const title = `오늘 시간표 ·pet=${JSON.stringify(r)}`;
  assert.ok(!/·m=(\d+),(\d+),(\d+),(\d+)/.test(title));
  assert.equal(title.split('·').length, 2);   // 앞의 «·pet=» 하나만
});
