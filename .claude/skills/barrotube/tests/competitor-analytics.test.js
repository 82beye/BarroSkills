import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuration, lengthBucket, isShorts,
  planQuota, quotaPreflight, classifyApiError, uploadsPlaylistId,
  selectVideoIdsToFetch, appendStatsHistory, subscriberDelta,
  tokenize, stopwordCandidates, median, viewsPerDay, relativeVpd,
  contentGaps, outliers, blueOcean, titleFeatures, formatPatterns, relatedTerms,
} from '../scripts/automation/lib/competitor-analytics.js';

const NOW = new Date('2026-08-13T00:00:00Z');

/** 채널 픽스처. daysAgo 로 나이를 주고 views 로 성과를 준다. */
function ch(id, name, videos) {
  return {
    id,
    name,
    videos: videos.map((v, i) => ({
      videoId: v.id ?? `${id}-${i}`,
      title: v.title,
      publishedAt: new Date(NOW.getTime() - (v.daysAgo ?? 3) * 86400_000).toISOString(),
      duration_s: v.dur ?? 700,
      length_bucket: v.bucket ?? lengthBucket(v.dur ?? 700),
      views: v.views ?? 1000,
    })),
  };
}

test('parseDuration handles the ISO forms YouTube actually returns', () => {
  assert.equal(parseDuration('PT12M31S'), 751);
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('P0D'), null, 'live/premiere has no known length');
  assert.equal(parseDuration('PT0S'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration('garbage'), null);
});

test('PT1M is exactly 60s and counts as Shorts — the old regex missed it', () => {
  // 구 정규식 /PT\d{0,2}([0-5]?\dS)?$/ 는 "PT1M" 에서 \d{0,2}가 "1"을 먹고
  // "M"이 남아 $ 앵커에 걸려 false 를 냈다. 실측 회귀 차단.
  const legacy = /PT\d{0,2}([0-5]?\dS)?$/;
  assert.equal(legacy.test('PT1M'), false, 'documents the old bug');

  assert.equal(parseDuration('PT1M'), 60);
  assert.equal(isShorts(parseDuration('PT1M')), true);
});

test('isShorts and lengthBucket keep live out of the video population', () => {
  assert.equal(isShorts(60), true);
  assert.equal(isShorts(61), false);
  assert.equal(isShorts(null), false, 'unknown length is not Shorts');
  assert.equal(isShorts(undefined), false);

  assert.equal(lengthBucket(null), 'live');
  assert.equal(lengthBucket(45), 'shorts');
  assert.equal(lengthBucket(60), 'shorts');
  assert.equal(lengthBucket(61), 'mid');
  assert.equal(lengthBucket(600), 'mid');
  assert.equal(lengthBucket(601), 'long');
  assert.equal(lengthBucket(1800), 'long');
  assert.equal(lengthBucket(1801), 'xlong');
});

test('planQuota prices a scan at 3 units per channel', () => {
  assert.equal(planQuota(6), 18);
  assert.equal(planQuota(10), 30);
  assert.equal(planQuota(0), 0);
  assert.equal(planQuota(6, { deep: true }), 54);
  assert.equal(planQuota(10, { deep: true }), 90);
  assert.throws(() => planQuota(-1), TypeError);
  assert.throws(() => planQuota(1.5), TypeError);
});

test('quotaPreflight blocks before spending, not after', () => {
  assert.equal(quotaPreflight({ used: 0, planned: 18, cap: 2000 }).allowed, true);
  assert.equal(quotaPreflight({ used: 1982, planned: 18, cap: 2000 }).allowed, true, 'exactly at cap is allowed');

  const over = quotaPreflight({ used: 1990, planned: 18, cap: 2000 });
  assert.equal(over.allowed, false);
  assert.match(over.reason, /2008 > cap 2000/);
});

test('classifyApiError routes quota, auth and transient distinctly', () => {
  assert.equal(classifyApiError(403, '{"error":{"errors":[{"reason":"quotaExceeded"}]}}'), 'quota');
  assert.equal(classifyApiError(403, 'rateLimitExceeded'), 'quota');
  assert.equal(classifyApiError(403, 'forbidden for other reasons'), 'forbidden');
  assert.equal(classifyApiError(401, ''), 'auth');
  assert.equal(classifyApiError(404, ''), 'not_found');
  assert.equal(classifyApiError(500, ''), 'transient');
  assert.equal(classifyApiError(429, ''), 'transient');
  assert.equal(classifyApiError(400, ''), 'other');
});

