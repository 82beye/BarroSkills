/**
 * scene-slot-taxonomy.js — 씬 자산 슬롯 분류 (2026-09-22)
 *
 * 슬롯 키는 `<주제군>/<방향>` 이다. 재사용 폴백이 "오브제는 비슷한데 주제가 다른" 컷을
 * 집는 것을 막고, 무엇이 없는지를 셀 수 있게 만든다. 설계 근거는
 * docs/asset-library-prd.md.
 *
 * **주제는 image_prompt 가 아니라 한국어 대사로 판정한다.**
 * PRD 초안은 프롬프트의 중앙 객체·BACKGROUND 절로 맞히자고 썼는데, 실제로 어휘를 세어
 * 보니 대부분이 조명·분위기어였다 (2026-09-22, 426컷): glow 204 · warm 191 · skyline 78
 * 에 비해 주제어는 chip 15 · oil 16 수준이다. 프롬프트는 **어떻게 보이나**를 적고 주제는
 * 대사에 있다. 대사 기반으로 바꾸자 미분류가 16% 로 떨어졌다(프롬프트 기반은 그보다 나빴다).
 *
 * 방향은 `[palette:*]` 태그를 그대로 읽는다 — 426컷 전부가 보유하고 있어 추측이 없다.
 */

/**
 * 주제 사전. 값은 대사에 그대로 등장하는 한국어 표기다.
 *
 * 넓은 말은 일부러 뺐다. 'AI' · '정책' · '기업' · '시장' 같은 단어는 거의 모든 회차에
 * 나와서 변별력이 없고, 넣으면 복수매칭만 늘린다(초안에서 56% → 정리 후 아래 MARGIN
 * 판정으로 흡수). 비중 순서는 163편 브리프 실측을 따른다.
 */
export const THEME_TERMS = {
  index:       ['코스피', '코스닥', '나스닥', '다우', 'S&P', '지수', '증시', '시가총액', '주가', '상장지수', '종목'],
  semis:       ['반도체', '삼성전자', '하이닉스', '엔비디아', 'TSMC', '파운드리', '메모리', 'HBM', '마이크론', '웨이퍼'],
  rates:       ['금리', '국채', '채권', '연준', 'FOMC', '기준금리', '수익률', '인플레', '긴축', '통화정책', '장단기'],
  energy:      ['유가', 'WTI', '브렌트', '원유', '천연가스', '정유', '휘발유', '석유', 'OPEC', '배럴'],
  fx:          ['환율', '원/달러', '원달러', '엔화', '위안', '달러인덱스', '외환', '절상', '절하'],
  earnings:    ['실적', '영업이익', '매출', '배당', '인수합병', '분기 실적', '어닝', '자사주'],
  labor:       ['고용', '실업', '일자리', '임금', '소비자물가', '소비심리', '급여', '비농업'],
  geopolitics: ['관세', '제재', '전쟁', '회담', '대통령', '유엔', '지정학', '무역분쟁', '수출규제'],
  crypto:      ['비트코인', '이더리움', '가상자산', '스테이블', '알트코인', '코인'],
  realestate:  ['부동산', '아파트', '전세', '주택', '청약', '분양', '임대'],
  metals:      ['금값', '금 가격', '귀금속', '은값', '구리', '팔라듐', '니켈', '원자재'],
};

/** 슬롯 등급과 목표 보유량. 주제 비중(163편 브리프 실측)에서 나눴다. */
export const THEME_GRADE = {
  index: 'A', semis: 'A', rates: 'A',
  energy: 'B', fx: 'B', earnings: 'B', labor: 'B',
  geopolitics: 'C', crypto: 'C', realestate: 'C', metals: 'C',
};

export const GRADE_TARGET = { A: 4, B: 3, C: 2, R: 6 };

/** 팔레트 → 방향. cta 는 주제 슬롯이 아니라 역할 슬롯으로 간다. */
export const PALETTE_DIRECTION = {
  bullish: 'up', wealth: 'up',
  bearish: 'down',
  explainer: 'neutral',
};

