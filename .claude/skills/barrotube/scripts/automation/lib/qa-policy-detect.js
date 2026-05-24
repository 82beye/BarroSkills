/**
 * qa-policy-detect.js — Public Figure 정책 §6.2 자동 검출 헬퍼 (CEO v1.0, 2026-04-26)
 *
 * generate-qa-report.js에서 호출. brief frontmatter + 30_script.md frontmatter +
 * 70_publish_meta.json (있으면)을 입력받아 5개 정책 BLOCK/WARN을 정량 검출한다.
 *
 * 정책 §6.2 5개 검사:
 *   1. 카테고리 정합 (CHARACTERIZE 인물이 NEUTRAL_MASCOT으로 표현되거나 그 반대)
 *   2. Sensitivity 표현 (sensitivity=high인 씬에 풍자·조롱 키워드)
 *   3. Photorealistic 금지 (모든 image_prompt에 photorealistic류 키워드)
 *   4. 씬 수 상한 (Shorts ≤2 / Long ≤3 캐리커처 씬)
 *   5. 색채 팔레트 정합 (정성 — sensitivity=high에서 Alert Red 사용 검출)
 *
 * 산출:
 *   {
 *     blocks: [{ section, code, message, scene_id?, severity: 'BLOCK' }],
 *     warns:  [{ section, code, message, scene_id?, severity: 'WARN' }],
 *     overrideApplied: boolean,
 *     overrideMeta: { section, reason, approved_by, approved_at } | null,
 *     summary: { total_blocks, total_warns, scene_count, characterize_scene_count }
 *   }
 *
 * BLOCK이 1개라도 있고 policy_override가 없으면 QA Reviewer는 risk:HIGH로 전체 verdict
 * 분류 → S10 차단 (approve-episode.js).
 */

import { resolveFiguresForBrief } from './public-figures.js';

/** sensitivity high에서 절대 금지인 표현 (정책 §3.2 / §4.3) */
const HIGH_SENSITIVITY_FORBIDDEN_PATTERNS = [
  // 풍자·조롱·코미디 표정/액션
  /\bsmiling\b/i,
  /\bsmile\b/i,
  /\bfriendly\b/i,
  /\bconfident\b/i,
  /\bhappy\b/i,
  /\bjoyful\b/i,
  /\bcheerful\b/i,
  /\bexcited\b/i,
  /\bcelebrat(?:ory|ing|e)\b/i,
  /\bmocking\b/i,
  /\btease/i,
  /\bteasing\b/i,
  /\bwink(?:ing)?\b/i,
  /\bgrin(?:ning)?\b/i,
  /\blaugh(?:ing)?\b/i,
  /\bcomedy\b/i,
  /\bcomedic\b/i,
  /\bcartoon-comedy\b/i,
  /\bcomedy props\b/i,
  // 사망·부상·총상·피
  /\bbloodied?\b/i,
  /\bbleeding\b/i,
  /\bgunshot\b/i,
  /\bbullet\b/i,
  /\bwounded?\b/i,
  /\binjur(?:ed|y)\b/i,
  /\bdead\b/i,
  /\bcorpse\b/i,
  /\bskull\b/i,
  /\bexploding\b/i,
  /\bexplosion\b/i,
  /\bhalo of stars\b/i, // 만화 코미디 별
];

/** 모든 sensitivity에서 금지 — photorealistic류 (정책 §4.2) */
const PHOTOREALISTIC_PATTERNS = [
  /\bphotorealistic\b/i,
  /\bphoto-realistic\b/i,
  /\brealistic photo\b/i,
  /\bhyper-?realistic\b/i,
  /\b8k\b/i,
  /\b4k\b/i,
  /\bdslr\b/i,
  /\baI photo-?likeness\b/i,
  /\bdeepfake\b/i,
  /\bface[- ]swap\b/i,
];

/** 채널 trademark color (정책 §4.4) — sensitivity=high에서 사용 비권장 */
const TRADEMARK_HIGH_SENSITIVITY_PATTERNS = [
  /#E63946/i,                 // Alert Red
  /\balert red\b/i,
  /\bsaturated red tie\b/i,    // 트럼프 빨간 넥타이 등
  /\bbright red\b/i,
];

