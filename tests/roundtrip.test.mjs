// 왕복 시험 — 되돌리기가 있는 동작마다 «바꾸기 → 되돌리기 = 처음»(updatedAt 제외). 연결 점검 PR 2 (2026-11-15). `npm test`
// 화면(planner.js)이 되돌리기 줄에 넘기는 것과 같은 patch 를 만든다: 지우기·완료(칸 줄임 포함)·칸 빼기·나누기·매일 몫 끝·받았음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../engine/task-engine.js';
import { applyPatch } from '../engine/progress-engine.js';

const TODAY = '2026-11-16';
const AREAS = T.AREAS;

// updatedAt 만 빼고 저장소 전체를 비교한다 (null 칸은 DB에 남지 않으므로 지운다)
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const c = x != null && k !== 'updatedAt' ? clean(x) : undefined; if (c !== undefined) o[k] = c; }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}
const same = (a, b, msg) => assert.deepEqual(clean(a) ?? {}, clean(b) ?? {}, msg);
const plannerOf = (...ts) => ({ tasks: Object.fromEntries(ts.map(({ id, ...v }) => [id, v])), rules: {}, prepSkip: {} });
const get = (p, id) => T.shapeTask(id, p.tasks[id]);
const apply = (p, patch) => { T.assertPlannerPatch(patch); return applyPatch(p, patch); };

// 무작위 할 일 — 같은 씨앗이면 같은 결과
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function randomTask(r, id) {
  const pick = a => a[Math.floor(r() * a.length)];
  const day = n => { const d = new Date(Date.UTC(2026, 10, 16 + n)); return d.toISOString().slice(0, 10); };
  const t = { title: `일 ${id} ${pick(['보고', '결재', '읽기', '정리'])}`, area: pick(AREAS), kind: r() < 0.15 ? 'watch' : 'once', createdAt: 'c', src: 'app' };
  if (r() < 0.6) t.due = day(Math.floor(r() * 10) - 3);
  if (t.kind === 'once') {
    if (r() < 0.4) t.today = TODAY;
    if (r() < 0.4) t.slot = { date: r() < 0.6 ? TODAY : day(2), start: pick(['09:00', '13:30', '16:00']), min: pick([30, 60, 90]) };
    if (r() < 0.3) t.extra = t.slot?.date || t.today || undefined;
    if (r() < 0.3) t.daily = true;
    if (r() < 0.4) t.wait = { state: pick(['waiting', 'blocked']), who: pick(['', '부장님']), since: day(-2) };
  }
  if (r() < 0.3) t.note = '메모';
  return { id, ...T.normalizeTask(t, { now: 'n0' }) };
}

test('지우기 → 되돌리기 = 처음 (보통 일)', () => {
  const t = randomTask(rng(1), 'tA001');
  const p0 = plannerOf(t);
  const r = T.planDeleteTask(get(p0, 'tA001'), p0);
  const p1 = apply(p0, r.patch);
  assert.equal(p1.tasks?.tA001, undefined);
  same(apply(p1, r.undo), p0);
});

test('반복 건 지우기: 원래 날짜(id)를 건너뛰고, 되돌리면 건너뛰기도 지운다 — 마감을 옮긴 뒤에도', () => {
  const id = T.ruleTaskId('rw1', '2026-11-20');
  assert.equal(T.ruleDateOf({ id, ruleId: 'rw1' }), '2026-11-20');
  assert.equal(T.ruleDateOf({ id: 'tX', ruleId: 'rw1' }), null);
  assert.equal(T.ruleDateOf({ id, ruleId: 'other' }), null);
  const t = { id, ...T.normalizeTask({ title: '주간 회의 준비', area: '학교', due: '2026-11-24', ruleId: 'rw1' }, { now: 'n0' }) };   // 마감을 24일로 옮겨 둔 건
  const p0 = { ...plannerOf(t), rules: { rw1: { title: '주간 회의 준비', area: '학교', dow: 'fri', every: 'week' } } };
  const r = T.planDeleteTask(get(p0, id), p0);
  assert.equal(r.patch['rules/rw1/skip/2026-11-20'], true);
  assert.equal('rules/rw1/skip/2026-11-24' in r.patch, false);   // 전에는 마감 날짜(24일)를 건너뛰어 20일 건이 다시 생겼다
  const p1 = apply(p0, r.patch);
  // 지운 뒤 펼쳐도 다시 안 생긴다
  const mat = T.planMaterialize(p1, '2026-11-16', { horizonDays: 14, now: 'n' });
  assert.equal(`tasks/${id}` in mat, false);
  same(apply(p1, r.undo), p0);
});

