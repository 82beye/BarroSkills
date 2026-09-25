/**
 * backfill-prompt.js — 빈 슬롯을 채울 image_prompt 와 한국어 대사를 합성한다 (2026-09-25)
 *
 * 왜 필요한가: 평소 image_prompt 는 작가가 그 회차의 대사에서 만든다. 백필에는 대사가
 * 없다 — 슬롯(`<주제군>/<방향>`)만 있다. 슬롯에서 계약을 지키는 프롬프트를 거꾸로
 * 만들어야 굽는 단계로 넘어갈 수 있다.
 *
 * 두 가지를 같이 만든다. 이유가 다르다.
 *   ① image_prompt — 그림을 굽는 입력. image-prompt-contract 를 지켜야 한다.
 *   ② 한국어 대사   — **분류의 정본**이다. classify-scene-assets.js 는 프롬프트가 아니라
 *      대사로 주제를 맞힌다(scene-asset-index.js 의 `text`). 대사를 빼먹으면 방금 구운
 *      컷이 `unclassified` 로 떨어져 목표 슬롯이 그대로 비어 있다 — 백필이 아무것도
 *      하지 않은 것과 같아진다.
 *
 * 프롬프트 골격·마스코트 절·꼬리는 전부 image-prompt-contract.js 에서 가져온다.
 * 계약이 바뀌면 백필도 따라와야 하므로 문자열을 여기 복사하지 않는다.
 */

import { MASCOT_CLAUSE, CANONICAL_TAIL, BOUNDS } from './image-prompt-contract.js';
import { THEME_GRADE, PALETTE_DIRECTION } from './scene-slot-taxonomy.js';

/** 방향 → 팔레트 태그. PALETTE_DIRECTION 의 역방향이고, up 은 bullish 를 정본으로 쓴다. */
export const DIRECTION_PALETTE = { up: 'bullish', down: 'bearish', neutral: 'explainer' };

/**
 * 방향별 감정·자세·오브젝트 상태.
 *
 * 오브젝트 상태를 방향에서 만드는 이유: 객체마다 3개씩 손으로 쓰면 6주제 × 5객체 × 3방향
 * = 90개 문장이 되고 그중 대부분은 한 번도 안 쓰인다. 방향이 의미를 지고 객체는 소재만
 * 지게 나누면 문장 수가 주제 객체 수만큼으로 줄고, 새 객체를 넣을 때 한 줄만 쓴다.
 */
const DIRECTION_SPEC = {
  up: {
    emotion: 'startled',
    body: 'planting its rounded shoe-feet wide',
    state: (n) => `the unified ${n} driven to its highest mark and holding there`,
    accent: 'warm orange glow',
  },
  down: {
    emotion: 'wary',
    body: 'bracing its body',
    state: (n) => `the unified ${n} sagging toward its lowest mark under visible strain`,
    accent: 'red accent',
  },
  neutral: {
    emotion: 'focused',
    body: 'planting its rounded shoe-feet',
    state: (n) => `the unified ${n} resting level at its middle mark with both sides even`,
    accent: 'orange accent',
  },
};

/**
 * 주제별 무대와 중앙 객체.
 *
 * 객체 선정 규칙 세 개가 실측에서 나왔다.
 *   ① **한 낱말 명사만 쓴다.** normalizeObject 가 `before a … in the centre` 를 잡아
 *      수식어를 떼고 남는 마지막 낱말을 객체로 본다. 합성어를 쓰면 하이픈 앞쪽이 잡혀
 *      엉뚱한 객체로 집계된다(`interest-rate ladder` → `interest`).
 *   ② **포화 객체를 피한다.** 2026-09-25 집계 상위 — bell 27 · scale 21 · gauge 13 ·
 *      chart 12 · dial 12. 더 구워도 쏠림만 깊어진다.
 *   ③ **계약 금지어를 피한다.** OFF_SHEET_WARDROBE 에 helmet·apron·uniform·vest 가
 *      있어 labor 의 자연스러운 후보 몇 개가 BLOCK 된다. GENERIC_OBJECTS(chart·board·
 *      panel·podium…)도 뺀다 — 그쪽은 2차 범용 배정이 쓰는 구도다.
 */
