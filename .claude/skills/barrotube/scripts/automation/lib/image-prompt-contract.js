/**
 * image_prompt 계약 — 단일 진실 원천(SSOT)
 *
 * 왜 코드에 두는가: 지금까지 규격이 4곳에 흩어져 서로 모순이었다.
 *   generate-script.js RULE 3  → "≤25 words, cartoon stick figure"
 *   barrotube-writer.md:188    → "영문 100~200자"
 *   barrotube-writer.md:64     → 예시에 마스코트가 아예 없음
 *   EP-2026-0069(발행본 실측)   → 695자, 마스코트가 씬 문장의 주어
 * 문서를 여러 벌 두면 반드시 갈라진다. 템플릿·수치를 여기 상수로 두고
 * 생성기(generate-script.js)·검증기(validate-image-prompts.js)·QA 리포트가
 * 전부 이 모듈을 import 한다. references/IMAGE-PROMPT.md 는 이 모듈을 설명할 뿐이다.
 *
 * 기준점: EP-2026-0069 (6컷, 발행 완료). EP-2026-0070 과의 A/B 로 규칙을 역산했다.
 *   0069 평균 695자 · 마스코트가 주어인 문장 58% · 금지어 1.2개 · 프레임% 0/6 → 마스코트 크고 중앙
 *   0070 평균 1024자 · 26% · 4.8개 · 5/5           → 5컷 전부 구석 스티커, 금지문 6종이 그대로 렌더됨
 */

/** 검증에 쓰는 수치. 0069 실측(648~766자)에 여유를 둔 값. */
export const BOUNDS = {
  minChars: 640,
  maxChars: 780,
  maxNegations: 1,        // 고정 꼬리의 "no readable text or numbers" 는 제외하고 센다
  maxWardrobeScenes: 1,   // 한 EP에서 의상 지정은 최대 1컷 (60초 안에 갈아입으면 연속성이 깨진다)
};

/** 모든 프롬프트가 끝나야 하는 고정 꼬리. 이 문장이 스타일과 안전 규칙을 동시에 고정한다. */
export const CANONICAL_TAIL =
  'bold illustrated line art, 9:16 vertical, no readable text or numbers.';

/**
 * 대본의 image_prompt 안에 들어갈 마스코트 절 — EP-2026-0069(발행본) 실물이다.
 *
 * ⚠️ 채널의 character-dna.md 첫 코드블록(v12, 1001자·금지표현 8개)을 여기에 그대로 넣으면
 * 안 된다. 그 블록은 generate-image-gemini.js 가 이미지 API 호출의 prefix 로 쓰는 것이고,
 * image_prompt 에 넣으면 프롬프트 하나가 계약 상한(780자·금지어 1개)을 구조적으로 넘겨
 * 모든 컷이 BLOCK 된다 (2026-07-29 실측: EP-0072 10건 BLOCK → 재생성도 JSON 잘림으로 실패).
 *
 * 즉 DNA 는 "이미지 생성 단계의 정본", 이 절은 "대본 단계의 정본"이다. 둘은 용도가 다르다.
 */
// 2026-08-14: 여기에 "bare cream-white … arms and legs visible" 를 덧붙였다가 되돌렸다.
// EP-0092 의 정장·팔 소실은 이 절이 부족해서가 아니라 스테이징 문구(STAGING_PHRASES)가
// 통째로 빠져서 생긴 것이었고(발행본 5/5 vs 0092 0/5), 절을 늘리면 프롬프트가 780자
// 상한을 넘겨 씬 묘사를 깎아먹는다. 절은 발행본과 같게 둔다.
// 2026-08-14: "rounded pear-shaped body" 를 버렸다. 배 모양은 아래가 불룩한 형태라
// 모델이 마시를 뚱뚱하게 그렸다(EP-0092 실측). 정본 캐릭터시트의 몸통은 좁고 날씬한
// 캡슐이고 팔다리는 막대처럼 가늘다 — 시트 §1 MAIN CHARACTER·§2 TURNAROUND 기준.
export const MASCOT_CLAUSE =
  '마시 the 바로경제 mascot (official character sheet for the character only — ' +
  'large round head on a slim capsule body with thin stick limbs, white mitten hands and ' +
  'rounded shoe-feet, big solid black eyes with white highlights, orange (#FF9A1F) ' +
  'blush cheeks, no nose or ears)';

