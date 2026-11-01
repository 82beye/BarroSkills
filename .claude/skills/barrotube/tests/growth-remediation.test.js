// KPI 진단·자동 처방 루프 — KPI 가 RED 일 때 원인을 찾고, 처방을 켜고, 효과로 유지·되돌림을 정한다.
// 2026-10-06: 좋아요율 0.61% RED 의 원인(마무리 좋아요 요청 0/39편)을 아무도 짚지 않았고,
// 처방은 같은 수치를 다시 보여 줄 뿐이었다. 이 루프가 끊기면 KPI 는 다시 관상용이 된다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  slotWeekdays, classifyMiss, diagnosePublishing, diagnoseLikeRate, diagnoseViews48, kstDate,
} from '../scripts/automation/lib/growth-diagnosis.js';
import {
  planRemediation, emptyState, ensureClosingCta, remedySection, activeRemedies, closingCtaOf,
} from '../scripts/automation/lib/growth-remediation.js';
import { buildDirective } from '../scripts/automation/growth-directives.js';
import { checkSummary } from '../scripts/automation/generate-summary-script.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const NOW = new Date('2026-10-06T07:00:00Z');   // 2026-10-06(화) 16:00 KST
const kpi = (id, grade, display = '') => ({ overall: grade, kpis: [{ id, grade, display }] });
const CATALOG = JSON.parse(read('config/growth.json')).remedies;

test('편성 요일: 요일 없는 cron 은 매일, 범위·쉼표를 읽는다', () => {
  assert.equal(slotWeekdays('06:00').size, 7);
  assert.deepEqual([...slotWeekdays('Mon-Fri 16:00')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...slotWeekdays('Fri 10:00')], [5]);
  assert.deepEqual([...slotWeekdays('Mon-Thu,Sat,Sun 10:00')].sort(), [0, 1, 2, 3, 4, 6]);
});

test('누락 원인: 그날 처음 난 장애가 원인이고, 운영자 건너뜀·취소·중단·미실행을 가른다', () => {
  const halt = { at: '2026-10-05T21:20:21Z', event: 'auto_pipeline_halt', detail: 'slot=us-close stage=Phase 5 계약 detail=재생성 후에도 위반 ep=EP-2026-0212' };
  const fail = { at: '2026-10-05T22:00:00Z', event: 'auto_pipeline_fail', detail: 'slot=us-close ep=EP-2026-0212 stage=Phase 8 produce detail=x' };
  const c = classifyMiss([{ event: 'auto_pipeline_start', detail: 'slot=us-close' }, halt, fail]);
  assert.equal(c.cause, 'halt:Phase 5 계약');
  assert.equal(c.ep, 'EP-2026-0212');
  assert.equal(c.at, halt.at, '재발 판정은 사건 시각으로 한다');
  assert.equal(classifyMiss([{ event: 'auto_pipeline_skipped', detail: 'slot=omnibus reason=운영자' }]).cause, 'operator_skip');
  assert.equal(classifyMiss([{ event: 'auto_pipeline_ep_created', detail: 'slot=x ep=EP-2026-0001 topic=t' }],
    { 'EP-2026-0001': '토픽 오류' }).cause, 'cancelled');
  assert.equal(classifyMiss([{ event: 'auto_pipeline_start', detail: 'slot=x' }]).cause, 'interrupted');
  assert.equal(classifyMiss([]).cause, 'no_run');
});

