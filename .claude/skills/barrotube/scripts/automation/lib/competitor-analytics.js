/**
 * competitor-analytics.js — 경쟁 인텔 순수 함수 모듈
 *
 * 규약: fs·network·Date.now() 를 직접 쓰지 않는다. 시각이 필요한 함수는 now 를 인자로 받는다.
 * 이 규약 덕분에 전 함수가 픽스처만으로 결정론 테스트 가능하다.
 *
 * S1 범위: duration 파싱 · 길이 버킷 · 쿼터 계산 · API 오류 분류
 * S2 범위(예정): tokenize · contentGaps · outliers · blueOcean · titleFeatureLift
 */

/** ISO 8601 duration. YouTube 는 라이브·프리미어·미처리 영상에 "P0D" 를 준다. */
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/;

/**
 * ISO 8601 duration → 초. 길이를 알 수 없으면 null.
 *
 * 구 정규식 `/PT\d{0,2}([0-5]?\dS)?$/` 은 "PT1M"(정확히 60초)을 놓쳤다.
 * `\d{0,2}` 가 "1" 을 먹은 뒤 "M" 이 남아 `$` 앵커에서 실패하기 때문이다.
 */
export function parseDuration(iso) {
  const m = ISO_DURATION.exec(iso ?? '');
  if (!m) return null;
  const sec = 86400 * (+m[1] || 0) + 3600 * (+m[2] || 0) + 60 * (+m[3] || 0) + (+m[4] || 0);
  return sec > 0 ? sec : null; // "P0D" / "PT0S" → 길이 불명
}

/**
 * 길이 버킷. vpd 분포가 자릿수 단위로 다르므로 이상치 baseline 은 버킷별로 분리해야 한다.
 * live 는 조회수 누적 곡선 자체가 달라 일반 영상과 섞으면 중앙값이 왜곡된다.
 */
export function lengthBucket(sec) {
  if (sec === null || sec === undefined) return 'live';
  if (sec <= 60) return 'shorts';
  if (sec <= 600) return 'mid';
  if (sec <= 1800) return 'long';
  return 'xlong';
}

/** 60초 이하만 쇼츠. 길이 불명(live)은 쇼츠가 아니다. */
export function isShorts(sec) {
  return sec !== null && sec !== undefined && sec <= 60;
}

/**
 * 수집 1회의 쿼터 소요(units).
 * 채널당 channels.list 1 + playlistItems.list 1 + videos.list 1 = 3.
 * deep scan 은 playlistItems 를 pages 회 돌고 videos.list 도 페이지마다 1회.
 */
export function planQuota(channelCount, { deep = false, pages = 4 } = {}) {
  if (!Number.isInteger(channelCount) || channelCount < 0) {
    throw new TypeError(`channelCount must be a non-negative integer, got ${channelCount}`);
  }
  const perChannel = deep ? 1 + pages + pages : 3;
  return channelCount * perChannel;
}

/** 일일 상한 대비 사전 점검. 초과하면 수집을 아예 시작하지 않는다. */
export function quotaPreflight({ used = 0, planned = 0, cap = 2000 } = {}) {
  const total = used + planned;
  return total > cap
    ? { allowed: false, total, cap, reason: `quota preflight: ${used} + ${planned} = ${total} > cap ${cap}` }
    : { allowed: true, total, cap, reason: null };
}

/**
 * YouTube API 오류 분류. 호출부는 이 분류로만 분기한다.
 *  quota      — 오늘은 더 못 부른다. 부분 저장 후 종료
 *  auth       — OAuth 갱신 필요. 사람 개입
 *  not_found  — 채널 소멸·비공개. 해당 채널만 건너뛴다
 *  transient  — 재시도 가능
 */
export function classifyApiError(status, body = '') {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  if (status === 403 && /quotaExceeded|rateLimitExceeded|userRateLimitExceeded/.test(text)) return 'quota';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500 || status === 429) return 'transient';
  return 'other';
}

/** 채널 uploads 재생목록 ID. UC… → UU… 치환은 YouTube 규약이며 API 호출이 필요 없다. */
export function uploadsPlaylistId(channelId) {
  return /^UC[\w-]{22}$/.test(channelId ?? '') ? `UU${channelId.slice(2)}` : null;
}