export const THEME_SCENES = {
  rates: {
    setting: 'district of bank towers',
    element: 'the tower rooftops',
    texture: 'faint grid lines',
    objects: [
      { noun: 'ratchet', adj: 'tall', hand: 'turns the ratchet handle one notch' },
      { noun: 'pendulum', adj: 'towering', hand: 'steadies the swinging pendulum rod' },
      { noun: 'faucet', adj: 'wide', hand: 'grips the faucet handle' },
      { noun: 'turnstile', adj: 'tall', hand: 'pushes one arm of the turnstile' },
      { noun: 'escalator', adj: 'towering', hand: 'rests on the escalator rail' },
    ],
  },
  energy: {
    setting: 'refinery skyline at dusk',
    element: 'the stack silhouettes',
    texture: 'soft grain texture',
    objects: [
      { noun: 'derrick', adj: 'towering', hand: 'pulls the derrick lever' },
      { noun: 'nozzle', adj: 'wide', hand: 'squeezes the nozzle trigger' },
      { noun: 'pipeline', adj: 'thick', hand: 'taps the pipeline joint' },
      { noun: 'jerrycan', adj: 'tall', hand: 'lifts the jerrycan by its handle' },
      { noun: 'flare', adj: 'tall', hand: 'reaches toward the flare tip' },
    ],
  },
  fx: {
    setting: 'currency exchange hall',
    element: 'the counter edges',
    texture: 'fine line texture',
    objects: [
      { noun: 'footbridge', adj: 'wide', hand: 'grips the footbridge rope' },
      { noun: 'ferry', adj: 'wide', hand: 'points at the loaded ferry' },
      { noun: 'pulley', adj: 'tall', hand: 'pulls the pulley cord' },
      { noun: 'kiosk', adj: 'wide', hand: 'leans on the kiosk shutter' },
      { noun: 'conveyor', adj: 'wide', hand: 'sets one note on the conveyor' },
    ],
  },
  earnings: {
    setting: 'corporate lobby',
    element: 'the lobby columns',
    texture: 'soft dotted texture',
    objects: [
      { noun: 'vault', adj: 'towering', hand: 'spins the vault wheel' },
      { noun: 'ledger', adj: 'thick', hand: 'turns one page of the ledger' },
      { noun: 'trophy', adj: 'tall', hand: 'lifts the trophy by one handle' },
      { noun: 'jar', adj: 'wide', hand: 'tips the jar forward' },
      { noun: 'envelope', adj: 'wide', hand: 'holds the sealed envelope up' },
    ],
  },
  labor: {
    setting: 'factory floor',
    element: 'the floor markings',
    texture: 'soft grain texture',
    objects: [
      { noun: 'timecard', adj: 'wide', hand: 'slots the timecard into its rack' },
      { noun: 'toolbox', adj: 'wide', hand: 'flips the toolbox latch' },
      { noun: 'hourglass', adj: 'tall', hand: 'tilts the hourglass' },
      { noun: 'ladder', adj: 'towering', hand: 'grips one rung of the ladder' },
      { noun: 'lunchbox', adj: 'wide', hand: 'snaps the lunchbox shut' },
    ],
  },
  metals: {
    setting: 'foundry hall',
    element: 'the crucible rim',
    texture: 'fine line texture',
    objects: [
      { noun: 'ingot', adj: 'thick', hand: 'steadies the stacked ingot' },
      { noun: 'crucible', adj: 'wide', hand: 'tips the crucible forward' },
      { noun: 'anvil', adj: 'thick', hand: 'taps the anvil face' },
      { noun: 'nugget', adj: 'wide', hand: 'holds the nugget up' },
      { noun: 'coil', adj: 'thick', hand: 'unrolls one turn of the coil' },
    ],
  },
  index: {
    setting: 'trading floor',
    element: 'the ticker rails',
    texture: 'faint grid lines',
    objects: [
      { noun: 'staircase', adj: 'towering', hand: 'sets one foot on the staircase' },
      { noun: 'thermometer', adj: 'tall', hand: 'traces the thermometer column' },
      { noun: 'mast', adj: 'towering', hand: 'grips the mast rope' },
      { noun: 'drum', adj: 'wide', hand: 'taps the drum head' },
      { noun: 'kite', adj: 'wide', hand: 'holds the kite string' },
    ],
  },
  semis: {
    setting: 'clean-room corridor',
    element: 'the corridor lights',
    texture: 'fine line texture',
    objects: [
      { noun: 'cassette', adj: 'wide', hand: 'slides the wafer cassette in' },
      { noun: 'tweezers', adj: 'wide', hand: 'closes the tweezers' },
      { noun: 'lattice', adj: 'tall', hand: 'traces one row of the lattice' },
      { noun: 'oven', adj: 'wide', hand: 'opens the oven door' },
      { noun: 'spindle', adj: 'tall', hand: 'turns the spindle' },
    ],
  },
  geopolitics: {
    setting: 'summit hall',
    element: 'the hall banners',
    texture: 'soft dotted texture',
    objects: [
      { noun: 'drawbridge', adj: 'wide', hand: 'pulls the drawbridge chain' },
      { noun: 'checkpoint', adj: 'wide', hand: 'raises the checkpoint arm' },
      { noun: 'padlock', adj: 'thick', hand: 'turns the padlock shackle' },
      { noun: 'handshake', adj: 'wide', hand: 'reaches toward the handshake sculpture' },
      { noun: 'crate', adj: 'thick', hand: 'pushes the stamped crate' },
    ],
  },
  crypto: {
    setting: 'server hall',
    element: 'the rack edges',
    texture: 'faint grid lines',
    objects: [
      { noun: 'rollercoaster', adj: 'towering', hand: 'grips the rollercoaster rail' },
      { noun: 'token', adj: 'thick', hand: 'spins the token on its rim' },
      { noun: 'cable', adj: 'thick', hand: 'plugs in the cable' },
      { noun: 'lantern', adj: 'tall', hand: 'lifts the lantern' },
      { noun: 'domino', adj: 'tall', hand: 'holds back one domino' },
    ],
  },
  realestate: {
    setting: 'housing block at dusk',
    element: 'the window rows',
    texture: 'soft grain texture',
    objects: [
      { noun: 'keyring', adj: 'wide', hand: 'holds up the keyring' },
      { noun: 'blueprint', adj: 'wide', hand: 'unrolls the blueprint' },
      { noun: 'mailbox', adj: 'tall', hand: 'opens the mailbox flap' },
      { noun: 'crane', adj: 'towering', hand: 'pulls the crane cable' },
      { noun: 'doorframe', adj: 'tall', hand: 'braces the doorframe' },
    ],
  },
};