test('발행 누락: 같은 원인 2회부터 수정 설계서, 고친 뒤의 재발만 센다, 운영자 건너뜀은 빼고', () => {
  const slots = { 'us-close': { cron: '06:00' }, omnibus: { cron: 'Mon-Thu 10:00' } };
  const day = (n) => kstDate(NOW.getTime() - n * 86400_000);
  const audit = [];
  for (let n = 1; n <= 7; n++) {
    // us-close 는 매일 발행, 단 2·4일 전은 5단계에서 멈춤
    const t = `${day(n)}T06:30:00+09:00`;
    if (n === 2 || n === 4) {
      audit.push({ at: t, event: 'auto_pipeline_halt', detail: `slot=us-close stage=Phase 5 계약 detail=x ep=EP-2026-01${n}0` });
    } else {
      audit.push({ at: t, event: 'auto_pipeline_published', detail: `slot=us-close ep=EP-2026-02${n}0` });
    }
  }
  // omnibus 는 전부 발행됐다고 치되 하루는 운영자가 건너뜀
  for (let n = 1; n <= 7; n++) {
    const wd = new Date(`${day(n)}T12:00:00+09:00`).getUTCDay();
    if (![1, 2, 3, 4].includes(wd)) continue;
    audit.push(n === 1
      ? { at: `${day(n)}T10:30:00+09:00`, event: 'auto_pipeline_skipped', detail: 'slot=omnibus reason=운영자' }
      : { at: `${day(n)}T12:00:00+09:00`, event: 'auto_pipeline_published', detail: `slot=omnibus ep=EP-2026-03${n}0` });
  }
  const k = kpi('publish_consistency_7d', 'RED', '76%');
  const f = diagnosePublishing({ kpi: k, slots, audit, now: NOW });
  const systemic = f.find((x) => x.id === 'systemic_miss:halt:Phase 5 계약');
  assert.ok(systemic, '같은 원인 2회 → 반복 장애');
  assert.equal(systemic.remedy, 'R-FIX-BRIEF');
  assert.ok(!f.some((x) => x.id.includes('operator_skip')), '운영자 건너뜀은 장애가 아니다');

  // 고친 시각 이후 재발이 없으면 반복 장애로 올리지 않는다
  const fixed = diagnosePublishing({ kpi: k, slots, audit, now: NOW,
    resolved: [{ cause: 'halt:Phase 5 계약', resolved_at: `${day(1)}T00:00:00+09:00` }] });
  assert.ok(!fixed.some((x) => x.id.startsWith('systemic_miss')), '고친 뒤 재발 없음');

  // KPI 가 GREEN 이면 진단하지 않는다
  assert.deepEqual(diagnosePublishing({ kpi: kpi('publish_consistency_7d', 'GREEN'), slots, audit, now: NOW }), []);
});