/**
 * 증분 수집 대상 선별.
 * 처음 보는 영상은 무조건, 이미 아는 영상은 refreshWindowDays 이내인 것만 다시 받는다.
 * (오래된 영상은 조회수가 안정돼 재조회 가치가 낮다)
 */
export function selectVideoIdsToFetch(candidates, index, { refreshWindowDays = 14, limit = 50, now } = {}) {
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');
  const cutoff = now.getTime() - refreshWindowDays * 86400_000;
  const known = index?.videos ?? {};
  const out = [];
  for (const c of candidates) {
    if (!c?.videoId) continue;
    const seen = known[c.videoId];
    const published = Date.parse(c.publishedAt ?? '');
    const fresh = Number.isFinite(published) && published >= cutoff;
    if (!seen || fresh) out.push(c.videoId);
    if (out.length >= limit) break;
  }
  return out;
}

/** stats_history 는 최근 N개만 남긴다. 남기지 않으면 파일이 무한히 자란다. */
export function appendStatsHistory(history, sample, max = 30) {
  const next = [...(history ?? []), sample];
  return next.length > max ? next.slice(next.length - max) : next;
}

// ─────────────────────────────────────────────────────────────
// 분석 (S2) — 입력은 정규화된 채널 배열:
//   [{ id, name, videos: [{ videoId, title, publishedAt, duration_s, length_bucket, views, ... }] }]
// ─────────────────────────────────────────────────────────────

const PARTICLES = /(은|는|이|가|을|를|에|의|로|와|과|도|만|까지|부터|보다|에서|에게|으로|이나|라도)$/;

export const DEFAULT_STOPWORDS = [
  // 시점·형식
  '오늘', '내일', '어제', '이번', '지금', '이제', '현재', '최근', '당일', '전일', '금일',
  '속보', '실시간', '라이브', '다시보기', '풀버전', '모아보기', '전체', '영상', '방송',
  '마감', '개장', '이모저모', '요약', '총정리', '한눈',
  // 도메인 상투어 — 어느 영상에나 붙어 주제를 구분하지 못한다
  '이슈', '뉴스', '시장', '경제', '주식', '증시', '투자', '분석', '전망', '정리',
  '특징주', '테마', '종목', '관심', '상승', '하락', '급등', '급락', '수급', '차트',
  // 일반 부사·대명사·연결어
  '다시', '기회', '진짜', '정말', '완전', '역시', '결국', '과연', '드디어', '아직',
  '모두', '전부', '함께', '통해', '위해', '대해', '관련', '경우', '때문', '그것', '이것',
  '어디', '무엇', '누구', '얼마', '가능', '필요', '시작', '준비',
  // 채널 운영어
  '채널', '구독', '좋아요', '댓글', '알림', '멤버십',
];

/** "08월", "12일", "2026년", "3분기" 처럼 주제가 아닌 날짜·수량 토큰 */
const DATE_LIKE = /^\d{1,4}(년|월|일|주|분기|호|차|편|회)$/;

/** 제목 → 유니그램 + 인접 바이그램. 형태소 분석기 의존 없이 조사만 떼어낸다. */
export function tokenize(title, stopwords = DEFAULT_STOPWORDS) {
  const stop = stopwords instanceof Set ? stopwords : new Set(stopwords);
  const raw = String(title ?? '').match(/[가-힣A-Za-z0-9]{2,}/g) ?? [];
  const uni = raw
    .map((t) => (t.length >= 3 ? t.replace(PARTICLES, '') : t))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && t.length <= 12)
    .filter((t) => !stop.has(t) && !/^\d+$/.test(t) && !DATE_LIKE.test(t));
  const bi = uni.slice(0, -1).map((t, i) => `${t} ${uni[i + 1]}`);
  return [...new Set([...uni, ...bi])];
}

/**
 * 임의 문자열에서 스톱워드 후보를 뽑는다 (채널명·핸들 등).
 * tokenize 와 같은 조사 제거·소문자화를 거쳐야 실제 토큰과 일치한다.
 * (2026-08-13: 채널명 "오선의 미국증시 라이브" 에서 "오선의" 를 그대로 넣었더니
 *  조사가 떨어진 "오선" 과 어긋나 "강세 오선" 이 블루오션 키워드로 새어나왔다)
 */
