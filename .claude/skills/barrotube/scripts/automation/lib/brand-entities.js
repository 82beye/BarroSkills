/**
 * brand-entities.js — 타이틀에 들어온 기업명을 "연관 인물 + CI" 로 바꾼다.
 *
 * 왜 필요한가. 인물 감지(lib/public-figures.js)는 **사람 이름**만 찾는다. 그런데 실제
 * 타이틀은 사람이 아니라 회사를 말한다 — EP-2026-0114 의 「…엔비디아가 7일 연속 하락한
 * 이유」에는 '젠슨 황' 이라는 글자가 없어서 allowlist 가 아무도 감지하지 못했고, 인트로는
 * 익명 마스코트 + 일반 하락 차트로 나갔다. 시청자는 어느 회사 얘긴지 그림만 봐서는 모른다.
 * 이 모듈이 그 빠진 고리(기업 → 인물·로고)를 메운다.
 *
 * 두 갈래로 표현한다. 근거는 이 저장소가 이미 배운 것들이다.
 *   • 인물 = 이미지 모델이 그린다(캐리커처). 정책 정본은 채널의
 *     policies/public-figures-policy.md 이고, 판정은 lib/public-figures.js 가 한다.
 *   • CI  = 그리게 두지 않는다. 라이선스 SVG(workspace/assets, SimpleIcons CC0)를 생성 후에
 *     합성한다. 글자를 모델에게 맡기면 깨진다는 걸 카드에서 이미 확인했고(메타→머타),
 *     로고는 글자보다 더 잘 깨진다. 프롬프트는 자리만 비워 두라고 지시한다.
 *
 * 노출 API:
 *   loadBrandRegistry()
 *   detectCompaniesInText(registry, text)
 *   resolveBrandsForTitle(channel, briefFM, title, opts) → { brands, primary, logoSpecs, promptBlock, notes }
 *   buildBrandPromptBlock(brands, opts)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeTreatment, findFigureById, loadAllowlist } from './public-figures.js';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REGISTRY_PATH = join(SKILL_ROOT, 'config', 'brand-entities.json');
const MANIFEST_PATH = join(SKILL_ROOT, 'workspace', 'assets', 'manifest.json');
const ASSETS_DIR = join(SKILL_ROOT, 'workspace', 'assets');

/**
 * 한국어 조사. alias 뒤에 붙은 한글 덩어리가 **통째로** 이 중 하나여야 매칭을 인정한다.
 * "엔비디아가" 는 통과하고 "메타버스" 는 걸러진다.
 */
const JOSA = [
  '가', '이', '은', '는', '을', '를', '의', '에', '에서', '에게', '와', '과', '도', '만',
  '로', '으로', '부터', '까지', '보다', '처럼', '랑', '이랑', '한테', '께', '께서',
  '나', '이나', '든지', '조차', '마저', '밖에', '대로', '같이', '라도', '이라도',
  '라는', '이라는', '이라', '라', '요', '였', '이었',
];
/** 회사명 뒤에 자주 붙는 명사 꼬리. "테슬라주가", "엔비디아발", "삼성그룹" 을 살린다. */
const NOUN_TAIL = ['주가', '주', '발', '사', '그룹', '측', '株'];

const JOSA_RE = new RegExp(`^(?:${JOSA.join('|')})$`);
const NOUN_TAIL_RE = new RegExp(`^(?:${NOUN_TAIL.join('|')})(?:${JOSA.join('|')})?$`);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** alias 바로 뒤의 한글 덩어리가 매칭을 깨는지 판정. */
function followOk(run) {
  if (!run) return true;
  return JOSA_RE.test(run) || NOUN_TAIL_RE.test(run);
}

/**
 * text 안에서 alias 의 첫 유효 위치. 없으면 -1.
 * 라틴 alias 는 단어 경계로 자른다 — 'intel' 이 'intelligence' 에, 'kia' 가 'Nokia' 에
 * 걸리면 엉뚱한 회사의 로고가 붙는다.
 */
export function findAliasIndex(text, alias) {
  const a = String(alias || '').trim();
  if (!a || !text) return -1;
  const pre = /^[A-Za-z0-9]/.test(a) ? '(?<![A-Za-z0-9가-힣])' : '(?<![가-힣])';
  const post = /[A-Za-z0-9]$/.test(a) ? '(?![A-Za-z0-9])' : '';
  const re = new RegExp(`${pre}${escapeRe(a)}${post}([가-힣]*)`, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (followOk(m[1])) return m.index;
    if (m.index === re.lastIndex) re.lastIndex++;   // zero-width 방어
  }
  return -1;
}

