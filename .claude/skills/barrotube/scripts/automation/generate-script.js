#!/usr/bin/env node

/**
 * generate-script.js — Gemini로 스크립트 자동 생성 (format 분기 지원)
 *
 * v1.1 (2026-04-22): format=shorts(5씬·60s) / format=long-3min(7씬·180s) 듀얼 라인 지원
 *   - brief의 `format` 필드로 분기
 *   - long-3min는 series_id/series_episode 있으면 시리즈 컨텍스트 자동 로드
 *   - style-guide-{format}.md + persona/{persona}.md 함께 컨텍스트에 주입
 *
 * 입력:
 *   - 00_brief.md (topic, channel_id, format, persona, series_id?, series_episode?)
 *   - 10_market_research.md + 20_strategy.md (있으면 대본의 분석 입력으로 우선 주입)
 *   - 05_topic_references.md (선택)
 *   - workspace/channels/{channel}/style-guide-{format}.md
 *   - workspace/channels/{channel}/persona/{persona}.md (있으면)
 *   - workspace/channels/{channel}/series/{series_id}/curriculum.md (long 시리즈)
 *   - workspace/channels/{channel}/series/{series_id}/ep-{N-1}-brief.md (이전 편 리캡)
 *
 * 출력:
 *   - 30_script.md (YAML frontmatter + N씬 narration/image_prompt/bgm_mood/emphasis_tokens)
 *
 * 엔진 (2026-08-13):
 *   기본은 claude → codex → gemini 순으로 시도한다. 앞의 둘은 메인 세션이 쓰는 CLI라
 *   구독으로 돌고, Gemini 는 선불 크레딧이 말라 파이프라인을 세운 전력이 있다.
 *
 * Usage:
 *   node generate-script.js --episode <dir>                   # auto (체인)
 *   node generate-script.js --episode <dir> --engine claude    # 단일 지정 (폴백 없음)
 *   node generate-script.js --episode <dir> --engine codex
 *   node generate-script.js --episode <dir> --engine gemini --model gemini-2.5-flash
 *   BT_SCRIPT_ENGINE_CHAIN=codex,claude node generate-script.js --episode <dir>
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { getSecret } from './config-loader.js';
import {
  resolveFiguresForBrief,
  buildAllowlistContextBlock,
} from './lib/public-figures.js';
import { formatToPlatform } from './paths.js';
import { TEMPLATE, BOUNDS, KNOWN_PALETTES, CANONICAL_TAIL, MASCOT_CLAUSE } from './lib/image-prompt-contract.js';
import { callClaudeCode, callCodex, resolveChain, runEngineChain } from './lib/text-engine.js';
import { buildAnalystContractBlock, validateScript, formatIssue } from './lib/script-quality-contract.js';

const ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * auto 모드의 시도 순서.
 *
 * 메인 세션이 쓰는 CLI(claude·codex)를 먼저 둔다 — 구독으로 도는 경로라
 * 별도 크레딧이 마르지 않고, research-brief.js 도 이미 claude -p 로 돈다.
 * Gemini 는 API 키·선불 크레딧이 필요해 2026-08-13 파이프라인을 세운 전력이 있다.
 */
const ENGINE_CHAIN = resolveChain(process.env.BT_SCRIPT_ENGINE_CHAIN);

const FORMAT_SPECS = {
  'shorts': {
    scene_count: 5,
    target_total_seconds: 60,
    scene_chars_range: '60~90 Korean chars (8~13s TTS)',
    aspect: 'vertical 9:16',
    scene_roles: '001=hook, 002=context, 003=insight, 004=implication, 005=cta',
    mid_hook: false,
    style_guide_filename: 'style-guide-shorts.md',
    voice_tone_note: '긴장·경고 톤 허용 (사실 기반 내에서). "놓치면 손해" 류 Hook OK.',
  },
  'shorts-3min': {
    scene_count: 7,
    target_total_seconds: 172,
    scene_chars_range: '90~180 Korean chars per scene (scene별 15~30s, 전체 약 1000자)',
    aspect: 'vertical 9:16',
    scene_roles: '001=hook(15s), 002=Korea day-one(25s), 003=Korea day-two(27s), 004=mid-hook/global bridge(24s), 005=global cause chain(28s), 006=US watchlist(30s), 007=scenario wrap+CTA(23s)',
    mid_hook: true,
    style_guide_filename: 'style-guide-shorts.md',
    voice_tone_note: '분석적·신뢰 톤. 하루 수치를 나열하지 말고 이틀 수급과 국제 변수의 인과를 설명한다. 공포·확정 예측 금지.',
  },
  'long-3min': {
    scene_count: 7,
    target_total_seconds: 180,
    scene_chars_range: '120~180 Korean chars per scene (scene별 10~40s, 전체 900~1100자)',
    aspect: 'horizontal 16:9',
    scene_roles: '001=hook(15s), 002=intro/recap(15s), 003=definition(35s), 004=data(40s·mid_hook at 75s), 005=insight(35s), 006=implication(30s), 007=wrap+teaser+disclaimer(10s)',
    mid_hook: true,
    style_guide_filename: 'style-guide-long.md',
    voice_tone_note: '친근·신뢰 톤. 공포·경고 금지. 음성 면책 5초 씬 7 필수 ("본 영상은 투자 조언이 아닙니다...").',
  },
};

