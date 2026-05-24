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
const ROLE_PALETTE_FALLBACK = {
  hook: 'bullish',
  data: 'bullish',
  insight: 'explainer',
  implication: 'wealth',
  wrap: 'cta',
};

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
    characterClause = `Character: the mascot positioned on one side, posed expressively to match the topic's emotion (surprised for shock values, confident thumbs-up for bullish, thoughtful hand-on-chin for complex, determined for risk).`;
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
    console.error('Usage: generate-thumbnail.js --episode <dir> [--keyword "..."] [--palette NAME] [--force]');
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

  // palette resolution: CLI > series spec > role fallback > bullish
  const paletteName = opts.palette
    || specPalette
    || ROLE_PALETTE_FALLBACK[hookScene?.role]
    || 'bullish';
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
    publicFigure: primaryFigure,
    noTextMode: isV2,
  });

  // Aspect: thumbnails match the format (YouTube accepts 16:9 for long, 9:16 for Shorts)
  const aspectRatio = aspectForFormat(format);

  console.log(`🖼  Generating thumbnail for ${fm.episode_id}${isV2 ? ' (v2 composer mode)' : ''}`);
  console.log(`   Series: ${seriesName} [${seriesN}/${seriesM}]`);
  console.log(`   Topic: ${topic}`);
  console.log(`   Palette: ${paletteName}${opts.palette ? '' : ' (auto from role)'}`);
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
  console.log(`   Out: ${outPath}`);

  try {
    if (isV2) {
      const baseOutPath = join(baseDir, '47_thumbnail.base.png');
      await generateImageGemini({
        prompt,
        outPath: baseOutPath,
        aspectRatio,
        resolution: '1K',
        costContext: { episode: fm.episode_id || null, stage: 'S6e', note: 'thumbnail-base' },
      });
      console.log(`   📸 Base image: ${baseOutPath}`);
      const result = await composeThumbnail({ baseImagePath: baseOutPath, spec: v2spec, outPath });
      console.log(`✅ Thumbnail (v2 composer, ${result.layers} layers): ${outPath}`);
    } else {
      await generateImageGemini({
        prompt,
        outPath,
        aspectRatio,
        resolution: '1K',
        costContext: { episode: fm.episode_id || null, stage: 'S6e', note: 'thumbnail' },
      });
      console.log(`✅ Thumbnail saved: ${outPath}`);
    }
  } catch (e) {
    console.error(`❌ Thumbnail generation failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
