import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ageDays, vpd, baselineVpd, recentVideos, hitRate, likeRate,
  netDelta, weeklyViewsGrowth, grade, overallGrade, computeScorecard, normalizeIndex,
} from '../scripts/automation/lib/growth-kpi.js';

const NOW = new Date('2026-08-31T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400_000).toISOString();

const vid = (d, views, likes = 0, over = {}) => ({
  videoId: `v${d}`, title: `t${d}`, publishedAt: daysAgo(d), views, likes, comments: 0, ...over,
});

test('ageDays·vpd — 24h 미만은 하루로 클램프, 파싱 불가는 null', () => {
  assert.ok(Math.abs(ageDays(vid(3, 0), NOW) - 3) < 1e-9);
  assert.equal(ageDays({ publishedAt: 'garbage' }, NOW), null);
  // 게시 0.5일·조회 600 → vpd 는 600/1(클램프)이지 1200이 아니다
  assert.equal(vpd(vid(0.5, 600), NOW), 600);
  assert.equal(vpd(vid(2, 800), NOW), 400);
});

test('baselineVpd — 7~37d 창, 표본 3 미만이면 null', () => {
  const base3 = [vid(10, 1000), vid(20, 2000), vid(30, 3000)];
  assert.equal(baselineVpd(base3, NOW), 100); // vpd: 100,100,100 → median 100
  assert.equal(baselineVpd(base3.slice(0, 2), NOW), null);
  // 창 밖(3d·40d)은 기준선에 안 들어간다
  assert.equal(baselineVpd([...base3, vid(3, 99999), vid(40, 1)], NOW), 100);
});

test('hitRate — 기준선 1.5배 이상 비율, 기준선 없으면 null', () => {
  const base = [vid(10, 1000), vid(20, 2000), vid(30, 3000)]; // baseline vpd=100
  const recent = [vid(2, 400), vid(3, 100)]; // vpd 200(hit), 33(miss)
  assert.equal(hitRate([...base, ...recent], NOW), 0.5);
  assert.equal(hitRate(recent, NOW), null); // 기준선 표본 부족
});

test('likeRate — Σlikes/Σviews, 최근 조회 0이면 null', () => {
  const vs = [vid(1, 1000, 10), vid(2, 1000, 30)];
  assert.equal(likeRate(vs, NOW), 0.02);
  assert.equal(likeRate([vid(20, 1000, 10)], NOW), null); // 7d 밖
});

test('netDelta — 앵커 허용오차 밖이면 null (관측 축적 초기)', () => {
  const h = (hrs, subs) => ({ at: new Date(NOW.getTime() - hrs * 3600_000).toISOString(), subs });
  assert.equal(netDelta([h(170, 100), h(0, 130)], 'subs', NOW), 30);
  // 이틀치뿐 — 168h 앵커에서 100h 이상 벗어나면 null
  assert.equal(netDelta([h(30, 100), h(0, 130)], 'subs', NOW), null);
  assert.equal(netDelta([h(0, 130)], 'subs', NOW), null);
  // null 은 '관측 없음' — 0 으로 코어싱해 Δ=-130 을 만들면 안 된다 (리뷰 2026-08-31)
  assert.equal(netDelta([h(170, 100), h(1, null), h(0, 130)], 'subs', NOW), 30);
  // now 이후의 미래 관측은 끝점이 될 수 없다 — '지난주 델타' 호출의 핵심
  const past = new Date(NOW.getTime() - 168 * 3600_000);
  assert.equal(netDelta([h(336, 50), h(168, 80), h(0, 130)], 'subs', past), 30);
  // 끝점이 now 에서 tolerance 이상 멀면 trailing 윈도가 아니다
  assert.equal(netDelta([h(400, 50), h(240, 80)], 'subs', NOW), null);
});

test('weeklyViewsGrowth — history 방식이 진짜 WoW 를 낸다 (Δ7d/Δ14d 버그 회귀 방지)', () => {
  const h = (hrs, views) => ({ at: new Date(NOW.getTime() - hrs * 3600_000).toISOString(), views, subs: 1 });
  // 지난주 +1000, 이번주 +1500 → 1.5× (버그 시절엔 1500/2500=0.6 이 나왔다)
  const r = weeklyViewsGrowth([h(336, 1000), h(168, 2000), h(0, 3500)], [], NOW);
  assert.equal(r.method, 'history');
  assert.equal(r.value, 1.5);
});

test('weeklyViewsGrowth — 히스토리 없으면 코호트 프록시로 강등', () => {
  const videos = [vid(2, 3000), vid(10, 2000)];
  const r = weeklyViewsGrowth([], videos, NOW);
  assert.equal(r.method, 'proxy_cohort');
  assert.equal(r.value, 1.5);
  assert.equal(weeklyViewsGrowth([], [vid(2, 100)], NOW).method, 'na');
});

test('grade·overallGrade — NA 는 실패가 아니라 미관측', () => {
  const def = { green: 10, yellow: 3 };
  assert.equal(grade(12, def), 'GREEN');
  assert.equal(grade(5, def), 'YELLOW');
  assert.equal(grade(1, def), 'RED');
  assert.equal(grade(null, def), 'NA');
  assert.equal(overallGrade(['GREEN', 'NA', 'YELLOW']), 'YELLOW');
  assert.equal(overallGrade(['GREEN', 'RED']), 'RED');
  assert.equal(overallGrade(['NA', 'NA']), 'NA');
});

test('computeScorecard — 관측 0 상태에서도 죽지 않고 NA 스코어카드를 낸다', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../config/growth.json', import.meta.url), 'utf-8'));
  const empty = computeScorecard({ videos: [], history: [], config, now: NOW });
  assert.ok(['NA', 'RED'].includes(empty.overall)); // 발행 0/13 은 RED 로 잡혀야 정상
  assert.equal(empty.kpis.length, 6);

  const videos = [
    ...[10, 15, 20, 30].map((d) => vid(d, d * 100, d)),
    ...[1, 2, 3].map((d) => vid(d, 900, 18)),
  ];
  const history = [
    { at: daysAgo(7.05), subs: 100, views: 40000 },
    { at: daysAgo(0), subs: 112, views: 48000 },
  ];
  const card = computeScorecard({ videos, history, config, now: NOW });
  const byId = Object.fromEntries(card.kpis.map((k) => [k.id, k]));
  assert.equal(byId.weekly_net_subs.value, 12);
  assert.equal(byId.weekly_net_subs.grade, 'GREEN');
  assert.equal(byId.subs_per_1k_views_7d.value, 1.5);
  assert.ok(card.top.length >= 1);
  // history 가 1주치뿐이면 WoW 는 프록시로 강등 → 값은 있어도 등급은 NA
  assert.equal(byId.weekly_views_growth.grade, 'NA');

  // private 로 남은 업로드는 발행 일관성에 안 들어간다 (privacy null 은 구 인덱스 호환)
  const withPrivate = [...videos, vid(1, 500, 5, { videoId: 'priv', privacy: 'private' })];
  const card2 = computeScorecard({ videos: withPrivate, history, config, now: NOW });
  const pc = (c) => c.kpis.find((k) => k.id === 'publish_consistency_7d').value;
  assert.equal(pc(card2), pc(card), 'private 추가가 발행 일관성을 올리면 안 된다');
});

test('normalizeIndex — stats_history 마지막 관측을 편다', () => {
  const idx = { videos: { a1: {
    title: 'T', publishedAt: daysAgo(1), duration_s: 45, isShorts: true,
    stats_history: [{ at: daysAgo(0.5), views: 10, likes: 1, comments: 0 }, { at: daysAgo(0), views: 99, likes: 5, comments: 2 }],
  } } };
  const [v] = normalizeIndex(idx);
  assert.equal(v.views, 99);
  assert.equal(v.likes, 5);
  assert.equal(normalizeIndex({}).length, 0);
});