/**
 * 채널 character-dna.md 의 첫 코드블록에서 마스코트 절을 뽑는다.
 * 그 블록은 이미 generate-image-gemini.js 가 이미지 생성 시 주입하는 SSOT인데,
 * 정작 대본을 쓰는 이 단계에는 전달된 적이 없었다 — 그래서 작가 모델이 캐릭터를
 * 모른 채 "cartoon stick figure" 를 쓰고, 렌더 단계에서 사람이 즉흥으로 메웠다.
 * 프롬프트가 EP마다 갈라진 근본 원인이다.
 */
/**
 * 대본에 넣을 마스코트 절.
 *
 * 이전에는 character-dna.md 첫 코드블록(1001자)을 900자로 잘라 "verbatim 사용"으로 넘겼는데,
 * 그러면 image_prompt 하나가 계약 상한(780자·금지어 1개)을 구조적으로 넘겨 전 컷이 BLOCK 된다.
 * DNA 는 이미지 API prefix 용 정본이고, 대본용 정본은 계약 모듈의 MASCOT_CLAUSE 다.
 * 채널에 DNA 가 없으면 인라인 서술로 폴백한다(기존 동작 유지).
 */
function loadMascotClause(channel) {
  const path = resolve('workspace/channels', channel, 'character-dna.md');
  return existsSync(path) ? MASCOT_CLAUSE : null;
}

/**
 * image_prompt 계약 블록. 수치·템플릿은 lib/image-prompt-contract.js 가 유일한 출처다 —
 * 여기에 숫자를 다시 적으면 검증기와 갈라진다(그래서 예전 "≤25 words" 규칙이 생겼다).
 */
/**
 * 공인 캐리커처 절 (정책 §2·§4). 인물이 씬의 중심 키워드인데 익명 마스코트로만 그리면
 * 시청자가 누구 얘긴지 못 알아본다 — 정책은 2026-04-26 부터 CHARACTERIZE 를 요구했지만
 * 실행 룰이 없어 전 EP 가 마스코트로 나갔다(정책 §0.2 가 스스로 진단한 "정책-실행 갭").
 */
function buildCaricatureBlock() {
  return [
    'RULE C — 공인 캐리커처 (인물이 씬의 중심 키워드일 때만):',
    '- 대상: 외국 정치인·외국 CEO·외국 경제 인사·사망/역사 인물 → 캐리커처로 그린다.',
    '  한국 정치인·한국 CEO·한국 경제 인사·일반인 → 캐리커처 금지, 마스코트만 쓴다.',
    '- 인물 이름이 narration 에 나오기만 해도 되는 게 아니라, 그 씬의 논지가 그 사람의',
    '  발언·결정일 때만 해당한다. 배경 언급이면 마스코트 씬으로 둔다.',
    '- 형식: 마스코트 절과 스테이징 문구는 그대로 두고, BACKGROUND 앞에 한 문장을 덧댄다 —',
    '  "WITH: a flat cartoon caricature of <영문 이름><식별 단서 2~3개>, same line-art style, similar scale."',
    '- 식별 단서는 헤어 실루엣·트레이드마크 의상/색·상징 props 수준까지만. 주름·점 같은',
    '  얼굴 정밀 묘사, photorealistic/photo/digital painting 표현, 뿔·동물화는 금지.',
    '- 캐리커처 컷은 프롬프트 상한이 880자로 완화된다(피사체가 둘이라). 씬 수 상한은',
    '  5씬 포맷 2컷 / 7씬 포맷 3컷이며, 초과하면 검증기가 BLOCK 한다.',
  ].join('\n');
}

function buildImagePromptContractBlock(mascotClause) {
  const identity = mascotClause
    ? `The channel mascot clause you MUST use (verbatim, inside the parentheses form shown):\n${mascotClause}\n`
    : 'The channel has no character DNA on disk — describe the mascot inline and keep it identical across every scene.\n';

  return `
RULE 3-CONTRACT — image_prompt (machine-checked, blocks the pipeline on violation):

TEMPLATE (follow exactly):
${TEMPLATE}

${identity}
1. The mascot MUST be the grammatical SUBJECT of the scene action, in ONE sentence:
   "<mascot clause>, <emotion>, standing before <the single scene object> …".
   Do NOT describe the mascot in a separate sentence ("Masi is the protagonist, 40% of frame").
   Subject position is what makes the model draw it large and centred; a separate
   descriptive sentence makes it a corner sticker. This is the single most important rule.
2. Exactly ONE dominant scene object, described through its relation to the mascot
   (standing before / between / beside / under). Multiple props split the model's attention.
3. NO negative instructions beyond the fixed tail (max ${BOUNDS.maxNegations}). Image models render what you name.
   Write the positive form: not "no tiny corner mascot" but "standing in the centre, face readable".
4. NO frame-percentage ("40% of frame height") and NO camera specs ("24mm", "wide-angle") — both are ignored.
5. NO wardrobe unless the character sheet defines it; leaving it out yields the sheet default.
   At most ${BOUNDS.maxWardrobeScenes} scene per episode may specify wardrobe.
6. Length ${BOUNDS.minChars}~${BOUNDS.maxChars} characters per prompt, ending with the fixed tail.
7. Palette tag from: ${KNOWN_PALETTES.join(' | ')}.
`;
}

