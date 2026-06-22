#!/usr/bin/env node

/**
 * generate-thumbnail.js — YouTube 썸네일 생성기
 *
 * Script frontmatter + hook scene narration + 00_brief.md topic을 바탕으로
 * YouTube 피드에서 클릭을 유도하는 썸네일 이미지를 생성.
 *
 * 일반 씬 이미지와 다른 점:
 *  - 큰 키워드·수치 텍스트가 핵심 (No-text 규칙 예외)
 *  - 캐릭터는 표정·포즈로 감정 전달 (놀람·환호·사고)
 *  - scene-backgrounds.md 팔레트 재사용 (에피소드 감정에 맞게)
 *
 * 출력: <episode_dir>/47_thumbnail.png
 *  - Long format: 1280×720 (YouTube 표준)
 *  - Shorts format: 1080×1920 (Shorts 썸네일)
 *
 * Usage:
 *   node generate-thumbnail.js --episode <dir>
 *   node generate-thumbnail.js --episode <dir> --palette bullish --keyword "90%" --force
 *   node generate-thumbnail.js --episode <dir> --engine openai   # gpt-image-1 (실패 시 Gemini 폴백)
 *
 * 이미지 엔진(기본 Gemini):
 *   --engine openai  또는  BT_THUMBNAIL_ENGINE=openai (+ OPENAI_API_KEY) → gpt-image-1.
 *   인트로(S6d v10)와 동일하게 opt-in 이며, 키 없음/호출 실패 시 자동으로 Gemini 폴백.
 *
 * 참조 문서: workspace/channels/{channel}/intro-thumbnail-guide.md
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parse as parseYAML } from 'yaml';
import {
  generateImageGemini,
  loadCharacterDna,
  loadChannelStylePrefix,
  loadPalette,
  parseFrontmatter,
} from './generate-image-gemini.js';
import {
  resolveFiguresForBrief,
} from './lib/public-figures.js';
import { composeThumbnail } from './lib/thumbnail-composer.js';
import { detectSentimentPalette } from './lib/sentiment.js';
import { resolveImageEngine } from './lib/image-engine-config.js';
import { getSecret } from './config-loader.js';

// OpenAI 키를 .env/keychain → process.env 로 hydrate. resolver·openai-gpt-image·enrich·verify
// 가 모두 process.env.OPENAI_API_KEY 를 직접 읽으므로, keychain에만 있어도 전역으로 인식되게 한다.
function hydrateOpenAIKey() {
  if (process.env.OPENAI_API_KEY) return;
  try { const k = getSecret('OPENAI_API_KEY'); if (k) process.env.OPENAI_API_KEY = k; } catch { /* keychain 미설정 무시 */ }
}

function locateBase(epDir, platformHint) {
  const candidates = platformHint
    ? [join(epDir, 'platforms', platformHint, '30_script.md')]
    : [
        join(epDir, 'platforms', 'long', '30_script.md'),
        join(epDir, 'platforms', 'shorts', '30_script.md'),
        join(epDir, '30_script.md'),
      ];
  for (const c of candidates) if (existsSync(c)) return { scriptPath: c, baseDir: dirname(c) };
  return { scriptPath: null, baseDir: null };
}

// 시리즈 표시명 — paperclip/config/series.json에서 동적 로드.
// 우선순위: series.json display_name_short > series.json name 정규화 > series_id
// 새 시리즈 추가 시 코드 수정 없이 series.json만 갱신하면 됨.

function loadSeriesDisplayName(seriesId) {
  if (!seriesId) return '';
  try {
    const cfg = JSON.parse(readFileSync(resolve('paperclip/config/series.json'), 'utf-8'));
    const s = (cfg.series || []).find(x => x.id === seriesId);
    if (!s) return seriesId;
    // 1순위: 명시적 display_name_short ("S&P500 입문" 같은 짧은 배지용)
    if (s.display_name_short) return s.display_name_short;
    // 2순위: name에서 "5편" 같은 보일러플레이트 제거 (배지에 길면 안 됨)
    if (s.name) return s.name.replace(/\s*\d+편$/, '').trim();
    return seriesId;
  } catch { return seriesId; }
}

const BRAND_TAGLINE = '3분이면 충분한 경제';

// role 기반 기본 팔레트 (Hook 씬의 role이 thumbnail emotion과 가장 가까움)
// 주의: role 단독으로는 감정(상승/하락)을 구분하지 못한다. 단발 EP는
// detectSentimentPalette()가 topic/narration 감정을 먼저 반영하고, 여기는 최후 fallback.
const ROLE_PALETTE_FALLBACK = {
  hook: 'bullish',
  data: 'bullish',
  insight: 'explainer',
  implication: 'wealth',
  wrap: 'cta',
};