/**
 * 역할 슬롯 — 주제와 무관하게 구도가 고정되는 씬.
 *
 * PRD 초안에는 `hook/generic` 도 있었는데 구현해 보니 **채워질 수 없는 유령 슬롯**이었다.
 * hook 씬은 그 회차의 주제로 열리므로 본질적으로 주제 슬롯이다(semis 회차의 hook 은
 * semis 컷이다). 남겨 두면 영구히 "비어 있음"으로 표시돼 체크리스트의 신호를 죽인다.
 * 실제로 역할이 고정된 것은 cta 하나뿐이다 — 팔로우 요청·다음 일정.
 */
export const ROLE_SLOTS = ['cta/generic'];

/**
 * 포화 판정 — 한 객체가 슬롯의 이 비율 이상을 차지하면 포화다.
 *
 * 초안은 "고유 종류 수 < 목표의 절반"으로 쟀는데 정작 문제 슬롯을 못 잡았다.
 * cta/generic 은 71컷에 고유 객체 31종이라 그 기준을 여유롭게 통과했는데, 실제로는
 * 71컷 중 32컷(45%)이 전부 "벨"이다. 세어야 할 것은 종류 수가 아니라 **쏠린 양**이다.
 */
export const SATURATION_SHARE = 0.35;

/**
 * 슬롯의 포화 여부와 최빈 객체를 계산한다.
 * 객체를 하나도 못 읽어낸 슬롯은 판정하지 않는다 — 파싱 실패를 포화로 보고하면
 * 운영자가 없는 문제를 쫓는다.
 */
export function saturationOf(objects) {
  const named = objects.filter(Boolean);
  if (named.length === 0) return { saturated: false, top: null, share: 0, known: false };
  const freq = new Map();
  for (const o of named) freq.set(o, (freq.get(o) || 0) + 1);
  const [top, n] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = n / named.length;
  return { saturated: share >= SATURATION_SHARE && named.length >= 4, top, share, known: true };
}

/**
 * 1위가 2위의 이 배수를 넘지 못하면 모호로 보고 배정하지 않는다.
 *
 * 추측 배정은 없는 것보다 나쁘다 — 2026-09-22 실측에서 점수 0.357 의 구세대 컷이
 * 정상으로 배정돼 한 영상의 화풍이 깨졌다. 1.15 는 실측에서 모호 판정이 5% 로
 * 떨어지는 값이고, 전체 미분류는 16% 다(목표 25% 이하).
 */
export const AMBIGUITY_MARGIN = 1.15;

/**
 * 키워드별 IDF 를 코퍼스에서 학습한다.
 *
 * 고정 가중치를 손으로 주지 않는 이유는 scene-asset-index 의 TF-IDF 와 같다 —
 * 채널이 다루는 주제가 옮겨 가면 '지수' 같은 흔한 말의 변별력이 저절로 떨어져야 한다.
 */
export function buildThemeScorer(texts) {
  const all = [...new Set(Object.values(THEME_TERMS).flat())];
  const n = Math.max(texts.length, 1);
  const idf = new Map();
  for (const term of all) {
    const df = texts.reduce((acc, t) => acc + (t.includes(term) ? 1 : 0), 0) || 1;
    /**
     * 평활 IDF. 순수 log(n/df) 를 쓰면 **모든 문서에 있는 용어의 가중치가 0** 이 되어,
     * 그 용어 하나만 걸린 씬이 "매칭 없음"으로 떨어진다. 코퍼스가 작을수록 심하고
     * 문서가 1개면 전부 0 이 된다. 여기서 IDF 는 주제 **간** 우열을 가리는 용도이지
     * 매칭 여부를 끄는 스위치가 아니므로, 항상 양수인 log(1 + n/df) 를 쓴다.
     * 상대 가중(희소한 용어가 더 무겁다)은 그대로 유지된다.
     */
    idf.set(term, Math.log(1 + n / df));
  }

  return function scoreThemes(text) {
    const s = String(text || '');
    const scored = [];
    for (const [theme, terms] of Object.entries(THEME_TERMS)) {
      let sum = 0;
      const hits = [];
      for (const term of terms) {
        if (!s.includes(term)) continue;
        sum += idf.get(term) || 0;
        hits.push(term);
      }
      if (sum > 0) scored.push({ theme, score: sum, hits });
    }
    return scored.sort((a, b) => b.score - a.score);
  };
}