const FORMAT_SCENE_CAPS = {
  shorts: 2,
  'long-3min': 3,
};

/**
 * 한 씬이 실제로 캐리커처로 렌더링되는지 판정.
 *
 * 정책 §6.2 검출은 "prompt 텍스트가 실제로 어떻게 렌더되는지"를 본다.
 * scene.character_override 필드가 있어도 (a) allowlist 미등록 또는 (b) NEUTRAL_MASCOT 카테고리이면
 * generate-image-gemini.js가 이를 무시 → 실제 이미지는 stick figure로 렌더링됨.
 *
 * 따라서 정확한 판정은 image_prompt 텍스트를 우선:
 *   - "cartoon caricature" 키워드가 있거나
 *   - 해석된 CHARACTERIZE 인물 descriptor의 fingerprint 키워드(descriptor_short 일부)가 있으면 True
 *   - character_override 필드만 있고 prompt에 caricature 흔적이 없으면 False
 *     (character_override가 무시된 케이스 — fixture 02 같은 NEUTRAL_MASCOT)
 */
function isCharacterizeScene(scene, charDescriptors) {
  const prompt = String(scene?.image_prompt || '');
  // 가장 확실한 신호: prompt에 'cartoon caricature' 명시
  if (/cartoon caricature\b/i.test(prompt)) return true;
  // descriptor_short 키워드 매칭 (heuristic)
  for (const d of charDescriptors) {
    if (!d) continue;
    const fp = d.toLowerCase().slice(0, Math.min(20, d.length));
    if (fp && prompt.toLowerCase().includes(fp)) return true;
  }
  return false;
}

/**
 * 정책 §6.2 자동 검출. 입력은 모두 이미 파싱된 객체.
 *
 * @param {object} args
 *   - briefFM: brief frontmatter object
 *   - scriptFM: 30_script.md frontmatter object (scenes 포함)
 *   - channel: 채널 id
 *   - format: 'shorts' | 'long-3min'
 *   - topicText: topic + hook narration (인물 자동 감지용)
 *   - meta: 70_publish_meta.json object (있으면, sensitivity 형용사 검사용 — 미사용 가능)
 */
