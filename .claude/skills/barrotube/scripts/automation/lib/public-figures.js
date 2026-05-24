/**
 * public-figures.js — Public Figure allowlist 로딩 + 정책 결정 헬퍼 (CEO 정책 v1.0, 2026-04-26)
 *
 * Writer / Image Generator / Thumbnail Generator / Metadata Writer가 공통 사용.
 *
 * 정책 문서:
 *  - workspace/channels/{channel}/policies/public-figures-policy.md  (CEO v1.0)
 *  - workspace/channels/{channel}/policies/public-figures.md         (allowlist 시드)
 *
 * 우선순위 (정책 §2.2):
 *  1. EP brief frontmatter `policy_override`
 *  2. public-figures-policy.md §2 카테고리 표 (코드 상수로 인코딩)
 *  3. public-figures.md (allowlist의 카테고리 결정)
 *  4. character-dna v9 디폴트 (NEUTRAL_MASCOT)
 *
 * 노출 API:
 *   loadAllowlist(channel)
 *   detectFiguresInText(allowlist, text)
 *   resolveFigureForBrief(channel, briefFM, topic) → 결정된 figures[]
 *   buildAllowlistContextBlock(allowlist) → Writer system prompt에 inject할 텍스트
 *   computeTreatment(figure, briefFM) → { treatment, sensitivity, blockReason? }
 *
 * 결정 규칙:
 *  - REQUIRES_LEGAL_REVIEW(한국 인사) + brief.legal_review_approved_by 누락
 *      → blockReason 반환 (Image Generator는 throw, Writer는 NEUTRAL_MASCOT으로 강등)
 *  - sensitivity 등급: max(brief.sensitivity, figure.sensitivity_floor)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYAML } from 'yaml';

// 정책 §2 카테고리 표 (코드 상수, 정책 텍스트와 동기)
export const POLICY_CATEGORY_TREATMENT = {
  '외국 정치인': 'CHARACTERIZE',
  '외국 CEO': 'CHARACTERIZE',
  '외국 경제 인사': 'CHARACTERIZE',
  '외국 연예인': 'NEUTRAL_MASCOT',
  '한국 정치인': 'REQUIRES_LEGAL_REVIEW',
  '한국 CEO': 'REQUIRES_LEGAL_REVIEW',
  '한국 경제 인사': 'REQUIRES_LEGAL_REVIEW',
  '사망한 공인': 'CHARACTERIZE',
  '역사적 인물': 'CHARACTERIZE',
  '일반인': 'NEUTRAL_MASCOT',
};

const ALLOWLIST_FILENAME = 'public-figures.md';

/**
 * public-figures.md 파일을 파싱하여 시드 인물 배열을 반환.
 * 각 id 블록(```yaml ... ```)을 추출하고 YAML로 파싱.
 *
 * 반환:
 *   [
 *     { id, display_name_ko, aliases[], category, treatment, descriptor_en,
 *       descriptor_short, trademark_cues[], sensitivity, sensitivity_floor,
 *       last_reviewed, notes }
 *   ]
 */
export function loadAllowlist(channel) {
  const path = resolve('workspace/channels', channel, 'policies', ALLOWLIST_FILENAME);
  if (!existsSync(path)) {
    return { path, figures: [], frontmatter: null };
  }
  const md = readFileSync(path, 'utf-8');

  // 상단 frontmatter (schema_version 등)
  let frontmatter = null;
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    try { frontmatter = parseYAML(fmMatch[1]); } catch { frontmatter = null; }
  }

  // 모든 ```yaml ... ``` 블록 추출
  const blockRe = /```yaml\s*\n([\s\S]*?)\n```/g;
  const figures = [];
  let m;
  while ((m = blockRe.exec(md)) !== null) {
    let parsed;
    try { parsed = parseYAML(m[1]); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    if (!parsed.id || !parsed.aliases) continue;
    figures.push(parsed);
  }
  return { path, figures, frontmatter };
}

/**
 * Allowlist에서 id로 lookup.
 */
export function findFigureById(allowlist, id) {
  if (!id) return null;
  return allowlist.figures.find(f => f.id === id) || null;
}

/**
 * 텍스트(브리프 topic 등) 안에서 alias 매칭으로 figure 자동 감지.
 * 대소문자/공백 무시, 가장 긴 alias 우선 매칭하여 부분문자열 false-positive 회피.
 *
 * 반환: 매치된 figure[] (중복 제거)
 */
