// 여러 줄 붙여넣기 검사(checkBulkRows) — 한 줄 입력과 같은 규칙인지. 연결 점검 PR 3 (2026-11-15). `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../engine/task-engine.js';

const TODAY = '2026-11-16';   // 월요일
const row = (text, picked = true) => ({ p: T.parseQuickInput(text, TODAY), area: '기타', picked });
const open = (id, f) => T.shapeTask(id, T.normalizeTask({ title: id, ...f }, { now: 'n' }));

test('같은 제목: 열린 일이 있으면 open, 위 줄과 같으면 line (끝낸 일은 상관없음)', () => {
  const tasks = [open('t1', { title: '결재 올리기' }), { ...open('t2', { title: '보고서' }), status: 'done' }];
  const c = T.checkBulkRows([row('결재 올리기'), row('보고서'), row('보고서'), row('새 일')], { tasks, today: TODAY });
  assert.deepEqual(c.map(x => x.dup), ['open', null, 'line', null]);
});

test('위 줄을 고르지 않으면 아래 같은 제목 줄은 겹침이 아니다', () => {
  const c = T.checkBulkRows([row('보고서', false), row('보고서')], { today: TODAY });
  assert.deepEqual(c.map(x => x.dup), [null, null]);
});

test('줄끼리 칸 겹침: 위 줄이 놓은 칸과 겹치면 아래 줄은 칸을 비운다', () => {
  const rows = [row('회의 준비 내일 15시 1시간'), row('자료 읽기 내일 15:30 30분'), row('산책 내일 17시 30분')];
  assert.ok(rows[0].p.slot && rows[1].p.slot, '시험 전제: 칸으로 읽혀야 한다');
  const c = T.checkBulkRows(rows, { today: TODAY });
  assert.ok(c[0].slot);
  assert.equal(c[1].slot, null);
  assert.match(c[1].slotNote, /회의 준비/);
  assert.ok(c[2].slot);
  // 위 줄을 빼면 아래 줄 칸이 산다
  rows[0].picked = false;
  assert.ok(T.checkBulkRows(rows, { today: TODAY })[1].slot);
});

test('이미 있는 할 일 칸·수업과 겹치면 칸을 비운다 (한 줄 입력과 같은 slotConflict)', () => {
  const tasks = [open('t1', { title: '기존', slot: { date: '2026-11-17', start: '15:00', min: 60 } })];
  const c = T.checkBulkRows([row('자료 읽기 내일 15:30 30분')], { tasks, today: TODAY });
  assert.equal(c[0].slot, null);
  assert.match(c[0].slotNote, /기존/);
});

test('오늘 상한: 오늘 칸은 상한이 차면 비운다 — 위 줄이 채운 몫까지 센다', () => {
  const tasks = [1, 2, 3, 4].map(i => open(`t${i}`, { today: TODAY }));
  const rows = [row('가 오늘 18시 30분'), row('나 오늘 19시 30분')];
  assert.ok(rows[0].p.slot?.date === TODAY && rows[1].p.slot?.date === TODAY, '시험 전제: 오늘 칸');
  const c = T.checkBulkRows(rows, { tasks, today: TODAY, settings: { todayCap: 5 } });
  assert.ok(c[0].slot);
  assert.equal(c[1].slot, null);
  assert.match(c[1].slotNote, /오늘 할 일이 5개/);
});

test('제목이 없는 줄은 건드리지 않는다', () => {
  const c = T.checkBulkRows([{ p: { title: '' }, area: '기타' }], { today: TODAY });
  assert.deepEqual(c, [{ dup: null, slot: null, slotNote: '' }]);
});