// topic + hook narration 텍스트 감정 → 팔레트 자동 추론 로직은 lib/sentiment.js로 이관.
// (단순 키워드 매칭 → 부정/반전 문맥 인식 스코어링 + 옵셔널 LLM 하이브리드)
// scene-backgrounds.md §63 자동 매핑("hook + 위기/충격 → bearish") 준수.

function aspectForFormat(format) {
  return format === 'long-3min' ? '16:9' : '9:16';
}

// 썸네일 이미지 렌더 — 엔진 라우팅. 기본 Gemini, OpenAI gpt-image-1 opt-in.
// 인트로(S6d v10)와 동일 정책: env/플래그로 OpenAI 선택, 실패 시 Gemini 자동 폴백.
// gpt-image-1 지원 사이즈는 1024x1536(세로)·1536x1024(가로)·1024x1024 뿐이라
// 정확한 16:9/9:16이 아닌 근사 비율(가로 3:2 / 세로 2:3)이다. v2는 composer가
// 1080×1920 cover로 재정렬하므로 무관하고, v1 직출력은 약간의 크롭이 생길 수 있다.
async function renderThumbnailImage({ useOpenAI, prompt, outPath, aspectRatio, episodeId, note }) {
  if (useOpenAI) {
    try {
      const { generateImageOpenAI } = await import('./lib/image-engines/openai-gpt-image.js');
      const size = aspectRatio === '16:9' ? '1536x1024' : '1024x1536';
      await generateImageOpenAI({
        prompt,
        outPath,
        size,
        quality: 'high',
        costContext: { episode: episodeId, stage: 'S6e', note: `${note}-openai`, engine: 'openai-gpt-image-1' },
      });
      return 'openai-gpt-image-1';
    } catch (e) {
      console.warn(`   ⚠ OpenAI(gpt-image-1) 썸네일 실패 (${String(e.message).slice(0, 120)}) → Gemini 폴백`);
    }
  }
  await generateImageGemini({
    prompt,
    outPath,
    aspectRatio,
    resolution: '1K',
    costContext: { episode: episodeId, stage: 'S6e', note },
  });
  return 'gemini';
}

function resolveStylePrefix(channel, format) {
  const suffix = format === 'long-3min' ? 'long' : 'shorts';
  const candidates = [
    resolve('workspace/channels', channel, `style-guide-${suffix}.md`),
    resolve('workspace/channels', channel, 'style-guide.md'),
  ];
  for (const sg of candidates) {
    if (existsSync(sg)) {
      const framing = loadChannelStylePrefix(sg);
      if (framing) return framing;
    }
  }
  return '';
}

