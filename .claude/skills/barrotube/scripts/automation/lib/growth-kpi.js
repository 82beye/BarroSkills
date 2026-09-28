/**
 * growth-kpi.js — 채널 성장 KPI 순수 계산 라이브러리
 *
 * I/O 없음. 모든 함수는 (데이터, 설정, now) → 값. LLM 없음, 네트워크 없음.
 * CLI(../growth-kpi.js)가 파일을 읽어 여기로 넘기고 결과를 기록한다.
 *
 * 입력 정규화 형태:
 *   videos:  [{ videoId, title, publishedAt, duration_s, isShorts, views, likes, comments }]
 *            — workspace/growth/channel/videos.json 인덱스의 stats_history 마지막 관측을 편 것
 *   history: [{ at, subs, views, videoCount }]  — history.jsonl 시계열 (시간순 정렬 가정 안 함)
 *
 * 등급 규약: GREEN ≥ green, YELLOW ≥ yellow, RED < yellow, NA = 계산 불가(관측 부족).
 * NA 는 실패가 아니다 — 채널 관측 축적 초기(첫 7일)에 정상적으로 나온다.
 */

const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;

/** publishedAt 기준 경과 일수. 미래·파싱 불가면 null. */
export function ageDays(video, now) {
  const t = Date.parse(video?.publishedAt ?? '');
  if (!Number.isFinite(t)) return null;
  const d = (now.getTime() - t) / DAY_MS;
  return d > 0 ? d : null;
}