test('uploadsPlaylistId derives UU from UC without an API call', () => {
  assert.equal(uploadsPlaylistId('UCsJ6RuBiTVWRX156FVbeaGg'), 'UUsJ6RuBiTVWRX156FVbeaGg');
  assert.equal(uploadsPlaylistId('not-a-channel'), null);
  assert.equal(uploadsPlaylistId(null), null);
});

test('selectVideoIdsToFetch takes new videos always and known ones only while fresh', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  const index = {
    videos: {
      old_known: { publishedAt: '2026-01-01T00:00:00Z' },
      recent_known: { publishedAt: '2026-08-10T00:00:00Z' },
    },
  };
  const candidates = [
    { videoId: 'brand_new', publishedAt: '2026-08-12T00:00:00Z' },
    { videoId: 'recent_known', publishedAt: '2026-08-10T00:00:00Z' },
    { videoId: 'old_known', publishedAt: '2026-01-01T00:00:00Z' },
  ];
  const got = selectVideoIdsToFetch(candidates, index, { refreshWindowDays: 14, now });
  assert.deepEqual(got, ['brand_new', 'recent_known'], 'settled old videos are not re-fetched');
});

test('selectVideoIdsToFetch caps at the videos.list page size', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  const many = Array.from({ length: 80 }, (_, i) => ({ videoId: `v${i}`, publishedAt: '2026-08-12T00:00:00Z' }));
  assert.equal(selectVideoIdsToFetch(many, { videos: {} }, { limit: 50, now }).length, 50);
});

test('selectVideoIdsToFetch demands an injected clock', () => {
  assert.throws(() => selectVideoIdsToFetch([], { videos: {} }, {}), TypeError);
});

test('appendStatsHistory keeps the newest N samples', () => {
  const seed = Array.from({ length: 30 }, (_, i) => ({ at: `t${i}`, views: i }));
  const next = appendStatsHistory(seed, { at: 't30', views: 30 }, 30);
  assert.equal(next.length, 30);
  assert.equal(next[0].at, 't1', 'oldest dropped');
  assert.equal(next.at(-1).at, 't30');
  assert.deepEqual(appendStatsHistory(undefined, { at: 't0' }), [{ at: 't0' }]);
});

test('subscriberDelta returns null when there is nothing to compare against', () => {
  // 2026-08-13 실측 사고: Number(null) === 0 이라 "이전 값 없음"이 "이전엔 0명"이 되어
  // 구독자 전체가 증가분으로 보고됐다.
  assert.equal(subscriberDelta(1190000, null), null);
  assert.equal(subscriberDelta(1190000, undefined), null);
  assert.equal(subscriberDelta(1190000, ''), null);
  assert.equal(subscriberDelta(null, 100), null);

  assert.equal(subscriberDelta(100, 90), 10);
  assert.equal(subscriberDelta('3720000', '3708000'), 12000, 'API gives counts as strings');
  assert.equal(subscriberDelta(100, 100), 0, 'no change is 0, distinct from null');
  assert.equal(subscriberDelta(90, 100), -10);
});

test('analytics helpers are deterministic across repeated calls', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  const candidates = [{ videoId: 'a', publishedAt: '2026-08-12T00:00:00Z' }];
  const a = selectVideoIdsToFetch(candidates, { videos: {} }, { now });
  const b = selectVideoIdsToFetch(candidates, { videos: {} }, { now });
  assert.deepEqual(a, b);
  assert.deepEqual(planQuota(6), planQuota(6));
});

// ─────────────────────────────────────────────────────────────
// S2 — 분석 함수
// ─────────────────────────────────────────────────────────────

test('tokenize strips particles, stopwords, dates and numbers', () => {
  const t = tokenize('트럼프의 관세 협상이 시작됐다');
  assert.ok(t.includes('트럼프'), '조사 "의" 제거');
  assert.ok(t.includes('관세'));
  assert.ok(t.includes('트럼프 관세'), '인접 바이그램 생성');

  assert.equal(tokenize('오늘 증시 시장 분석').length, 0, '전부 스톱워드');
  assert.deepEqual(tokenize('08월 12일 2026년 3분기'), [], '날짜 토큰은 주제가 아니다');
  assert.ok(!tokenize('삼성전자 12345').includes('12345'), '순수 숫자 제외');
});