export function stopwordCandidates(text) {
  return (String(text ?? '').match(/[가-힣A-Za-z0-9]{2,}/g) ?? [])
    .map((t) => (t.length >= 3 ? t.replace(PARTICLES, '') : t))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (a.length === 0) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function ageDays(publishedAt, now) {
  const t = Date.parse(publishedAt ?? '');
  return Number.isFinite(t) ? Math.max((now.getTime() - t) / 86400_000, 0) : null;
}

/** 조회수/일. 하루 미만은 1일로 눌러 신생 영상이 무한대로 튀지 않게 한다. */
export function viewsPerDay(video, now) {
  const age = ageDays(video.publishedAt, now);
  return age === null ? null : (video.views ?? 0) / Math.max(age, 1);
}

function withinWindow(video, days, now) {
  const age = ageDays(video.publishedAt, now);
  return age !== null && age <= days;
}

/**
 * 콘텐츠 갭 — 경쟁사가 다뤘고 우리는 안 다룬 주제.
 * comp_df ≥ 2 가 핵심: 한 채널의 단발 기획은 노이즈, 2개 이상이면 수요가 검증된 것으로 본다.
 */
export function contentGaps(channels, ownTf = {}, opts = {}) {
  const {
    windowDays = 7, minDf = 2, minViews = 20000, limit = 15,
    stopwords = DEFAULT_STOPWORDS, now,
  } = opts;
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');

  const N = channels.length || 1;
  const df = new Map();     // term → Set(channelId)
  const tf = new Map();
  const views = new Map();
  const evidence = new Map(); // term → [{videoId, channel, views}]

  for (const ch of channels) {
    for (const v of ch.videos ?? []) {
      if (!withinWindow(v, windowDays, now)) continue;
      for (const t of tokenize(v.title, stopwords)) {
        if (!df.has(t)) { df.set(t, new Set()); tf.set(t, 0); views.set(t, 0); evidence.set(t, []); }
        df.get(t).add(ch.id);
        tf.set(t, tf.get(t) + 1);
        views.set(t, views.get(t) + (v.views ?? 0));
        evidence.get(t).push({ videoId: v.videoId, channel: ch.name, views: v.views ?? 0 });
      }
    }
  }

  const out = [];
  for (const [term, chans] of df) {
    const compDf = chans.size;
    const compViews = views.get(term);
    const own = ownTf[term] ?? 0;
    if (compDf < minDf || own !== 0 || compViews < minViews) continue;
    out.push({
      term,
      gap_score: +(Math.log10(1 + compViews) * (compDf / N) * (1 / (1 + own))).toFixed(4),
      comp_df: compDf,
      comp_tf: tf.get(term),
      comp_views: compViews,
      own_tf: own,
      evidence: evidence.get(term).sort((a, b) => b.views - a.views || a.videoId.localeCompare(b.videoId)).slice(0, 3),
    });
  }
  // 동점은 term 사전순으로 깨서 결정성을 보장한다
  return out.sort((a, b) => b.gap_score - a.gap_score || a.term.localeCompare(b.term)).slice(0, limit);
}

/**
 * 성과 이상치 — 수정 z-score(Iglewicz–Hoaglin).
 * 평균·표준편차는 표본 30개에서 이상치 자신에게 오염되므로 중앙값·MAD 를 쓴다.
 * 버킷별로 모집단을 나눠야 한다 — shorts 와 xlong 의 vpd 는 자릿수가 다르다.
 */
export function outliers(channels, opts = {}) {
  const {
    minZ = 3.5, minViews = 10000, baselineDays = 90, minAgeDays = 1, poolSize = 30, limit = 20, now,
  } = opts;
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');

  const found = [];
  for (const ch of channels) {
    const byBucket = new Map();
    for (const v of ch.videos ?? []) {
      const age = ageDays(v.publishedAt, now);
      if (age === null || age > baselineDays) continue;
      const b = v.length_bucket ?? 'live';
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b).push(v);
    }

    for (const [bucket, vids] of byBucket) {
      if (bucket === 'live') continue; // 라이브는 조회수 누적 곡선이 달라 비교 불가
      const pool = vids
        .filter((v) => (ageDays(v.publishedAt, now) ?? 0) >= 3)
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, poolSize);
      if (pool.length < 3) continue;

      const vpds = pool.map((v) => viewsPerDay(v, now)).filter(Number.isFinite);
      const med = median(vpds);
      if (med === null || med <= 0) continue;
      const mad = median(vpds.map((x) => Math.abs(x - med)));

      for (const v of vids) {
        const age = ageDays(v.publishedAt, now);
        if (age === null || age < minAgeDays) continue;
        if ((v.views ?? 0) < minViews) continue;
        const vpd = viewsPerDay(v, now);
        if (!Number.isFinite(vpd)) continue;

        const z = mad > 0 ? 0.6745 * (vpd - med) / mad : (vpd >= 3 * med ? 999 : 0);
        if (z < minZ) continue;

        found.push({
          videoId: v.videoId,
          channel: ch.name,
          title: v.title,
          publishedAt: v.publishedAt,
          views: v.views ?? 0,
          vpd: Math.round(vpd),
          median_vpd: Math.round(med),
          multiple: +(vpd / med).toFixed(2),
          mad_z: z === 999 ? 999 : +z.toFixed(2),
          length_bucket: bucket,
          duration_s: v.duration_s ?? null,
          accelerating: v.accelerating ?? null,
          thumbnail: v.thumbnail ?? null,
        });
      }
    }
  }
  return found.sort((a, b) => b.multiple - a.multiple || a.videoId.localeCompare(b.videoId)).slice(0, limit);
}