test('발행 누락 정합: 마커의 운영자 패스는 누락이 아니고, 업로드 후 비공개는 누락이다 (2026-10-16 오분류)', () => {
  // 2026-10-15 omnibus: 감사엔 start 만 있고 끝이 없다 — 운영자가 Phase 2 에서 멈췄고 마커 guard 에만 남았다.
  const guard = '🛑 운영자 패스 — 운영자 지시로 패스 (2026-10-15 13:1x KST)';
  const start = [{ event: 'auto_pipeline_start', detail: 'slot=omnibus dry_run=0' }];
  assert.equal(classifyMiss(start).cause, 'interrupted', '마커가 없으면 여전히 중단');
  assert.equal(classifyMiss(start, {}, { status: 'guarded', guard }).cause, 'operator_skip');
  assert.equal(classifyMiss(start, {}, { status: 'guarded', operatorSkip: true }).cause, 'operator_skip');
  assert.equal(classifyMiss(start, {}, { status: 'guarded', guard: '🛑 EP-2026-0001 QA FAIL — publish 차단' }).cause,
    'interrupted', 'QA 차단 🛑 은 운영자 패스가 아니다');

  const now = new Date('2026-10-15T21:40:00Z');           // 10-16(목) 06:40 KST
  const slots = { 'us-close': { cron: '06:00' }, omnibus: { cron: 'Mon-Thu 10:00' } };
  const audit = [];
  const videos = [];
  const pub = (day, slot, n, { privacy = 'public', publishAt = `${day}T08:00:00+09:00`, seen = '2026-10-16T06:40:00Z' } = {}) => {
    const ep = `EP-2026-0${slot === 'omnibus' ? 3 : 2}${n}0`;
    const vid = `${slot}-${day}`;
    audit.push({ at: `${day}T07:00:00+09:00`, event: 'auto_pipeline_published', detail: `slot=${slot} ep=${ep}` });
    audit.push({ timestamp: `${day}T07:00:01+09:00`, episode_id: ep, action: 'published',
      result: { targets: { youtube: { status: 'scheduled', videoId: vid, publishedAt: publishAt, privacyStatus: 'private' } } } });
    videos.push({ videoId: vid, privacy, publishedAt: publishAt, stats_history: [{ at: seen, views: 5 }] });
  };
  const markers = {};
  for (let n = 1; n <= 7; n++) {
    const day = kstDate(now.getTime() - n * 86400_000);
    // us-close: 하루 전(10-15)은 업로드 후 비공개(예약 해제), 이틀 전은 예약 시각이 마지막 관측보다 뒤(인덱스가 낡음)
    if (n === 1) pub(day, 'us-close', n, { privacy: 'private', publishAt: null });
    else if (n === 2) pub(day, 'us-close', n, { privacy: 'private', seen: `${day}T07:30:00+09:00` });
    else pub(day, 'us-close', n);
    const wd = new Date(`${day}T12:00:00+09:00`).getUTCDay();
    if (![1, 2, 3, 4].includes(wd)) continue;
    if (n === 1) {
      audit.push({ at: `${day}T13:01:00+09:00`, event: 'auto_pipeline_start', detail: 'slot=omnibus dry_run=0' });
      markers[`omnibus|${day}`] = { status: 'guarded', guard, operatorSkip: true };
    } else pub(day, 'omnibus', n);
  }
  const k = kpi('publish_consistency_7d', 'YELLOW', '82%');
  const f = diagnosePublishing({ kpi: k, slots, audit, markers, videos, now });
  const misses = f.find((x) => x.id === 'publish_misses');
  const by = (slot) => misses.evidence.filter((m) => m.slot === slot);
  assert.deepEqual(by('omnibus').map((m) => m.cause), ['operator_skip']);
  assert.deepEqual(by('us-close').map((m) => [m.cause, m.ep]), [['unpublished_after_upload', 'EP-2026-0210']],
    '예약 해제·비공개는 누락');
  assert.deepEqual(misses.pending_review.map((m) => [m.slot, m.ep, m.pending]),
    [['us-close', 'EP-2026-0220', 'scheduled_after_last_observation']], '예약 대기(관측이 예약보다 앞)는 보류');
  assert.equal(misses.counts.planned, 7 + 4);
  assert.deepEqual([misses.counts.skipped, misses.counts.missed, misses.counts.published, misses.counts.pending_review],
    [1, 1, 8, 1]);
  assert.match(misses.summary, /편성 11편\(운영자 패스 1 제외 10\) 중 발행 8 \(80%\) · 판정 보류 1 · 1회 누락/);
  assert.ok(!f.some((x) => x.id.startsWith('systemic_miss')), '운영자 패스·단발 비공개는 반복 장애가 아니다');

  // 마커·인덱스를 안 넘기면 예전 판정 그대로 (호출부 호환)
  const legacy = diagnosePublishing({ kpi: k, slots, audit, now }).find((x) => x.id === 'publish_misses');
  assert.deepEqual(legacy.evidence.map((m) => m.cause), ['interrupted']);
});