/**
 * 작성 템플릿. generate-script.js 가 그대로 모델에게 넘긴다.
 *
 * 고정 문구(a single … in the centre / face readable / the unified …)는 장식이 아니라
 * 실측으로 검증된 것이다. 발행본 EP-2026-0091 은 5컷 전부가 이 문구를 갖고 있었고,
 * 이 문구가 하나도 없던 EP-2026-0092 는 마시가 정장을 입고 화면 30% 로 줄고 배경이
 * 회화풍으로 채워졌다(2026-08-14 실측). 마스코트에게 신체 동작을 주지 않으면
 * 모델이 그를 배치 대상이 아니라 나중에 얹는 장식으로 처리한다.
 */
export const TEMPLATE =
  '[palette:<tag>] <MASCOT_CLAUSE>, <emotion>, standing before a single <adjective> ' +
  '<scene object> in the centre, face readable, <mascot body action — planting its ' +
  'rounded shoe-feet / bracing its body> while one white mitten hand <acts on the object>, ' +
  'the unified <scene object> <state that carries the scene meaning>. ' +
  'BACKGROUND: deep navy abstract <place>, <accent> on <element>, <texture> at low contrast, ' +
  CANONICAL_TAIL;

/**
 * 발행본이 100% 갖고 있던 스테이징 문구. 하나라도 빠지면 마스코트가 구석으로 밀린다.
 * 값을 늘리기 전에 발행본 실측을 먼저 하라 — 여기 있는 셋은 EP-0091 5/5 근거다.
 */
export const STAGING_PHRASES = [
  { key: 'in the centre', re: /in the cent(re|er)/i, hint: '"in the centre" 로 씬 오브젝트를 중앙에 고정하세요.' },
  { key: 'face readable', re: /face readable/i, hint: '"face readable" 이 없으면 마스코트가 썸네일에서 안 보일 크기로 줄어듭니다.' },
  { key: 'a single', re: /\ba single\b/i, hint: '"a single <object>" 로 오브젝트를 하나로 못박으세요. 없으면 배경이 채워집니다.' },
];

/**
 * 마스코트가 "씬 동작의 주어"인지 판정할 때 찾는 동사.
 * 0070 은 마스코트를 서술 대상으로만 두어("Masi is the dominant protagonist, 36-40% of frame height")
 * 모델이 배치 대상이 아니라 나중에 얹는 장식으로 처리했다.
 */
const SCENE_VERBS = /\b(standing|sitting|walking|running|facing|holding|gripping|pointing|pushing|pulling|reaching|leaning|bracing|kneeling|climbing|balancing|carrying|presenting|watching|looking|stepping|raising|lifting|hugging|floating)\b/i;

/** 캐릭터 시트에 없는 의상. DNA 허용은 "기본 무착장" 또는 "네이비 정장+타이" 둘뿐이다. */
const OFF_SHEET_WARDROBE = /\b(waistcoat|vest|hoodie|hood|zip-?up|jacket|blazer|coat|parka|pouch|backpack|crossbody|scarf|cape|apron|uniform|helmet)\b/i;
/** DNA가 허용하는 유일한 의상 표현. */
const ON_SHEET_WARDROBE = /\b(suit and tie|business suit|navy suit)\b/i;

const NEGATION = /\b(no|not|never|without|avoid|don't|do not)\b/gi;
const FRAME_RATIO = /\d+\s*[-–]\s*\d+\s*%\s*of\s*(the\s*)?frame|\bof frame height\b/i;
const CAMERA_SPEC = /\b\d{1,3}\s*mm\b|\bfocal length\b|\bwide-?angle\b/i;
const PALETTE_TAG = /\[palette:([a-z0-9_-]+)\]/i;

/** scene-backgrounds.md 에 정의된 팔레트. 없는 태그는 조용히 무시되므로 잡아준다. */
export const KNOWN_PALETTES = ['bullish', 'bearish', 'explainer', 'cta', 'wealth'];

const BLOCK = 'BLOCK';
const WARN = 'WARN';

function mascotClause(prompt, mascotPattern) {
  const re = mascotPattern || /([^,.]*\bmascot\b\s*\([^)]*\))/i;
  const m = prompt.match(re);
  return m ? m[1] || m[0] : null;
}