/**
 * 한 씬을 슬롯에 배정한다.
 *
 * @returns {{slot: string|null, theme: string|null, direction: string|null, reason: string}}
 */
export function assignSlot(entry, scoreThemes, { margin = AMBIGUITY_MARGIN } = {}) {
  // 역할 슬롯이 먼저다. cta 컷은 주제가 무엇이든 마지막 씬 구도로 만들어졌다.
  if (entry.role === 'cta' || entry.palette === 'cta') {
    return { slot: 'cta/generic', theme: null, direction: null, reason: 'role' };
  }

  const direction = PALETTE_DIRECTION[entry.palette];
  if (!direction) {
    return { slot: null, theme: null, direction: null, reason: `palette_unmapped:${entry.palette || 'none'}` };
  }

  const ranked = scoreThemes(entry.text);
  if (ranked.length === 0) {
    return { slot: null, theme: null, direction, reason: 'no_theme_term' };
  }
  if (ranked.length > 1 && ranked[0].score < ranked[1].score * margin) {
    return {
      slot: null, theme: null, direction,
      reason: `ambiguous:${ranked[0].theme}~${ranked[1].theme}`,
    };
  }

  const theme = ranked[0].theme;
  return { slot: `${theme}/${direction}`, theme, direction, reason: 'ok' };
}

/** 슬롯의 목표 보유량. */
export function slotTarget(slot) {
  if (ROLE_SLOTS.includes(slot)) return GRADE_TARGET.R;
  const theme = String(slot).split('/')[0];
  return GRADE_TARGET[THEME_GRADE[theme]] ?? 2;
}

export function slotGrade(slot) {
  if (ROLE_SLOTS.includes(slot)) return 'R';
  return THEME_GRADE[String(slot).split('/')[0]] ?? 'C';
}

/** 주제 슬롯 전체 (11 × 3) + 역할 슬롯 2. */
export function allSlots() {
  const out = [];
  for (const theme of Object.keys(THEME_TERMS)) {
    for (const dir of ['up', 'down', 'neutral']) out.push(`${theme}/${dir}`);
  }
  return [...out, ...ROLE_SLOTS];
}

/**
 * 중앙 객체를 정규화해 다양성 계산의 단위로 만든다.
 *
 * `large glowing alarm bell` 과 `bright notification bell` 은 같은 그림이다. 형용사를
 * 떼고 핵심 명사만 남긴다. 이 정규화가 없으면 cta 슬롯이 "64컷 보유"로 보이는데
 * 실제로는 32컷이 전부 벨이라 쿨다운을 걸면 같은 그림이 계속 돌아온다.
 */
const MODIFIERS = new Set([
  'single', 'giant', 'towering', 'large', 'tall', 'huge', 'oversized', 'monumental', 'wide',
  'round', 'small', 'thick', 'taut', 'steep', 'uneven', 'lopsided', 'tilted', 'tilting',
  'split', 'glowing', 'dim', 'rusty', 'bright', 'golden', 'gold', 'silver', 'dark', 'pale',
  'cracked', 'broken', 'ringing', 'shaped', 'stylized', 'oversize', 'massive', 'thin', 'flat',
  'a', 'an', 'the', 'one',
]);

export function normalizeObject(prompt) {
  const m = String(prompt).match(/before (?:a|an|the) ([^,.]{3,70}?) in the (?:centre|center)/i)
    || String(prompt).match(/before (?:a|an|the) ([^,.]{3,70})/i);
  if (!m) return null;
  const words = m[1].toLowerCase().match(/[a-z-]+/g) || [];
  const core = words.filter((w) => !MODIFIERS.has(w));
  if (core.length === 0) return null;
  // 마지막 명사가 핵심이다: "bell-shaped notification icon" → icon 이 아니라 bell 이
  // 핵심이므로, 하이픈 합성어는 앞쪽을 살린다.
  const head = core.find((w) => w.includes('-'))?.split('-')[0] || core[core.length - 1];
  return head;
}