test('비공개 업로드는 시각이 찍힌 관측으로만 누락을 확정하고, 확정할 수 없으면 보류한다 (YOU-458 반려)', () => {
  const now = new Date('2026-10-16T06:40:00Z');
  const day = '2026-10-15';
  const ep = 'EP-2026-0234';
  const videoId = 'private-upload';
  const slots = { 'us-close': { cron: '06:00' } };
  const check = (publishAt, stats_history) => {
    const audit = [
      { at: `${day}T07:00:00+09:00`, event: 'auto_pipeline_published', detail: `slot=us-close ep=${ep}` },
      { at: `${day}T07:00:01+09:00`, action: 'published', episode_id: ep,
        result: { targets: { youtube: { videoId, publishedAt: publishAt } } } },
    ];
    const videos = [{ videoId, privacy: 'private', ...(stats_history === undefined ? {} : { stats_history }) }];
    return diagnosePublishing({ kpi: kpi('publish_consistency_7d', 'RED'), slots, audit, videos, now, windowDays: 1 })
      .find((f) => f.id === 'publish_misses');
  };
  const missed = (f, why) => {
    assert.deepEqual(f.evidence.map((m) => [m.cause, m.ep]), [['unpublished_after_upload', ep]], why);
    assert.deepEqual([f.counts.published, f.counts.missed, f.counts.pending_review], [0, 1, 0], why);
  };
  const held = (f, reason, why) => {
    assert.deepEqual(f.evidence, [], `${why} — 누락 목록에 없다`);
    assert.deepEqual(f.pending_review.map((m) => [m.pending, m.ep, m.videoId]), [[reason, ep, videoId]], why);
    assert.deepEqual([f.counts.published, f.counts.missed, f.counts.pending_review], [0, 0, 1], `${why} — 발행도 아니다`);
    assert.match(f.summary, /발행 0 \(0%\) · 판정 보류 1 · 0회 누락/);
  };
  const reserved = `${day}T08:00:00+09:00`;

  // 1. 예약 없음 + 시각이 찍힌 관측 → 누락
  missed(check(null, [{ at: `${day}T09:00:00+09:00` }]), '예약이 풀렸고 시각이 찍힌 비공개 관측은 누락');
  // 2. 관측 시각 없음 → 예약 유무와 무관하게 보류 (지금 시각으로 대신하지 않는다)
  for (const publishAt of [null, reserved]) {
    held(check(publishAt, undefined), 'no_dated_observation', `stats_history 없음 (예약 ${publishAt})`);
    held(check(publishAt, []), 'no_dated_observation', `stats_history 빈 배열 (예약 ${publishAt})`);
    held(check(publishAt, [{ at: 'not-a-date', views: 3 }, { views: 4 }]), 'no_dated_observation',
      `at 파싱 불가 (예약 ${publishAt})`);
  }
  // 3. 예약 전 관측(예약 > 마지막 관측) → 보류
  held(check(reserved, [{ at: `${day}T07:30:00+09:00` }]), 'scheduled_after_last_observation',
    '예약 전 비공개 관측은 정상적인 대기 상태일 수 있다');
  // 4. 예약 후 관측(예약 ≤ 마지막 관측) → 누락. 파싱 안 되는 관측이 섞여도 유효한 것 중 가장 늦은 것을 본다.
  missed(check(reserved, [{ at: `${day}T09:00:00+09:00` }, { at: 'bad' }]), '예약 이후에도 비공개면 누락');
  missed(check(reserved, [{ at: reserved }]), '예약 시각과 같은 관측도 예약 이후로 본다');
});

test('좋아요율: 마무리에 좋아요 요청이 비면 자동 처방, 이미 절반 넘게 있으면 침묵', () => {
  const eps = (likeEvery) => Array.from({ length: 10 }, (_, i) => ({
    ep: `EP-2026-01${i}0`, slot: i === 0 ? 'realestate' : 'kr-close', publishedAt: `2026-10-0${i % 5 + 1}T09:00:00Z`,
    closing: i === 0 ? '본 영상은 투자 조언이 아닙니다.'
      : (likeEvery && i % likeEvery === 0 ? '좋아요 눌러 주세요. 매일 신호는 팔로우하세요.' : '매일 신호는 팔로우하세요.'),
  }));
  const k = kpi('like_rate_7d', 'RED', '0.61%');
  const f = diagnoseLikeRate({ kpi: k, episodes: eps(0) });
  assert.equal(f.length, 1);
  assert.equal(f[0].remedy, 'R-LIKE-CTA');
  assert.match(f[0].summary, /realestate/, '요청이 아예 없는 슬롯을 짚는다');
  assert.deepEqual(diagnoseLikeRate({ kpi: k, episodes: eps(1) }), [], '이미 요청이 있으면 다른 원인이다');
});