test('반복 건: 이미 건너뛰기였던 날은 되돌려도 건너뛰기로 남는다', () => {
  const id = T.ruleTaskId('rw1', '2026-11-20');
  const t = { id, ...T.normalizeTask({ title: '회의', ruleId: 'rw1', due: '2026-11-20' }, { now: 'n0' }) };
  const p0 = { ...plannerOf(t), rules: { rw1: { title: '회의', dow: 'fri', skip: { '2026-11-20': true } } } };
  const r = T.planDeleteTask(get(p0, id), p0);
  same(apply(apply(p0, r.patch), r.undo), p0);
});

test('수업 준비 지우기: prepSkip 를 남기고, 되돌리면 지운다', () => {
  const t = { id: 'pg1_12', ...T.normalizeTask({ title: '수업 준비 · 역사 12차시', area: '수업', due: '2026-11-19', src: 'prep', prepDue: '2026-11-19' }, { now: 'n0' }) };
  const p0 = plannerOf(t);
  const r = T.planDeleteTask(get(p0, 'pg1_12'), p0);
  assert.equal(r.patch['prepSkip/pg1_12'], true);
  same(apply(apply(p0, r.patch), r.undo), p0);
});

test('완료(일찍 끝내 칸 줄임 포함) → 되돌리기 = 처음 — 오늘 표시·이번만 초과도 돌아온다', () => {
  const t = { id: 'tB001', ...T.normalizeTask({ title: '보고서', today: TODAY, slot: { date: TODAY, start: '09:00', min: 90 }, extra: TODAY }, { now: 'n0' }) };
  // normalizeTask 는 today 와 slot 을 같이 둘 수 있다 (옛 데이터) — 화면 doneUndoOpts 와 같은 되돌리기
  const p0 = plannerOf(t);
  const now = `${TODAY} 09:20:00`;
  const p1 = apply(p0, T.planComplete(get(p0, 'tB001'), { now }));
  assert.equal(get(p1, 'tB001').slot.min, 20);
  const undo = { ...T.planUndoComplete(get(p1, 'tB001'), { now: 'n2' }), ...T.planRestoreFields(get(p0, 'tB001'), ['slot', 'today', 'extra'], { now: 'n2' }) };
  same(apply(p1, undo), p0);
});

test('일찍 끝내 줄인 칸 → 6초 뒤 «완료 되돌리기»만 눌러도 원래 길이로', () => {
  const t = { id: 'tB002', ...T.normalizeTask({ title: '채점', slot: { date: TODAY, start: '13:00', min: 60 } }, { now: 'n0' }) };
  const p0 = plannerOf(t);
  const p1 = apply(p0, T.planComplete(get(p0, 'tB002'), { now: `${TODAY} 13:12:00` }));
  assert.equal(get(p1, 'tB002').slot.min, 15);
  same(apply(p1, T.planUndoComplete(get(p1, 'tB002'), { now: 'n2' })), p0);
  // 끝낸 뒤 칸을 고쳤으면 고친 칸을 따른다(원래 길이로 덮지 않음), 기억해 둔 칸은 지운다
  const moved = { date: TODAY, start: '15:00', min: 15 };
  const p2 = apply(p1, T.planRestoreFields({ ...get(p1, 'tB002'), slot: moved }, ['slot'], { now: 'n3' }));
  const p3 = apply(p2, T.planUndoComplete(get(p2, 'tB002'), { now: 'n4' }));
  assert.deepEqual(get(p3, 'tB002').slot, moved);
  assert.equal(get(p3, 'tB002').slotWas, undefined);
  // 다시 끝내면(칸을 안 줄였으면) 옛 기억은 남지 않는다
  const p4 = apply(p3, T.planComplete(get(p3, 'tB002'), { now: `${TODAY} 16:00:00` }));
  assert.equal(get(p4, 'tB002').slotWas, undefined);
});

test('칸 빼기 → 되돌리기 = 처음', () => {
  const t = { id: 'tC001', ...T.normalizeTask({ title: '읽기', slot: { date: TODAY, start: '13:30', min: 60 }, extra: TODAY }, { now: 'n0' }) };
  const p0 = plannerOf(t);
  const before = get(p0, 'tC001');
  const p1 = apply(p0, T.planSetSlot(before, null, { now: 'n1' }));
  assert.equal(get(p1, 'tC001').extra, undefined);   // 칸을 빼면 그날 «이번만 초과»도 비운다 (10번)
  same(apply(p1, T.planRestoreFields({ ...get(p1, 'tC001'), slot: before.slot, today: before.today, extra: before.extra }, ['slot', 'today', 'extra'], { now: 'n2' })), p0);
});

test('나누기 → 되돌리기 = 처음', () => {
  const t = { id: 'tD001', ...T.normalizeTask({ title: '논문 읽기', slot: { date: TODAY, start: '09:00', min: 60 }, wait: { state: 'waiting', since: '2026-11-10' } }, { now: 'n0' }) };
  const p0 = plannerOf(t);
  const r = T.planSplitTask(get(p0, 'tD001'), { id: 'tD002', now: 'n1', firstMin: 30 });
  same(apply(apply(p0, r.patch), r.undo), p0);
});