export function detectFiguresInText(allowlist, text) {
  if (!text || !allowlist?.figures?.length) return [];
  const normalized = String(text).toLowerCase();
  const hits = new Map(); // id -> figure
  // alias 길이 내림차순 (긴 alias 우선)
  const candidates = [];
  for (const fig of allowlist.figures) {
    for (const a of (fig.aliases || [])) {
      candidates.push({ alias: String(a).toLowerCase().trim(), fig });
    }
  }
  candidates.sort((x, y) => y.alias.length - x.alias.length);
  for (const { alias, fig } of candidates) {
    if (!alias) continue;
    if (normalized.includes(alias)) {
      if (!hits.has(fig.id)) hits.set(fig.id, fig);
    }
  }
  return Array.from(hits.values());
}

/**
 * 정책 §2.2 우선순위에 따라 인물의 최종 treatment 결정.
 *  1. brief.policy_override (인물 단위 X — 정책 절 단위만이라 무시 가능)
 *  2. POLICY_CATEGORY_TREATMENT (정책 §2 표)
 *  3. figure.treatment (allowlist 자체 결정)
 *  4. NEUTRAL_MASCOT
 *
 * sensitivity 등급은 max(brief.sensitivity, figure.sensitivity_floor).
 *
 * REQUIRES_LEGAL_REVIEW 카테고리 + 운영자 승인 토큰 누락 시 blockReason 반환.
 */
export function computeTreatment(figure, briefFM = {}) {
  if (!figure) {
    return { treatment: 'NEUTRAL_MASCOT', sensitivity: briefFM.sensitivity || 'low' };
  }

  // 카테고리 → 정책 표 우선
  let treatment =
    POLICY_CATEGORY_TREATMENT[figure.category]
    || figure.treatment
    || 'NEUTRAL_MASCOT';

  // sensitivity 격상
  const ladder = ['low', 'medium', 'high'];
  const briefSens = briefFM.sensitivity || 'low';
  const floor = figure.sensitivity_floor || figure.sensitivity || 'low';
  const briefIdx = ladder.indexOf(briefSens) >= 0 ? ladder.indexOf(briefSens) : 0;
  const floorIdx = ladder.indexOf(floor) >= 0 ? ladder.indexOf(floor) : 0;
  const sensitivity = ladder[Math.max(briefIdx, floorIdx)];

  // REQUIRES_LEGAL_REVIEW 검증
  let blockReason = null;
  if (treatment === 'REQUIRES_LEGAL_REVIEW') {
    const approved =
      briefFM.legal_review_approved === true
      || briefFM.legal_review_approved_by; // policy §2.2 토큰
    if (!approved) {
      // 운영자 승인 누락 → CHARACTERIZE를 사용하면 안 되며, NEUTRAL_MASCOT으로 강제 강등.
      // Image Generator는 더 엄격하게 — character_override 명시 + 미승인 시 throw.
      blockReason = `legal_review_required: figure.id="${figure.id}" category="${figure.category}" 운영자 승인 토큰(legal_review_approved_by) 누락. 정책 §2.2 / §5.2 위반.`;
      treatment = 'NEUTRAL_MASCOT';
    } else {
      treatment = 'CHARACTERIZE';
    }
  }

  return { treatment, sensitivity, blockReason };
}

/**
 * EP brief의 public_figures 필드(있으면) + topic 자동 감지(fallback)로
 * 최종 인물 결정 묶음을 만든다.
 *
 * 반환:
 *   {
 *     allowlist: { path, figures[] },
 *     resolved: [
 *       {
 *         id, figure, treatment, sensitivity, blockReason?, source: 'brief'|'topic'
 *       }
 *     ]
 *   }
 */
export function resolveFiguresForBrief(channel, briefFM = {}, topicText = '') {
  const allowlist = loadAllowlist(channel);
  const resolved = [];
  const seen = new Set();

  // 1. brief.public_figures (명시적 — 우선)
  const bfArr = Array.isArray(briefFM.public_figures) ? briefFM.public_figures : [];
  for (const entry of bfArr) {
    // entry는 string id 또는 { name, category, treatment } 객체일 수 있음
    let figure = null;
    if (typeof entry === 'string') {
      figure = findFigureById(allowlist, entry);
      if (!figure) {
        // alias로도 시도
        const hits = detectFiguresInText(allowlist, entry);
        if (hits.length) figure = hits[0];
      }
    } else if (entry && typeof entry === 'object') {
      if (entry.id) figure = findFigureById(allowlist, entry.id);
      if (!figure && entry.name) {
        const hits = detectFiguresInText(allowlist, entry.name);
        if (hits.length) figure = hits[0];
      }
    }
    if (!figure) continue;
    if (seen.has(figure.id)) continue;
    seen.add(figure.id);
    const r = computeTreatment(figure, briefFM);
    resolved.push({ id: figure.id, figure, ...r, source: 'brief' });
  }

  // 2. topic 텍스트 fallback 감지
  if (topicText) {
    const hits = detectFiguresInText(allowlist, topicText);
    for (const figure of hits) {
      if (seen.has(figure.id)) continue;
      seen.add(figure.id);
      const r = computeTreatment(figure, briefFM);
      resolved.push({ id: figure.id, figure, ...r, source: 'topic' });
    }
  }

  return { allowlist, resolved };
}

