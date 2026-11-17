// 바탕화면 펫 신호 (2026-11-16)
// 바탕화면 위젯(?widget=1)이 창 제목 «오늘 시간표 ·pet={...}» 로 30초마다 잠깐 실어 보내는 값을 만든다.
// 받는 쪽: 교사업무\클로드작업\도구\펫-위젯.ps1 (곰 = 수업 알림, 고양이 = 할 일·퇴근 알림, 수업 중엔 조용히).
// 이 모양(키 이름)을 바꾸면 펫-위젯.ps1 의 Status·Check-Alerts 도 같이 고친다.
import { nextPeriodAfter } from './progress-engine.js';

const pad = n => String(n).padStart(2, '0');
const hm = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
// 창 제목의 «·» 는 시간표-위젯.ps1 신호(·m= ·move ·size)의 표시라 글 안의 것은 다른 점으로 바꾼다
const safe = s => String(s || '').replace(/·/g, '∙').replace(/\s+/g, ' ').trim();
export const PET_TITLE_MAX = 30;   // 할 일 제목은 이만큼만 (창 제목이 너무 길지 않게)

// nowMin   지금(분)
// weekend  주말이면 true
// periods  { 교시: { start, end } } (위젯이 쓰는 getPeriods() 그대로)
// cells    { 교시: { kind: 'lesson'|'event'|'free', short } } (위젯 deskCell_ 결과)
// curP     지금 교시 (위젯 getCurrentPeriod(), 없으면 null)
// items    오늘 할 일 [{ title, start }] (planner.todayItems(), start 는 오늘 칸 시작 'HH:MM' 또는 '')
// overdue  마감 지난 일 수
// doneToday 오늘 끝낸 할 일 수 (task-engine doneTodayCount, 2026-11-17 — 펫이 늘어난 걸 보고 칭찬)
// 돌려주는 값: { v, q, cur, n, nl, done, wk, t, ts, tt, o, dn } — 빈 값은 '' 또는 0
export function petPayload({ nowMin, weekend = false, periods = {}, cells = {}, curP = null, items = [], overdue = 0, doneToday = 0 }) {
  const out = { v: 1, q: 0, cur: '', n: '', nl: '', done: 0, wk: weekend ? 1 : 0, t: 0, ts: '', tt: '', o: Number(overdue) || 0, dn: Math.max(0, Number(doneToday) || 0) };
  const list = Array.isArray(items) ? items : [];
  out.t = list.length;
  const next = list
    .filter(it => { const m = toMin(it?.start); return m !== null && m >= nowMin; })
    .sort((a, b) => toMin(a.start) - toMin(b.start))[0];
  if (next) {
    out.ts = next.start;
    const title = safe(next.title);
    out.tt = title.length > PET_TITLE_MAX ? title.slice(0, PET_TITLE_MAX - 1) + '…' : title;
  }
  if (weekend) return out;
  const busy = p => !!cells[p] && cells[p].kind !== 'free';
  const anyBusy = Object.keys(periods).some(p => busy(p));
  if (!anyBusy) return out;
  if (curP !== null && curP !== undefined && busy(curP)) {
    out.q = 1;
    out.cur = safe(`${curP}교시 ${cells[curP].short || ''}`);
  }
  const nb = nextPeriodAfter(periods, nowMin, busy);
  if (nb !== null) {
    const st = toMin(periods[nb].start);
    out.n = st === null ? '' : hm(st);
    out.nl = safe(`${nb}교시 ${cells[nb].short || ''}`);
  } else if (!out.q) {
    out.done = 1;
  }
  return out;
}
