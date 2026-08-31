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
export function hitRate(videos, now, { windowDays = 7, multiple = 1.5 } = {}) {
  const base = baselineVpd(videos, now);
  if (base === null || base <= 0) return null;
  const recent = recentVideos(videos, now, windowDays);
  if (!recent.length) return null;
  const hits = recent.filter((v) => {
    const x = vpd(v, now);
    return x !== null && x >= multiple * base;
  });
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
export function computeScorecard({ videos, history, config, now }) {
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
  const dSubs = netDelta(history, 'subs', now);
  const dViews = netDelta(history, 'views', now);
  push('subs_per_1k_views_7d',
    dSubs !== null && dViews !== null && dViews > 0 ? dSubs / (dViews / 1000) : null, 'history');

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
      views: Number.isFinite(last.views) ? last.views : null,
      likes: Number.isFinite(last.likes) ? last.likes : null,
      comments: Number.isFinite(last.comments) ? last.comments : null,
    });
  }
  return out;
}