/**
 * Writer system prompt에 주입할 [PUBLIC FIGURE ALLOWLIST] 컨텍스트 블록을 만든다.
 * descriptor_en / sensitivity / 정책 핵심 룰을 요약.
 *
 * - resolved가 비어 있어도 호출 가능 (그래도 short summary는 출력)
 * - 인물 이름은 영어 prompt 텍스트가 노출하지 않도록 한국어 표기 + descriptor_en만 사용
 */
export function buildAllowlistContextBlock(allowlist, resolved = []) {
  const lines = [];
  lines.push('[PUBLIC FIGURE ALLOWLIST]');
  lines.push('정책: workspace/channels/econ-daily/policies/public-figures-policy.md (CEO v1.0, 2026-04-26)');
  lines.push('Allowlist: workspace/channels/econ-daily/policies/public-figures.md');
  lines.push('');
  lines.push('카테고리별 디폴트 treatment:');
  for (const [cat, tr] of Object.entries(POLICY_CATEGORY_TREATMENT)) {
    lines.push(`  - ${cat}: ${tr}`);
  }
  lines.push('');

  if (resolved.length === 0) {
    lines.push('이 EP의 brief / topic에서 감지된 등록 공인: 없음 (RULE 14 미적용 — RULE 3 cartoon stick figure 그대로).');
    return lines.join('\n');
  }

  lines.push(`이 EP에서 감지된 등록 공인 (${resolved.length}명):`);
  for (const r of resolved) {
    const f = r.figure;
    lines.push(`  • id="${f.id}" (${f.display_name_ko}) — category="${f.category}" treatment=${r.treatment} sensitivity=${r.sensitivity} source=${r.source}`);
    if (r.blockReason) {
      lines.push(`     ⚠ BLOCKED: ${r.blockReason} → NEUTRAL_MASCOT 강제`);
      continue;
    }
    if (r.treatment === 'CHARACTERIZE') {
      lines.push(`     descriptor_en: ${f.descriptor_en}`);
      lines.push(`     descriptor_short: ${f.descriptor_short}`);
      if (Array.isArray(f.trademark_cues) && f.trademark_cues.length) {
        lines.push(`     trademark_cues: ${f.trademark_cues.join(' | ')}`);
      }
    }
  }
  lines.push('');
  lines.push('적용 룰 (RULE 14 — Public Figure Characterization):');
  lines.push('  (a) treatment=CHARACTERIZE 인물이 등장하는 씬의 image_prompt는 RULE 3 "cartoon stick figure" 대신 위 descriptor_en을 caricature descriptor로 사용한다.');
  lines.push('  (b) 인물이 등장하지 않는 씬은 RULE 3을 그대로 유지 (cartoon stick figure).');
  lines.push('  (c) sensitivity=high 인 인물의 씬에서는 풍자/조롱/코미디 props·표정 절대 금지. 표정은 무표정 또는 진지(serious)만. 사망/부상/피/총상 시각 묘사 금지.');
  lines.push('  (d) 한 영상 내 캐리커처 등장 씬 수 상한: Shorts ≤2씬, Long-3min ≤3씬 (정책 §5.1).');
  lines.push('  (e) image_prompt 텍스트에 인물 이름(한국어/영어 모두)을 노출하지 마라 — descriptor만 사용. RULE 11 (텍스트 라벨 금지)과 호환.');
  lines.push('  (f) treatment=NEUTRAL_MASCOT 인물 (외국 연예인 / 미승인 한국 인사 / 일반인 등)은 식별 단서 주입 금지 — RULE 3 cartoon stick figure 그대로.');
  lines.push('  (g) treatment=REQUIRES_LEGAL_REVIEW 가 운영자 승인 토큰 없이 들어온 경우 자동으로 NEUTRAL_MASCOT 으로 강등됨 (위 BLOCKED 표시 참조).');
  return lines.join('\n');
}

/**
 * 인물의 한국어 표기 → primary keyword 후보로 사용 (Metadata Writer용).
 * 정책 §3.2 metadata SEO 우선순위에 사용.
 */
export function pickPrimaryKeywordCandidates(resolved) {
  const out = [];
  for (const r of resolved) {
    if (!r?.figure) continue;
    if (r.treatment !== 'CHARACTERIZE') continue;
    const ko = r.figure.display_name_ko;
    if (ko) out.push(ko);
  }
  return out;
}

export default {
  POLICY_CATEGORY_TREATMENT,
  loadAllowlist,
  findFigureById,
  detectFiguresInText,
  computeTreatment,
  resolveFiguresForBrief,
  buildAllowlistContextBlock,
  pickPrimaryKeywordCandidates,
};