function buildThumbnailPrompt({
  channel,
  format,
  seriesName,
  episodeN,
  episodeM,
  topic,
  hookNarration,
  keywordHint,
  paletteBlock,
  sentiment = null,    // 'bearish' | 'bullish' | null — 마스코트 표정/포즈 정합용
  publicFigure,        // resolved figure (max 1, primary) — { figure, treatment, sensitivity, blockReason? }
  noTextMode = false,  // v2: composer가 텍스트·로고·인용을 후처리할 base 이미지 모드
}) {
  const framing = resolveStylePrefix(channel, format);
  const useCaricature = publicFigure && publicFigure.treatment === 'CHARACTERIZE' && !publicFigure.blockReason;

  // CHARACTERIZE 인물이면 DNA 블록은 framing-only로 다운그레이드 (CEO 정책 §10 / intro-thumbnail-guide §10)
  const dna = useCaricature ? '' : loadCharacterDna(channel);

  const keywordDirective = keywordHint
    ? `Use this exact main message (pre-chosen): "${keywordHint}".`
    : `Choose the SINGLE most impactful keyword + number from the hook narration below (max 6 Korean characters + 1 number). Pick something that will stop a scroll on the YouTube feed.`;

  // 시리즈 미소속(단발) 에피소드는 series badge 자체를 그리지 않음.
  // episodeN/episodeM이 모두 정의돼 있고 seriesName이 비어있지 않을 때만 배지 표시.
  const isSeriesEpisode = seriesName && episodeN !== undefined && episodeN !== null && episodeM;
  const seriesBadgeLine = isSeriesEpisode
    ? `Series badge (small, top-left corner): "${seriesName} ${episodeN}/${episodeM}" in clean small sans-serif.`
    : `No series badge anywhere in the frame (this is a standalone episode, not part of a numbered series).`;

  // Character clause — public figure caricature variant vs default mascot
  let characterClause;
  let primarySubjectClause = ''; // top-of-prompt emphasis for caricature only
  if (useCaricature) {
    const fig = publicFigure.figure;
    const sens = publicFigure.sensitivity;
    const isHigh = sens === 'high';
    // sensitivity high 에서도 식별 단서는 유지 (정책 §4.3 / allowlist v1.2 notes).
    // COLOR RULE은 채도 다운톤 + 면적 축소이지 식별 단서 제거가 아님.
    const expressionRule = isHigh
      ? 'EXPRESSION RULE (sensitivity=high): facial expression MUST be 무표정 / 진지(serious) / confident / thoughtful only. NO surprised/celebratory/comedic/winking/teasing/mocking expressions. NO comedy props (stars, exploding effects, skulls, animal substitution). NO sight of injury/blood/weapon — strictly absent. The figure must remain CLEARLY IDENTIFIABLE — keep all trademark hair/jaw/tie cues visible; do not anonymize.'
      : (sens === 'medium'
        ? 'EXPRESSION RULE (sensitivity=medium): neutral, serious, confident, or thoughtful expression only. NO mocking/teasing/celebratory expressions. Keep identifying features clearly visible.'
        : 'EXPRESSION RULE: neutral, confident, or thoughtful expression matching topic emotion. Avoid mocking or teasing tone. Keep identifying features clearly visible.');
    const colorRule = isHigh
      ? `COLOR RULE (sensitivity=high): trademark accent color (e.g. signature tie) is desaturated to a MUTED but still recognizable shade — NOT fully neutralized. For a red tie, use muted/dusty red (e.g. #A04040, dusty brick) instead of saturated Alert Red (#E63946). DO NOT replace the trademark color with charcoal/grey/slate — that erases identification. Trademark color occupies roughly 8-15% of frame area (small but visible).`
      : `COLOR RULE: brand palette dominates. The figure's trademark color may appear as an accent (≤ 25% of frame area).`;
    const cues = (fig.trademark_cues || []).slice(0, 4).join(' / ') || 'hairstyle silhouette, signature outfit color';
    // PRIMARY SUBJECT — placed at very top of prompt to dominate composition
    primarySubjectClause = `PRIMARY SUBJECT (must be clearly visible, identifiable, and dominate the composition): ${fig.descriptor_en}. The figure occupies roughly 45-55% of the frame, positioned in the left-center or center, framed from waist-up or chest-up. The figure's identifying features (${cues}) MUST be unambiguous so a viewer recognizes the person at a glance from the YouTube feed thumbnail. Do NOT generate a generic mascot or anonymous stick-figure — the figure is the named public-figure caricature.`;
    characterClause = `Character details (carry over from PRIMARY SUBJECT above): ${expressionRule} ${colorRule} Stylization MUST stay cartoon (NOT photorealistic — no AI photo-likeness, no realistic skin texture, no hyperrealistic facial details). Trademark visual cues to preserve: ${cues}. NEVER add the figure's name as on-screen text — name appears only in voice/narration, not in the image.`;
  } else {
    // sentiment가 명확하면 표정/포즈를 강제해 팔레트와 정합시킨다.
    // (하락 뉴스인데 웃으며 thumbs-up + 상승 화살표가 나오던 버그 교정)
    const moodPose = sentiment === 'bearish'
      ? 'worried / alarmed / serious expression — a concerned hand-near-face or pointing down at a FALLING/red downward chart. ABSOLUTELY NO smiling, NO thumbs-up, NO celebration, NO upward-rising green/orange arrows. The visual mood must read as a market drop / warning'
      : sentiment === 'bullish'
        ? 'confident, upbeat expression — thumbs-up or pointing up at a RISING chart, energetic positive mood'
        : "expressively to match the topic's emotion (surprised for shock values, confident thumbs-up for bullish, thoughtful hand-on-chin for complex, determined for risk)";
    characterClause = `Character: the mascot positioned on one side, posed ${moodPose}.`;
  }

  const thumbnailSpec = noTextMode
    ? `
THUMBNAIL BASE (v2 — text-free for post-processing):
This image is the BASE LAYER of a YouTube thumbnail. All text, brand logos, license citations, and series badges will be added by a separate post-processor (thumbnail-composer.js) — DO NOT draw any of them here.
ABSOLUTELY NO TEXT in the image — no Korean characters (한글 금지), no English words, no numbers/digits, no series badges, no taglines, no logos, no signatures, no watermarks. Zero typographic glyphs of any kind.
The image must contain ONLY: the background palette + the mascot (or caricature) + a subtle non-text visual hook (one symbolic icon such as a chart line, an arrow, a money stack — but no labels on it).
${characterClause}
Background: follow the palette colors below; keep it ONE uniform flat color (the post-processor will add a dark vignette or news-style overlay if needed).

Hook narration (for visual mood inference only — DO NOT render any of its words on the image): "${hookNarration}"
`.trim()
    : `
THUMBNAIL SPECIAL: this image is a YouTube thumbnail for the episode "${topic}".
${seriesBadgeLine}
Main hook text (CENTER or upper area, huge, unmissable, but MUST NOT cover the figure's face): ${keywordDirective}
Render the main hook in extra-bold Korean-friendly sans-serif, keyword in black and number/percent in warm orange (#F4A261), BOTH with a thick white outline for contrast and a subtle drop shadow. The main hook must occupy roughly 25-35% of the frame height to be legible on a small YouTube feed thumbnail. Layout the text so the figure's face/upper body remains fully visible and identifiable.
Small bottom tagline (bottom-center, compact): "${BRAND_TAGLINE}".
${characterClause}
Text-rule exception: the three text elements above (series badge, main hook, tagline) ARE allowed in this thumbnail; NO other text anywhere.
Background: follow the palette colors provided below; keep it ONE uniform flat color (no bottom strip, no split bar) except where the palette explicitly specifies a split.

Hook narration (for keyword extraction): "${hookNarration}"
`.trim();

  // PRIMARY SUBJECT clause는 prompt 최상단 (DNA·framing·palette보다 먼저)에 배치하여
  // 모델이 인물을 합성의 1순위 요소로 인식하도록 가중치 강화.
  return [primarySubjectClause, dna, framing, paletteBlock, thumbnailSpec].filter(Boolean).join('\n\n');
}