function buildSystemPrompt(format, persona, seriesContext, publicFiguresInfo = null, mascotClause = null) {
  const spec = FORMAT_SPECS[format];
  const sceneCount = spec.scene_count;

  const seriesBlock = seriesContext
    ? `\nSERIES CONTEXT:\n- Series: ${seriesContext.series_id} (episode ${seriesContext.series_episode}/${seriesContext.series_total})\n- This episode theme_axis: ${seriesContext.theme_axis}\n- Intro card template: "📚 Barro 경제수업 · ${seriesContext.series_name} [${seriesContext.series_episode}/${seriesContext.series_total}]"\n- Required: 씬 2에 이전 편 리캡 포함 (EP02~). 씬 7에 다음 편 티저 (시리즈 마지막은 다음 시리즈 예고).\n`
    : '';

  const personaBlock = persona
    ? `\nPERSONA: ${persona}\n- 톤 가이드: ${spec.voice_tone_note}\n- persona 상세 규칙은 [PERSONA GUIDE] 블록 참조.\n`
    : '';

  // RULE 14 활성화 여부 판단 (한 번이라도 등록 공인이 감지되면 활성)
  const pfResolved = publicFiguresInfo?.resolved || [];
  const hasCharacterizeFigure = pfResolved.some(r => r.treatment === 'CHARACTERIZE');
  const sceneCap = format === 'shorts' ? 2 : 3;

  return `You are "Writer Agent" of BarroTube, a Korean economy YouTube channel.

FORMAT: ${format}
- Scene count: EXACTLY ${sceneCount} scenes
- Target total duration: ~${spec.target_total_seconds} seconds
- Narration length: ${spec.scene_chars_range}
- Aspect: ${spec.aspect}
- Scene roles (mandatory): ${spec.scene_roles}
${spec.mid_hook ? '- MID-HOOK REQUIRED: 씬 4 마지막 부분 또는 75초 지점에 "재점화 Hook" (이탈 방지 질문/궁금증 유발 1문장) 포함\n' : ''}${seriesBlock}${personaBlock}
RULES:
1. Output MUST be a single JSON object. No markdown, no prose, no code fences.
2. Voice is Yohan Koo (ElevenLabs Korean male) at ~6-7 Korean chars/sec.
3. Image prompts in ENGLISH. They MUST satisfy the image_prompt contract below (RULE 3-CONTRACT). It is machine-checked by validate-image-prompts.js before any image is generated — a violation blocks the pipeline.
${buildImagePromptContractBlock(mascotClause)}
${buildCaricatureBlock()}
4. CRITICAL — narration is TTS input: write every date, number, decimal, percentage, and range as Korean spoken words; never use Arabic digits. Add subtitle_text for every scene with the same meaning, using Arabic number display where useful (예: narration "사십 퍼센트", subtitle_text "40%").
${buildAnalystContractBlock(sceneCount)}
5. BGM moods: tense_intro, calm_explain, dramatic_reveal, hopeful_outro, neutral_bg, upbeat_energy.
6. emphasis_tokens: 1~3 Korean keywords per scene.
7. Target audience: 20~40대 한국 투자자.
8. FORBIDDEN: specific stock buy/sell recommendations, "무조건/100%/확실/이것만 하면 부자", 정치 편향.
9. CRITICAL — narration is FOR TTS ONLY. DO NOT include in narration: emojis (📚 🚨 etc), bracket tags ([1/5]), intro card text, subtitle overlays, or any text that appears as visual-only elements. Those belong to video/subtitle layers — not to spoken audio.
10. CRITICAL — Hook scene (씬 001) MUST include the SINGLE most impactful numeric value from the brief (percentage, count, date, dollar amount). Generic hooks without a specific number fail impact check.
11. CRITICAL — image_prompt MUST NOT contain any text/words/numbers/company-names/labels to be rendered as text in the image. The image model will literally draw any text you mention. Use visual metaphors only:
    - BAD:  "pie chart labeled '80% of market cap' with company names 'Apple, Microsoft, Amazon'"
    - GOOD: "pie chart with one large highlighted wedge, three small anonymous company building icons stacked beside it"
    - BAD:  "stick figure holding sign that says 'WARNING'"
    - GOOD: "stick figure with surprised expression, large exclamation mark floating overhead"
    Use symbolic shapes (arrow up/down for change, stacks of coins for money, chart with wedge for percentage, generic building icon for company) — NEVER text labels.
12. CRITICAL — narration length MUST match target_seconds at ~6.0 Korean chars/sec (TTS speaking rate). For a scene with target_seconds=30, narration MUST be 170~190 Korean chars. Too short leaves silence; too long gets cut off. Compute per scene:
    - target 10s → 55~65자
    - target 15s → 85~95자
    - target 30s → 170~190자
    - target 35s → 200~215자
    - target 40s → 230~245자
    Count Korean characters only (exclude punctuation from the hard limit; you may go ±5 chars for natural flow).
13. CRITICAL — For the FINAL wrap scene with disclaimer (format=long-3min), target_seconds MUST be AT LEAST 20s because the mandatory disclaimer ("본 영상은 투자 조언이 아닙니다. 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다.") alone is ~50 Korean chars (~8s TTS). Redistribute 5~10s from middle scenes (3~6) to the wrap scene when the total would otherwise exceed ${spec.target_total_seconds}s. The sum of all target_seconds MUST still equal ${spec.target_total_seconds}s exactly.
14. CRITICAL — PUBLIC FIGURE CHARACTERIZATION (CEO 정책 v1.0, 2026-04-26 발효, econ-daily 채널 한정):
    Refer to the [PUBLIC FIGURE ALLOWLIST] context block (injected below in user message) for the list of registered figures detected in this EP and their pre-resolved treatment / sensitivity / descriptor_en.
    ${hasCharacterizeFigure
      ? `THIS EPISODE HAS ${pfResolved.filter(r => r.treatment === 'CHARACTERIZE').length} REGISTERED CHARACTERIZE FIGURE(S). Apply RULE 14 sub-rules below.`
      : 'No registered CHARACTERIZE figure detected in this EP — the RULE 3-CONTRACT mascot clause applies as default for ALL scenes. RULE 14 sub-rules (a)~(g) below remain authoritative if any inferred figure surfaces in narration.'}
    Sub-rules:
    (a) For scenes that depict a registered CHARACTERIZE figure, KEEP the RULE 3-CONTRACT mascot clause and staging phrases exactly as they are, and ADD one sentence just before BACKGROUND: — the RULE C form
        "WITH: a flat cartoon caricature of <identifying cues from descriptor_en>, same line-art style, similar scale."
        Do NOT replace the mascot clause. The validator (lib/image-prompt-contract.js) BLOCKs a prompt with no mascot clause (MASCOT_CLAUSE_MISSING) and only recognises a caricature in this WITH: form — replacing it makes the cut unbuildable no matter how many times it is regenerated. (2026-08-27 EP-2026-0118 씬 002 가 정확히 이렇게 막혔다: 이 규칙이 REPLACE 라고 적혀 있어 작성자가 지시대로 교체했고, 게이트가 그걸 위반으로 잡아 재생성이 무한히 실패했다.)
        Example BAD (mascot replaced — validator BLOCKs): "[palette:explainer] a cartoon caricature of an older man with silver-grey hair …, standing before a chart …"
        Example GOOD (mascot kept, caricature added): "[palette:explainer] <MASCOT_CLAUSE>, focused, standing before a single tilted gauge in the centre, face readable, bracing its body while one white mitten hand pulls the lever. WITH: a flat cartoon caricature of an older man with short silver-grey side-parted hair and thin metal-rimmed glasses in a dark navy suit, same line-art style, similar scale. BACKGROUND: …, bold illustrated line art, 9:16 vertical, no readable text or numbers."
    (b) For scenes that do NOT depict any CHARACTERIZE figure, the RULE 3-CONTRACT mascot clause applies unchanged.
    (c) For figures whose resolved treatment is NEUTRAL_MASCOT (외국 연예인, 미승인 한국 인사, 일반인 등), do NOT inject any identification cues — the RULE 3-CONTRACT mascot clause applies unchanged. The allowlist context block marks these explicitly.
    (d) For figures with sensitivity=high (암살·사망·범죄·테러 등 보도): in scenes depicting that figure, EVERY image_prompt and narration MUST avoid 풍자·조롱·코미디 props/표정. Use 무표정 또는 진지(serious) only. NEVER include sight of 사망/부상/피/총상/총알. NEVER include comedy stars, exploding effects, skulls, or animal substitution. (정책 §3.2 high · §4.3 금지표 적용)
    (e) Per-video CHARACTERIZE scene cap: Shorts ≤ 2 scenes, Long-3min ≤ 3 scenes. (sceneCount=${sceneCount}, cap=${sceneCap}). If multiple CHARACTERIZE figures appear, the cap is the SUM (not per figure).
    (f) Image prompts MUST NOT spell out the figure's name in any language (Korean/English/native script). Use only the descriptor — RULE 11 (no text labels) remains authoritative. Narration may reference the figure by Korean display name (display_name_ko) since narration is voiced, not rendered as on-screen text.
    (g) If the allowlist context block marks a figure as BLOCKED (REQUIRES_LEGAL_REVIEW without operator approval), treat that figure as NEUTRAL_MASCOT and DO NOT inject any descriptor — fall back to the RULE 3-CONTRACT mascot clause.
    (h) CRITICAL — image_prompt MUST NOT contain the literal words "photorealistic", "photo-realistic", "photo realistic", "realistic photo", "hyperrealistic", "hyper-realistic", or "lifelike" in ANY context — including negation forms like "not photorealistic" or "no photorealistic rendering". The QA policy §6.2.3 detector matches these keywords by string-presence regardless of negation. Use positive descriptors only ("cartoon caricature", "bold line art", "stylized features", "simplified rounded face", "mascot proportions"). Do NOT explain the absence of realism — assert the cartoon style positively.
        BAD:  "stylized features but not photorealistic, simplified rounded face"
        BAD:  "no photorealistic rendering, no photo-realistic textures"
        GOOD: "stylized exaggerated features, simplified rounded face, mascot proportions, bold flat line art"
${format === 'long-3min' ? '9. REQUIRED: 씬 7 마지막에 음성 면책 멘트 포함 ("본 영상은 투자 조언이 아닙니다. 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다.").\n' : '9. 자막 면책 "투자조언 아님"은 후처리로 자막 레이어에 추가됨 (narration에 넣지 말 것).\n'}
OUTPUT SCHEMA:
{
  "scenes": [
    {
      "scene_id": "001",
      "role": "hook",
      "narration": "...",
      "subtitle_text": "...",
      "image_prompt": "[palette:bearish] <mascot clause>, worried, standing before <one scene object> …. BACKGROUND: …, ${CANONICAL_TAIL}",
      "bgm_mood": "tense_intro",
      "target_seconds": 15,
      "emphasis_tokens": ["...", "..."]
    }
    // ... ${sceneCount} total
  ],
  "angle_summary": "Short (한국어, 1 문장) summary of the episode angle chosen."
}`;
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function parseBriefFrontmatter(brief) {
  const match = brief.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try { return parseYAML(match[1]) || {}; } catch { return {}; }
}

function loadSeriesContext(channel, fm) {
  if (!fm.series_id) return null;
  const seriesDir = resolve('workspace/channels', channel, 'series', fm.series_id);
  const curriculumPath = join(seriesDir, 'curriculum.md');
  if (!existsSync(curriculumPath)) return null;

  const curriculum = readFileSync(curriculumPath, 'utf-8');
  const cFM = parseBriefFrontmatter(curriculum);

  const ctx = {
    series_id: fm.series_id,
    series_episode: fm.series_episode,
    series_total: cFM.total_episodes || fm.series_total,
    series_name: cFM.series_name || fm.series_id,
    theme_axis: fm.theme_axis,
    curriculum_text: curriculum,
  };

  // 이전 편 brief (리캡용)
  if (fm.series_episode && fm.series_episode > 1) {
    const prevN = String(fm.series_episode - 1).padStart(2, '0');
    const prevPath = join(seriesDir, `ep-${prevN}-brief.md`);
    if (existsSync(prevPath)) ctx.previous_brief_text = readFileSync(prevPath, 'utf-8');
  }

  return ctx;
}

async function callGemini(systemPrompt, userPrompt, model = DEFAULT_MODEL, maxOutputTokens = 5000) {
  const key = getSecret('GOOGLE_AI_API_KEY');
  if (!key) throw new Error('GOOGLE_AI_API_KEY not set');
  const url = `${API_BASE}/models/${model}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.7,
      maxOutputTokens,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`No content: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}

async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string' },   // claude | gemini | auto(기본)
      episode: { type: 'string', short: 'e' },
      model: { type: 'string', short: 'm' },
      platform: { type: 'string' },          // long | shorts — 명시 시 platforms/<platform>/00_brief.md 우선 + 출력 platforms/<platform>/30_script.md 강제
      brief: { type: 'string' },             // 명시 시 이 brief 파일을 우선 읽음 (--platform 보다 우선순위 높음)
      force: { type: 'boolean' },            // 기존 30_script.md 덮어쓰기 허용 (default: false → existing 보호)
    },
  });
  if (!values.episode) {
    console.error('Usage: generate-script.js --episode <dir> [--platform long|shorts] [--brief <path>] [--model gemini-2.5-flash] [--force]');
    process.exit(1);
  }

  const epDir = resolve(values.episode);

  // Brief 검색 우선순위:
  //   1) --brief <path> 명시 (운영자가 직접 지정)
  //   2) --platform 명시 시 platforms/<platform>/00_brief.md
  //   3) epDir/00_brief.md (long-form master / legacy v1)
  let briefPath;
  if (values.brief) {
    briefPath = resolve(values.brief);
  } else if (values.platform) {
    const platformBrief = join(epDir, 'platforms', values.platform, '00_brief.md');
    briefPath = existsSync(platformBrief) ? platformBrief : join(epDir, '00_brief.md');
  } else {
    briefPath = join(epDir, '00_brief.md');
  }
  const brief = readIfExists(briefPath);
  const refs = readIfExists(join(epDir, '05_topic_references.md'));
  const research = readIfExists(join(epDir, '10_market_research.md'));
  const strategy = readIfExists(join(epDir, '20_strategy.md'));
  // 기자단 브리핑 원본. 10_market_research.md 는 이걸 요약한 것이라 출처 URL 이 깎여 있다.
  // 대본이 수치를 쓸 때 근거를 직접 보게 하려고 원본도 같이 넣는다.
  // 길면 자른다 — brief+refs 가 길어져 응답이 잘린 전례가 있다 (아래 max_tokens 주석 참조).
  const deskBrief = readIfExists(join(epDir, '05_desk_briefing.md')).slice(0, 6000);

  if (!brief) {
    console.error(`❌ Missing brief: ${briefPath}`);
    process.exit(1);
  }
  console.log(`   Brief source: ${briefPath}`);

  const fm = parseBriefFrontmatter(brief);
  const channel = fm.channel_id || 'econ-daily';
  const episodeId = fm.episode_id || 'EP-UNKNOWN';
  const topic = fm.topic || '';

  // format 분기 — --platform 명시(shorts/long) 우선, 다음 brief.format, 마지막 'shorts' fallback
  const platformOverride = values.platform === 'shorts' ? 'shorts'
                         : values.platform === 'long' ? 'long-3min'
                         : null;
  const format = platformOverride && fm.format && formatToPlatform(fm.format) === values.platform
    ? fm.format
    : (platformOverride || fm.format || 'shorts');
  if (!FORMAT_SPECS[format]) {
    console.error(`❌ Unknown format: ${format}. Supported: ${Object.keys(FORMAT_SPECS).join(', ')}`);
    process.exit(1);
  }
  // brief.format과 --platform이 충돌하면 경고 (브리프를 신뢰할 수 없는 경우 방어선)
  if (platformOverride && fm.format && formatToPlatform(fm.format) !== values.platform) {
    console.warn(`⚠️  --platform=${values.platform} (format=${platformOverride}) overrides brief.format=${fm.format}`);
  }
  const spec = FORMAT_SPECS[format];

  const persona = fm.persona || (format === 'long-3min' ? 'barro-teacher' : 'barro-alert');

  // Style guide 분기
  const styleGuidePath = resolve('workspace/channels', channel, spec.style_guide_filename);
  let styleGuide = readIfExists(styleGuidePath);
  if (!styleGuide) {
    // fallback: 옛 style-guide.md (호환성)
    styleGuide = readIfExists(resolve('workspace/channels', channel, 'style-guide.md'));
    if (styleGuide) {
      console.warn(`⚠️  Falling back to style-guide.md (recommend: create ${spec.style_guide_filename})`);
    }
  }

  // Persona guide
  const personaGuide = readIfExists(resolve('workspace/channels', channel, 'persona', `${persona}.md`));

  // Brand (공통)
  const brand = readIfExists(resolve('workspace/channels', channel, 'brand.md'));

  // Series 컨텍스트 (long-3min 시리즈만)
  const seriesContext = format === 'long-3min' ? loadSeriesContext(channel, fm) : null;

  // Public Figures 결정 (CEO 정책 v1.0, 2026-04-26)
  // brief.public_figures + topic 텍스트 fallback 자동 감지
  const publicFiguresInfo = resolveFiguresForBrief(channel, fm, topic);

  console.log(`🎬 Generating script for ${episodeId}`);
  console.log(`   Format: ${format} (${spec.scene_count} scenes, ${spec.target_total_seconds}s)`);
  console.log(`   Persona: ${persona}`);
  console.log(`   Channel: ${channel}`);
  console.log(`   Topic: ${topic}`);
  if (seriesContext) {
    console.log(`   Series: ${seriesContext.series_id} [${seriesContext.series_episode}/${seriesContext.series_total}] theme=${seriesContext.theme_axis}`);
  }
  if (publicFiguresInfo.resolved.length) {
    const summary = publicFiguresInfo.resolved
      .map(r => `${r.figure.display_name_ko}(${r.treatment}/${r.sensitivity}${r.blockReason ? ',BLOCKED' : ''})`)
      .join(', ');
    console.log(`   Public Figures: ${summary}`);
  }
  console.log(`   Model: ${values.model || DEFAULT_MODEL}`);

  const mascotClause = loadMascotClause(channel);
  console.log(`   Mascot DNA: ${mascotClause ? `주입됨 (${mascotClause.length}자)` : '없음 — 인라인 서술 지시'}`);

  const systemPrompt = buildSystemPrompt(format, persona, seriesContext, publicFiguresInfo, mascotClause);

  const userPromptParts = [
    `[EPISODE BRIEF]`,
    brief,
    '',
  ];
  if (research) userPromptParts.push(`[MARKET RESEARCH]`, research, '');
  if (strategy) userPromptParts.push(`[CONTENT STRATEGY]`, strategy, '');
  if (deskBrief) userPromptParts.push(`[DESK BRIEFING — 기자단 원본 근거·출처]`, deskBrief, '');
  if (refs) userPromptParts.push(`[NEWS REFERENCES]`, refs, '');
  if (brand) userPromptParts.push(`[CHANNEL BRAND]`, brand, '');
  if (styleGuide) userPromptParts.push(`[STYLE GUIDE: ${spec.style_guide_filename}]`, styleGuide, '');
  if (personaGuide) userPromptParts.push(`[PERSONA GUIDE: ${persona}]`, personaGuide, '');
  if (seriesContext?.curriculum_text) userPromptParts.push(`[SERIES CURRICULUM]`, seriesContext.curriculum_text, '');
  if (seriesContext?.previous_brief_text) userPromptParts.push(`[PREVIOUS EPISODE BRIEF (for recap)]`, seriesContext.previous_brief_text, '');

  // [PUBLIC FIGURE ALLOWLIST] — RULE 14 컨텍스트 (항상 주입; 등록 인물 없을 때도 short summary)
  userPromptParts.push(
    buildAllowlistContextBlock(publicFiguresInfo.allowlist, publicFiguresInfo.resolved),
    '',
  );

  userPromptParts.push(
    `[TASK]`,
    `위 브리프·시장 리서치·콘텐츠 전략·뉴스·채널 가이드·페르소나 규칙을 바탕으로 ${spec.scene_count}씬 ${spec.target_total_seconds}초 ${format} 스크립트를 JSON으로 작성하라.`,
    format === 'long-3min'
      ? `- 시리즈 컨텍스트 준수: 씬 2에 이전 편 리캡 (EP01 제외), 씬 7에 다음 편 티저 + 음성 면책.`
      : `- 뉴스 레퍼런스 중 가장 관련성 높은 것을 훅(hook)으로 활용하되, 운영자 의도(주제)가 우선.`,
    `- 페르소나 금기 표현 준수. 페르소나 위반은 품질 저하로 판정됨.`,
    `- 팩트 기반, 수치는 구어체.`,
    `- 특정 종목 매수 추천 X.`,
  );

  const userPrompt = userPromptParts.join('\n');
  // Long-form is ~3x content of shorts — needs much larger token budget.
  // Shorts 5000 → 8000 (2026-05-14): 시사·해설 EP에서 길어진 brief+refs로 응답이 잘리는 사례
  // (EP-2026-0050) 대응. 일반 shorts는 보통 1.5~2k token 출력이라 비용 영향 없음.
  const maxTokens = format.endsWith('3min') ? 12000 : 8000;
  const requested = values.engine || process.env.BT_SCRIPT_ENGINE || 'auto';
  const chain = requested === 'auto' ? ENGINE_CHAIN : [requested];

  // 엔진 러너는 lib/text-engine.js 의 runEngineChain 이 순서대로 시도한다.
  const buildRunners = (prompt) => ({
    claude: () => ({ json: callClaudeCode(systemPrompt, prompt, values.model || 'sonnet'), used: 'claude-code' }),
    codex:  () => ({ json: callCodex(systemPrompt, prompt, values.model || null), used: 'codex' }),
    gemini: async () => ({ json: await callGemini(systemPrompt, prompt, values.model, maxTokens),
                           used: values.model || DEFAULT_MODEL }),
  });

  /**
   * 품질 계약 위반은 한 번만 되돌려 준다.
   *
   * 두 번째도 실패하면 위반을 frontmatter 에 남기고 진행한다 — 주관이 섞인 지표로
   * 매일 도는 파이프라인을 멈춰 세우면, 다음 사람이 게이트를 끄는 쪽을 택하게 된다.
   * 남은 위반은 Board 승인 화면에서 사람이 본다.
   */
  let parsed, engineUsed, scenes, qualityIssues = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? userPrompt
      : [userPrompt, '', '## 재작성 지시 — 직전 응답이 RULE 4-CONTRACT 를 위반했다',
         ...qualityIssues.map((i) => `- ${i.message}\n  → ${i.suggestion}`), '',
         '지적된 것만 고치고 나머지 계약(씬 수·target_seconds 합·image_prompt·TTS 한글 수사)은 그대로 지켜라.',
         '수치를 덜어낸 자리는 비우지 말고, 오늘 이 뉴스에서만 할 수 있는 인과·함의로 채워라. 분량은 유지한다.',
        ].join('\n');

    const got = await runEngineChain(chain, buildRunners(prompt));
    engineUsed = got.engineUsed;

    try {
      parsed = JSON.parse(got.json);
    } catch {
      console.error('❌ JSON 파싱 실패');
      console.error(got.json.slice(0, 500));
      process.exit(1);
    }

    scenes = parsed.scenes;
    if (!Array.isArray(scenes) || scenes.length !== spec.scene_count) {
      console.error(`❌ 씬 수 불일치: 기대 ${spec.scene_count}씬, 실제 ${scenes?.length || 0}씬`);
      process.exit(1);
    }

    qualityIssues = validateScript(scenes);
    qualityIssues.forEach((i) => console.error(`   ${formatIssue(i)}`));
    if (!qualityIssues.some((i) => i.severity === 'error')) break;

    if (attempt === 2) {
      console.warn('   ⚠ 재작성 후에도 품질 계약 위반이 남았다 — frontmatter 에 기록하고 진행한다');
      break;
    }
    console.warn('   ↻ 품질 계약 위반 — 위반 목록을 붙여 한 번 재작성한다');
  }

  const total = scenes.reduce((a, s) => a + (s.target_seconds || (spec.target_total_seconds / spec.scene_count)), 0);

  // Frontmatter 조립
  const outFM = {
    episode_id: episodeId,
    channel_id: channel,
    format,
    persona,
    target_total_seconds: total,
    language: 'ko',
    writer: `writer-agent (${engineUsed})`,
    created_at: new Date().toISOString(),
    revision: 1,
  };
  if (fm.series_id) {
    outFM.series_id = fm.series_id;
    outFM.series_episode = fm.series_episode;
    if (fm.series_total) outFM.series_total = fm.series_total;
  }
  if (fm.parent_episode_id) outFM.parent_episode_id = fm.parent_episode_id;
  // 남은 위반은 숨기지 않는다 — Board 승인 화면과 사후 추적이 이 필드를 본다.
  if (qualityIssues.length) {
    outFM.quality_issues = qualityIssues.map((i) => `${i.severity}: ${i.rule} ${i.message}`);
  }
  outFM.scenes = scenes;

  const scriptBody = [
    '---',
    stringifyYAML(outFM).trim(),
    '---',
    '',
    `# ${episodeId} Script (auto-generated, format=${format})`,
    '',
    `## 주제`,
    topic,
    '',
    `## 앵글`,
    parsed.angle_summary || '(no summary)',
    '',
    refs ? `## 레퍼런스\n05_topic_references.md 참조\n` : '',
  ].join('\n');

  // v2 layout: episodeDir/platforms/{platform}/30_script.md (platforms/ 디렉토리가 이미 있으면 v2)
  // v1 layout: episodeDir/30_script.md (legacy)
  const platform = format === 'long-3min' ? 'long' : 'shorts';
  const v2BaseDir = join(epDir, 'platforms', platform);
  const isV2 = existsSync(join(epDir, 'platforms'));
  const outDir = isV2 ? v2BaseDir : epDir;
  if (isV2) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outDir, { recursive: true });
  }
  const outPath = join(outDir, '30_script.md');

  // Overwrite guard (2026-05-09): 기존 파일이 다른 format일 때 silent clobber 방지.
  // 기존 30_script.md가 있고, 그 frontmatter format이 이번 호출 format과 다르면 --force 없이는 거부.
  if (existsSync(outPath) && !values.force) {
    const existing = readFileSync(outPath, 'utf-8');
    const existingFmMatch = existing.match(/^---\n([\s\S]*?)\n---/);
    if (existingFmMatch) {
      try {
        const existingFm = parseYAML(existingFmMatch[1]) || {};
        if (existingFm.format && existingFm.format !== format) {
          console.error(`❌ Refuse to overwrite ${outPath}`);
          console.error(`   existing format=${existingFm.format} (revision=${existingFm.revision || '?'})`);
          console.error(`   incoming format=${format}`);
          console.error(`   Pass --force to overwrite, or use --platform/--brief to target the correct platforms/<platform>/00_brief.md`);
          process.exit(1);
        }
      } catch { /* malformed frontmatter — fall through to write */ }
    }
  }

  writeFileSync(outPath, scriptBody, 'utf-8');

  console.log(`✅ Script saved: ${outPath}`);
  console.log(`   Scenes: ${scenes.length}, total target: ${total}s (spec ${spec.target_total_seconds}s)`);
  console.log(`   Angle: ${parsed.angle_summary || '-'}`);
  scenes.forEach(s => {
    const chars = s.narration?.length || 0;
    console.log(`   [${s.scene_id}/${s.role}] ${s.target_seconds}s · ${chars}자 · "${s.narration?.slice(0, 40) || ''}..."`);
  });
}

// CLI 로 직접 실행할 때만 돈다.
// 가드가 없으면 이 파일을 import 하는 순간 main() 이 돌아 usage 를 뱉고 죽는다
// (2026-08-13: 테스트가 isExhausted 를 import 하다 발견).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}