export function detectPolicyViolations({
  briefFM = {},
  scriptFM = {},
  channel = 'econ-daily',
  format = 'long-3min',
  topicText = '',
  meta = null,
}) {
  const blocks = [];
  const warns = [];

  const sceneCap = FORMAT_SCENE_CAPS[format] ?? 3;
  const scenes = Array.isArray(scriptFM.scenes) ? scriptFM.scenes : [];

  // Public-figure 결정 묶음 (brief.public_figures + topic fallback)
  const pf = resolveFiguresForBrief(channel, briefFM, topicText);
  const charactersResolved = pf.resolved;

  // 등록 인물 descriptor heuristic — 씬 캐리커처 검출용
  const characterizeDescriptorShorts = charactersResolved
    .filter(r => r.treatment === 'CHARACTERIZE' && !r.blockReason)
    .map(r => r.figure?.descriptor_short || '')
    .filter(Boolean);

  // 1. 카테고리 정합 체크 (정책 §6.2.1)
  //    - REQUIRES_LEGAL_REVIEW + 운영자 승인 누락 → BLOCK (이미 public-figures.js가 blockReason 채움)
  //    - NEUTRAL_MASCOT 카테고리에 식별 단서 주입 → BLOCK (heuristic)
  //    - CHARACTERIZE 카테고리인데 모든 씬이 stick figure (식별 단서 0개) → BLOCK
  for (const r of charactersResolved) {
    if (r.blockReason) {
      blocks.push({
        section: '§2.2 / §5',
        code: 'CATEGORY_BLOCKED_LEGAL_REVIEW',
        message: `Public-figure "${r.figure.display_name_ko}" 카테고리=${r.figure.category} → 운영자 승인 토큰(legal_review_approved_by) 누락. 정책 §2.2 / §5.2 위반. blockReason: ${r.blockReason}`,
        severity: 'BLOCK',
      });
    }
  }

  // CHARACTERIZE 인물이 brief에 명시되었는데 캐리커처 씬이 0개면 정책-실행 갭 (EP-0027 인시던트 재현)
  const characterizeFigures = charactersResolved.filter(
    r => r.treatment === 'CHARACTERIZE' && !r.blockReason,
  );
  let characterizeSceneCount = 0;
  for (const sc of scenes) {
    if (isCharacterizeScene(sc, characterizeDescriptorShorts)) characterizeSceneCount++;
  }
  if (characterizeFigures.length > 0 && characterizeSceneCount === 0) {
    blocks.push({
      section: '§2 / §6.2.1',
      code: 'CATEGORY_MISMATCH_NO_CARICATURE',
      message: `Brief에 ${characterizeFigures.length}명 CHARACTERIZE 인물(${characterizeFigures.map(r => r.figure.display_name_ko).join(', ')}) 명시되었으나 ${scenes.length}씬 모두 stick figure 마스코트 — 식별 단서 부재. 정책 §2 위반 (EP-0027 인시던트 패턴).`,
      severity: 'BLOCK',
    });
  }

  // NEUTRAL_MASCOT 카테고리인데 image_prompt에 인물 식별 단서가 명시적으로 들어간 경우
  for (const r of charactersResolved) {
    if (r.treatment !== 'NEUTRAL_MASCOT') continue;
    const fig = r.figure;
    if (!fig) continue;
    const cues = [
      ...(fig.trademark_cues || []),
      fig.descriptor_short || '',
    ].filter(Boolean);
    for (const sc of scenes) {
      const prompt = String(sc?.image_prompt || '').toLowerCase();
      for (const cue of cues) {
        const cueLow = String(cue).toLowerCase().slice(0, Math.min(20, cue.length));
        if (cueLow && prompt.includes(cueLow)) {
          blocks.push({
            section: '§6.2.1',
            code: 'NEUTRAL_MASCOT_CUE_LEAK',
            message: `Scene ${sc.scene_id}: NEUTRAL_MASCOT 카테고리("${fig.display_name_ko}")인데 image_prompt에 식별 단서 "${cue}"가 포함됨. 정책 §6.2.1 위반.`,
            scene_id: sc.scene_id,
            severity: 'BLOCK',
          });
          break;
        }
      }
    }
  }

  // 2. Sensitivity 표현 체크 (정책 §6.2.2)
  // sensitivity=high인 씬에 조롱·코미디·부상 키워드
  const briefSensitivity = String(briefFM.sensitivity || 'low').toLowerCase();
  for (const sc of scenes) {
    // 씬 단위 sensitivity 추론 — character_override가 있으면 해당 인물의 resolved sensitivity,
    // 없으면 brief sensitivity, max 적용
    let sceneSens = briefSensitivity;
    if (sc.character_override) {
      const figRes = charactersResolved.find(r => r.figure?.id === sc.character_override);
      if (figRes) {
        const ladder = ['low', 'medium', 'high'];
        const a = ladder.indexOf(sceneSens);
        const b = ladder.indexOf(figRes.sensitivity || 'low');
        sceneSens = ladder[Math.max(a >= 0 ? a : 0, b >= 0 ? b : 0)];
      }
    }
    if (sceneSens !== 'high') continue;
    if (!isCharacterizeScene(sc, characterizeDescriptorShorts)) continue;
    const prompt = String(sc.image_prompt || '');
    for (const re of HIGH_SENSITIVITY_FORBIDDEN_PATTERNS) {
      if (re.test(prompt)) {
        blocks.push({
          section: '§3.2 / §6.2.2',
          code: 'HIGH_SENSITIVITY_FORBIDDEN_TONE',
          message: `Scene ${sc.scene_id}: sensitivity=high 캐리커처 씬에 금지 표현 "${re.source}" 검출. 풍자·조롱·코미디 props·표정 절대 금지 (정책 §3.2 high). prompt 발췌: "${prompt.slice(0, 120)}..."`,
          scene_id: sc.scene_id,
          severity: 'BLOCK',
        });
        break;
      }
    }
  }

  // 3. Photorealistic 금지 (정책 §4.2 / §6.2.3) — 모든 sensitivity에 무조건 적용
  for (const sc of scenes) {
    const prompt = String(sc.image_prompt || '');
    for (const re of PHOTOREALISTIC_PATTERNS) {
      if (re.test(prompt)) {
        blocks.push({
          section: '§4.2 / §6.2.3',
          code: 'PHOTOREALISTIC_FORBIDDEN',
          message: `Scene ${sc.scene_id}: photorealistic류 표현 "${re.source}" 검출. 정책 §4.2 위반 — cartoon caricature only. prompt 발췌: "${prompt.slice(0, 120)}..."`,
          scene_id: sc.scene_id,
          severity: 'BLOCK',
        });
        break;
      }
    }
  }

  // 4. 씬 수 상한 (정책 §5.1 / §6.2.4)
  const overrideSceneCap = briefFM.caricature_scene_limit_override === true;
  if (characterizeSceneCount > sceneCap && !overrideSceneCap) {
    blocks.push({
      section: '§5.1 / §6.2.4',
      code: 'SCENE_CAP_EXCEEDED',
      message: `캐리커처 씬 수 ${characterizeSceneCount}씬 > 상한 ${sceneCap}씬 (format=${format}). 정책 §5.1 위반. 운영자 승인은 brief.caricature_scene_limit_override=true 토큰으로 우회 가능.`,
      severity: 'BLOCK',
    });
  } else if (characterizeSceneCount > sceneCap && overrideSceneCap) {
    warns.push({
      section: '§5.1',
      code: 'SCENE_CAP_OVERRIDE',
      message: `캐리커처 씬 수 ${characterizeSceneCount}씬 > 상한 ${sceneCap}씬이지만 brief.caricature_scene_limit_override=true 운영자 승인 → 통과.`,
      severity: 'WARN',
    });
  }

  // 5. 색채 팔레트 정합 (정책 §4.4 / §6.2.5) — 정성 체크: sensitivity=high에서 Alert Red 사용 검출
  for (const sc of scenes) {
    let sceneSens = briefSensitivity;
    if (sc.character_override) {
      const figRes = charactersResolved.find(r => r.figure?.id === sc.character_override);
      if (figRes) {
        const ladder = ['low', 'medium', 'high'];
        const a = ladder.indexOf(sceneSens);
        const b = ladder.indexOf(figRes.sensitivity || 'low');
        sceneSens = ladder[Math.max(a >= 0 ? a : 0, b >= 0 ? b : 0)];
      }
    }
    if (sceneSens !== 'high') continue;
    if (!isCharacterizeScene(sc, characterizeDescriptorShorts)) continue;
    const prompt = String(sc.image_prompt || '');
    for (const re of TRADEMARK_HIGH_SENSITIVITY_PATTERNS) {
      if (re.test(prompt)) {
        warns.push({
          section: '§4.4 / §6.2.5',
          code: 'TRADEMARK_COLOR_HIGH_SENSITIVITY',
          message: `Scene ${sc.scene_id}: sensitivity=high에서 트레이드마크 saturated 색상 ("${re.source}") 사용. neutral 톤(charcoal navy/muted slate)으로 다운톤 권장 (정책 §4.4).`,
          scene_id: sc.scene_id,
          severity: 'WARN',
        });
        break;
      }
    }
  }

  // policy_override 처리 (정책 §6.5)
  // brief frontmatter의 policy_override 토큰이 있으면 해당 section의 BLOCK들이 WARN으로 다운그레이드됨.
  // 1) 토큰이 객체 형태이고 section/reason/approved_by/approved_at 모두 있으면 partial override
  // 2) 토큰의 section이 "*" 또는 "ALL"이면 전체 BLOCK → WARN
  let overrideMeta = null;
  let overrideApplied = false;
  const ovRaw = briefFM.policy_override;
  const ovValid =
    ovRaw &&
    typeof ovRaw === 'object' &&
    ovRaw.section &&
    ovRaw.reason &&
    ovRaw.approved_by &&
    ovRaw.approved_at;
  if (ovValid) {
    overrideMeta = {
      section: String(ovRaw.section),
      reason: String(ovRaw.reason),
      approved_by: String(ovRaw.approved_by),
      approved_at: String(ovRaw.approved_at),
    };
    const targetSection = overrideMeta.section.toLowerCase();
    const isAll = targetSection === '*' || targetSection === 'all';
    const stillBlock = [];
    for (const b of blocks) {
      const matchesSection =
        isAll ||
        String(b.section).toLowerCase().includes(targetSection.replace(/^§/, ''));
      if (matchesSection) {
        warns.push({
          ...b,
          severity: 'WARN',
          code: `${b.code}_OVERRIDDEN`,
          message: `[POLICY OVERRIDE: ${overrideMeta.section} by ${overrideMeta.approved_by}] ${b.message} — 운영자 승인으로 다운그레이드.`,
        });
        overrideApplied = true;
      } else {
        stillBlock.push(b);
      }
    }
    blocks.length = 0;
    blocks.push(...stillBlock);
  }

  return {
    blocks,
    warns,
    overrideApplied,
    overrideMeta,
    summary: {
      total_blocks: blocks.length,
      total_warns: warns.length,
      scene_count: scenes.length,
      characterize_scene_count: characterizeSceneCount,
      registered_figures: charactersResolved.map(r => ({
        id: r.figure?.id,
        display_name_ko: r.figure?.display_name_ko,
        treatment: r.treatment,
        sensitivity: r.sensitivity,
        blocked: !!r.blockReason,
      })),
    },
  };
}