/**
 * 주제·방향별 한국어 대사. 분류가 이 문장으로 주제를 맞힌다.
 *
 * 규칙: ① 그 주제의 THEME_TERMS 를 2개 이상 담는다 ② 다른 주제의 용어를 섞지 않는다.
 * ②를 지키지 않으면 1·2위 점수가 AMBIGUITY_MARGIN(1.15) 안에 들어와 `unclassified` 로
 * 떨어진다 — 예컨대 rates 대사에 "증시"(index) 나 "소비자물가"(labor) 를 넣으면 그렇다.
 */
export const NARRATION = {
  rates: {
    up: '국채 금리가 올랐습니다. 연준의 기준금리 전망이 채권 수익률을 밀어 올렸습니다.',
    down: '국채 금리가 내렸습니다. 연준의 기준금리 인하 기대가 채권 수익률을 끌어내렸습니다.',
    neutral: '국채 금리는 보합입니다. 연준의 기준금리 경로를 두고 채권 수익률이 방향을 못 잡았습니다.',
  },
  energy: {
    up: '유가가 올랐습니다. 브렌트유와 WTI 원유가 배럴당 기준으로 함께 뛰었습니다.',
    down: '유가가 내렸습니다. 브렌트유와 WTI 원유가 배럴당 기준으로 함께 밀렸습니다.',
    neutral: '유가는 보합입니다. 브렌트유와 WTI 원유가 배럴당 기준으로 방향을 못 잡았습니다.',
  },
  fx: {
    up: '환율이 올랐습니다. 원/달러 환율이 뛰고 달러인덱스도 강해져 원화가 절하됐습니다.',
    down: '환율이 내렸습니다. 원/달러 환율이 밀리고 달러인덱스도 약해져 원화가 절상됐습니다.',
    neutral: '환율은 보합입니다. 원/달러 환율과 달러인덱스가 함께 방향을 못 잡았습니다.',
  },
  earnings: {
    up: '실적이 좋았습니다. 분기 실적에서 매출과 영업이익이 함께 늘고 배당도 올랐습니다.',
    down: '실적이 나빴습니다. 분기 실적에서 매출과 영업이익이 함께 줄고 배당도 깎였습니다.',
    neutral: '실적은 엇갈렸습니다. 분기 실적에서 매출은 늘었지만 영업이익은 줄었습니다.',
  },
  labor: {
    up: '고용이 늘었습니다. 비농업 일자리가 증가하고 임금과 급여도 함께 올랐습니다.',
    down: '고용이 줄었습니다. 비농업 일자리가 감소하고 실업이 늘어 임금도 눌렸습니다.',
    neutral: '고용은 보합입니다. 비농업 일자리와 임금이 함께 방향을 못 잡았습니다.',
  },
  metals: {
    up: '금값이 올랐습니다. 은값과 구리 같은 귀금속·원자재 가격이 함께 뛰었습니다.',
    down: '금값이 내렸습니다. 은값과 구리 같은 귀금속·원자재 가격이 함께 밀렸습니다.',
    neutral: '금값은 보합입니다. 은값과 구리 같은 귀금속·원자재 가격이 방향을 못 잡았습니다.',
  },
  index: {
    up: '증시가 올랐습니다. 코스피와 나스닥 지수가 함께 뛰고 시가총액도 늘었습니다.',
    down: '증시가 내렸습니다. 코스피와 나스닥 지수가 함께 밀리고 시가총액도 줄었습니다.',
    neutral: '증시는 보합입니다. 코스피와 나스닥 지수가 함께 방향을 못 잡았습니다.',
  },
  semis: {
    up: '반도체가 올랐습니다. 삼성전자와 하이닉스의 메모리·HBM 수요 전망이 좋아졌습니다.',
    down: '반도체가 내렸습니다. 삼성전자와 하이닉스의 메모리·HBM 수요 전망이 나빠졌습니다.',
    neutral: '반도체는 보합입니다. 삼성전자와 하이닉스의 메모리·HBM 전망이 엇갈렸습니다.',
  },
  geopolitics: {
    up: '지정학 위험이 풀렸습니다. 관세와 수출규제를 둘러싼 회담이 무역분쟁을 진정시켰습니다.',
    down: '지정학 위험이 커졌습니다. 관세와 제재가 겹치며 무역분쟁과 수출규제가 번졌습니다.',
    neutral: '지정학 위험은 그대로입니다. 관세와 제재를 둘러싼 회담이 결론 없이 끝났습니다.',
  },
  crypto: {
    up: '비트코인이 올랐습니다. 이더리움과 알트코인 같은 가상자산이 함께 뛰었습니다.',
    down: '비트코인이 내렸습니다. 이더리움과 알트코인 같은 가상자산이 함께 밀렸습니다.',
    neutral: '비트코인은 보합입니다. 이더리움과 알트코인 같은 가상자산이 방향을 못 잡았습니다.',
  },
  realestate: {
    up: '부동산이 올랐습니다. 아파트 분양과 청약 수요가 늘고 전세와 임대도 강해졌습니다.',
    down: '부동산이 내렸습니다. 아파트 분양과 청약 수요가 줄고 전세와 임대도 약해졌습니다.',
    neutral: '부동산은 보합입니다. 아파트 분양과 청약, 전세 시장이 방향을 못 잡았습니다.',
  },
};