test('매일 몫 끝 → 되돌리기, 받았음 → 되돌리기 = 처음', () => {
  const t = { id: 'tE001', ...T.normalizeTask({ title: '스트레칭', daily: true, wait: { state: 'blocked', who: '교육청', since: '2026-11-12' } }, { now: 'n0' }) };
  const p0 = plannerOf(t);
  const p1 = apply(p0, T.planDailyDone(get(p0, 'tE001'), TODAY, { now: 'n1' }));
  same(apply(p1, T.planDailyUndo(get(p1, 'tE001'), TODAY, { now: 'n2' })), p0);
  const p2 = apply(p0, T.planSetWait(get(p0, 'tE001'), null, { today: TODAY, now: 'n1' }));
  same(apply(p2, T.planRestoreWait(get(p2, 'tE001'), t.wait, { now: 'n2' })), p0);
});

test('무작위 300건: 지우기·완료·칸 빼기·나누기 왕복', () => {
  const r = rng(20261115);
  for (let i = 0; i < 300; i++) {
    const id = `tR${String(i).padStart(4, '0')}`;
    const t = randomTask(r, id);
    const p0 = plannerOf(t, randomTask(r, 'tOther1'));
    const cur = get(p0, id);
    // 지우기
    const d = T.planDeleteTask(cur, p0);
    same(apply(apply(p0, d.patch), d.undo), p0, `지우기 ${i}`);
    if (cur.status !== 'open') continue;
    // 완료 (화면과 같은 되돌리기: 칸이 줄었을 때만 칸·오늘·초과를 되살린다 → 언제나 되살려도 같아야 한다)
    const now = `${TODAY} ${['09:10', '10:00', '15:00'][i % 3]}:00`;
    const p1 = apply(p0, T.planComplete(cur, { now }));
    const undoDone = { ...T.planUndoComplete(get(p1, id), { now: 'n2' }), ...T.planRestoreFields(cur, ['slot', 'today', 'extra'], { now: 'n2' }) };
    same(apply(p1, undoDone), p0, `완료 ${i}`);
    // 6초가 지난 뒤의 «완료 되돌리기»(목록·고치기 창·대시보드)도 칸을 원래 길이로 돌린다 (2026-11-25)
    same(apply(p1, T.planUndoComplete(get(p1, id), { now: 'n2' })), p0, `완료 → 나중에 되돌리기 ${i}`);
    // 칸 빼기
    if (cur.slot) {
      const p2 = apply(p0, T.planSetSlot(cur, null, { now: 'n1' }));
      same(apply(p2, T.planRestoreFields({ ...get(p2, id), slot: cur.slot, today: cur.today, extra: cur.extra }, ['slot', 'today', 'extra'], { now: 'n2' })), p0, `칸 빼기 ${i}`);
    }
    // 나누기
    if (cur.kind === 'once') {
      const firstMin = cur.slot ? Math.max(5, cur.slot.min - 15) : null;
      const s = T.planSplitTask(cur, { id: 'tSplit1', now: 'n1', firstMin });
      same(apply(apply(p0, s.patch), s.undo), p0, `나누기 ${i}`);
    }
  }
});

test('미루기는 이번만 초과를 비운다, 지켜보기로 바꾸면 칸·오늘 표시를 비운다', () => {
  const t = { id: 'tF001', ...T.normalizeTask({ title: '정리', today: TODAY, extra: TODAY }, { now: 'n0' }) };
  assert.equal(T.planPostpone(t, '2026-11-20', { now: 'n' })['tasks/tF001/extra'], null);
  const s = { id: 'tF002', ...T.normalizeTask({ title: '정리', slot: { date: TODAY, start: '09:00', min: 30 }, today: TODAY, extra: TODAY }, { now: 'n0' }) };
  const p = T.planEditTask(s, { kind: 'watch' }, { now: 'n' });
  assert.equal(p['tasks/tF002/slot'], null);
  assert.equal(p['tasks/tF002/today'], null);
  assert.equal(p['tasks/tF002/extra'], null);
  const after = get(applyPatch(plannerOf(s), p), 'tF002');
  assert.equal(T.chosenFor([after], TODAY).length, 0);
  assert.equal(T.extraFor([after], TODAY).length, 0);
  // 칸을 다른 날로 옮기면 그날 것이 아닌 초과 표시는 비우고, 같은 날 안에서 옮기면 지킨다
  const moved = T.planSetSlot({ ...s, today: null }, { date: '2026-11-18', start: '09:00', min: 30 }, { now: 'n' });
  assert.equal(moved['tasks/tF002/extra'], null);
  const same1 = T.planSetSlot({ ...s, today: null }, { date: TODAY, start: '10:00', min: 30 }, { now: 'n' });
  assert.equal('tasks/tF002/extra' in same1, false);
});