/** views per day. 게시 24시간 미만은 하루로 본다 — 분모 폭주 방지. */
export function vpd(video, now) {
  const d = ageDays(video, now);
  if (d === null || !Number.isFinite(video?.views)) return null;
  return video.views / Math.max(d, 1);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 기준선: minAgeDays~maxAgeDays 사이 영상들의 vpd 중앙값. 표본 3 미만이면 null. */
export function baselineVpd(videos, now, { minAgeDays = 7, maxAgeDays = 37 } = {}) {
  const xs = [];
  for (const v of videos) {
    const d = ageDays(v, now);
    if (d === null || d < minAgeDays || d > maxAgeDays) continue;
    const x = vpd(v, now);
    if (x !== null) xs.push(x);
  }
  return xs.length >= 3 ? median(xs) : null;
}

/** 최근 windowDays 안에 게시된 영상들. */
export function recentVideos(videos, now, windowDays = 7) {
  return videos.filter((v) => {
    const d = ageDays(v, now);
    return d !== null && d <= windowDays;
  });
}

/**
 * KPI 계산식의 판본.
 *
 * 왜 필요한가 — 실험 판정은 "시작 시점 KPI 문서" 와 "종료 시점 KPI 문서" 를 견준다.
 * 그 사이에 계산식이 바뀌면 실험이 아니라 **계산식 변경을 측정**하게 된다.
 * 2026-09-14 EXP-01-title-bracket 이 정확히 그렇게 fail 판정을 받았다:
 *   - 시작(2026-08-31) 히트율 1.0 — 옛 vpd 기준 (갓 올라간 영상이 항상 배수를 넘던 식)
 *   - 종료(2026-09-14) 히트율 0.09 — 2026-09-10 커밋 1ae7391 로 48h 나이 정합 비교로 교체된 뒤
 *   → -91% 로 읽혀 '제목 대괄호가 조회를 죽였다' 는 결론이 났지만, 그 커밋의 제목이
 *     "조회가 무너지는 주에 초록불이 켜지던 KPI를 고친다" 다. 옛 값이 틀렸던 것이다.
 * 판본이 다르면 판정하지 않는다 — 실험을 태우느니 한 주 더 돌리는 게 싸다.
 */
export const METRICS_VERSION = 3;

/** 계산식이 바뀐 시점들. 판본 필드가 없던 옛 문서도 생성 시각으로 되짚는다. */
const METRICS_EPOCHS = [
  { version: 2, from: '2026-09-10T11:55:43Z' },  // 1ae7391 — 히트율을 48h 나이 정합 비교로 교체
];

export function metricsVersionOf(kpiDoc) {
  if (Number.isFinite(kpiDoc?.metrics_version)) return kpiDoc.metrics_version;
  const t = Date.parse(kpiDoc?.generated_at ?? '');
  if (!Number.isFinite(t)) return null;
  let v = 1;
  for (const e of METRICS_EPOCHS) if (t >= Date.parse(e.from)) v = e.version;
  return v;
}

export function hitRate(videos, now, { windowDays = 7, multiple = 1.5, atHours = 48 } = {}) {
  // **나이를 맞춰 비교한다.** 예전에는 vpd(누적조회/나이)를 30일 중앙값과 견줬는데,
  // Shorts 는 초기 이틀에 조회가 몰려서 vpd 가 나이에 반비례한다 — 갓 올라간 영상은
  // 성과와 무관하게 항상 배수를 넘고, 같은 영상이 나이만 먹으면 자동 탈락한다.
  // 2026-09-10 실측: 48h 조회가 968→312 로 3분의 1이 된 주에 히트율은 100% GREEN 이었다.
  const at = (v) => viewsAtAge(v, atHours);
  const pool = [];
  for (const v of videos) {
    const d = ageDays(v, now);
    if (d === null || d < atHours / 24 || d > 37) continue;
    const x = at(v);
    if (Number.isFinite(x)) pool.push(x);
  }
  if (pool.length < 3) return null;
  const base = median(pool);
  if (!base || base <= 0) return null;
  // 판정 대상도 48h 를 넘긴 것만 — 아직 크는 중인 영상을 실패로 세지 않는다.
  const recent = recentVideos(videos, now, windowDays)
    .filter((v) => { const d = ageDays(v, now); return d !== null && d >= atHours / 24 && Number.isFinite(at(v)); });
  if (!recent.length) return null;
  const hits = recent.filter((v) => { const x = at(v); return Number.isFinite(x) && x >= multiple * base; });
  return hits.length / recent.length;
}

/**
 * 48h 조회 지수: 최근 7일 영상의 48시간 조회 중앙값 ÷ 기준선(2~37일) 중앙값.
 *
 * 히트율과 같은 재료를 쓰지만 **임계 통과 비율이 아니라 크기의 비**다. 왜 둘 다 필요한가 —
 * 히트율은 표본 11편짜리 임계 지표라 분포가 통째로 조금만 내려가도 100% → 0% 로 튄다
 * (2026-09-08 100% → 09-09 0%). RED 를 봐도 "한 계단 내려갔다"인지 "절반이 됐다"인지
 * 구분이 안 된다. 2026-09-14 실측: 히트율 9%(RED) 뒤에 있던 실제 값은 475 / 792 = 0.60 이다 —
 * 조회가 40% 빠진 건 사실이지만 -91% 는 아니었다.
 * 실험 판정도 이 연속값으로 하는 편이 임계 비율보다 훨씬 덜 흔들린다.
 */
export function views48Index(videos, now, { windowDays = 7, atHours = 48 } = {}) {
  const at = (v) => viewsAtAge(v, atHours);
  const minAge = atHours / 24;
  // 기준선에서 **최근 창을 뺀다.** 넣으면 분모가 분자를 따라 내려가 변화가 지워진다 —
  // 2026-09-14 실측: 넣으면 475/518 = 0.92 (완만해 보인다), 빼면 475/792 = 0.60 (실제 낙폭).
  const pool = [];
  for (const v of videos) {
    const d = ageDays(v, now);
    if (d === null || d <= windowDays || d > 37) continue;
    const x = at(v);
    if (Number.isFinite(x)) pool.push(x);
  }
  if (pool.length < 3) return null;
  const base = median(pool);
  if (!base || base <= 0) return null;
  const recent = [];
  for (const v of recentVideos(videos, now, windowDays)) {
    const d = ageDays(v, now);
    if (d === null || d < minAge) continue;
    const x = at(v);
    if (Number.isFinite(x)) recent.push(x);
  }
  if (!recent.length) return null;
  return median(recent) / base;
}

/**
 * 발행 1편이 실제로 사 온 조회 = 최근 7일 채널 조회 증분 ÷ 같은 기간 발행 편수.
 *
 * 이 지표가 없으면 스코어카드의 두 RED 가 **서로 반대 방향을 가리키는데** 아무도 모른다.
 * 2026-09-14 실측(채널 Analytics, 9/01~9/11):
 *   2편 발행일 (n=5) 채널 총 조회 중앙값 1249  →  편당 625
 *   3편 발행일 (n=3) 채널 총 조회 중앙값 1239  →  편당 413
 * 셋째 편은 총 도달을 **1%도 늘리지 못하고** 같은 파이를 나눈다. 그런데
 * publish_consistency_7d 는 주 13편(1.86/일)을 목표로 두고 미달이면 RED 를 켠다 —
 * 그 RED 를 끄려고 더 올리면 video_hit_rate_7d 와 views_48h_index_7d 가 내려간다.
 * 표본이 8일치라 확정은 아니다. 그래서 판정이 아니라 **계측기**를 먼저 놓는다.
 */
export function viewsPerPublish(videos, now, { windowDays = 7 } = {}) {
  const v0 = indexViewsAt(videos, now);
  const v1 = indexViewsAt(videos, new Date(now.getTime() - windowDays * 24 * HOUR_MS));
  if (v0 === null || v1 === null) return null;
  const published = recentVideos(videos, now, windowDays)
    .filter((v) => v.privacy == null || v.privacy === 'public').length;
  if (!published) return null;
  const gained = v0 - v1;
  return gained >= 0 ? gained / published : null;
}

/** 좋아요율: 최근 영상 Σlikes/Σviews. 조회 0이면 null. */
export function likeRate(videos, now, { windowDays = 7 } = {}) {
  const recent = recentVideos(videos, now, windowDays);
  let likes = 0, views = 0;
  for (const v of recent) {
    if (Number.isFinite(v.views)) views += v.views;
    if (Number.isFinite(v.likes)) likes += v.likes;
  }
  return views > 0 ? likes / views : null;
}

/**
 * 시계열에서 trailing 윈도 증분. now 로부터 windowHours 이전(±tolerance)에 가장
 * 가까운 관측을 앵커로 잡는다. 앵커가 없으면 null — 관측 축적 초기의 정상 상태.
 */
export function netDelta(history, field, now, { windowHours = 168, toleranceHours = 36 } = {}) {
  const rows = (history ?? [])
    // null 은 '관측 없음'이다 — Number(null)===0 이라 그대로 두면 결손 행 하나가
    // Δsubs=-116 같은 거짓 RED 를 만든다. now 이후 행도 제외해야 '지난주 델타'
    // 호출(now 를 과거로 넘기는 weeklyViewsGrowth)이 미래 관측을 끝점으로 잡지 않는다.
    .map((r) => ({ t: Date.parse(r.at ?? ''), v: r[field] == null ? NaN : Number(r[field]) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v) && r.t <= now.getTime())
    .sort((a, b) => a.t - b.t);
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  // 끝점이 now 에서 너무 멀면 이건 'now 기준 trailing 윈도'가 아니다.
  if (now.getTime() - latest.t > toleranceHours * HOUR_MS) return null;
  const target = now.getTime() - windowHours * HOUR_MS;
  let anchor = null, best = Infinity;
  for (const r of rows) {
    const gap = Math.abs(r.t - target);
    if (gap < best) { best = gap; anchor = r; }
  }
  if (!anchor || anchor.t === latest.t) return null;
  if (best > toleranceHours * HOUR_MS) return null;
  return latest.v - anchor.v;
}

/**
 * 주간 조회 성장 (WoW). 채널 누적 조회 시계열이 2주치 있으면 Δ이번주/Δ지난주.
 * 없으면 코호트 프록시: (0~7d 영상 조회 합)/(7~14d 영상 조회 합) — 구세대 코호트가
 * 누적 시간이 더 길어 보수적으로 낮게 나온다. method 로 어느 쪽인지 밝힌다.
 */
export function weeklyViewsGrowth(history, videos, now, analytics = null) {
  // Analytics 일별 조회는 같은 집계 기준의 완결된 7일 창 두 개를 제공한다.
  const days = analyticsWindow(analytics, now, 14);
  if (days.length === 14) {
    const previous = days.slice(0, 7).reduce((sum, r) => sum + r.views, 0);
    const current = days.slice(7).reduce((sum, r) => sum + r.views, 0);
    if (previous > 0) return { value: current / previous, method: 'analytics' };
  }
  // Analytics가 없으면 영상 인덱스의 동일한 관측 기준으로 비교한다.
  const n0 = indexViewsAt(videos, now);
  const n1 = indexViewsAt(videos, new Date(now.getTime() - 168 * HOUR_MS));
  const n2 = indexViewsAt(videos, new Date(now.getTime() - 336 * HOUR_MS));
  if (n0 !== null && n1 !== null && n2 !== null) {
    const cur = n0 - n1;
    const prev = n1 - n2;
    if (prev > 0 && cur >= 0) return { value: cur / prev, method: 'index' };
  }
  // 영상 인덱스와 채널 누적 통계는 서로 다른 모집단이다. 인덱스의 14일 앵커가
  // 없다고 채널값으로 갈아타면 2026-09-14처럼 거짓 12.25× GREEN 이 나온다.
  const hasIndexHistory = videos.some((v) => v.stats_history?.length);
  const thisWeek = hasIndexHistory ? null : netDelta(history, 'views', now, { windowHours: 168 });
  if (thisWeek !== null) {
    const prev = netDelta(history, 'views', new Date(now.getTime() - 168 * HOUR_MS), { windowHours: 168 });
    if (prev !== null && prev > 0) return { value: thisWeek / prev, method: 'history' };
  }
  let cur = 0, old = 0;
  for (const v of videos) {
    const d = ageDays(v, now);
    if (d === null || !Number.isFinite(v.views)) continue;
    if (d <= 7) cur += v.views;
    else if (d <= 14) old += v.views;
  }
  if (old > 0 && cur > 0) return { value: cur / old, method: 'proxy_cohort' };
  return { value: null, method: 'na' };
}

const obsAt = (h) => Date.parse(h?.at ?? h?.observed_at ?? '');

function analyticsWindow(rows, now, windowDays = 7) {
  const days = new Map();
  for (const row of rows ?? []) {
    const t = Date.parse(`${row.day}T00:00:00Z`);
    if (Number.isFinite(t) && t <= now.getTime() && row.views != null && Number.isFinite(Number(row.views)) && Number(row.views) >= 0) {
      days.set(row.day, { ...row, views: Number(row.views) });
    }
  }
  const ordered = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const last = Date.parse(ordered.at(-1)?.day ?? '');
  // Analytics는 확정 일자까지 지연된다. 마지막 확정일을 표시하고 그날까지 비교한다.
  if (!Number.isFinite(last) || now.getTime() - last > 4 * DAY_MS) return [];
  return ordered.filter((r) => Date.parse(r.day) > last - windowDays * DAY_MS);
}

/**
 * 인덱스 기준 채널 총 조회수(시각 t). 각 영상의 t 이전 마지막 관측을 더한다.
 *
 * 채널 statistics.viewCount와 영상 인덱스는 모집단·갱신 시점이 다를 수 있어 섞지 않는다.
 * 2026-09-10 실측: 영상별 합계 59,518 vs 채널값 49,317(-10,201), 그리고 주간 증분은
 * 영상 9편이 약 5,400 뷰를 받는 동안 **+16** 이었다. 그 16 이 분모로 들어가
 * 구독 전환이 375/1k뷰(GREEN)로 나왔다 — 조회가 실제로 무너지던 주에 초록불이 켜졌다.
 */
export function indexViewsAt(videos, t) {
  const ms = t instanceof Date ? t.getTime() : Number(t);
  let total = 0;
  let seen = 0;
  for (const v of videos ?? []) {
    let last = null;
    let lastAt = -Infinity;
    for (const h of v.stats_history ?? []) {
      const at = obsAt(h);
      if (Number.isFinite(at) && at <= ms && at >= lastAt && Number.isFinite(h.views) && h.views >= 0) {
        last = h.views;
        lastAt = at;
      }
    }
    if (last !== null) { total += last; seen += 1; }
  }
  return seen ? total : null;
}

/**
 * 게시 후 maxHours 시점의 조회수. Shorts 는 초기 이틀에 승부가 나고 그 뒤로는 거의 눕는다.
 * 나이가 다른 영상을 같은 자로 재려면 vpd 가 아니라 이 값을 써야 한다.
 */
export function viewsAtAge(v, maxHours = 48) {
  const pub = Date.parse(v?.publishedAt ?? '');
  if (!Number.isFinite(pub)) return null;
  let val = null;
  let lastAt = -Infinity;
  for (const h of v.stats_history ?? []) {
    const at = obsAt(h);
    const age = (at - pub) / HOUR_MS;
    // 하루 두 번 수집하므로 목표 시점 직전 24시간 안의 관측만 쓴다.
    if (!Number.isFinite(at) || !Number.isFinite(h.views) || h.views < 0) continue;
    if (age >= Math.max(0, maxHours - 24) && age <= maxHours && at >= lastAt) {
      val = h.views;
      lastAt = at;
    }
  }
  return val;
}

/**
 * 최근 windowDays 의 평균 시청률(조회 가중). Analytics 행이 없으면 null.
 *
 * 왜 averageViewDuration 이 아니라 percentage 인가 — 60초 Shorts 와 176초 롱폼이
 * 한 채널에 섞여 있어서 초 단위로는 비교가 안 된다. 2026-09-10 실측에서 176초 두 편의
 * 시청률이 41.5%·56.1% 로 가장 낮았는데, 초로만 보면 72초·98초라 오히려 길어 보인다.
 */
export function avgViewPct(analyticsRows, now, { windowDays = 7 } = {}) {
  if (!Array.isArray(analyticsRows) || !analyticsRows.length) return null;
  let num = 0;
  let den = 0;
  for (const r of analyticsWindow(analyticsRows, now, windowDays)) {
    if (r.views == null || r.averageViewPercentage == null) continue;
    const v = Number(r.views);
    const p = Number(r.averageViewPercentage);
    if (!Number.isFinite(v) || !Number.isFinite(p) || v <= 0) continue;
    num += v * p;
    den += v;
  }
  return den > 0 ? num / den / 100 : null;
}

/** 등급 판정. value null → NA. */
export function grade(value, { green, yellow, direction = 'gte' } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'NA';
  if (direction === 'gte') {
    if (value >= green) return 'GREEN';
    if (value >= yellow) return 'YELLOW';
    return 'RED';
  }
  if (value <= green) return 'GREEN';
  if (value <= yellow) return 'YELLOW';
  return 'RED';
}

/** 전체 등급: RED 하나라도 있으면 RED, 아니면 YELLOW 존재 시 YELLOW, 전부 NA 면 NA. */
export function overallGrade(grades) {
  const gs = grades.filter((g) => g !== 'NA');
  if (!gs.length) return 'NA';
  if (gs.includes('RED')) return 'RED';
  if (gs.includes('YELLOW')) return 'YELLOW';
  return 'GREEN';
}

function fmt(value, format) {
  if (value === null || value === undefined) return '—';
  switch (format) {
    case 'ratio': return `${Math.round(value * 100)}%`;
    case 'pct': return `${(value * 100).toFixed(2)}%`;
    case 'multiple': return `${value.toFixed(2)}×`;
    case 'int': return `${Math.round(value) >= 0 ? '+' : ''}${Math.round(value)}`;
    default: return value.toFixed(2);
  }
}

/**
 * 스코어카드 조립. config 는 config/growth.json 의 kpis 블록.
 * 반환: { overall, kpis: [{id,label,value,display,grade,method}], top, bottom }
 */
export function computeScorecard({ videos, history, config, now, analytics = null }) {
  videos = videos.filter((v) => (v.privacy == null || v.privacy === 'public')
    && (v.upload_status == null || v.upload_status === 'processed'));
  const k = config.kpis;
  const out = [];
  const push = (id, value, method = 'index') => {
    const def = k[id];
    out.push({
      id, label: def.label, value,
      display: fmt(value, def.format),
      grade: grade(value, def),
      method,
    });
  };

  // 발행 일관성은 '공개된' 영상만 센다 — private 로 남은 업로드(발행 사고)를 성과로
  // 치면 사고가 지표에서 사라진다. privacy 미상(null)은 구 인덱스 호환으로 포함.
  const recent = recentVideos(videos, now, 7)
    .filter((v) => v.privacy == null || v.privacy === 'public');
  push('publish_consistency_7d',
    k.publish_consistency_7d.planned_per_week > 0
      ? recent.length / k.publish_consistency_7d.planned_per_week : null);
  push('weekly_net_subs', netDelta(history, 'subs', now), 'history');
  const wvg = weeklyViewsGrowth(history, videos, now, analytics);
  // 코호트 프록시는 구세대가 누적 시간이 길어 구조적으로 낮게 나온다 — 값만 보여주고
  // 등급은 NA. history 2주치가 쌓이면 진짜 WoW 로 판정이 살아난다.
  push('weekly_views_growth', wvg.value, wvg.method);
  if (!['history', 'index', 'analytics'].includes(wvg.method)) {
    const w = out.find((o) => o.id === 'weekly_views_growth');
    w.grade = 'NA';
  }
  push('video_hit_rate_7d', hitRate(videos, now, { multiple: k.video_hit_rate_7d.hit_multiple }));
  // 히트율 바로 옆에 둔다 — RED 가 '한 계단'인지 '절반'인지는 이 값이 말해 준다.
  if (k.views_48h_index_7d) push('views_48h_index_7d', views48Index(videos, now));
  if (k.views_per_publish_7d) push('views_per_publish_7d', viewsPerPublish(videos, now));
  push('like_rate_7d', likeRate(videos, now));
  if (k.avg_view_pct_7d) push('avg_view_pct_7d', avgViewPct(analytics, now), analytics ? 'analytics' : 'na');
  const dSubs = netDelta(history, 'subs', now);
  // 분모는 인덱스 총조회 증분이다. 채널 viewCount 증분(주 +16)을 쓰면 375/1k 같은
  // 값이 나오고, 하필 GREEN 이라 조회 붕괴를 스코어카드가 덮어 버린다.
  const v0 = indexViewsAt(videos, now);
  const v1 = indexViewsAt(videos, new Date(now.getTime() - 168 * HOUR_MS));
  const dViews = v0 !== null && v1 !== null ? v0 - v1 : netDelta(history, 'views', now);
  push('subs_per_1k_views_7d',
    dSubs !== null && dViews !== null && dViews > 0 ? dSubs / (dViews / 1000) : null,
    v0 !== null && v1 !== null ? 'index' : 'history');

  const ranked = recentVideos(videos, now, 14)
    .map((v) => ({ ...v, _vpd: vpd(v, now) }))
    .filter((v) => v._vpd !== null)
    .sort((a, b) => b._vpd - a._vpd);

  return {
    overall: overallGrade(out.map((o) => o.grade)),
    kpis: out,
    top: ranked.slice(0, 3).map(({ videoId, title, views, _vpd }) => ({ videoId, title, views, vpd: Math.round(_vpd) })),
    bottom: ranked.slice(-3).reverse().map(({ videoId, title, views, _vpd }) => ({ videoId, title, views, vpd: Math.round(_vpd) })),
  };
}

/** 인덱스(videos.json) → 정규화 배열. stats_history 마지막 관측을 편다. */
export function normalizeIndex(index, now = new Date()) {
  const out = [];
  for (const [videoId, v] of Object.entries(index?.videos ?? {})) {
    const observations = (v.stats_history ?? [])
      .filter((h) => Number.isFinite(obsAt(h)) && obsAt(h) <= now.getTime())
      .sort((a, b) => obsAt(a) - obsAt(b));
    const last = observations.at(-1) ?? {};
    out.push({
      videoId,
      title: v.title ?? '',
      publishedAt: v.publishedAt ?? null,
      duration_s: v.duration_s ?? null,
      isShorts: !!v.isShorts,
      privacy: v.privacy ?? null,
      upload_status: v.upload_status ?? null,
      // 시점별 조회수를 복원하려면 관측 이력이 필요하다 — indexViewsAt / viewsAtAge 가 쓴다.
      stats_history: observations,
      views: Number.isFinite(last.views) ? last.views : null,
      likes: Number.isFinite(last.likes) ? last.likes : null,
      comments: Number.isFinite(last.comments) ? last.comments : null,
    });
  }
  return out;
}
