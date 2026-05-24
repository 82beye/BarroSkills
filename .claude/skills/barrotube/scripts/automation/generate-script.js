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
 *   - 05_topic_references.md (선택)
 *   - workspace/channels/{channel}/style-guide-{format}.md
 *   - workspace/channels/{channel}/persona/{persona}.md (있으면)
 *   - workspace/channels/{channel}/series/{series_id}/curriculum.md (long 시리즈)
 *   - workspace/channels/{channel}/series/{series_id}/ep-{N-1}-brief.md (이전 편 리캡)
 *
 * 출력:
 *   - 30_script.md (YAML frontmatter + N씬 narration/image_prompt/bgm_mood/emphasis_tokens)
 *
 * Usage:
 *   node generate-script.js --episode <dir>
 *   node generate-script.js --episode <dir> --model gemini-2.5-flash
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

const DEFAULT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

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

function buildSystemPrompt(format, persona, seriesContext, publicFiguresInfo = null) {
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
3. Image prompts in ENGLISH. Pattern MUST match proven format: "${spec.aspect}, cartoon stick figure [action verb-ing], [1-2 simple symbolic props], bold line art". Keep to 1 short sentence (≤25 words). FORBIDDEN words in image_prompt: "friendly", "smiling", "confident", "happy", "excited", "attentive", "suit", "tie", "shirt", "hair", "teacher", "businessman" — these bias the model toward detailed characters. Use ACTION VERBS only: "pointing at", "holding", "standing beside", "balancing", "running toward", "watching", "confused between", "raising". Example GOOD: "horizontal 16:9, cartoon stick figure pointing at pie chart with one large orange wedge, small stack of coins below, bold line art". Example BAD: "a friendly stick figure teacher with confident smile holding a pie chart".
4. Korean numbers as Korean words (예: "사십 퍼센트" not "40%").
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
      : 'No registered CHARACTERIZE figure detected in this EP — RULE 3 (cartoon stick figure) applies as default for ALL scenes. RULE 14 sub-rules (a)~(g) below remain authoritative if any inferred figure surfaces in narration.'}
    Sub-rules:
    (a) For scenes that depict a registered CHARACTERIZE figure, REPLACE the "cartoon stick figure" phrase from RULE 3 with the figure's descriptor_en (caricature descriptor) listed in the allowlist context block. Keep the rest of RULE 3 intact (aspect prefix, action verbs, props, "bold line art").
        Example BAD (RULE 3 only): "horizontal 16:9, cartoon stick figure pointing at upward arrow chart, bold line art".
        Example GOOD (descriptor injected): "horizontal 16:9, cartoon caricature of an orange-haired man in dark navy suit and red tie pointing at upward arrow chart, bold line art".
    (b) For scenes that do NOT depict any CHARACTERIZE figure, RULE 3 applies unchanged ("cartoon stick figure").
    (c) For figures whose resolved treatment is NEUTRAL_MASCOT (외국 연예인, 미승인 한국 인사, 일반인 등), do NOT inject any identification cues — RULE 3 applies unchanged. The allowlist context block marks these explicitly.
    (d) For figures with sensitivity=high (암살·사망·범죄·테러 등 보도): in scenes depicting that figure, EVERY image_prompt and narration MUST avoid 풍자·조롱·코미디 props/표정. Use 무표정 또는 진지(serious) only. NEVER include sight of 사망/부상/피/총상/총알. NEVER include comedy stars, exploding effects, skulls, or animal substitution. (정책 §3.2 high · §4.3 금지표 적용)
    (e) Per-video CHARACTERIZE scene cap: Shorts ≤ 2 scenes, Long-3min ≤ 3 scenes. (sceneCount=${sceneCount}, cap=${sceneCap}). If multiple CHARACTERIZE figures appear, the cap is the SUM (not per figure).
    (f) Image prompts MUST NOT spell out the figure's name in any language (Korean/English/native script). Use only the descriptor — RULE 11 (no text labels) remains authoritative. Narration may reference the figure by Korean display name (display_name_ko) since narration is voiced, not rendered as on-screen text.
    (g) If the allowlist context block marks a figure as BLOCKED (REQUIRES_LEGAL_REVIEW without operator approval), treat that figure as NEUTRAL_MASCOT and DO NOT inject any descriptor — fall back to RULE 3.
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
      "image_prompt": "${spec.aspect}, cartoon stick figure...",
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
  const format = platformOverride || fm.format || 'shorts';
  if (!FORMAT_SPECS[format]) {
    console.error(`❌ Unknown format: ${format}. Supported: ${Object.keys(FORMAT_SPECS).join(', ')}`);
    process.exit(1);
  }
  // brief.format과 --platform이 충돌하면 경고 (브리프를 신뢰할 수 없는 경우 방어선)
  if (platformOverride && fm.format && fm.format !== platformOverride) {
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

  const systemPrompt = buildSystemPrompt(format, persona, seriesContext, publicFiguresInfo);

  const userPromptParts = [
    `[EPISODE BRIEF]`,
    brief,
    '',
  ];
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
    `위 브리프·뉴스·채널 가이드·페르소나 규칙을 바탕으로 ${spec.scene_count}씬 ${spec.target_total_seconds}초 ${format} 스크립트를 JSON으로 작성하라.`,
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
  const maxTokens = format === 'long-3min' ? 12000 : 8000;
  const rawJson = await callGemini(systemPrompt, userPrompt, values.model, maxTokens);

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    console.error('❌ JSON 파싱 실패');
    console.error(rawJson.slice(0, 500));
    process.exit(1);
  }

  const scenes = parsed.scenes;
  if (!Array.isArray(scenes) || scenes.length !== spec.scene_count) {
    console.error(`❌ 씬 수 불일치: 기대 ${spec.scene_count}씬, 실제 ${scenes?.length || 0}씬`);
    process.exit(1);
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
    writer: 'writer-agent (gemini)',
    created_at: new Date().toISOString(),
    revision: 1,
  };
  if (fm.series_id) {
    outFM.series_id = fm.series_id;
    outFM.series_episode = fm.series_episode;
    if (fm.series_total) outFM.series_total = fm.series_total;
  }
  if (fm.parent_episode_id) outFM.parent_episode_id = fm.parent_episode_id;
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

main().catch(e => { console.error('❌', e.message); process.exit(1); });