/** 프롬프트를 문장으로 쪼갠다. 괄호 안의 마침표는 무시. */
function sentences(prompt) {
  return prompt.replace(/\([^)]*\)/g, s => s.replace(/\./g, '·')).split(/(?<=\.)\s+/);
}

/**
 * 한 컷 검증.
 * @param {string} prompt        image_prompt 원문
 * @param {object} [opts]
 * @param {RegExp} [opts.mascotPattern]  채널 마스코트 절을 찾는 정규식 (미지정 시 "... mascot (...)")
 * @param {string} [opts.sceneId]
 * @returns {{code:string,severity:string,message:string,sceneId?:string}[]}
 */
export function checkImagePrompt(prompt, opts = {}) {
  const p = String(prompt || '').replace(/\s+/g, ' ').trim();
  const v = [];
  const add = (code, severity, message) => v.push({ code, severity, message, sceneId: opts.sceneId });

  if (!p) { add('EMPTY', BLOCK, 'image_prompt 가 비어 있습니다.'); return v; }

  // 1. 마스코트가 존재하고, 씬 동작의 주어여야 한다 — 크기·배치를 정하는 유일한 실효 수단.
  const clause = mascotClause(p, opts.mascotPattern);
  if (!clause) {
    add('MASCOT_CLAUSE_MISSING', BLOCK,
      '마스코트 정체성 절이 없습니다. "<이름> the <채널> mascot (…생김새…)" 를 프롬프트 앞에 두세요.');
  } else {
    const host = sentences(p).find(s => s.includes(clause.slice(0, 24)));
    if (!host || !SCENE_VERBS.test(host)) {
      add('MASCOT_NOT_SUBJECT', BLOCK,
        '마스코트가 씬 동작의 주어가 아닙니다. 정체성·감정·포즈·씬을 한 문장으로 묶으세요 ' +
        '("… mascot (…), worried, standing before …"). 별도 문장으로 크기를 서술하면 구석으로 밀립니다.');
    }
  }

  // 1-b. 스테이징 문구 — 마스코트를 크게·중앙에 두는 실효 수단.
  //      EP-0091(발행, 정상) 5/5 보유 vs EP-0092(드리프트) 0/5. 빠지면 구석으로 밀린다.
  for (const s of STAGING_PHRASES) {
    if (!s.re.test(p)) add('STAGING_PHRASE_MISSING', BLOCK, `"${s.key}" 가 없습니다. ${s.hint}`);
  }

  // 2. 구조 — BACKGROUND 분리 + 고정 꼬리
  if (!/BACKGROUND:/i.test(p)) {
    add('BACKGROUND_MISSING', BLOCK, '"BACKGROUND:" 구간이 없습니다. 씬과 배경을 분리하세요.');
  }
  if (!p.endsWith(CANONICAL_TAIL)) {
    add('TAIL_MISSING', BLOCK, `고정 꼬리로 끝나야 합니다: "${CANONICAL_TAIL}"`);
  }

  // 3. 금지문 — 이미지 모델은 부정을 신뢰성 있게 처리하지 못한다.
  //    0070 은 "no tiny corner mascot" 을 5컷에 넣고 5컷 전부 구석 스티커를 얻었다.
  const body = p.endsWith(CANONICAL_TAIL) ? p.slice(0, -CANONICAL_TAIL.length) : p;
  const negs = (body.match(NEGATION) || []).length;
  if (negs > BOUNDS.maxNegations) {
    add('TOO_MANY_NEGATIONS', BLOCK,
      `금지 표현 ${negs}개 (허용 ${BOUNDS.maxNegations}개). 원하는 것을 긍정문으로 쓰세요 — ` +
      '"no tiny corner mascot" 이 아니라 "standing in the centre, face readable at thumbnail size".');
  }

  // 4. 수치 지정 — 지켜지지 않는다(0070 실측: 42-46% 지정 → 실제 약 12%).
  if (FRAME_RATIO.test(p)) {
    add('FRAME_RATIO_SPEC', BLOCK,
      '프레임 비율(%) 지정은 무시됩니다. 규칙 1(마스코트를 주어로)로 크기를 정하세요.');
  }
  if (CAMERA_SPEC.test(p)) {
    add('CAMERA_SPEC', WARN, '카메라 초점거리·화각 지정은 일러스트 모델에서 효과가 없습니다.');
  }

  // 5. 의상 — DNA 허용은 기본 무착장 또는 네이비 정장뿐.
  if (OFF_SHEET_WARDROBE.test(p)) {
    add('WARDROBE_OFF_SHEET', BLOCK,
      `캐릭터 시트에 없는 의상입니다 ("${p.match(OFF_SHEET_WARDROBE)[0]}"). ` +
      '기본(무착장) 또는 시트의 네이비 정장만 쓸 수 있습니다.');
  }

  // 6. 팔레트 태그
  const tag = p.match(PALETTE_TAG);
  if (tag && !KNOWN_PALETTES.includes(tag[1].toLowerCase())) {
    add('PALETTE_TAG_UNKNOWN', WARN,
      `scene-backgrounds.md 에 없는 팔레트 "${tag[1]}" — 조용히 무시됩니다.`);
  }

  // 7. 길이
  if (p.length < BOUNDS.minChars || p.length > BOUNDS.maxChars) {
    add('LENGTH_OUT_OF_RANGE', WARN,
      `${p.length}자 (권장 ${BOUNDS.minChars}~${BOUNDS.maxChars}자). ` +
      '짧으면 모델이 캐릭터를 추론하고, 길면 씬 묘사가 마스코트의 주의 예산을 잡아먹습니다.');
  }

  return v;
}

