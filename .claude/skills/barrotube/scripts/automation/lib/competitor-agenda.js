/**
 * competitor-agenda.js — 「오늘 경쟁사가 공통으로 다루는 사건」 추출
 *
 * 왜 따로 만들었나
 * ────────────────
 * 기존 analyze-competitors 는 토큰 **빈도 갭**을 잰다. "경쟁사는 쓰는데 우리는 안 쓰는 말"을
 * 찾는 도구라, 산출이 「이렇게 · 겁니다 · 1부 · 3부 · 대표」 같은 조각으로 나온다
 * (2026-09-15 실제 산출). 그건 어휘지 사건이 아니다.
 *
 * 2026-09-16 운영자 지적: 같은 날 경쟁사 헤드라인이
 *   09:11 「국채금리 5%, TACO 쏟아낸 트럼프」
 *   09:15 「10년물 금리 5% 터치…연준의 금리 결정」
 *   14:21 「금리·유가·AI 삼중고에 발목 잡힌 코스피」
 * 로 한 사건을 가리키고 있었는데, 우리 토픽 선정은 그걸 못 봤다.
 *
 * 그래서 재는 것을 바꾼다 — **빈도가 아니라 합의(consensus)**다.
 * 몇 개의 서로 다른 채널이 같은 것을 말하는가. 한 채널이 10번 말한 건 그 채널의 편성이고,
 * 다섯 채널이 한 번씩 말한 건 그날의 사건이다. 그래서 점수는 distinct 채널 수로 낸다.
 *
 * 이 모듈은 순수 함수다 — I/O 없음. 호출자가 스냅샷을 읽어 넘긴다.
 */

import { DEFAULT_STOPWORDS } from './competitor-analytics.js';

const HOUR_MS = 3600_000;

/** 조사·어미 꼬리. tokenize 와 같은 계열이지만 여기선 더 보수적으로 깎는다. */
const TAIL = /(은|는|이|가|을|를|에|의|도|만|과|와|로|으로|에서|에게|까지|부터|보다|처럼|라며|이라|하며|한다|했다|인가|일까|된다|되나)$/;

/**
 * 수치+단위는 통째로 한 토큰이다. "5%" 와 "금리" 를 따로 세면
 * 「국채금리 5% 돌파」가 "금리"(흔함) + "5"(무의미)로 흩어져 사건이 사라진다.
 */
const NUM_UNIT = /\d+(?:[.,]\d+)?\s*(?:%|퍼센트|달러|원|엔|선|조|억|만|bp|배|년|개월|일째|연속)/g;

/** 사건을 만드는 고유명사·지표어. 스톱워드에 걸려 날아가면 안 된다. */
const KEEP = new Set([
  '금리', '국채', '유가', '환율', '물가', '고용', '실업', '연준', 'fomc', 'cpi', 'ppi',
  '코스피', '코스닥', '나스닥', '다우', 's&p', '엔비디아', '삼성전자', '하이닉스', '테슬라',
  '비트코인', '반도체', '관세', '트럼프', '파월', '집값', '전세', '분양', '공급', '대출',
  'ai', '브로드컴', '앤트로픽', '속도조절', '침체', '버블', '거품',
]);

/**
 * 2026-09-16 1차 산출에서 상위를 먹은 조각들. 여러 채널이 쓰지만 사건이 아니다 —
 * 「'이렇게' 됩니다」, 「'이때'를 봐야」, 「진짜 '이유'」 는 다섯 채널이 써도 같은 얘기가 아니다.
 * 지역·국가명도 뺀다: '서울'이 7채널이라고 그날 서울이 사건인 건 아니다(부동산 채널의 상수).
 */
const AGENDA_STOP = [
  '이유', '이렇게', '이때', '겁니다', '입니다', '합니다', '됩니다', '있다', '없다', '한다',
  '서울', '한국', '미국', '중국', '일본', '경기도', '대표', '박사', '랩장', '소장', '위원',
  '인터뷰', '콜라보', '방송', '보기', '오전', '오후', '저녁', '아침', '시황', '전체보기',
  '무서운', '심상치않다', '사세요', '있을까', '될까', '봐야', '하는', '해야', '가능성',
];

const stopSet = new Set([...DEFAULT_STOPWORDS, ...AGENDA_STOP]);

/** 수치+단위 토큰인가. 이런 토큰은 본질적으로 구체적이라 사건일 확률이 높다. */
const isNumeric = (t) => /\d/.test(t);

/** 제목 → 사건 후보 토큰. 수치+단위는 보존하고, 흔한 말은 버린다. */
export function agendaTokens(title) {
  const t = String(title ?? '').toLowerCase();
  const out = new Set();

  for (const m of t.match(NUM_UNIT) ?? []) out.add(m.replace(/\s+/g, ''));

  const words = (t.match(/[가-힣a-z]{2,}/g) ?? [])
    .map((w) => (w.length >= 3 ? w.replace(TAIL, '') : w))
    .filter((w) => w.length >= 2 && w.length <= 10);

  for (const w of words) {
    if (KEEP.has(w)) { out.add(w); continue; }
    if (stopSet.has(w)) continue;
    out.add(w);
  }
  // 인접 2-gram: "국채 금리", "속도조절 반도체" 처럼 둘이 붙어야 사건이 되는 경우
  for (let i = 0; i < words.length - 1; i += 1) {
    const a = words[i], b = words[i + 1];
    if (stopSet.has(a) && stopSet.has(b)) continue;
    out.add(`${a} ${b}`);
  }
  return [...out];
}