test('stopwordCandidates matches what tokenize produces', () => {
  // 채널명 "오선의 미국증시 라이브" → tokenize 는 "오선"을 내는데
  // 스톱워드에 "오선의"가 들어가면 어긋나 채널명이 키워드로 새어나온다 (2026-08-13 실측)
  const cands = stopwordCandidates('오선의 미국증시 라이브');
  assert.ok(cands.includes('오선'), `조사가 떨어져야 한다: ${cands}`);

  const leaked = tokenize('오선의 강세 전망', new Set([...cands, '전망']));
  assert.ok(!leaked.some((t) => t.includes('오선')), `채널명이 새어나왔다: ${leaked}`);
});

test('median handles even, odd and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, 5]), 5);
});

test('viewsPerDay floors age at one day so fresh videos do not blow up', () => {
  const v = { publishedAt: new Date(NOW.getTime() - 3600_000).toISOString(), views: 1000 };
  assert.equal(viewsPerDay(v, NOW), 1000, '1시간된 영상도 1일로 계산');
  const w = { publishedAt: new Date(NOW.getTime() - 4 * 86400_000).toISOString(), views: 400 };
  assert.equal(viewsPerDay(w, NOW), 100);
});

test('contentGaps requires two independent channels and no prior coverage', () => {
  const channels = [
    ch('a', 'A', [{ title: '이란 협상 타결', views: 500000 }]),
    ch('b', 'B', [{ title: '이란 협상 전망', views: 400000 }]),
    ch('c', 'C', [{ title: '단독 기획물', views: 900000 }]),
  ];
  const gaps = contentGaps(channels, {}, { now: NOW, minViews: 1000 });
  const terms = gaps.map((g) => g.term);

  assert.ok(terms.includes('이란'), '2채널이 다룬 주제는 갭');
  assert.ok(!terms.includes('단독'), 'df=1 은 노이즈로 버린다');
  for (const g of gaps) {
    assert.ok(g.comp_df >= 2 && g.own_tf === 0 && g.comp_views >= 1000);
    assert.ok(Array.isArray(g.evidence) && g.evidence.length <= 3);
  }
  // 이미 다룬 주제는 제외된다
  const filtered = contentGaps(channels, { 이란: 3 }, { now: NOW, minViews: 1000 });
  assert.ok(!filtered.map((g) => g.term).includes('이란'));
});

test('contentGaps is sorted and deterministic', () => {
  const channels = [
    ch('a', 'A', [{ title: '반도체 수출 급증', views: 300000 }]),
    ch('b', 'B', [{ title: '반도체 수출 호조', views: 200000 }]),
  ];
  const a = contentGaps(channels, {}, { now: NOW, minViews: 1000 });
  const b = contentGaps(channels, {}, { now: NOW, minViews: 1000 });
  assert.deepEqual(a, b, '같은 입력 → 같은 출력');
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].gap_score >= a[i].gap_score);
});

test('outliers separate buckets and skip live', () => {
  const normal = Array.from({ length: 8 }, (_, i) => ({ title: `평범 ${i}`, views: 10000, daysAgo: 10 + i, dur: 700 }));
  const channels = [ch('a', 'A', [
    ...normal,
    { id: 'spike', title: '대박', views: 2_000_000, daysAgo: 4, dur: 700 },
    { id: 'live1', title: '라이브', views: 5_000_000, daysAgo: 4, dur: null, bucket: 'live' },
  ])];
  const found = outliers(channels, { now: NOW, minViews: 1000 });
  const ids = found.map((o) => o.videoId);
  assert.ok(ids.includes('spike'));
  assert.ok(!ids.includes('live1'), '라이브는 조회수 곡선이 달라 제외한다');
  assert.ok(found[0].multiple > 1 && found[0].mad_z >= 3.5);
});

test('outliers fall back sanely when MAD is zero', () => {
  const flat = Array.from({ length: 6 }, (_, i) => ({ title: `동일 ${i}`, views: 10000, daysAgo: 10, dur: 700 }));
  const channels = [ch('a', 'A', [...flat, { id: 'big', title: '폭발', views: 100000, daysAgo: 10, dur: 700 }])];
  const found = outliers(channels, { now: NOW, minViews: 1000 });
  assert.ok(found.some((o) => o.videoId === 'big'), 'MAD=0 이어도 3배 이상은 잡는다');
});