/** `<theme>/<direction>` 을 갈라 준다. 잘못된 슬롯은 예외로 세운다 — 조용히 통과하면 빈 프롬프트가 굽는다. */
export function parseSlot(slot) {
  const [theme, direction] = String(slot).split('/');
  if (!THEME_SCENES[theme]) throw new Error(`무대 정의가 없는 주제: ${theme} (슬롯 ${slot})`);
  if (!DIRECTION_SPEC[direction]) throw new Error(`방향이 아닙니다: ${direction} (슬롯 ${slot})`);
  return { theme, direction };
}

/**
 * 슬롯에서 image_prompt 를 합성한다. 계약(640~780자)에 맞춘 골격이다.
 */
export function synthesizePrompt(slot, object) {
  const { theme, direction } = parseSlot(slot);
  const stage = THEME_SCENES[theme];
  const dir = DIRECTION_SPEC[direction];
  const palette = DIRECTION_PALETTE[direction];

  return `[palette:${palette}] ${MASCOT_CLAUSE}, ${dir.emotion}, standing before a single ` +
    `${object.adj} ${object.noun} in the centre, face readable, ${dir.body} while one ` +
    `white mitten hand ${object.hand}, ${dir.state(object.noun)}. ` +
    `BACKGROUND: deep navy abstract ${stage.setting}, ${dir.accent} on ${stage.element}, ` +
    `${stage.texture} at low contrast, ${CANONICAL_TAIL}`;
}