/**
 * 경쟁사 스냅샷 → 합의 상위 의제.
 *
 * @param snapshot  workspace/intel/competitors/<date>.json 파싱본
 * @param now       기준 시각
 * @param windowHours  최근 몇 시간을 볼지. 기본 30h — 미국장 마감(아침)과
 *                     국내장 마감(오후)을 한 회차 기준으로 같이 담으려면 하루보다 조금 넓어야 한다.
 * @param minChannels  최소 몇 개 채널이 말해야 의제로 인정할지
 */
export function competitorAgenda(snapshot, now = new Date(), {
  windowHours = 30, minChannels = 2, limit = 8, slot = null,
} = {}) {
  const cutoff = now.getTime() - windowHours * HOUR_MS;
  /** token → { channels:Set, titles:[], latest:number } */
  const agg = new Map();
  let scanned = 0;

  for (const [chId, ch] of Object.entries(snapshot?.channels ?? {})) {
    // **슬롯으로 거른다.** 경쟁 채널 27개 중 21개가 부동산이라, 안 거르면 us-close 회차에도
    // 부동산 의제가 상위를 독식한다 (2026-09-16 1차 산출: 상위 5개 중 3개가 부동산).
    // competes_with 는 config/competitor-channels.json 이 정본이고 스냅샷이 그대로 들고 온다.
    const competes = ch?.resolved?.competes_with ?? [];
    if (slot && competes.length && !competes.includes(slot)) continue;
    const name = ch?.resolved?.name || ch?.resolved?.title || chId;
    for (const v of ch?.recent_videos ?? []) {
      const ts = Date.parse(v?.publishedAt ?? v?.published_at ?? '');
      if (!Number.isFinite(ts) || ts < cutoff || ts > now.getTime()) continue;
      scanned += 1;
      const title = v?.title ?? '';
      for (const tok of agendaTokens(title)) {
        if (!agg.has(tok)) agg.set(tok, { channels: new Set(), titles: [], latest: 0 });
        const e = agg.get(tok);
        e.channels.add(name);
        if (e.titles.length < 3) e.titles.push({ channel: name, title, at: ts });
        if (ts > e.latest) e.latest = ts;
      }
    }
  }

  const ranked = [...agg.entries()]
    .map(([token, e]) => ({
      token,
      channels: e.channels.size,
      mentions: e.titles.length,
      latest: new Date(e.latest).toISOString(),
      examples: e.titles,
    }))
    .filter((x) => x.channels >= minChannels)
    // 채널 수가 1차 기준이다 — 한 채널의 연속 편성은 사건이 아니다.
    // 동률이면 수치 토큰을 위로 올린다: 「5%」는 「금리」보다 그날을 특정한다.
    .sort((a, b) => (b.channels - a.channels)
      || (Number(isNumeric(b.token)) - Number(isNumeric(a.token)))
      || (Date.parse(b.latest) - Date.parse(a.latest)));

  // 포함 관계 중복 제거: "금리" 와 "국채 금리" 가 같은 채널 집합이면 더 구체적인 쪽만 남긴다.
  const kept = [];
  for (const cand of ranked) {
    const dup = kept.find((k) => k.channels === cand.channels
      && (k.token.includes(cand.token) || cand.token.includes(k.token)));
    if (dup) {
      if (cand.token.length > dup.token.length) Object.assign(dup, cand);
      continue;
    }
    kept.push(cand);
    if (kept.length >= limit) break;
  }

  return { window_hours: windowHours, videos_scanned: scanned, agenda: kept };
}

/** 지시문·브리프에 넣을 사람 읽는 블록. */
export function formatAgenda(result) {
  if (!result?.agenda?.length) {
    return ['## 오늘 경쟁사 의제', `- (최근 ${result?.window_hours ?? 30}시간 내 경쟁사 영상 ${result?.videos_scanned ?? 0}편 — 합의 의제 없음)`, ''];
  }
  const lines = [
    `## 오늘 경쟁사 의제 (최근 ${result.window_hours}시간 · 영상 ${result.videos_scanned}편)`,
    '- 여러 채널이 **같은 것**을 말하면 그날의 사건이다. 우리 회차의 주제는 여기서 고른다.',
  ];
  for (const a of result.agenda.slice(0, 5)) {
    // 토큰이 가장 앞에 나오는 제목을 예로 든다. 먼저 담긴 것을 그냥 쓰면 다섯 항목이
    // 전부 같은 제목을 가리켜, 지시문을 읽는 모델이 의제를 구분하지 못한다.
    const key = a.token.split(' ')[0];
    const best = [...a.examples].sort((x, y) => {
      const ix = x.title.toLowerCase().indexOf(key); const iy = y.title.toLowerCase().indexOf(key);
      return (ix < 0 ? 1e9 : ix) - (iy < 0 ? 1e9 : iy);
    })[0];
    lines.push(`- **${a.token}** — ${a.channels}개 채널`);
    lines.push(`  예: 「${best.title.slice(0, 46)}」(${best.channel.slice(0, 14)})`);
  }
  lines.push('');
  return lines;
}