async function main() {
  hydrateOpenAIKey();
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }

  if (!opts.episode) {
    console.error('Usage: generate-thumbnail.js --episode <dir> [--keyword "..."] [--palette NAME] [--engine gemini|openai] [--sentiment-llm] [--force]');
    process.exit(1);
  }

  const epDir = resolve(opts.episode);
  const { scriptPath, baseDir } = locateBase(epDir, opts.platform);
  const briefPath = join(epDir, '00_brief.md');
  if (!scriptPath) {
    console.error(`❌ Missing 30_script.md under ${epDir} (tried platforms/long, platforms/shorts, legacy root)`);
    process.exit(1);
  }

  const fm = parseFrontmatter(scriptPath);
  if (!fm) { console.error('❌ No frontmatter in script'); process.exit(1); }

  const format = fm.format || 'shorts';
  const channel = fm.channel_id;
  const seriesId = fm.series_id;
  const seriesN = fm.series_episode;
  const seriesM = fm.series_total || 5;
  const seriesName = loadSeriesDisplayName(seriesId) || '';

  // topic + brief frontmatter 추출
  let topic = '';
  let briefFM = {};
  if (existsSync(briefPath)) {
    const brief = readFileSync(briefPath, 'utf-8');
    const m = brief.match(/^topic:\s*["']?(.+?)["']?\s*$/m);
    topic = m ? m[1].trim() : '';
    const fmM = brief.match(/^---\n([\s\S]*?)\n---/);
    if (fmM) {
      try { briefFM = parseYAML(fmM[1]) || {}; } catch { briefFM = {}; }
    }
    // brief frontmatter의 topic이 우선
    if (briefFM.topic) topic = briefFM.topic;
  }

  // hook scene narration
  const hookScene = (fm.scenes || []).find(s => s.role === 'hook') || fm.scenes?.[0];
  const hookNarration = hookScene?.narration || '';

  // Public Figure 감지 (CEO 정책 §10 / intro-thumbnail-guide §10)
  // brief.public_figures 우선, 미명시 시 topic + hook narration 텍스트 fallback
  const detectionText = `${topic}\n${hookNarration}`;
  const pfInfo = resolveFiguresForBrief(channel, briefFM, detectionText);
  // 썸네일은 1명 캐리커처만 사용 (CHARACTERIZE 우선, source=brief 우선)
  const charFigures = pfInfo.resolved.filter(r => r.treatment === 'CHARACTERIZE');
  const primaryFigure =
    charFigures.find(r => r.source === 'brief')
    || charFigures[0]
    || null;
  const blockedFigures = pfInfo.resolved.filter(r => r.blockReason);

  // 시리즈 thumbnail_specs 자동 로드 (paperclip/config/series.json)
  // 우선순위: CLI override (--keyword/--palette) > series.json thumbnail_specs > 자동 fallback
  let specKeyword = null, specPalette = null, specSeriesEntry = null;
  if (seriesId && seriesN) {
    try {
      const seriesCfg = JSON.parse(readFileSync(resolve('paperclip/config/series.json'), 'utf-8'));
      const series = (seriesCfg.series || []).find(s => s.id === seriesId);
      specSeriesEntry = series?.thumbnail_specs?.find(t => t.episode === seriesN) || null;
      if (specSeriesEntry) {
        specKeyword = specSeriesEntry.keyword;
        specPalette = specSeriesEntry.palette;
        console.log(`   📋 series.json thumbnail_spec: keyword="${specSeriesEntry.keyword}", palette=${specSeriesEntry.palette}${specSeriesEntry.headline_text ? `, headline="${specSeriesEntry.headline_text}"` : ''}${specSeriesEntry.rationale ? ` (rationale: ${specSeriesEntry.rationale})` : ''}`);
      }
    } catch (e) {
      console.warn(`   ⚠ series.json 로드 실패: ${e.message}`);
    }
  }

  // sentiment 자동 감지: 단발 EP도 topic/narration 감정(상승/하락)을 팔레트에 반영.
  // (scene-backgrounds.md §63 자동 매핑 준수 — role 단독 fallback의 bullish 고정 버그 교정)
  // 기본은 결정적 regex(부정/반전 인식). --sentiment-llm 또는 BARROTUBE_SENTIMENT_LLM=1
  // + OPENAI_API_KEY 가 있으면 gpt-4o-mini 문맥 분류로 정밀화(실패 시 regex 폴백).
  const useSentimentLLM = !!opts['sentiment-llm']
    || /^(1|true|yes)$/i.test(process.env.BARROTUBE_SENTIMENT_LLM || '');
  const sentiment = await detectSentimentPalette(`${topic}\n${hookNarration}`, {
    useLLM: useSentimentLLM,
    costContext: { episode: fm.episode_id || null, stage: 'S6e' },
  });
  const sentimentPalette = sentiment.palette;

  // palette resolution: CLI > series spec > sentiment > role fallback > bullish
  const paletteName = opts.palette
    || specPalette
    || sentimentPalette
    || ROLE_PALETTE_FALLBACK[hookScene?.role]
    || 'bullish';
  const paletteSource = opts.palette ? 'CLI' : specPalette ? 'series-spec' : sentimentPalette ? `sentiment/${sentiment.source}` : ROLE_PALETTE_FALLBACK[hookScene?.role] ? 'role' : 'default';
  const paletteBlock = loadPalette(channel, paletteName);
  // keyword resolution: CLI > series spec > null (Gemini가 hook narration에서 추출)
  const keywordResolved = opts.keyword || specKeyword || null;

  const outPath = join(baseDir, '47_thumbnail.png');
  if (existsSync(outPath) && !opts.force) {
    console.log(`⏭  Thumbnail already exists at ${outPath}. Use --force to regenerate.`);
    process.exit(0);
  }

  // v2 spec composition — brief frontmatter > series.json entry > defaults
  // headline_text 존재 시 v2 모드: Gemini가 NO TEXT base 생성 → composer가 텍스트·로고·인용 합성
  const briefThumb = (briefFM && briefFM.thumbnail && typeof briefFM.thumbnail === 'object') ? briefFM.thumbnail : {};
  const v2spec = {
    episode: seriesN || undefined,
    keyword: keywordResolved || undefined,
    palette: paletteName,
    headline_text: briefThumb.headline_text || specSeriesEntry?.headline_text || null,
    keyword_number: briefThumb.keyword_number || specSeriesEntry?.keyword_number || null,
    accent_color: briefThumb.accent_color || specSeriesEntry?.accent_color || 'yellow',
    background_style: briefThumb.background_style || specSeriesEntry?.background_style || 'dark',
    mascot_emotion: briefThumb.mascot_emotion || specSeriesEntry?.mascot_emotion || null,
    featured_person: briefThumb.featured_person || specSeriesEntry?.featured_person || null,
    brand_logos: briefThumb.brand_logos || specSeriesEntry?.brand_logos || null,
  };
  const isV2 = !!v2spec.headline_text;

  const prompt = buildThumbnailPrompt({
    channel,
    format,
    seriesName,
    episodeN: seriesN,
    episodeM: seriesM,
    topic,
    hookNarration,
    keywordHint: keywordResolved,
    paletteBlock,
    sentiment: sentimentPalette,
    publicFigure: primaryFigure,
    noTextMode: isV2,
  });

  // Aspect: thumbnails match the format (YouTube accepts 16:9 for long, 9:16 for Shorts)
  const aspectRatio = aspectForFormat(format);

  // 이미지 엔진: 전역 resolver(SSOT)로 통일. --engine / BT_THUMBNAIL_ENGINE / BT_IMAGE_ENGINE
  // / config/image-engines.json 순으로 해석. 기본(auto)은 현행 호환 = gemini.
  const thumbEngine = resolveImageEngine('S6e_thumbnail', { cliOverride: opts.engine });
  const useOpenAIThumb = thumbEngine.engine === 'openai';
  if (thumbEngine.downgraded) console.warn('   ⚠ OpenAI 요청됐으나 OPENAI_API_KEY 없음 → Gemini 사용');

  console.log(`🖼  Generating thumbnail for ${fm.episode_id}${isV2 ? ' (v2 composer mode)' : ''}`);
  console.log(`   Series: ${seriesName} [${seriesN}/${seriesM}]`);
  console.log(`   Topic: ${topic}`);
  console.log(`   Palette: ${paletteName} (${paletteSource}${paletteSource.startsWith('sentiment') ? `: ${sentimentPalette === 'bearish' ? '위기/하락 감지' : '상승/호재 감지'}` : ''})`);
  if (opts.keyword) console.log(`   Keyword hint: ${opts.keyword}`);
  if (isV2) {
    console.log(`   v2 spec: headline="${v2spec.headline_text}"${v2spec.keyword_number ? `, keyword_number="${v2spec.keyword_number}"` : ''}, bg=${v2spec.background_style}, accent=${v2spec.accent_color}${v2spec.featured_person ? `, person=${v2spec.featured_person.id}(${v2spec.featured_person.treatment})` : ''}${v2spec.brand_logos ? `, logos=[${v2spec.brand_logos.map(b=>b.id).join(',')}]` : ''}`);
  }
  if (primaryFigure) {
    console.log(`   Public Figure (caricature): ${primaryFigure.figure.display_name_ko} [${primaryFigure.treatment}/${primaryFigure.sensitivity}, source=${primaryFigure.source}, dna:bypassed]`);
  } else if (pfInfo.resolved.length) {
    const summary = pfInfo.resolved.map(r => `${r.figure.display_name_ko}(${r.treatment}${r.blockReason ? ',BLOCKED' : ''})`).join(', ');
    console.log(`   Public Figures detected (no caricature applied): ${summary}`);
  }
  if (blockedFigures.length) {
    for (const b of blockedFigures) {
      console.warn(`   ⚠ Public-figure blocked: ${b.figure.display_name_ko} — ${b.blockReason}`);
    }
  }
  console.log(`   Format: ${format} → aspect=${aspectRatio}`);
  console.log(`   Engine: ${useOpenAIThumb ? 'openai-gpt-image-1 (Gemini 폴백)' : 'gemini'} (source=${thumbEngine.source})`);
  console.log(`   Out: ${outPath}`);

  try {
    if (isV2) {
      const baseOutPath = join(baseDir, '47_thumbnail.base.png');
      const baseEngine = await renderThumbnailImage({
        useOpenAI: useOpenAIThumb,
        prompt,
        outPath: baseOutPath,
        aspectRatio,
        episodeId: fm.episode_id || null,
        note: 'thumbnail-base',
      });
      console.log(`   📸 Base image (${baseEngine}): ${baseOutPath}`);
      const result = await composeThumbnail({ baseImagePath: baseOutPath, spec: v2spec, outPath });
      console.log(`✅ Thumbnail (v2 composer, ${result.layers} layers): ${outPath}`);
    } else {
      const engUsed = await renderThumbnailImage({
        useOpenAI: useOpenAIThumb,
        prompt,
        outPath,
        aspectRatio,
        episodeId: fm.episode_id || null,
        note: 'thumbnail',
      });
      console.log(`✅ Thumbnail saved (${engUsed}): ${outPath}`);
    }
  } catch (e) {
    console.error(`❌ Thumbnail generation failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