const KST = 'Asia/Seoul';
const HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: KST, hour: '2-digit', hour12: false });
const WDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: KST, weekday: 'short' });
const WDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function kstHour(publishedAt) {
  const t = Date.parse(publishedAt ?? '');
  return Number.isFinite(t) ? parseInt(HOUR_FMT.format(new Date(t)), 10) % 24 : null;
}

export function kstWeekday(publishedAt) {
  const t = Date.parse(publishedAt ?? '');
  return Number.isFinite(t) ? WDAY_IDX[WDAY_FMT.format(new Date(t))] ?? null : null;
}

/**
 * 채널 규모를 걷어낸 상대 성과. 각 영상의 vpd 를 그 채널의 median vpd 로 나눈다.
 *
 * 이 정규화가 없으면 "어떤 제목·포맷이 잘 되는가"가 아니라
 * "어느 채널이 큰가"를 측정하게 된다 — 실제로 2026-08-13 첫 분석에서
 * has_bracket(오선, 고조회) 5.98× / has_split(심플관심종목TV, 저조회) 0.35× 가 나왔는데
 * 이는 피처의 효과가 아니라 채널 규모 차이였다.
 */
export function relativeVpd(channels, windowDays, now) {
  const rel = new Map(); // videoId → 상대 성과
  for (const ch of channels) {
    const vids = (ch.videos ?? []).filter((v) => withinWindow(v, windowDays, now));
    const vpds = vids.map((v) => viewsPerDay(v, now)).filter(Number.isFinite);
    const med = median(vpds);
    if (med === null || med <= 0) continue;
    for (const v of vids) {
      const vpd = viewsPerDay(v, now);
      if (Number.isFinite(vpd)) rel.set(v.videoId, vpd / med);
    }
  }
  return rel;
}