test('48h 조회: 배포 안 된 공개 영상과 긴 포맷 묶음을 따로 짚는다', () => {
  const hour = 3600_000;
  const video = (id, daysAgo, v48, durationS = 60, privacy = 'public') => {
    const pub = new Date(NOW.getTime() - daysAgo * 86400_000);
    return {
      videoId: id, title: id, publishedAt: pub.toISOString(), duration_s: durationS, privacy,
      stats_history: [{ at: new Date(pub.getTime() + 48 * hour).toISOString(), views: v48 }],
      views: v48, likes: 1,
    };
  };
  const videos = [
    ...Array.from({ length: 6 }, (_, i) => video(`old${i}`, 20 + i, 800)),   // 기준선 800
    video('long1', 3, 200, 140), video('long2', 5, 220, 130), video('long3', 8, 240, 124),
    video('short1', 4, 900), video('short2', 6, 850),
    video('dead1', 9, 3, 55),
    video('priv1', 7, 0, 60, 'private'),
  ];
  const episodes = [{ videoId: 'dead1', ep: 'EP-2026-0202', slot: 'kr-close' }];
  const f = diagnoseViews48({ kpi: kpi('views_48h_index_7d', 'RED', '0.63×'), videos, episodes, now: NOW });
  const ids = f.map((x) => x.id);
  assert.ok(ids.includes('zero_distribution'), '공개인데 조회가 없는 영상');
  assert.match(f.find((x) => x.id === 'zero_distribution').summary, /EP-2026-0202\(kr-close\)/);
  assert.ok(ids.includes('buried_private'), '비공개로 묻힌 업로드');
  const long = f.find((x) => x.id === 'long_format');
  assert.ok(long, '긴 영상 묶음이 기준의 0.6× 미만');
  assert.equal(long.remedy, 'R-LONG-FORMAT');
  assert.equal(long.evidence.length, 3, '배포 실패 영상은 포맷 판정에서 뺀다');
});

test('처방: 자동 처방을 켜고 기준선을 잰다, 설계서·알림은 resend_days 안에 다시 보내지 않는다', () => {
  const videos = Array.from({ length: 8 }, (_, i) => ({
    videoId: `v${i}`, publishedAt: new Date(NOW.getTime() - (3 + i) * 86400_000).toISOString(),
    privacy: 'public', views: 1000, likes: 6,
  }));
  const findings = [
    { id: 'like_cta_missing', kpi: 'like_rate_7d', grade: 'RED', summary: 's', remedy: 'R-LIKE-CTA' },
    { id: 'long_format', kpi: 'views_48h_index_7d', grade: 'RED', summary: 's', remedy: 'R-LONG-FORMAT', evidence: [] },
  ];
  const first = planRemediation({ findings, state: emptyState(), catalog: CATALOG, videos, now: NOW });
  assert.equal(first.state.active.length, 1);
  assert.equal(first.state.active[0].remedy, 'R-LIKE-CTA');
  assert.equal(first.state.active[0].baseline.value, 0.006, '기준 좋아요율 = Σ좋아요/Σ조회');
  assert.deepEqual(first.outbox.map((o) => o.kind).sort(), ['applied', 'propose']);

  const next = planRemediation({ findings, state: first.state, catalog: CATALOG, videos,
    now: new Date(NOW.getTime() + 86400_000) });
  assert.equal(next.state.active.length, 1, '같은 처방을 두 번 켜지 않는다');
  assert.equal(next.outbox.length, 0, '설계서는 resend_days 안에 다시 보내지 않는다');
});