test('blueOcean score falls as competition rises', () => {
  const wide = [
    ch('a', 'A', [{ title: '국채 경매 결과', views: 100000 }]),
    ch('b', 'B', [{ title: '국채 경매 분석', views: 100000 }]),
    ch('c', 'C', [{ title: '국채 경매 리뷰', views: 100000 }]),
    ch('d', 'D', [{ title: '무관한 주제', views: 100000 }]),
  ];
  const narrow = [
    ch('a', 'A', [{ title: '국채 경매 결과', views: 100000 }]),
    ch('b', 'B', [{ title: '무관한 주제', views: 100000 }]),
    ch('c', 'C', [{ title: '다른 주제', views: 100000 }]),
    ch('d', 'D', [{ title: '또 다른 것', views: 100000 }]),
  ];
  const s = (r) => r.find((x) => x.keyword === '국채')?.score ?? 0;
  assert.ok(s(blueOcean(narrow, {}, { now: NOW, maxCompetition: 1, minDemandNorm: 0 }))
          > s(blueOcean(wide, {}, { now: NOW, maxCompetition: 1, minDemandNorm: 0 })),
    '경쟁도가 높을수록 점수가 낮아야 한다');

  for (const b of blueOcean(wide, {}, { now: NOW })) assert.ok(b.competition <= 0.34);
});

test('relativeVpd removes channel scale', () => {
  const channels = [
    ch('big', 'Big', [{ title: 'x', views: 1_000_000 }, { title: 'y', views: 1_000_000 }]),
    ch('small', 'Small', [{ title: 'x', views: 1000 }, { title: 'y', views: 1000 }]),
  ];
  const rel = relativeVpd(channels, 30, NOW);
  assert.equal(rel.get('big-0'), 1, '자기 채널 중앙값 대비 1.0');
  assert.equal(rel.get('small-0'), 1, '규모가 달라도 동일하게 1.0');
});

test('titleFeatures needs the feature to appear in at least two channels', () => {
  // 한 채널만 대괄호를 쓰고 그 채널이 크면, 정규화 전에는 피처 효과로 오인된다
  const solo = [
    ch('a', 'A', Array.from({ length: 8 }, (_, i) => ({ title: `[속보] 건 ${i}`, views: 500000, daysAgo: 5 }))),
    ch('b', 'B', Array.from({ length: 8 }, (_, i) => ({ title: `일반 제목 ${i}`, views: 1000, daysAgo: 5 }))),
  ];
  const feats = titleFeatures(solo, { now: NOW, minN: 3 });
  assert.ok(!feats.some((f) => f.feature === 'has_bracket'),
    '단일 채널 피처는 채널 효과와 분리 불가 — 보고하지 않는다');
});

test('formatPatterns reports KST hours and never mutates our schedule', () => {
  const channels = [ch('a', 'A', Array.from({ length: 10 }, (_, i) => ({
    title: `건 ${i}`, views: 10000 + i, daysAgo: 2 + i, dur: 700,
  })))];
  const p = formatPatterns(channels, { now: NOW, ourSlots: { 'us-close': 8 } });
  assert.equal(p.upload_hour_kst.histogram.length, 24);
  assert.equal(p.weekday_kst.histogram.length, 7);
  assert.ok(['aligned', 'shift_candidate'].includes(p.slot_alignment['us-close'].verdict));
  assert.equal(p.slot_alignment['us-close'].our_publish_kst, 8, '권고만 하고 값을 바꾸지 않는다');
});

test('relatedTerms surfaces co-occurring unigrams only', () => {
  const channels = [ch('a', 'A', [
    { title: '국채 금리 상승세', views: 1000, daysAgo: 1 },
    { title: '국채 금리 반등', views: 1000, daysAgo: 2 },
    { title: '국채 금리 흐름', views: 1000, daysAgo: 3 },
  ])];
  const r = relatedTerms(channels, ['국채'], { now: NOW, minCooccur: 3 });
  assert.ok(r['국채']?.includes('금리'));
  assert.ok(!(r['국채'] ?? []).some((t) => t.includes(' ')), '바이그램은 공기어로 쓰지 않는다');
});

test('analysis functions demand an injected clock', () => {
  for (const fn of [contentGaps, outliers, blueOcean, titleFeatures, formatPatterns]) {
    assert.throws(() => fn([], {}, {}), TypeError, `${fn.name} must require now`);
  }
});
