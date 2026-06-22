#!/usr/bin/env node

/**
 * generate-intro.js — BarroTube 시리즈 인트로 카드 생성기
 *
 * 2초 정지 이미지로 영상 맨 앞에 prepend되는 시리즈 브랜드 카드를 생성.
 * Script frontmatter의 series_id / series_episode / series_total을 읽어
 * `📚 Barro 경제수업 · [SERIES_NAME] [N/M]` 배지가 포함된 인트로 카드를 렌더.
 *
 * Character DNA는 character-dna.md에서 자동 로드, framing은 format별
 * style-guide-{shorts,long}.md에서 로드. 두 블록 뒤에 INTRO 전용 지시를 붙여
 * Gemini 3.1 Flash Image Preview 호출.
 *
 * 출력: <episode_dir>/45_intro.png (1K 기본, format aspect ratio)
 *
 * Usage:
 *   node generate-intro.js --episode <dir>
 *   node generate-intro.js --episode <dir> --force   (기존 파일 덮어쓰기)
 *   node generate-intro.js --episode <dir> --engine gemini|openai  (엔진 1회성 override)
 *
 * 이미지 엔진은 전역 SSOT(config/image-engines.json + lib/image-engine-config.js)로 결정.
 * 전역 전환은 BT_IMAGE_ENGINE=openai, 인트로 한정은 BT_INTRO_ENGINE=... (자세히는 .env.example).
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
  parseFrontmatter,
} from './generate-image-gemini.js';
import { composeThumbnail } from './lib/thumbnail-composer.js';
import { resolveImageEngine } from './lib/image-engine-config.js';
import { getSecret } from './config-loader.js';

// OpenAI 키를 .env/keychain → process.env 로 hydrate. resolver·openai-gpt-image·enrich·verify
// 가 모두 process.env.OPENAI_API_KEY 를 직접 읽으므로, keychain에만 있어도 전역으로 인식되게 한다.
function hydrateOpenAIKey() {
  if (process.env.OPENAI_API_KEY) return;
  try { const k = getSecret('OPENAI_API_KEY'); if (k) process.env.OPENAI_API_KEY = k; } catch { /* keychain 미설정 무시 */ }
}

/**
 * v2 (platforms/) layout 우선 → v1 (legacy) fallback.
 * 30_script.md 위치를 찾아 그 디렉토리를 base로 반환.
 */
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

// 시리즈별 표시명 — paperclip/config/series.json에서 동적 로드.
// 우선순위: display_name_short > name (보일러플레이트 정리) > series_id.
// 새 시리즈 추가 시 코드 수정 불필요.
function displaySeriesName(seriesId) {
  if (!seriesId) return '';
  try {
    const cfg = JSON.parse(readFileSync(resolve('paperclip/config/series.json'), 'utf-8'));
    const s = (cfg.series || []).find(x => x.id === seriesId);
    if (!s) return seriesId;
    if (s.display_name_short) return s.display_name_short;
    if (s.name) return s.name.replace(/\s*\d+편$/, '').trim();
    return seriesId;
  } catch { return seriesId; }
}