/** 포맷·업로드 시각 패턴. 권고만 하고 routines.json 을 자동 변경하지 않는다. */
export function formatPatterns(channels, opts = {}) {
  const { windowDays = 30, minBucketN = 5, ourSlots = {}, now } = opts;
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');

  const rel = relativeVpd(channels, windowDays, now);
  const all = [];
  for (const ch of channels) {
    for (const v of ch.videos ?? []) if (withinWindow(v, windowDays, now)) all.push(v);
  }

  const byBucket = {};
  for (const v of all) {
    const b = v.length_bucket ?? 'live';
    (byBucket[b] ??= []).push(v);
  }
  const length = { by_bucket: {}, recommendation: null };
  let best = null;
  for (const b of Object.keys(byBucket).sort()) {
    const vids = byBucket[b];
    const mv = median(vids.map((v) => v.views ?? 0));
    const mvpd = median(vids.map((v) => viewsPerDay(v, now)).filter(Number.isFinite));
    const mrel = median(vids.map((v) => rel.get(v.videoId)).filter(Number.isFinite));
    length.by_bucket[b] = {
      n: vids.length,
      median_views: mv === null ? null : Math.round(mv),
      median_vpd: mvpd === null ? null : Math.round(mvpd),
      median_relative: mrel === null ? null : +mrel.toFixed(2),
      share: +(vids.length / (all.length || 1)).toFixed(3),
    };
    // 권고는 채널 정규화 성과로 고른다 — 큰 채널이 쓰는 포맷이 아니라 실제로 잘 되는 포맷
    if (b !== 'live' && vids.length >= minBucketN && mrel !== null && (best === null || mrel > best.v)) {
      best = { b, v: mrel };
    }
  }
  length.recommendation = best?.b ?? null;

  const hourN = Array(24).fill(0);
  const hourVpd = Array.from({ length: 24 }, () => []);
  const wdayN = Array(7).fill(0);
  const wdayVpd = Array.from({ length: 7 }, () => []);
  for (const v of all) {
    const h = kstHour(v.publishedAt);
    const d = kstWeekday(v.publishedAt);
    const r = rel.get(v.videoId);
    if (h !== null) { hourN[h]++; if (Number.isFinite(r)) hourVpd[h].push(r); }
    if (d !== null) { wdayN[d]++; if (Number.isFinite(r)) wdayVpd[d].push(r); }
  }
  const rank = (ns, vpds, minN) => ns
    .map((n, i) => ({ i, n, m: median(vpds[i]) }))
    .filter((x) => x.n >= minN && x.m !== null)
    .sort((a, b) => b.m - a.m || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.i);

  const bestHours = rank(hourN, hourVpd, 3);
  const bestWeekdays = rank(wdayN, wdayVpd, 3);

  const slot_alignment = {};
  for (const [slot, hour] of Object.entries(ourSlots)) {
    slot_alignment[slot] = {
      our_publish_kst: hour,
      competitor_best: bestHours,
      verdict: bestHours.includes(hour) ? 'aligned' : 'shift_candidate',
    };
  }

  return {
    length,
    upload_hour_kst: { histogram: hourN, best_hours: bestHours },
    weekday_kst: { histogram: wdayN, best_weekdays: bestWeekdays },
    slot_alignment,
  };
}

export const TITLE_FEATURES = {
  has_number: (t) => /\d/.test(t),
  has_percent: (t) => /%|퍼센트|배 |bp/.test(t),
  has_question: (t) => /[?？]|왜 |어떻게|얼마나|진짜|정말|맞나/.test(t),
  has_bracket: (t) => /^\[[^\]]+\]|^【/.test(t),
  has_superlative: (t) => /최대|최고|역대|급등|급락|폭락|폭등|사상|처음|충격|경고|비상/.test(t),
  has_split: (t) => /[:|/]/.test(t),
  title_short: (t) => t.length <= 30,
  has_emoji: (t) => /\p{Extended_Pictographic}/u.test(t),
};

/**
 * 제목 피처의 상대 성과 중앙값 비(lift).
 * 채널 정규화된 값을 쓰므로 "큰 채널이 쓰는 문법"이 아니라 "실제로 먹히는 문법"을 잰다.
 * 피처를 쓰는 채널이 하나뿐이면 여전히 채널 효과와 구분되지 않으므로 minChannels 로 막는다.
 */
export function titleFeatures(channels, opts = {}) {
  const { windowDays = 30, minN = 5, minLift = 1.3, minChannels = 2, extraFeatures = {}, now } = opts;
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');

  const rel = relativeVpd(channels, windowDays, now);
  const vids = [];
  for (const ch of channels) {
    for (const v of ch.videos ?? []) if (withinWindow(v, windowDays, now)) vids.push({ ...v, _ch: ch.id });
  }

  const feats = { ...TITLE_FEATURES, ...extraFeatures };
  const out = [];
  for (const name of Object.keys(feats).sort()) {
    const fn = feats[name];
    const withF = [], withoutF = [];
    const chWith = new Set();
    for (const v of vids) {
      const r = rel.get(v.videoId);
      if (!Number.isFinite(r)) continue;
      if (fn(String(v.title ?? ''))) { withF.push(r); chWith.add(v._ch); } else withoutF.push(r);
    }
    if (withF.length < minN || withoutF.length < minN) continue;
    // 한 채널에서만 나타나는 피처는 채널 효과와 분리할 수 없다
    if (chWith.size < minChannels) continue;
    const a = median(withF), b = median(withoutF);
    if (a === null || b === null || b <= 0) continue;
    const lift = a / b;
    if (lift < minLift && lift > 1 / minLift) continue;
    out.push({
      feature: name,
      n_with: withF.length,
      n_without: withoutF.length,
      lift: +lift.toFixed(2),
      direction: lift >= 1 ? 'positive' : 'negative',
    });
  }
  return out.sort((a, b) => b.lift - a.lift || a.feature.localeCompare(b.feature));
}