/**
 * 검출 결과를 사람이 읽을 수 있는 markdown 섹션으로 포맷.
 * generate-qa-report.js가 60_qa_report.md에 추가.
 */
export function formatPolicySection(result) {
  const lines = [];
  lines.push('## Public Figure Policy Checks (CEO 정책 v1.0, 2026-04-26)');
  lines.push('');
  lines.push(`- 검출 BLOCK: ${result.summary.total_blocks}건`);
  lines.push(`- 검출 WARN: ${result.summary.total_warns}건`);
  lines.push(`- 캐리커처 씬: ${result.summary.characterize_scene_count}/${result.summary.scene_count}`);
  if (result.summary.registered_figures.length) {
    lines.push('');
    lines.push('등록 인물:');
    for (const f of result.summary.registered_figures) {
      lines.push(`  - ${f.display_name_ko} (id=${f.id}) treatment=${f.treatment} sensitivity=${f.sensitivity}${f.blocked ? ' [BLOCKED]' : ''}`);
    }
  }
  if (result.overrideApplied) {
    lines.push('');
    lines.push(`> ⚠ POLICY OVERRIDE applied: section=${result.overrideMeta.section} approved_by=${result.overrideMeta.approved_by} at=${result.overrideMeta.approved_at}`);
    lines.push(`> reason: ${result.overrideMeta.reason}`);
  }
  lines.push('');

  if (result.blocks.length) {
    lines.push('### BLOCK (S10 차단)');
    lines.push('| Section | Code | Scene | Message |');
    lines.push('|---|---|---|---|');
    for (const b of result.blocks) {
      lines.push(`| ${b.section} | ${b.code} | ${b.scene_id || '-'} | ${b.message.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  if (result.warns.length) {
    lines.push('### WARN (운영자 확인)');
    lines.push('| Section | Code | Scene | Message |');
    lines.push('|---|---|---|---|');
    for (const w of result.warns) {
      lines.push(`| ${w.section} | ${w.code} | ${w.scene_id || '-'} | ${w.message.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  if (!result.blocks.length && !result.warns.length) {
    lines.push('정책 위반 없음 (5개 검사 모두 통과).');
  }
  return lines.join('\n');
}

export default { detectPolicyViolations, formatPolicySection };