function aspectForFormat(format) {
  return format === 'long-3min' ? '16:9' : '9:16';
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

// Emotion → 인트로용 짧은 표현 hint
const INTRO_EMOTION_HINTS = {
  surprise: 'a surprised expression (wider eyes, mouth a small round O), both arms raised slightly',
  worry: 'a concerned expression (eyes tilted inward at the top, slight frown), one hand near the temple',
  confident: 'a confident gentle smile, one arm giving a thumbs-up',
  thinking: 'a thoughtful expression, one hand on chin, looking upward',
  pointing: 'pointing toward the background content with one extended arm',
  angry: 'an upset expression with furrowed brows and clenched fists',
  crying: 'a sad expression with closed eyes and small teardrops',
  annoyed: 'a mildly annoyed expression with squinted eyes and one raised palm',
};

function buildIntroPrompt({ channel, format, seriesName, episodeN, episodeM, standalone, noTextMode = false, topic = '', visualHint = '', mascotEmotion = 'confident' }) {
  const dna = loadCharacterDna(channel);

  if (noTextMode) {
    // 2026-05-16 갱신: 씬용 framing(style-guide-shorts.md)은 인트로와 정면 충돌(마스코트 ABSENT vs DOMINANT)이라
    // 인트로 v2 모드에서는 framing 제외. 인트로 전용 v2Spec만 사용. 또한 brief의 topic + visual_keywords[0] +
    // mascot_emotion을 흡수해 콘텐츠 시각 hint를 포함 (운영자 피드백, EP-0052).
    const emotionDesc = INTRO_EMOTION_HINTS[mascotEmotion] || INTRO_EMOTION_HINTS.confident;
    const contentLine = visualHint
      ? `Background context (subtle, behind the mascot, lower opacity, NOT competing with the mascot): ${visualHint}. Render a single dominant element from this context with a yellow (#FFD60A) or red (#FF3B30) accent.`
      : 'Background: a soft circular spotlight glow behind the mascot in deep navy tone.';
    const topicLine = topic
      ? `Episode topic context (for visual mood inference, DO NOT render any of these words on the image): "${topic}".`
      : '';

    const v2Spec = `
INTRO CARD BASE (v2 — text-free, mascot-dominant, content-aware): a vertical 9:16 YouTube Shorts intro card.
${topicLine}

Mascot: a friendly BarroTube cartoon character (per the DNA above) with ${emotionDesc}, standing prominently in the center-foreground, occupying 40-50% of the frame height. The mascot makes subtle eye contact with the viewer.

${contentLine}

Color palette: deep navy or near-black base (#0A1628). Single bright accent color (yellow #FFD60A or red #FF3B30) on ONE element of the background context. High visual contrast, editorial illustration style with clean bold lines, NOT photorealistic.

Layout safety zones: keep the TOP 20% of the frame relatively clear (a headline text will be overlaid in post-processing) and the BOTTOM 15% relatively clear (a small brand badge will be overlaid). The mascot occupies the central band.

TEXT POLICY: absolutely NO text, NO Korean characters, NO English words, NO numbers, NO logos, NO watermarks, NO signatures anywhere in the image itself. All text and badges are composited in a separate post-processing step.
`.trim();

    return [dna, v2Spec].filter(Boolean).join('\n\n');
  }

  const framing = resolveStylePrefix(channel, format);
  const introSpec = standalone
    ? `
INTRO CARD SPECIAL (STANDALONE): this image is a 2-second brand intro card, NOT a regular scene.
This is a one-off episode (no series), so render only the channel brand block.
Layout:
  • LEFT side (~40%): the mascot character in a friendly greeting/waving pose.
  • RIGHT side (~60%): a clean stacked text block composed of three lines, top to bottom:
      line 1: "📚 Barro 경제수업"     (medium weight, solid black)
      line 2: a thin horizontal orange (#F4A261) divider line, about 60% of the block width
      line 3: "오늘의 경제 한 컷"     (slightly larger, solid warm orange #F4A261)
Background: flat cream (#FFF8EC), uniform top to bottom, no strips or bands anywhere.
Add two small orange five-point stars floating near the character as subtle accents.
The text must be crisp, Korean-friendly sans-serif, clearly legible even at small sizes.
Keep the composition minimal, balanced, and branded — this is a channel-identity frame,
not a narrative scene. The only allowed text in the entire image is the three lines above.
`.trim()
    : `
INTRO CARD SPECIAL: this image is a 2-second brand intro card, NOT a regular scene.
Layout:
  • LEFT side (~40%): the mascot character in a friendly greeting/waving pose.
  • RIGHT side (~60%): a clean stacked text block composed of four lines, top to bottom:
      line 1: "📚 Barro 경제수업"   (medium weight, solid black)
      line 2: a thin horizontal orange (#F4A261) divider line, about 60% of the block width
      line 3: "${seriesName}"       (slightly larger, solid black)
      line 4: "[${episodeN}/${episodeM}]"  (smaller, solid warm orange #F4A261)
Background: flat cream (#FFF8EC), uniform top to bottom, no strips or bands anywhere.
Add two small orange five-point stars floating near the character as subtle accents.
The text must be crisp, Korean-friendly sans-serif, clearly legible even at small sizes.
Keep the composition minimal, balanced, and branded — this is a series-identity frame,
not a narrative scene. The only allowed text in the entire image is the four lines above.
`.trim();

  return [dna, framing, introSpec].filter(Boolean).join('\n\n');
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
    console.error('Usage: generate-intro.js --episode <dir> [--force]');
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
  const seriesName = displaySeriesName(seriesId);

  // 단발 (standalone) Shorts: series_id 또는 series_episode가 비어 있으면
  // 채널 브랜드 기반 단발 인트로 카드를 생성한다. 시리즈 표기([N/M])는 제거.
  // 명시적으로 시리즈 인트로를 강제하려면 frontmatter에 series_id/series_episode를 채울 것.
  const isStandalone = !seriesId || seriesN === undefined || seriesN === null;

  // brief frontmatter — thumbnail.* 공유 spec 추출 (인트로도 동일 spec 활용)
  let briefFM = {};
  if (existsSync(briefPath)) {
    const brief = readFileSync(briefPath, 'utf-8');
    const fmM = brief.match(/^---\n([\s\S]*?)\n---/);
    if (fmM) {
      try { briefFM = parseYAML(fmM[1]) || {}; } catch { briefFM = {}; }
    }
  }

  // series.json thumbnail_specs entry
  let specSeriesEntry = null;
  if (seriesId && seriesN) {
    try {
      const seriesCfg = JSON.parse(readFileSync(resolve('paperclip/config/series.json'), 'utf-8'));
      const series = (seriesCfg.series || []).find(s => s.id === seriesId);
      specSeriesEntry = series?.thumbnail_specs?.find(t => t.episode === seriesN) || null;
    } catch {}
  }

  const briefThumb = (briefFM && briefFM.thumbnail && typeof briefFM.thumbnail === 'object') ? briefFM.thumbnail : {};
  // Standalone(단발) EP는 채널 시그니처 카드 — default "오늘의 이슈". intro_headline_text가
  // brief.thumbnail에 명시되어 있으면 그것 우선. 시리즈 EP는 thumbnail headline 또는 series spec.
  const standaloneDefaultHeadline = '오늘의 이슈';
  const v2spec = {
    is_intro: true,
    headline_text: briefThumb.intro_headline_text
      || (isStandalone
        ? standaloneDefaultHeadline
        : (briefThumb.headline_text || specSeriesEntry?.headline_text))
      || null,
    accent_color: briefThumb.accent_color || specSeriesEntry?.accent_color || 'yellow',
    background_style: briefThumb.background_style || specSeriesEntry?.background_style || 'dark',
    series_badge_text: isStandalone ? 'BarroTube' : `${seriesName} ${seriesN}/${seriesM}`,
  };
  const isV2 = !!v2spec.headline_text;

  const outPath = join(baseDir, '45_intro.png');
  if (existsSync(outPath) && !opts.force) {
    console.log(`⏭  Intro already exists at ${outPath}. Use --force to regenerate.`);
    process.exit(0);
  }

  const visualHint = (Array.isArray(briefFM.visual_keywords) && briefFM.visual_keywords.length > 0)
    ? briefFM.visual_keywords[0]
    : '';
  const introMascotEmotion = briefThumb.intro_mascot_emotion
    || briefThumb.mascot_emotion
    || specSeriesEntry?.mascot_emotion
    || 'confident';

  const prompt = buildIntroPrompt({
    channel,
    format,
    seriesName,
    episodeN: seriesN,
    episodeM: seriesM,
    standalone: isStandalone,
    noTextMode: isV2,
    topic: briefFM.topic || '',
    visualHint,
    mascotEmotion: introMascotEmotion,
  });

  const aspectRatio = aspectForFormat(format);

  console.log(`🎬 Generating intro card for ${fm.episode_id}${isV2 ? ' (v2 composer mode)' : ''}`);
  if (isStandalone) {
    console.log(`   Mode: STANDALONE (channel brand only — no series text)`);
  } else {
    console.log(`   Series: ${seriesName} [${seriesN}/${seriesM}]`);
  }
  if (isV2) {
    console.log(`   v2 headline: "${v2spec.headline_text}" (bg=${v2spec.background_style}, badge=${v2spec.series_badge_text || 'none'})`);
  }
  console.log(`   Format: ${format} → aspect=${aspectRatio}`);
  console.log(`   Out: ${outPath}`);

  // 이미지 엔진: 전역 resolver(SSOT)로 통일. --engine / BT_INTRO_ENGINE / BT_INTRO_FORCE_GEMINI(legacy)
  // / BT_IMAGE_ENGINE / config/image-engines.json 순으로 해석. (OpenAI는 isV2 v10 경로에서만 의미)
  const introEngine = resolveImageEngine('S6d_intro', { cliOverride: opts.engine });
  const useOpenAI = introEngine.engine === 'openai';
  if (introEngine.downgraded) console.warn('   ⚠ OpenAI 요청됐으나 OPENAI_API_KEY 없음 → Gemini 사용');
  console.log(`   Engine: ${useOpenAI ? 'openai-gpt-image-1 (v10)' : 'gemini'} (source=${introEngine.source})`);

  // Debug: --print-prompt 또는 BT_PRINT_PROMPT=1 시 prompt만 출력하고 종료 (image gen skip).
  if (opts['print-prompt'] || process.env.BT_PRINT_PROMPT === '1') {
    console.log('===== FINAL PROMPT (sent to image API) =====');
    console.log(prompt);
    console.log('===== END PROMPT =====');
    console.log(`\n📏 prompt length: ${prompt.length} chars`);
    console.log(`🎨 engine: ${useOpenAI ? 'openai-gpt-image-1' : 'gemini-3.1-flash-image-preview'}`);
    console.log(`📐 v2spec: ${JSON.stringify(v2spec, null, 2)}`);
    process.exit(0);
  }

  try {
    if (isV2) {
      // 2026-05-16 v10: OpenAI 있으면 ALL-IN-ONE + verify retry loop (한글 정확도 보장).
      // 폴백: Gemini base + composer (기존 v2). 엔진은 위 resolver가 결정(useOpenAI).
      if (useOpenAI) {
        const { generateIntroV10, resolveIntroHeadline } = await import('./lib/image-engines/intro-v10.js');
        const introHeadline = resolveIntroHeadline({ briefThumb, topic: briefFM.topic || '' });
        const introKeyword = briefThumb.intro_keyword_number || briefThumb.keyword_number || '';
        console.log(`   🎬 v10 ALL-IN-ONE — headline="${introHeadline}", keyword="${introKeyword}"`);
        const result = await generateIntroV10({
          topic: briefFM.topic || '',
          visualHint,
          headline: introHeadline,
          keyword: introKeyword,
          outPath,
          maxRetries: 2,
        });
        console.log(`✅ Intro (v10${result.accurate ? ' ✓ accurate' : ' ⚠ partial accuracy'}, $${result.cost_usd.toFixed(4)}): ${outPath}`);
      } else {
        const baseOutPath = join(baseDir, '45_intro.base.png');
        await generateImageGemini({
          prompt,
          outPath: baseOutPath,
          aspectRatio,
          resolution: '1K',
          costContext: { episode: fm.episode_id || null, stage: 'S6d', note: 'intro_base_gemini' },
        });
        console.log(`   📸 Base image (Gemini fallback): ${baseOutPath}`);
        const result = await composeThumbnail({ baseImagePath: baseOutPath, spec: v2spec, outPath });
        console.log(`✅ Intro (v2 composer fallback, ${result.layers} layers): ${outPath}`);
      }
    } else {
      await generateImageGemini({
        prompt,
        outPath,
        aspectRatio,
        resolution: '1K',
        costContext: { episode: fm.episode_id || null, stage: 'S6d', note: 'intro_card' },
      });
      console.log(`✅ Intro saved: ${outPath}`);
    }
  } catch (e) {
    console.error(`❌ Intro generation failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