/**
 * 블루오션 — 수요는 있는데 경쟁이 얕은 키워드.
 * N=6 에서 comp_df=2 → competition=0.333 이라, 갭 조건(df≥2)과 여기 상한(0.34)이
 * 정확히 겹치는 지점이 스위트스팟이다.
 */
export function blueOcean(channels, ownTf = {}, opts = {}) {
  const {
    windowDays = 7, maxCompetition = 0.34, minDemandNorm = 0.5, limit = 10,
    stopwords = DEFAULT_STOPWORDS, now,
  } = opts;
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');

  const N = channels.length || 1;
  const df = new Map();
  const vpds = new Map();
  const ev = new Map();

  for (const ch of channels) {
    for (const v of ch.videos ?? []) {
      if (!withinWindow(v, windowDays, now)) continue;
      const vpd = viewsPerDay(v, now);
      if (!Number.isFinite(vpd)) continue;
      for (const t of tokenize(v.title, stopwords)) {
        if (!df.has(t)) { df.set(t, new Set()); vpds.set(t, []); ev.set(t, []); }
        df.get(t).add(ch.id);
        vpds.get(t).push(vpd);
        ev.get(t).push(v.videoId);
      }
    }
  }

  const demand = new Map();
  for (const [t, xs] of vpds) demand.set(t, median(xs) ?? 0);
  const maxDemand = Math.max(0, ...demand.values());
  const denom = Math.log10(1 + maxDemand) || 1;

  const out = [];
  for (const [term, chans] of df) {
    if ((ownTf[term] ?? 0) !== 0) continue;
    const competition = chans.size / N;
    if (competition > maxCompetition) continue;
    const d = demand.get(term);
    const demandNorm = Math.log10(1 + d) / denom;
    if (demandNorm < minDemandNorm) continue;
    out.push({
      keyword: term,
      score: +(demandNorm * (1 - competition)).toFixed(4),
      competition: +competition.toFixed(3),
      demand: Math.round(d),
      demand_norm: +demandNorm.toFixed(3),
      evidence: ev.get(term).slice(0, 3),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword)).slice(0, limit);
}

/** 제목 공기어. seo-enhance.js 가 조회만 하도록 여기서 미리 계산한다. */
export function relatedTerms(channels, terms, opts = {}) {
  const { windowDays = 30, minCooccur = 3, limit = 5, stopwords = DEFAULT_STOPWORDS, now } = opts;
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');

  const want = new Set(terms);
  const co = new Map(); // term → Map(other → count)
  for (const ch of channels) {
    for (const v of ch.videos ?? []) {
      if (!withinWindow(v, windowDays, now)) continue;
      const toks = tokenize(v.title, stopwords);
      for (const t of toks) {
        if (!want.has(t)) continue;
        if (!co.has(t)) co.set(t, new Map());
        const m = co.get(t);
        for (const o of toks) {
          if (o === t || o.includes(' ')) continue; // 바이그램은 공기어로 쓰지 않는다
          m.set(o, (m.get(o) ?? 0) + 1);
        }
      }
    }
  }

  const out = {};
  for (const term of [...want].sort()) {
    const m = co.get(term);
    if (!m) continue;
    const picks = [...m.entries()]
      .filter(([, n]) => n >= minCooccur)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([o]) => o);
    if (picks.length) out[term] = picks;
  }
  return out;
}

/**
 * 구독자 7일 차분. 비교 대상이 없으면 null (0 이 아니다 — "변화 없음"과 구분).
 *
 * null/'' 을 먼저 걸러야 한다. Number(null) 과 Number('') 은 모두 0 이고
 * Number.isFinite(0) 은 true 라, 그냥 두면 "이전 값 없음"이 "이전엔 0명"으로 둔갑해
 * 구독자 전체가 증가분으로 보고된다 (2026-08-13 실측 사고).
 */
export function subscriberDelta(current, previous) {
  const blank = (v) => v === null || v === undefined || v === '';
  if (blank(current) || blank(previous)) return null;
  const a = Number(current);
  const b = Number(previous);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}