test('처방 판정: 좋아지면 유지(adopted), 끝내 안 좋아지면 되돌리고 cooldown 동안 다시 켜지 않는다', () => {
  const start = NOW.getTime();
  const state = { ...emptyState(), active: [{ remedy: 'R-LIKE-CTA', finding: 'like_cta_missing', kpi: 'like_rate_7d',
    started_at: new Date(start).toISOString(), baseline: { value: 0.006, episodes: 12 }, status: 'active' }] };
  const after = (n, likes, remedies = ['R-LIKE-CTA']) => Array.from({ length: n }, (_, i) => ({
    videoId: `a${i}`, publishedAt: new Date(start + (i + 1) * 3600_000).toISOString(), privacy: 'public', views: 1000, likes, remedies,
  }));
  const later = new Date(start + 20 * 86400_000);

  const good = planRemediation({ findings: [], state, catalog: CATALOG, videos: after(6, 9), now: later });
  assert.equal(good.state.active[0].status, 'adopted', '0.9% / 0.6% = 1.5× ≥ 1.15');

  // 켜기 전에 만든 대본이 켠 뒤에 발행되면(10-06 EP-0213) 처방을 안 받은 회차다 — 세지 않는다
  const unapplied = planRemediation({ findings: [], state, catalog: CATALOG, videos: after(6, 9, []), now: later });
  assert.equal(unapplied.state.active[0].status, 'active', '받은 기록이 없는 회차로는 판정하지 않는다');
  const stale = planRemediation({ findings: [], state, catalog: CATALOG, videos: after(6, 9, []), now: new Date(start + 22 * 86400_000) });
  assert.equal(stale.state.active.length, 0, '3주 동안 받은 회차가 0편이면 적용 경로가 없는 처방이다');
  assert.equal(stale.state.history[0].result.reason, 'not_applied');
  assert.deepEqual(stale.outbox.map((o) => o.kind), ['stale']);

  const wait = planRemediation({ findings: [], state, catalog: CATALOG, videos: after(5, 6), now: later });
  assert.equal(wait.state.active[0].status, 'active', 'min_episodes 전이면 더 지켜본다');

  // 10-22 YOU-552: 48h 조회는 관측 이력이 잘려 14편(max_episodes)에 닿지 못했다 — kr-cause-first 0.08× 가 6편째에도 active 였다
  const bad = planRemediation({ findings: [], state, catalog: CATALOG, videos: after(6, 6), now: later });
  assert.equal(bad.state.active.length, 0);
  assert.equal(bad.state.history[0].verdict, 'reverted');
  const again = planRemediation({
    findings: [{ id: 'like_cta_missing', kpi: 'like_rate_7d', grade: 'RED', summary: 's', remedy: 'R-LIKE-CTA' }],
    state: bad.state, catalog: CATALOG, videos: [], now: new Date(later.getTime() + 86400_000) });
  assert.equal(again.state.active.length, 0, '되돌린 처방은 cooldown 동안 다시 켜지 않는다');
});

test('마무리 처방 문장: 팔로우 안내 앞에, 없으면 면책 앞에 넣고 자막도 같이, 두 번 넣지 않는다', () => {
  const cta = CATALOG['R-LIKE-CTA'].closing_cta;
  const s1 = [{ narration: '오늘의 핵심은 금리입니다. 매일 신호는 팔로우하세요. 투자 조언은 아닙니다.',
    subtitle_text: '오늘의 핵심은 금리입니다. 매일 신호는 팔로우하세요. 투자 조언은 아닙니다.' }];
  assert.equal(ensureClosingCta(s1, cta), true);
  assert.equal(s1[0].narration, `오늘의 핵심은 금리입니다. ${cta} 매일 신호는 팔로우하세요. 투자 조언은 아닙니다.`);
  assert.equal(s1[0].subtitle_text, s1[0].narration);
  assert.equal(ensureClosingCta(s1, cta), false, '이미 있으면 그대로');
  const s2 = [{ narration: '다음 주 지표를 보세요. 본 영상은 투자 조언이 아닙니다.',
    subtitle_text: '금리 · 환율, 함께 체크 | 투자 조언 아님' }];
  ensureClosingCta(s2, cta);
  assert.equal(s2[0].narration, `다음 주 지표를 보세요. ${cta} 본 영상은 투자 조언이 아닙니다.`);
  // 자막은 " | " 로 이어 쓰기도 한다 — 맨 앞에 붙으면 목소리보다 먼저 뜬다
  assert.equal(s2[0].subtitle_text, `금리 · 환율, 함께 체크 | ${cta} 투자 조언 아님`);
  const s3 = [{ narration: '오늘은 여기까지입니다.' }];
  ensureClosingCta(s3, cta);
  assert.equal(s3[0].narration, `오늘은 여기까지입니다. ${cta}`, '안내·면책이 없으면 끝에 붙인다');
  assert.doesNotMatch(cta, /\d|한 번|두 번/, 'TTS 숫자 계약에 걸리는 수사가 없어야 한다');
});