export function loadBrandRegistry(path = REGISTRY_PATH) {
  if (!existsSync(path)) return { path, companies: [] };
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    return { path, companies: Array.isArray(cfg.companies) ? cfg.companies : [] };
  } catch {
    return { path, companies: [] };
  }
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { brand_logos: [] };
  try {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    return { brand_logos: Array.isArray(m.brand_logos) ? m.brand_logos : [] };
  } catch {
    return { brand_logos: [] };
  }
}

/**
 * 텍스트에서 기업 감지. 긴 alias 우선(삼성전자 > 삼성), 결과는 타이틀에 나온 순서.
 * 반환: [{ company, alias, index }]
 */
export function detectCompaniesInText(registry, text) {
  if (!text || !registry?.companies?.length) return [];
  const candidates = [];
  for (const company of registry.companies) {
    for (const alias of company.aliases || []) {
      candidates.push({ alias: String(alias), company });
    }
  }
  candidates.sort((x, y) => y.alias.length - x.alias.length);

  const hits = new Map();   // company.id -> hit
  for (const { alias, company } of candidates) {
    if (hits.has(company.id)) continue;
    const index = findAliasIndex(text, alias);
    if (index >= 0) hits.set(company.id, { company, alias, index });
  }
  return Array.from(hits.values()).sort((a, b) => a.index - b.index);
}

/** manifest 에 로고 파일이 실제로 있는지. 없으면 CI 없이 간다(조용히 죽이지 않고 notes 로 알린다). */
function resolveLogo(manifest, logoId) {
  if (!logoId) return null;
  const lg = manifest.brand_logos.find(l => l.id === logoId);
  if (!lg || !lg.logo_path) return null;
  if (!existsSync(join(ASSETS_DIR, lg.logo_path))) return null;
  return lg;
}

/** 정책 §3.2 의 표정 규칙을 한 줄로. 인트로는 1.5~2초짜리라 길게 쓸 자리가 없다. */
function expressionRule(sensitivity) {
  if (sensitivity === 'high') {
    return 'EXPRESSION: 무표정 or serious only — no mocking, no celebration, no comedy props, no injury/blood. Identifying cues stay fully visible (do not anonymize)';
  }
  if (sensitivity === 'medium') {
    return 'EXPRESSION: neutral, serious, confident or thoughtful only — no mocking or celebratory faces';
  }
  return 'EXPRESSION: neutral, confident or thoughtful, matching the episode mood — no mocking tone';
}

/**
 * 타이틀 → 기업 → (인물, CI) 최종 판정.
 *
 * @param {string} channel   채널 id (allowlist 로딩용)
 * @param {object} briefFM   00_brief.md frontmatter (sensitivity / legal_review_* 토큰)
 * @param {string} title     에피소드 타이틀 (topic + 인트로 헤드라인)
 * @param {object} [opts]
 * @param {number} [opts.maxCompanies=2]  화면에 올릴 기업 수 상한 (로고가 3개 넘어가면 카드가 지저분해진다)
 * @param {string} [opts.logoPosition='top-right']  로고를 놓을 모서리. **합성기마다 다르다**:
 *   - thumbnail-composer 의 인트로 모드는 헤드라인을 y=80 부터 그린다 → 'bottom-right'
 *   - HyperFrames 카드는 타이틀이 화면 30% 지점이라 위가 비어 있다 → 'top-right'
 *   - 썸네일은 배지가 없고 헤드라인이 y=240 부터다 → 'top-right'
 *   프롬프트의 "이 모서리를 비워라" 문장도 이 값을 따라간다 — 둘이 어긋나면 로고가 그림 위에 얹힌다.
 *
 * 반환: {
 *   brands: [{ company, alias, logo, figure, treatment, sensitivity, blockReason, mode, note }],
 *   primary,        // 인물을 그릴 수 있는 첫 기업 (없으면 첫 기업)
 *   logoSpecs,      // thumbnail-composer 의 spec.brand_logos 형태
 *   promptBlock,    // 이미지 프롬프트에 붙일 [BRAND CONTEXT] 블록 (없으면 null)
 *   notes           // 운영자에게 보일 한 줄 설명들
 * }
 */
