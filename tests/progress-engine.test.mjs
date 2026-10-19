// 진도 엔진 v2 테스트 — `npm test` (node 내장 테스트, 설치할 것 없음)
// 지금까지 실제로 났던 오류와, 구조상 날 수 있던 오류를 시나리오로 고정해 둔다.
// 새 기능을 넣거나 고칠 때 여기 테스트가 하나라도 깨지면 배포되지 않는다 (.github/workflows/static.yml).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../engine/progress-engine.js';

const K = '201 A_역사A';
const cell = (c = '201 A', s = '역사A') => ({ class: c, subject: s });

// 2026-10-19(월) ~ 2026-11-30 학기, 201 A 역사A: 월 3교시, 수 2·5교시
// → 10/19 월3=1, 10/21 수2=2, 수5=3, 10/26 월3=4, 10/28 수2=5, 수5=6, 11/2 월3=7 ...
function base(extra = {}) {
  return {
    semester: { id: 'T', start: '2026-10-19', end: '2026-11-30' },
    periods: {
      1: { start: '09:00', end: '09:45' }, 2: { start: '09:55', end: '10:40' },
      3: { start: '10:50', end: '11:35' }, 4: { start: '11:45', end: '12:30' },
      5: { start: '13:20', end: '14:05' }, 6: { start: '14:15', end: '15:00' },
    },
    timetables: { '2026-10-19': { mon: { 3: cell() }, wed: { 2: cell(), 5: cell() }, tue: { 1: cell('305', '역사') } } },
    ...extra,
  };
}
const step = (d, date, p) => E.stepAt(d, K, date, p);