test('처방 소비: 지시문 맨 위·요약 대본 계약·대본 생성기가 켜진 처방을 반영한다', () => {
  const remedies = activeRemedies({ active: [{ remedy: 'R-LIKE-CTA', status: 'active', started_at: NOW.toISOString() }] }, CATALOG);
  assert.equal(closingCtaOf(remedies), CATALOG['R-LIKE-CTA'].closing_cta);
  const md = buildDirective({ date: '2026-10-06', slot: 'kr-close', analysis: null, kpi: null,
    experiment: { id: 'EXP-X', target: 'metadata', directive: 'd' }, remedies });
  assert.ok(md.indexOf('자동 처방') > 0 && md.indexOf('자동 처방') < md.indexOf('이번 주 실험'), '처방이 실험보다 위');
  assert.deepEqual(remedySection([]), []);

  const cfg = JSON.parse(read('config/market-summary.json'));
  const extra = CATALOG['R-LIKE-CTA'].closing_cta;
  const scenes = cfg.scenes.map((s, i) => ({ role: s.role, narration: i === 0 ? '오늘의 미국 증시 요약입니다.' : '가',
    subtitle_text: 'x', ...(s.card ? { card: { type: s.card } } : {}) }));
  scenes.at(-1).narration = `${cfg.cta} ${cfg.disclaimer}`;
  const out = { title_hook: '훅', scenes };
  assert.ok(!checkSummary(out).some((p) => p.includes(extra)), '처방이 없으면 요구하지 않는다');
  assert.ok(checkSummary(out, extra).some((p) => p.includes(extra)), '처방이 켜지면 마지막 씬에 있어야 한다');

  const gen = read('scripts/automation/generate-script.js');
  assert.match(gen, /ensureClosingCta\(scenes, closingCta\)/, '일반 대본도 결정론으로 넣는다');
  const sum = read('scripts/automation/generate-summary-script.js');
  assert.match(sum, /ensureClosingCta\(out\.scenes, extraCta\)/);
});

test('성장 루프 배선: 진단은 처방 생성보다 앞, LLM·네트워크를 쓰지 않는다', () => {
  const pipe = read('lib/growth-pipeline.sh');
  const diag = pipe.indexOf('growth-diagnose.js');
  assert.ok(diag > 0 && diag < pipe.indexOf('growth-directives.js'), '오늘 켠 처방이 오늘 지시문에 실린다');
  assert.ok(pipe.includes('$(tg_escape "$DIAG_LINE")'), '진단 요약도 이스케이프해서 보낸다');
  for (const f of ['scripts/automation/growth-diagnose.js', 'scripts/automation/lib/growth-diagnosis.js',
    'scripts/automation/lib/growth-remediation.js']) {
    const src = read(f);
    // 설계서가 가리키는 코드 경로("lib/text-engine.js")는 문자열일 뿐이라 import·호출만 본다.
    assert.doesNotMatch(src, /from ['"][^'"]*text-engine|callClaudeCode\(|callCodex\(|spawnSync\(|\bfetch\(/,
      `${f} — 무과금 원칙(LLM·네트워크 0회)`);
  }
});