export function resolveBrandsForTitle(channel, briefFM = {}, title = '', opts = {}) {
  const { maxCompanies = 2, logoPosition = 'top-right' } = opts;
  const empty = { brands: [], primary: null, logoSpecs: [], promptBlock: null, notes: [] };
  if (!title) return empty;

  const registry = loadBrandRegistry();
  const detected = detectCompaniesInText(registry, title);
  if (!detected.length) return empty;

  const manifest = loadManifest();
  const allowlist = loadAllowlist(channel);
  const notes = [];
  const brands = [];

  for (const { company, alias } of detected.slice(0, maxCompanies)) {
    const logo = resolveLogo(manifest, company.logo_id);
    if (!logo) {
      notes.push(`${company.name_ko}: 로고 자산 없음(manifest.brand_logos.${company.logo_id}) — CI 합성 생략. build-assets-library.js --brand-logos 로 받는다.`);
    }

    const figure = findFigureById(allowlist, company.figure_id);
    let treatment = 'NEUTRAL_MASCOT';
    let sensitivity = briefFM.sensitivity || 'low';
    let blockReason = null;

    if (company.figure_id && !figure) {
      notes.push(`${company.name_ko}: 연관 인물 "${company.figure_id}" 이(가) allowlist 미등록 — 인물 없이 CI 로만 간다(정책 §2.2 신규 인물 사전 승인 필요).`);
    } else if (figure) {
      ({ treatment, sensitivity, blockReason } = computeTreatment(figure, briefFM));
      if (blockReason) {
        notes.push(`${company.name_ko}: ${blockReason} → 마스코트 유지 + CI 만.`);
      }
    }

    const usePerson = !!figure && treatment === 'CHARACTERIZE' && !blockReason;
    brands.push({
      company,
      alias,
      logo,
      figure: usePerson ? figure : null,
      treatment,
      sensitivity,
      blockReason,
      mode: usePerson ? 'PERSON_AND_CI' : 'CI_ONLY',
    });
  }

  const primary = brands.find(b => b.mode === 'PERSON_AND_CI') || brands[0] || null;
  const logoSpecs = brands
    .filter(b => b.logo)
    .map(b => ({ id: b.logo.id, position: logoPosition, size: 'medium' }));

  return {
    brands,
    primary,
    logoSpecs,
    promptBlock: buildBrandPromptBlock(brands, opts),
    notes,
  };
}

/**
 * 이미지 프롬프트에 붙일 블록. 인물은 그리게 하고, CI 는 **자리만 비우게** 한다.
 *
 * @param {Array} brands  resolveBrandsForTitle 의 brands
 * @param {object} [opts]
 * @param {string} [opts.logoPosition='top-right']  비워 둘 모서리. logoSpecs 와 같은 값이어야 한다.
 */
export function buildBrandPromptBlock(brands, opts = {}) {
  const { logoPosition = 'top-right' } = opts;
  if (!Array.isArray(brands) || !brands.length) return null;

  const names = brands.map(b => `${b.company.name_ko} (${b.company.name_en})`).join(', ');
  const lines = [
    '[BRAND CONTEXT — resolved automatically from the episode title]',
    `The title names ${names}. Make the company readable in the picture — a viewer must know which company this episode is about without reading any word.`,
  ];

  const person = brands.find(b => b.mode === 'PERSON_AND_CI');
  if (person) {
    const fig = person.figure;
    const cues = (fig.trademark_cues || []).slice(0, 3).join(' / ') || 'hairstyle silhouette, signature outfit colour';
    lines.push(
      `ASSOCIATED FIGURE (draw this person, sharing the frame with the mascot at a comparable size and in the SAME flat line-art style): ${fig.descriptor_en}. `
      + `Identifying cues that must read at a glance: ${cues}. ${expressionRule(person.sensitivity)}. `
      + 'Keep it cartoon caricature — no photorealistic skin, no photo likeness, no realistic facial detail, no animal or demon substitution. '
      + 'NEVER write the person\'s name, the company name, or any other lettering in the image.'
    );
  }

  const ciOnly = brands.filter(b => b.mode === 'CI_ONLY');
  for (const b of ciOnly) {
    const why = b.blockReason
      ? 'channel policy keeps this company\'s executives anonymous in this episode'
      : 'no approved public-figure entry exists for this company';
    lines.push(
      `${b.company.name_ko}: do NOT draw a caricature of any real person — ${why}. The mascot stays the only character. `
      + `Represent the company with ${b.company.context_object || 'a single symbolic object from its industry'} placed as the scene object.`
    );
  }

  const withLogo = brands.filter(b => b.logo);
  if (withLogo.length) {
    const corner = String(logoPosition).toUpperCase();
    lines.push(
      `BRAND CI: the real ${withLogo.map(b => b.company.name_en).join(' / ')} logo is composited from a licensed vector file AFTER generation. `
      + `Leave the ${corner} corner (about 22% wide, 14% tall) clean and uncluttered, and DO NOT draw the logo, the wordmark, the company name, or any lettering yourself.`
    );
  }

  const accents = brands.map(b => b.company.accent).filter(Boolean);
  if (accents.length) {
    lines.push(
      `BRAND ACCENT: ONE background element may carry ${accents.join(' or ')} at low saturation. The channel palette still dominates — brand colour stays under 25% of the frame (policy §4.4).`
    );
  }

  return lines.join('\n');
}

export default {
  loadBrandRegistry,
  detectCompaniesInText,
  findAliasIndex,
  resolveBrandsForTitle,
  buildBrandPromptBlock,
};