/**
 * 이미 그 슬롯에 있는 객체와 전역 포화 객체를 피해 `count` 개를 고른다.
 *
 * 왜 전역까지 피하는가: 슬롯 안에서만 피하면 `metals/up` 에 bell 을 또 굽게 된다.
 * 포화는 슬롯 문제가 아니라 채널 전체의 그림 문제다.
 */
export function pickObjects(slot, { used = [], avoid = [], count = 1 } = {}) {
  const { theme } = parseSlot(slot);
  const taken = new Set([...used, ...avoid].filter(Boolean).map((o) => String(o).toLowerCase()));
  const free = THEME_SCENES[theme].objects.filter((o) => !taken.has(o.noun));
  if (free.length < count) {
    throw new Error(
      `${slot}: 쓸 수 있는 객체가 ${free.length}개뿐인데 ${count}개가 필요합니다. ` +
      `THEME_SCENES.${theme}.objects 를 늘리세요 (이미 쓴 것: ${[...taken].join(', ') || '없음'}).`);
  }
  return free.slice(0, count);
}

/** 슬롯 → 합성 씬 하나. 프롬프트·대사·팔레트를 한 묶음으로 낸다. */
export function synthesizeScene(slot, object) {
  const { theme, direction } = parseSlot(slot);
  const prompt = synthesizePrompt(slot, object);
  return {
    slot,
    theme,
    direction,
    grade: THEME_GRADE[theme] ?? 'C',
    object: object.noun,
    palette: DIRECTION_PALETTE[direction],
    prompt,
    narration: NARRATION[theme][direction],
    length: prompt.length,
    withinBounds: prompt.length >= BOUNDS.minChars && prompt.length <= BOUNDS.maxChars,
  };
}

export default { THEME_SCENES, NARRATION, DIRECTION_PALETTE, parseSlot, synthesizePrompt, pickObjects, synthesizeScene };
