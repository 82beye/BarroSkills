import assert from 'node:assert/strict';
import test from 'node:test';

import { metricsVersionOf } from '../scripts/automation/lib/growth-kpi.js';
import { judgeExperiment } from '../scripts/automation/growth-weekly.js';
import { findHeadlineCollision, headlineNumberTokens } from '../scripts/automation/generate-metadata.js';

/**
 * 2026-09-14 EXP-01-title-bracket 이 fail 판정을 받은 경위를 고정한다.
 * 히트율 1.0 → 0.09 는 제목이 아니라 계산식 교체(2026-09-10, 커밋 1ae7391) 때문이었다.
 */
const kpiDoc = (genAt, hit, like) => ({
  generated_at: genAt,
  kpis: [
    { id: 'video_hit_rate_7d', value: hit },
    { id: 'like_rate_7d', value: like },
  ],
});

test('계산식 판본은 문서 필드가 없으면 생성 시각으로 되짚는다', () => {
  assert.equal(metricsVersionOf(kpiDoc('2026-08-31T20:40:00Z', 1, 0.008)), 1);
  assert.equal(metricsVersionOf(kpiDoc('2026-09-13T20:40:00Z', 0.09, 0.011)), 2);
  assert.equal(metricsVersionOf({ metrics_version: 7, generated_at: '2026-01-01T00:00:00Z' }), 7);
  assert.equal(metricsVersionOf({ generated_at: 'nonsense' }), null);
});

test('판본이 다르면 판정하지 않는다 — EXP-01 의 거짓 fail 재현', () => {
  const start = kpiDoc('2026-08-31T20:40:00Z', 1, 0.00849437247823317);
  const end = kpiDoc('2026-09-13T20:40:00Z', 0.09090909090909091, 0.010792639773531494);
  const r = judgeExperiment(start, end);
  assert.equal(r.verdict, 'inconclusive', '-91% 는 계산식 교체분이라 fail 이 아니다');
  assert.match(r.reason, /계산식 판본/);
});

test('같은 판본 안에서는 기존 판정이 그대로 산다', () => {
  const a = kpiDoc('2026-09-11T20:40:00Z', 0.2, 0.010);
  assert.equal(judgeExperiment(a, kpiDoc('2026-09-13T20:40:00Z', 0.1, 0.010)).verdict, 'fail');
  assert.equal(judgeExperiment(a, kpiDoc('2026-09-13T20:40:00Z', 0.3, 0.010)).verdict, 'success');
  assert.equal(judgeExperiment(a, kpiDoc('2026-09-13T20:40:00Z', 0.21, 0.010)).verdict, 'inconclusive');
});

/** EXP-02-distinct-headline — 같은 수치를 반복한 제목은 48h 조회가 -64% 였다. */
const index = (rows) => ({ videos: Object.fromEntries(rows.map((r, i) => [`v${i}`, r])) });

test('제목 수치 토큰은 공백을 무시하고 단위까지 묶는다', () => {
  assert.deepEqual([...headlineNumberTokens('코스피 4.61% 폭등, 유가 108 달러')], ['4.61%', '108달러']);
  assert.equal(headlineNumberTokens('강남3구 동반 하락').size, 0, '단위 없는 숫자는 수치로 안 센다');
});

test('3일 안에 같은 수치를 또 쓰면 잡아낸다', () => {
  const idx = index([
    { title: '[속보] 코스피 4.61% 폭등 7000선 코앞, 반도체 재고 부족 신호', publishedAt: '2026-09-07T00:00:00Z' },
    { title: '[美마감] 국제유가 3.48% 급등', publishedAt: '2026-08-20T00:00:00Z' },
  ]);
  const now = new Date('2026-09-07T18:00:00Z');
  const hit = findHeadlineCollision('[속보] 코스피 4.61% 폭등, 美 휴장 속 나 홀로 랠리', idx, now);
  assert.deepEqual(hit?.shared, ['4.61%']);

  // 3일을 넘긴 회차는 충돌로 세지 않는다 — 같은 수치라도 화제가 이미 식었다.
  assert.equal(findHeadlineCollision('[美마감] 국제유가 3.48% 급등 재현', idx, now), null);
  // 겹치는 수치가 없으면 통과
  assert.equal(findHeadlineCollision('[美마감] 원달러 1,350원 돌파', idx, now), null);
});

