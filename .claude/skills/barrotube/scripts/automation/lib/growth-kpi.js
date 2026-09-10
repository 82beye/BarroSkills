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

/** 히트율: 최근 영상 중 vpd ≥ multiple × 기준선 비율. 기준선 없거나 최근 0편이면 null. */
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
    .filter((v) => { const d = ageDays(v, now); return d !== null && d >= atHours / 24; });
  if (!recent.length) return null;
  const hits = recent.filter((v) => { const x = at(v); return Number.isFinite(x) && x >= multiple * base; });
  return hits.length / recent.length;
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
export function weeklyViewsGrowth(history, videos, now) {
  // 1순위: 인덱스 총조회 (Shorts 포함). 채널 viewCount 는 Shorts 를 안 세므로 믿지 않는다.
  const n0 = indexViewsAt(videos, now);
  const n1 = indexViewsAt(videos, new Date(now.getTime() - 168 * HOUR_MS));
  const n2 = indexViewsAt(videos, new Date(now.getTime() - 336 * HOUR_MS));
  if (n0 !== null && n1 !== null && n2 !== null) {
    const cur = n0 - n1;
    const prev = n1 - n2;
    if (prev > 0 && cur >= 0) return { value: cur / prev, method: 'index' };
  }
  const thisWeek = netDelta(history, 'views', now, { windowHours: 168 });
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

/**
 * 인덱스 기준 채널 총 조회수(시각 t). 각 영상의 t 이전 마지막 관측을 더한다.
 *
 * 왜 채널 statistics.viewCount 를 안 쓰나 — 그 값이 Shorts 를 제대로 세지 않는다.
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
    for (const h of v.stats_history ?? []) {
      const at = obsAt(h);
      if (Number.isFinite(at) && at <= ms && Number.isFinite(h.views)) last = h.views;
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
  for (const h of v.stats_history ?? []) {
    const at = obsAt(h);
    if (!Number.isFinite(at) || !Number.isFinite(h.views)) continue;
    if ((at - pub) / HOUR_MS <= maxHours) val = h.views;
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
  const cutoff = now.getTime() - windowDays * 24 * HOUR_MS;
  let num = 0;
  let den = 0;
  for (const r of analyticsRows) {
    const t = Date.parse(`${r.day}T00:00:00Z`);
    if (!Number.isFinite(t) || t < cutoff) continue;
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
    .filter((v) => v.privacy === null || v.privacy === 'public');
  push('publish_consistency_7d',
    k.publish_consistency_7d.planned_per_week > 0
      ? recent.length / k.publish_consistency_7d.planned_per_week : null);
  push('weekly_net_subs', netDelta(history, 'subs', now), 'history');
  const wvg = weeklyViewsGrowth(history, videos, now);
  // 코호트 프록시는 구세대가 누적 시간이 길어 구조적으로 낮게 나온다 — 값만 보여주고
  // 등급은 NA. history 2주치가 쌓이면 진짜 WoW 로 판정이 살아난다.
  push('weekly_views_growth', wvg.value, wvg.method);
  if (wvg.method !== 'history') {
    const w = out.find((o) => o.id === 'weekly_views_growth');
    w.grade = 'NA';
  }
  push('video_hit_rate_7d', hitRate(videos, now, { multiple: k.video_hit_rate_7d.hit_multiple }));
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
export function normalizeIndex(index) {
  const out = [];
  for (const [videoId, v] of Object.entries(index?.videos ?? {})) {
    const last = (v.stats_history ?? []).at(-1) ?? {};
    out.push({
      videoId,
      title: v.title ?? '',
      publishedAt: v.publishedAt ?? null,
      duration_s: v.duration_s ?? null,
      isShorts: !!v.isShorts,
      privacy: v.privacy ?? null,
      // 시점별 조회수를 복원하려면 관측 이력이 필요하다 — indexViewsAt / viewsAtAge 가 쓴다.
      stats_history: v.stats_history ?? [],
      views: Number.isFinite(last.views) ? last.views : null,
      likes: Number.isFinite(last.likes) ? last.likes : null,
      comments: Number.isFinite(last.comments) ? last.comments : null,
    });
  }
  return out;
}