/**
 * EP 단위 검증 — 컷 사이 일관성(의상 변경 횟수)은 여기서만 판정할 수 있다.
 * @param {{sceneId?:string, prompt:string}[]} scenes
 * @param {object} [opts] checkImagePrompt 와 동일
 */
export function checkEpisodePrompts(scenes, opts = {}) {
  const violations = [];
  let wardrobe = 0;

  for (const s of scenes) {
    const p = String(s.prompt || '').replace(/\s+/g, ' ').trim();
    violations.push(...checkImagePrompt(p, { ...opts, sceneId: s.sceneId }));
    if (ON_SHEET_WARDROBE.test(p) || OFF_SHEET_WARDROBE.test(p)) wardrobe += 1;
  }

  if (wardrobe > BOUNDS.maxWardrobeScenes) {
    violations.push({
      code: 'WARDROBE_OVERUSE', severity: WARN,
      message: `의상 지정이 ${wardrobe}컷 (허용 ${BOUNDS.maxWardrobeScenes}컷). ` +
        '한 편 안에서 갈아입으면 캐릭터 연속성이 깨집니다.',
    });
  }

  const blocks = violations.filter(x => x.severity === BLOCK);
  return {
    ok: blocks.length === 0,
    violations,
    stats: profile(scenes.map(s => s.prompt), opts),
  };
}

/** 0069 대비 프로파일. 사람이 한눈에 "기준점에서 얼마나 벗어났나"를 보게 하는 용도. */
export function profile(prompts, opts = {}) {
  const ps = prompts.map(p => String(p || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!ps.length) return { scenes: 0 };
  let total = 0, subject = 0, negs = 0, ratio = 0;
  for (const p of ps) {
    total += p.length;
    const clause = mascotClause(p, opts.mascotPattern);
    if (clause) {
      for (const s of sentences(p)) {
        if (s.includes(clause.slice(0, 24)) && SCENE_VERBS.test(s)) subject += s.length;
      }
    }
    const body = p.endsWith(CANONICAL_TAIL) ? p.slice(0, -CANONICAL_TAIL.length) : p;
    negs += (body.match(NEGATION) || []).length;
    if (FRAME_RATIO.test(p)) ratio += 1;
  }
  return {
    scenes: ps.length,
    avgChars: Math.round(total / ps.length),
    subjectShare: Math.round((subject / total) * 100),   // 0069 기준점 = 58%
    avgNegations: Number((negs / ps.length).toFixed(1)), // 0069 기준점 = 1.2
    frameRatioSpecs: ratio,                              // 0069 기준점 = 0
  };
}

export default { BOUNDS, CANONICAL_TAIL, TEMPLATE, KNOWN_PALETTES, checkImagePrompt, checkEpisodePrompts, profile };