describe('날짜 계산', () => {
  test('월·연 경계와 요일', () => {
    assert.equal(E.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(E.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(E.addDays('2028-03-01', -1), '2028-02-29');
    assert.equal(E.weekdayKey('2026-10-19'), 'mon');
    assert.equal(E.weekdayKey('2027-01-03'), 'sun');
  });
});

describe('기본 세기', () => {
  test('학기 첫 수업이 1차시, 같은 날 두 수업은 교시 순', () => {
    const d = base();
    assert.equal(step(d, '2026-10-19', 3), 1);
    assert.equal(step(d, '2026-10-21', 2), 2);
    assert.equal(step(d, '2026-10-21', 5), 3);
    assert.equal(step(d, '2026-10-26', 3), 4);
  });

  test('다른 반 수업은 섞이지 않는다', () => {
    assert.equal(E.stepAt(base(), '305_역사', '2026-10-27', 1), 2);
  });

  test('수업 없는 칸은 null', () => {
    assert.equal(step(base(), '2026-10-20', 3), null);
  });
});

describe('학사일정', () => {
  test('하루 종일 행사·교시 행사는 빠지고 뒤 차시가 당겨진다', () => {
    const d = base({ calendar: { '2026-10-21': { 2: { type: 'event', label: '행사' } }, '2026-10-26': { all: { type: 'holiday', label: '재량휴업' } } } });
    assert.equal(step(d, '2026-10-21', 2), null);
    assert.equal(step(d, '2026-10-21', 5), 2);
    assert.equal(step(d, '2026-10-26', 3), null);
    assert.equal(step(d, '2026-10-28', 2), 3);
  });

  test('학사일정을 뒤늦게 넣어도 고정핀 뒤 차시는 그대로 (핀~그 수업 사이만 다시 센다)', () => {
    const pinned = base({ pins: { [K]: { '2026-10-28_2': { step: 10 } } } });
    const late = { ...pinned, calendar: { '2026-10-21': { all: { type: 'event', label: '체험학습' } } } };
    assert.equal(step(late, '2026-10-26', 3), 2);   // 핀 전: 하루 빠진 만큼 당겨짐
    assert.equal(step(late, '2026-10-28', 2), 10);  // 핀 자리: 그대로
    assert.equal(step(late, '2026-11-02', 3), 12);  // 핀 뒤: 그대로
  });
});

describe('특별 수업', () => {
  test('특별 수업은 차시를 세지 않고, 뒤 수업만 당겨진다', () => {
    const d = base({ specials: { '2026-10-21': { 2: { key: K, label: '자습' } } } });
    assert.equal(step(d, '2026-10-19', 3), 1);
    assert.equal(step(d, '2026-10-21', 2), null);
    assert.equal(step(d, '2026-10-21', 5), 2);
  });

  test('지난 수업을 특별 수업으로 표시해도 보정 없이 뒤 핀 이후는 그대로 (v1의 ±1 땜질이 필요 없음)', () => {
    const d0 = base({ pins: { [K]: { '2026-10-28_2': { step: 5 } } } });
    const patch = E.planSetSpecial(d0, K, '2026-10-21', 2, '자습');
    assert.deepEqual(Object.keys(patch), ['specials/2026-10-21/2']);
    const d1 = E.applyPatch(d0, patch);
    assert.equal(step(d1, '2026-10-21', 5), 2);
    assert.equal(step(d1, '2026-10-28', 2), 5);
    // 해제하면 원래대로
    const d2 = E.applyPatch(d1, E.planSetSpecial(d1, K, '2026-10-21', 2, null));
    assert.equal(step(d2, '2026-10-21', 2), 2);
    assert.equal(d2.specials, undefined);
  });

  test('다른 반 이름이 붙은 특별 수업 표시는 무시되고 점검에 뜬다', () => {
    const d = base({ specials: { '2026-10-21': { 2: { key: '202 A_역사A', label: '자습' } } } });
    assert.equal(step(d, '2026-10-21', 2), 2);
    assert.ok(E.checkHealth(d).some(i => i.code === 'orphan-special'));
  });
});

describe('고정핀 (차시 직접 고치기)', () => {
  test('고친 수업부터 그 뒤가 따라오고, 앞은 그대로', () => {
    const d0 = base();
    const r = E.planSetStep(d0, K, '2026-10-26', 3, 9);
    assert.equal(r.changed, true);
    const d = E.applyPatch(d0, r.patch);
    assert.equal(step(d, '2026-10-21', 5), 3);
    assert.equal(step(d, '2026-10-26', 3), 9);
    assert.equal(step(d, '2026-10-28', 2), 10);
  });

  test('수업 전에 고치든 후에 고치든 결과가 같다 (현재 시각을 안 씀)', () => {
    const d = E.applyPatch(base(), E.planSetStep(base(), K, '2026-10-21', 5, 7).patch);
    const morning = E.nextLesson(d, K, { date: '2026-10-21', min: 8 * 60 });
    const evening = E.nextLesson(d, K, { date: '2026-10-21', min: 18 * 60 });
    assert.equal(step(d, '2026-10-21', 5), 7);
    assert.equal(morning.step, 2);           // 그날 2교시 (핀은 5교시에 붙었으니 앞 교시는 그대로)
    assert.equal(evening.step, 8);           // 다음 수업 10/26
  });

  test('이미 그 차시면 아무것도 안 쓴다', () => {
    const r = E.planSetStep(base(), K, '2026-10-21', 2, 2);
    assert.equal(r.changed, false);
    assert.deepEqual(r.patch, {});
  });

  test('앞 수업을 고쳐도 뒤에 있는 핀이 이기고, 그 사실을 알려 준다', () => {
    const d0 = base({ pins: { [K]: { '2026-11-02_3': { step: 20 } } } });
    const r = E.planSetStep(d0, K, '2026-10-21', 2, 5);
    assert.equal(r.laterPins.length, 1);
    const d = E.applyPatch(d0, r.patch);
    assert.equal(step(d, '2026-10-28', 5), 9);
    assert.equal(step(d, '2026-11-02', 3), 20);
  });

  test('핀 자리 수업이 나중에 취소되면 그 뒤 첫 정규 수업이 그 차시가 된다', () => {
    const d = base({
      pins: { [K]: { '2026-10-26_3': { step: 9 } } },
      calendar: { '2026-10-26': { all: { type: 'holiday', label: '휴업' } } },
    });
    assert.equal(step(d, '2026-10-28', 2), 9);
    assert.ok(E.checkHealth(d).every(i => i.code !== 'pin-no-lesson')); // 자리는 남아 있음(행사로 빠졌을 뿐)
  });

  test('학사일정·특별 수업 칸에는 차시를 정할 수 없다, 0차시도 안 된다', () => {
    const d = base({ calendar: { '2026-10-19': { all: { type: 'event' } } } });
    assert.throws(() => E.planSetStep(d, K, '2026-10-19', 3, 4));
    assert.throws(() => E.planSetStep(d, K, '2026-10-21', 2, 0));
    assert.throws(() => E.planSetStep(d, K, '2026-10-20', 2, 4)); // 수업 없는 날
  });

  test('핀 지우기', () => {
    const d0 = base({ pins: { [K]: { '2026-10-26_3': { step: 9 } } } });
    const d = E.applyPatch(d0, E.planClearPin(K, '2026-10-26_3'));
    assert.equal(step(d, '2026-10-26', 3), 4);
    assert.equal(d.pins, undefined);
  });
});

describe('시간표 바꾸기 (v1에서 장부·지난 차시가 틀어지던 구조)', () => {
  // 11/2부터 201 A가 화 4교시 한 번으로 바뀜
  const changed = () => E.applyPatch(base({ pins: { [K]: { '2026-10-28_5': { step: 6 } } } }),
    E.planSetTimetable({ tue: { 4: cell() } }, '2026-11-02'));

  test('바꾸기 전 날짜는 옛 시간표 그대로 — 지난 장부 줄이 안 바뀐다', () => {
    const d = changed();
    assert.equal(step(d, '2026-10-26', 3), 4);
    assert.equal(step(d, '2026-10-28', 5), 6);
    assert.equal(step(d, '2026-10-27', 4), null); // 옛날 화요일에 가짜 줄이 생기지 않는다
  });

  test('바꾼 날부터 새 시간표로 이어서 센다', () => {
    const d = changed();
    assert.equal(step(d, '2026-11-02', 3), null);
    assert.equal(step(d, '2026-11-03', 4), 7);
    assert.equal(step(d, '2026-11-10', 4), 8);
  });

  test('바꾼 뒤 지난 수업을 고쳐도 앞으로의 차시가 엉뚱하게 밀리지 않는다', () => {
    const d0 = changed();
    const d = E.applyPatch(d0, E.planSetStep(d0, K, '2026-10-21', 5, 3).patch); // 원래 값 그대로 다시 저장
    assert.equal(step(d, '2026-11-03', 4), 7);
  });

  test('반만 적고 과목을 비우면 저장을 막는다', () => {
    assert.throws(() => E.planSetTimetable({ mon: { 1: { class: '201 A', subject: '' } } }, '2026-11-02'));
  });

  test('시간표 이름의 띄어쓰기를 정리해서 저장한다', () => {
    const p = E.planSetTimetable({ mon: { 1: { class: ' 201  A ', subject: '역사A' } } }, '2026-11-02');
    assert.deepEqual(p['timetables/2026-11-02'].mon[1], { class: '201 A', subject: '역사A' });
  });
});

describe('하루만 교시 바꾸기', () => {
  test('그날만 바뀌고 다음 주는 원래대로', () => {
    const d = base({ dayOverrides: { '2026-10-21': { 2: cell('305', '역사'), 3: cell() } } });
    assert.equal(step(d, '2026-10-21', 3), 2);   // 2교시 수업을 3교시로, 5교시는 빠짐
    assert.equal(step(d, '2026-10-21', 5), null);
    assert.equal(step(d, '2026-10-28', 2), 4);
    assert.equal(step(d, '2026-10-28', 5), 5);
  });
});

describe('반 이름', () => {
  test('띄어쓰기·전각 공백이 달라도 같은 반으로 센다', () => {
    const d = base({ timetables: { '2026-10-19': { mon: { 3: cell('201  A') }, wed: { 2: cell('201\u3000A ') } } } });
    assert.equal(step(d, '2026-10-21', 2), 2);
  });

  test('띄어쓰기만 다른 반 이름은 점검에서 경고', () => {
    const d = base({ timetables: { '2026-10-19': { mon: { 3: cell('201A') }, wed: { 2: cell() } } } });
    assert.ok(E.checkHealth(d).some(i => i.code === 'similar-keys'));
  });

  test('반쪽 칸은 수업으로 안 세고 점검에서 오류', () => {
    const d = base({ timetables: { '2026-10-19': { mon: { 3: { class: '201 A', subject: '' } } } } });
    assert.equal(step(d, '2026-10-19', 3), null);
    assert.ok(E.checkHealth(d).some(i => i.level === 'error' && i.code === 'half-cell'));
  });
});

describe('다음 수업·남은 차시', () => {
  test('진행 중인 수업도 "다음 수업"으로 본다 (끝나는 시각 기준)', () => {
    const d = base();
    assert.equal(E.nextLesson(d, K, { date: '2026-10-19', min: 11 * 60 }).step, 1);  // 3교시 중
    assert.equal(E.nextLesson(d, K, { date: '2026-10-19', min: 11 * 60 + 36 }).step, 2);
  });

  test('학기 끝 뒤에는 마지막 차시 + 1', () => {
    const d = base();
    assert.equal(E.nextLesson(d, K, { date: '2026-12-01', min: 0 }), null);
    assert.equal(E.nextStep(d, K, { date: '2026-12-01', min: 0 }), E.countRegular(d, K, '2026-10-19', '2026-11-30') + 1);
  });

  test('시험까지 남은 수업 — 시험 첫날 포함/제외', () => {
    const d = base();
    assert.equal(E.remainingUntil(d, K, '2026-10-26', '2026-11-02', true), 4);  // 10/26, 10/28×2, 11/2
    assert.equal(E.remainingUntil(d, K, '2026-10-26', '2026-11-02', false), 3);
    assert.equal(E.remainingUntil(d, K, '2026-11-10', '2026-11-02', true), 0);
  });
});

describe('자체 점검', () => {
  test('정상 데이터는 문제 없음', () => {
    assert.deepEqual(E.checkHealth(base({ pins: { [K]: { '2026-10-26_3': { step: 4 } } } }), { today: '2026-10-20' }), []);
  });

  test('시간표에 없는 반의 진도 기록, 수업 없는 자리의 핀, 되돌아가는 차시', () => {
    const d = base({ pins: { '999_없는반': { '2026-10-19_1': { step: 3 } }, [K]: { '2026-10-20_3': { step: 2 }, '2026-10-26_3': { step: 1 } } } });
    const codes = E.checkHealth(d).map(i => i.code);
    assert.ok(codes.includes('orphan-pin'));
    assert.ok(codes.includes('pin-no-lesson'));
    assert.ok(codes.includes('step-backwards'));
  });

  test('학기·시간표가 없으면 오류', () => {
    assert.equal(E.checkHealth({}).at(0).code, 'no-semester');
    assert.ok(E.checkHealth({ ...base(), timetables: {} }).some(i => i.code === 'no-timetable'));
    assert.ok(E.checkHealth(base(), { today: '2026-10-01' }).some(i => i.code === 'no-timetable-today'));
  });
});

describe('Firebase 배열 모양', () => {
  // RTDB는 1,2,3… 숫자 키를 [null, {...}, ...] 배열로 돌려준다 (실제 DB의 시간표·교시가 이 모양)
  test('배열로 온 시간표·교시도 똑같이 센다', () => {
    const d = base({
      periods: [null, ...Object.values(base().periods)],
      timetables: { '2026-10-19': { mon: [null, null, null, cell()], wed: [null, null, cell(), null, null, cell()] } },
    });
    assert.equal(step(d, '2026-10-21', 5), 3);
    assert.equal(E.nextLesson(d, K, { date: '2026-10-19', min: 11 * 60 + 36 }).step, 2);
    assert.deepEqual(E.checkHealth(d, { today: '2026-10-19' }), []);
  });
});

describe('applyPatch', () => {
  test('원본을 바꾸지 않는다', () => {
    const d0 = base();
    E.applyPatch(d0, { 'pins/x/2026-10-19_1': { step: 1 } });
    assert.equal(d0.pins, undefined);
  });
});

// ------------------------------------------------------------
// v1 → v2 옮기기: 지금 앱(app.js v1)이 보여 주는 차시와 똑같이 이어지는지
// ------------------------------------------------------------
// app.js(2026-10-16) 의 doneBefore / lessonStep 을 그대로 옮긴 기준 구현
function v1Step(v1, calendar, sem, key, date, p, today) {
  const sched = d => v1.dayOverrides?.[d] || v1.timetable.schedule[E.weekdayKey(d)] || {};
  const ev = (d, q) => calendar[d]?.[q] || calendar[d]?.all || null;
  const sp = (d, q) => { const s = v1.specialLessons?.[d]?.[q]; return s && s.key === key; };
  const lp = d => Object.entries(sched(d)).filter(([q, c]) => c?.class && `${c.class}_${c.subject}` === key && !ev(d, q) && !sp(d, q)).map(([q]) => Number(q)).sort((a, b) => a - b);
  const count = (a, b) => { let n = 0; for (let d = a; d <= b; d = E.addDays(d, 1)) n += lp(d).length; return n; };
  const e = v1.progress[sem][key];
  const lu = e.lastUpdated || E.addDays(today, -1);
  const done = date > lu ? e.current + count(E.addDays(lu, 1), E.addDays(date, -1)) : e.current - count(date, lu);
  return done + lp(date).filter(q => q < p).length + 1;
}

describe('v1 → v2 옮기기', () => {
  const sem = { start: '2026-08-18', end: '2027-01-08' };
  const calendar = { '2026-10-09': { all: { type: 'holiday', label: '한글날' } }, '2026-11-11': { 2: { type: 'event', label: '행사' } } };
  const v1 = () => ({
    timetable: {
      periods: base().periods,
      schedule: { mon: { 3: cell() }, fri: { 1: cell('202 A', '역사A') } },
    },
    progress: { '2026-2': {
      [K]: { current: 11, lastUpdated: '2026-10-13' },            // 월요일 8번 수업 → 학기 첫 수업이 4차시
      '202 A_역사A': { current: 8, lastUpdated: '2026-10-16' },   // 금요일 9번 - 한글날 = 8번
    } },
    specialLessons: { '2026-10-26': { 3: { key: K, label: '자습' } } },
    curriculum: { [K]: { 12: '프랑스 혁명(1)' } },
  });
  const migrate = (src = v1()) => E.migrateFromV1(src, { semesterId: '2026-2', semester: sem, calendar, today: '2026-10-19' });

  test('앞으로 두 달 모든 수업 차시가 v1과 같다', () => {
    const src = v1();
    const { data } = migrate(src);
    const d = { ...data, calendar };
    for (const key of [K, '202 A_역사A']) {
      for (const r of E.buildLedger(d, key).filter(x => x.kind === 'regular' && x.date >= '2026-10-14' && x.date <= '2026-12-20')) {
        assert.equal(r.step, v1Step(src, calendar, '2026-2', key, r.date, r.p, '2026-10-19'), `${key} ${r.date} ${r.p}교시`);
      }
    }
  });

  test('기준점 이전 장부 줄도 v1 화면과 같다 (학기 첫날 핀)', () => {
    const src = v1();
    const { data } = migrate(src);
    const d = { ...data, calendar };
    for (const r of E.buildLedger(d, K).filter(x => x.kind === 'regular' && x.date < '2026-10-14')) {
      const want = v1Step(src, calendar, '2026-2', K, r.date, r.p, '2026-10-19');
      if (want >= 1) assert.equal(r.step, want, `${r.date} ${r.p}교시`);
    }
  });

  test('수업이 차시보다 많았던 반은 경고하고, 앞으로의 차시는 그대로', () => {
    const src = v1();
    src.progress['2026-2']['202 A_역사A'] = { current: 2, lastUpdated: '2026-10-16' }; // 금요일 수업 8번인데 2차시까지
    const { data, report } = migrate(src);
    const d = { ...data, calendar };
    assert.ok(report.some(r => r.level === 'warn' && r.msg.includes('202 A_역사A')));
    assert.equal(E.stepAt(d, '202 A_역사A', '2026-10-23', 1), 3);
    // v1 장부에서 0차시 이하였던 학기 초 6번(8/21·8/28·9/4·9/11·9/18·9/25)은 '진도 외'로, 나머지 장부는 v1과 같다
    const extra = E.buildLedger(d, '202 A_역사A').filter(r => r.kind === 'special');
    assert.deepEqual(extra.map(r => r.date), ['2026-08-21', '2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25']);
    for (const r of E.buildLedger(d, '202 A_역사A').filter(x => x.kind === 'regular')) {
      assert.equal(r.step, v1Step(src, calendar, '2026-2', '202 A_역사A', r.date, r.p, '2026-10-19'), r.date);
    }
    assert.ok(!E.checkHealth(d).some(i => i.code === 'step-backwards'));
  });

  test('lastUpdated가 없던 기록은 지금 보이던 차시로 옮기고 오류로 알린다', () => {
    const src = v1();
    src.progress['2026-2'][K] = { current: 11 };
    const { data, report } = migrate(src);
    assert.ok(report.some(r => r.level === 'error' && r.msg.includes(K)));
    assert.equal(E.nextLesson({ ...data, calendar }, K, { date: '2026-10-19', min: 0 }).step, 12);
  });

  test('띄어쓰기만 다른 옛 키는 하나로 합치고 알린다 (더 최근 기준점 사용)', () => {
    const src = v1();
    src.progress['2026-2']['201  A_역사A'] = { current: 3, lastUpdated: '2026-09-01' };
    const { data, report } = migrate(src);
    assert.ok(report.some(r => r.level === 'warn' && r.msg.includes('합쳐집니다')));
    assert.ok(data.pins[K]['2026-10-14_0']);
  });

  test('학사일정은 옮긴 데이터에 넣지 않는다 (학교 공용 school/calendar 그대로 사용)', () => {
    assert.equal(migrate().data.calendar, undefined);
  });

  test('옮긴 데이터는 점검을 통과한다', () => {
    const { data } = migrate();
    const issues = E.checkHealth({ ...data, calendar }, { today: '2026-10-19' }).filter(i => i.level === 'error');
    assert.deepEqual(issues, []);
  });
});