/**
 * 48h 조회 지수 — 히트율(임계 통과 비율)이 못 읽어 주는 '크기'를 재는 짝 지표.
 * 2026-09-14 실측: 히트율 9% 옆에서 이 값은 0.60 이었다. 조회는 40% 빠졌지 91% 가 아니다.
 */
import { views48Index, hitRate } from '../scripts/automation/lib/growth-kpi.js';

/** age 일 전 게시, 48h 시점 관측 x 회 짜리 영상 하나. */
const vid = (ageDays, x, now) => {
  const pub = now.getTime() - ageDays * 86400_000;
  return {
    publishedAt: new Date(pub).toISOString(),
    stats_history: [{ at: new Date(pub + 46 * 3600_000).toISOString(), views: x }],
  };
};

test('48h 조회 지수는 기준선에서 최근 창을 빼고 잰다', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  // 최근 7일 5편은 400~500, 8~20일 전 5편은 800~900.
  const videos = [
    ...[3, 4, 5, 6, 7].map((d, i) => vid(d, 400 + i * 25, now)),
    ...[9, 11, 13, 15, 17].map((d, i) => vid(d, 800 + i * 25, now)),
  ];
  const idx = views48Index(videos, now);
  // 최근 중앙값 450 / 이전 코호트 중앙값 850 ≈ 0.53. 기준선에 최근을 넣었다면 훨씬 1에 가까워진다.
  assert.ok(idx > 0.5 && idx < 0.56, `0.53 근처여야 한다 — 실제 ${idx}`);

  // 같은 데이터에서 히트율은 0% 다 — 크기 변화를 전혀 못 읽어 준다.
  assert.equal(hitRate(videos, now, { multiple: 1.5 }), 0);
});

test('표본이 모자라면 지수는 null 이다 — 0 이 아니다', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  assert.equal(views48Index([vid(3, 400, now), vid(10, 800, now)], now), null);
  assert.equal(views48Index([], now), null);
});

/**
 * 발행당 조회 — 발행 일관성 RED 와 히트율 RED 가 충돌할 때 어느 쪽이 옳은지 가르는 계측기.
 * 2026-09 실측: 2편 발행일 편당 625 · 3편 발행일 편당 413 (총 도달은 1249 vs 1239 로 같다).
 */
import { viewsPerPublish } from '../scripts/automation/lib/growth-kpi.js';

/** 관측 두 개짜리 영상 — 7일 전과 지금. */
const tracked = (ageDays, then, nowViews, now) => {
  const pub = now.getTime() - ageDays * 86400_000;
  return {
    publishedAt: new Date(pub).toISOString(),
    privacy: 'public',
    stats_history: [
      { at: new Date(now.getTime() - 7 * 86400_000).toISOString(), views: then },
      { at: new Date(now.getTime()).toISOString(), views: nowViews },
    ],
  };
};

test('발행당 조회는 주간 조회 증분을 주간 발행 편수로 나눈다', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  // 최근 7일 2편 + 구작 1편. 주간 증분 = (300-0)+(500-0)+(120-100) = 820, 발행 2편 → 410
  const videos = [
    tracked(3, 0, 300, now),
    tracked(5, 0, 500, now),
    tracked(40, 100, 120, now),
  ];
  assert.equal(viewsPerPublish(videos, now), 410);
});

test('같은 조회를 더 많은 편수로 나누면 발행당 조회가 떨어진다', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  const two = [tracked(2, 0, 600, now), tracked(4, 0, 600, now)];
  const three = [tracked(2, 0, 400, now), tracked(4, 0, 400, now), tracked(6, 0, 400, now)];
  // 총 도달은 1200 으로 같은데 편수만 다르다 — 지표가 그 차이를 보여 줘야 한다.
  assert.equal(viewsPerPublish(two, now), 600);
  assert.equal(viewsPerPublish(three, now), 400);
});

test('발행이 없거나 조회가 줄면 null 이다 — 0 으로 뭉개지 않는다', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  assert.equal(viewsPerPublish([tracked(40, 100, 120, now)], now), null, '최근 발행 0편');
  assert.equal(viewsPerPublish([tracked(3, 500, 400, now)], now), null, '증분이 음수');
});
