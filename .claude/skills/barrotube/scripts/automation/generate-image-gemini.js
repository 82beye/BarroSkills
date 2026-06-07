#!/usr/bin/env node

/**
 * generate-image-gemini.js — Google Gemini Image API (Nano Banana 계열)
 *
 * Google AI Studio의 Gemini 3.1 Flash Image Preview (Nano Banana 2) 모델 사용.
 * 한국어 텍스트 렌더링, cartoon/illustration 품질이 FAL Recraft 계열 대비 우수.
 *
 * v1.1 (2026-04-23): format/style-guide 자동 분기 + force flag 수정
 *
 * Usage:
 *   node generate-image-gemini.js --prompt "..." --out scene.png [--aspect 9:16|16:9]
 *   node generate-image-gemini.js --script 30_script.md --out-dir assets/images/ [--force]
 *
 * 환경변수:
 *   GOOGLE_AI_API_KEY          (필수)
 *   GEMINI_IMAGE_MODEL         (선택, 기본: gemini-3.1-flash-image-preview)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';
import {
  loadAllowlist,
  findFigureById,
  computeTreatment,
} from './lib/public-figures.js';
import { recordCost } from './lib/cost-tracker.js';

const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function generateImageGemini({ prompt, outPath, aspectRatio = '9:16', resolution = '2K', model = DEFAULT_MODEL, costContext = {} }) {
  const apiKey = getSecret('GOOGLE_AI_API_KEY');
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set in .env');

  const url = `${API_BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio, imageSize: resolution },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini image gen failed: ${res.status} ${err.slice(0, 400)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData || p.inline_data);
  if (!imgPart) {
    throw new Error(`No image in response: ${JSON.stringify(data).slice(0, 400)}`);
  }

  const base64 = (imgPart.inlineData || imgPart.inline_data).data;
  const mime = (imgPart.inlineData || imgPart.inline_data).mimeType || 'image/png';
  const buffer = Buffer.from(base64, 'base64');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);

  // Cost tracking — best-effort, never blocks (2026-04-27)
  recordCost('image-generator', {
    model,
    images: 1,
    episode: costContext.episode || null,
    stage: costContext.stage || null,
    note: costContext.note || null,
  });

  return { path: outPath, bytes: buffer.length, mime };
}

export function parseFrontmatter(mdPath) {
  const content = readFileSync(mdPath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No YAML frontmatter');
  return parseYAML(match[1]);
}

// Mascot Emotion Pack v10 (2026-05-16, G3) — character-dna.md v10 섹션의 short overlay.
// character-dna.md는 LLM 직접 참조용 fuller version, 여기는 generate-image-gemini.js
// 자동 prepend용 short version. 두 곳 일관성은 운영자 책임 (변경 시 양쪽 동시 갱신).
const EMOTION_OVERLAYS = {
  surprise: 'Mascot expression overlay (SURPRISE): eyes 1.5x wider, mouth small round O shape, both arms raised up sharply with open palms.',
  worry:    'Mascot expression overlay (WORRY): eye dots slightly tilted inward at top, mouth downward arc, one hand near temple.',
  confident:'Mascot expression overlay (CONFIDENT): standard eyes, mouth upward arc smile, one arm giving thumbs-up.',
  crying:   'Mascot expression overlay (CRYING): eyes closed as short curved lines, two small teardrops below each eye, mouth strong downward arc, arms hanging down.',
  angry:    'Mascot expression overlay (ANGRY): short slanted brows above eyes, mouth tight horizontal or downward arc, both fists clenched.',
  thinking: 'Mascot expression overlay (THINKING): eyes positioned slightly higher (upward gaze), neutral mouth, one hand on chin, optional small rectangular glasses frame.',
  pointing: 'Mascot expression overlay (POINTING): standard eyes, mouth small open line, one arm fully extended horizontally with index-finger pose.',
  annoyed:  'Mascot expression overlay (ANNOYED): eyes squinted as short downward-tilted lines, short straight mouth tilted diagonally, one arm raised palm-up.'
};

// scene.role → emotion fallback (Writer가 image_prompt에 emotion=X를 명시하지 않은 경우)
const ROLE_EMOTION_FALLBACK = {
  hook: 'surprise',
  context: 'thinking',
  insight: 'thinking',
  implication: 'worry',
  wrap: 'pointing',
  cta: 'pointing',
};

export function selectEmotionForScene(scene) {
  const prompt = String(scene?.image_prompt || '');
  const explicit = prompt.match(/emotion\s*=\s*(\w+)/i);
  if (explicit) {
    const key = explicit[1].toLowerCase();
    if (EMOTION_OVERLAYS[key]) return key;
  }
  const role = String(scene?.role || '').toLowerCase();
  return ROLE_EMOTION_FALLBACK[role] || 'confident';
}

export function loadChannelStylePrefix(styleGuidePath) {
  const md = readFileSync(styleGuidePath, 'utf-8');
  const m = md.match(/```\n([\s\S]*?)\n```/);
  if (!m) return '';
  return m[1].trim();
}

export function loadCharacterDna(channel) {
  const dnaPath = resolve('workspace/channels', channel, 'character-dna.md');
  if (!existsSync(dnaPath)) return '';
  const md = readFileSync(dnaPath, 'utf-8');
  const m = md.match(/```\n([\s\S]*?)\n```/);
  return m ? m[1].trim() : '';
}

const ROLE_PALETTE_FALLBACK = {
  hook: 'bullish',
  'intro/recap': 'explainer',
  definition: 'explainer',
  data: 'bullish',
  insight: 'explainer',
  implication: 'wealth',
  'wrap+teaser+disclaimer': 'cta',
  wrap: 'cta',
};

export function loadPalette(channel, paletteName) {
  if (!paletteName) return '';
  const path = resolve('workspace/channels', channel, 'scene-backgrounds.md');
  if (!existsSync(path)) return '';
  const md = readFileSync(path, 'utf-8');
  // Match "## Palette: NAME" ... followed by ``` block
  const re = new RegExp(`##\\s*Palette:\\s*${paletteName}\\b[\\s\\S]*?\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\``, 'i');
  const m = md.match(re);
  return m ? m[1].trim() : '';
}

function extractPaletteToken(imagePrompt) {
  // look for [palette:NAME] in the image_prompt; consume and return cleaned prompt + name
  const m = imagePrompt.match(/\[palette:([a-zA-Z0-9_-]+)\]/i);
  if (!m) return { prompt: imagePrompt, paletteName: null };
  return {
    prompt: imagePrompt.replace(m[0], '').replace(/\s+/g, ' ').trim(),
    paletteName: m[1].toLowerCase(),
  };
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
      if (framing) {
        const dna = loadCharacterDna(channel);
        const combined = dna ? `${dna}\n\n${framing}` : framing;
        return { prefix: combined, path: sg, hasDna: !!dna };
      }
    }
  }
  return { prefix: '', path: null, hasDna: false };
}

function aspectForFormat(format) {
  return format === 'long-3min' ? '16:9' : '9:16';
}

/**
 * 스크립트 경로에서 EP 디렉토리 추정 후 00_brief.md frontmatter 로드.
 * v2 layout: <epDir>/platforms/{long,shorts}/30_script.md  → epDir = ../../..
 * v1 layout: <epDir>/30_script.md                          → epDir = ..
 */
function loadBriefFrontmatterFromScriptPath(scriptPath) {
  const abs = resolve(scriptPath);
  // v2: .../EP-XXXX/platforms/{long|shorts}/30_script.md
  const v2Match = abs.match(/^(.*\/EP-[^/]+)\/platforms\/(?:long|shorts)\/30_script\.md$/);
  // v1: .../EP-XXXX/30_script.md
  const v1Match = abs.match(/^(.*\/EP-[^/]+)\/30_script\.md$/);
  const epDir = v2Match?.[1] || v1Match?.[1] || dirname(abs);
  const briefPath = join(epDir, '00_brief.md');
  if (!existsSync(briefPath)) return { epDir, briefFM: {} };
  try {
    const md = readFileSync(briefPath, 'utf-8');
    const m = md.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return { epDir, briefFM: {} };
    return { epDir, briefFM: parseYAML(m[1]) || {} };
  } catch {
    return { epDir, briefFM: {} };
  }
}

/**
 * character_override를 정책에 따라 검증·해석.
 *
 * 반환:
 *   { applied: false }                       — override 무효 (allowlist 미등록 또는 NEUTRAL_MASCOT 카테고리)
 *   { applied: true, descriptor, figure, treatment, sensitivity }  — caricature descriptor 적용
 *   throw Error                              — REQUIRES_LEGAL_REVIEW + 운영자 승인 누락
 */
export function resolveCharacterOverride(channel, overrideId, briefFM) {
  if (!overrideId) return { applied: false };
  const allowlist = loadAllowlist(channel);
  const figure = findFigureById(allowlist, overrideId);
  if (!figure) {
    // 미등록 — 무시하고 기본 DNA 적용 (정책 §2 fall-through, 일반인/비공인 NEUTRAL_MASCOT)
    return { applied: false, reason: `unregistered character_override="${overrideId}"` };
  }
  const { treatment, sensitivity, blockReason } = computeTreatment(figure, briefFM);
  if (treatment !== 'CHARACTERIZE') {
    if (blockReason) {
      // REQUIRES_LEGAL_REVIEW + 운영자 승인 누락 — 작업 중단 (Step #30 명시 사양)
      const e = new Error(
        `Public-figure policy BLOCKED: ${blockReason} ` +
        `(scene character_override="${overrideId}", category="${figure.category}"). ` +
        `정책 §2.2 / §5.2 — brief frontmatter에 legal_review_approved_by + legal_review_at 추가 후 재시도.`
      );
      e.code = 'EPF_LEGAL_REVIEW_REQUIRED';
      throw e;
    }
    // NEUTRAL_MASCOT 카테고리 (외국 연예인 등) — 무시
    return { applied: false, reason: `treatment=${treatment} → 기본 DNA 적용`, figure };
  }
  return {
    applied: true,
    descriptor: figure.descriptor_en,
    descriptorShort: figure.descriptor_short,
    figure,
    treatment,
    sensitivity,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
      // boolean flag — do not consume next token
    } else {
      opts[key] = next;
      i++;
    }
  }

  try {
    if (opts.prompt && opts.out) {
      const aspectRatio = opts.aspect || '9:16';
      const r = await generateImageGemini({ prompt: opts.prompt, outPath: resolve(opts.out), aspectRatio });
      console.log(`✅ Image saved: ${opts.out} (${(r.bytes / 1024).toFixed(1)} KB, ${r.mime})`);
    } else if (opts.script && opts['out-dir']) {
      const meta = parseFrontmatter(opts.script);
      const outDir = resolve(opts['out-dir']);

      const format = meta.format || 'shorts';
      const aspectRatio = opts.aspect || aspectForFormat(format);
      const resolved = opts['style-prefix']
        ? { prefix: opts['style-prefix'], path: '(CLI override)', hasDna: false }
        : resolveStylePrefix(meta.channel_id, format);
      const { prefix: stylePrefix, path: stylePath, hasDna } = resolved;

      // Override 적용 씬용 framing-only prefix (DNA 제외) 별도 준비
      let framingOnlyPrefix = '';
      if (!opts['style-prefix']) {
        const suffix = format === 'long-3min' ? 'long' : 'shorts';
        const sgCandidates = [
          resolve('workspace/channels', meta.channel_id, `style-guide-${suffix}.md`),
          resolve('workspace/channels', meta.channel_id, 'style-guide.md'),
        ];
        for (const sg of sgCandidates) {
          if (existsSync(sg)) {
            const f = loadChannelStylePrefix(sg);
            if (f) { framingOnlyPrefix = f; break; }
          }
        }
      } else {
        framingOnlyPrefix = opts['style-prefix'];
      }

      // brief.md frontmatter 로드 (character_override 정책 검증용)
      const { briefFM } = loadBriefFrontmatterFromScriptPath(opts.script);

      mkdirSync(outDir, { recursive: true });

      const resolution = opts.resolution || '1K';
      console.log(`📐 Format=${format} → aspect=${aspectRatio}, resolution=${resolution}, model=${DEFAULT_MODEL}`);
      if (stylePath) {
        console.log(`📋 Framing: ${stylePath.replace(process.cwd() + '/', '')}`);
        if (hasDna) console.log(`🧬 Character DNA: workspace/channels/${meta.channel_id}/character-dna.md`);
      }
      console.log(`🎨 Generating ${meta.scenes.length} images via Gemini...`);

      for (const scene of meta.scenes) {
        const outPath = join(outDir, `scene_${scene.scene_id}.png`);
        if (existsSync(outPath) && !opts.force) {
          console.log(`  ⏭  Scene ${scene.scene_id} exists (use --force to regen)`);
          continue;
        }

        // 1. Extract [palette:NAME] token from image_prompt (if present)
        const { prompt: cleanedPrompt, paletteName: tokenPalette } = extractPaletteToken(scene.image_prompt || '');

        // 2. Palette 색상 강제 제거 (2026-06-07 배경이미지 룰 개선)
        //    role→bullish/bearish/wealth 자동 색상(ROLE_PALETTE_FALLBACK)과 [palette:NAME]
        //    색상 블록 주입을 비활성화. style-guide framing + character DNA 는 유지하고,
        //    배경 색감은 콘텐츠/씬 image_prompt 에 위임한다. (extractPaletteToken 은
        //    cleanedPrompt 에서 [palette:] 토큰만 제거하는 용도로 계속 사용)
        const palettePick = null;
        const paletteBlock = '';

        // 3. Scene mascot mode (Hybrid v2, 2026-05-16) — 씬 이미지에서 마스코트 비중 결정.
        //    'minimal' (기본): full DNA 제외, framing only + corner accent 안내. 콘텐츠 dominant.
        //    'full': 기존 동작 — DNA + framing 그대로 (인기 채널 paradigm 전 호환).
        //    env var: BT_SCENE_DNA_MODE=full 로 legacy mode 복원 가능.
        const SCENE_DNA_MODE = process.env.BT_SCENE_DNA_MODE || 'minimal';
        let charPrefix;
        let dnaUsed;
        if (SCENE_DNA_MODE === 'minimal' && !scene.character_override) {
          const minimalMascotClause = `MASCOT POLICY for this scene: the BarroTube mascot is ABSENT by default. Optionally, a tiny mascot accent (max 8% of frame area, low opacity around 70%, in the bottom-right or bottom-left corner) is permitted only if it adds personality without competing with the dominant SCENE CONTENT. The dominant subject is the topic itself (chart/infographic/illustration), not the mascot.`;
          charPrefix = framingOnlyPrefix
            ? `${minimalMascotClause}\n\n${framingOnlyPrefix}`
            : minimalMascotClause;
          dnaUsed = false;
        } else {
          charPrefix = stylePrefix;
          dnaUsed = hasDna;
        }

        // 4. character_override 검증 (CEO 정책 v1.0, 2026-04-26) — 씬 mode와 무관하게 override 우선
        //    - allowlist 등록 + CHARACTERIZE → DNA 우회, descriptor_en 자동 prefix
        //    - REQUIRES_LEGAL_REVIEW + 운영자 미승인 → throw
        //    - NEUTRAL_MASCOT / 미등록 → 무시 (기본 DNA 사용)
        let overrideTag = '';
        if (scene.character_override) {
          const ov = resolveCharacterOverride(meta.channel_id, scene.character_override, briefFM);
          if (ov.applied) {
            // DNA 블록 prepend 생략 (framing-only로 다운그레이드) + descriptor_en prefix
            // PRIMARY CHARACTER 강조 wrapper로 식별 단서가 합성의 1순위가 되도록 보장.
            // sensitivity high 에서도 식별 단서는 유지 (allowlist v1.2 / 정책 §4.3).
            const primaryCharacterClause =
              `PRIMARY CHARACTER (must be clearly recognizable, identifying features unambiguous): ${ov.descriptor}. ` +
              `Trademark visual cues MUST be visible (the figure is the named public-figure caricature, NOT a generic mascot or anonymous stick-figure).`;
            charPrefix = framingOnlyPrefix
              ? `${primaryCharacterClause}\n\n${framingOnlyPrefix}`
              : primaryCharacterClause;
            dnaUsed = false;
            overrideTag = ` [character_override:${scene.character_override}/${ov.treatment}/${ov.sensitivity}]`;
          } else {
            overrideTag = ` [character_override:${scene.character_override}/IGNORED]`;
            if (ov.reason) {
              console.warn(`  ⚠ Scene ${scene.scene_id} character_override 무시: ${ov.reason}`);
            }
          }
        }

        // 4. brief.visual_keywords scene-index 매핑 (G2, 2026-05-16)
        //    운영자가 brief.visual_keywords[N]로 시각 키워드를 명시한 경우 Writer가
        //    image_prompt에 흡수했는지와 무관하게 안전망으로 prompt에 prepend.
        const visualKeywords = Array.isArray(briefFM?.visual_keywords) ? briefFM.visual_keywords : [];
        const sceneIndex = parseInt(scene.scene_id, 10) - 1;
        const visualHint = visualKeywords[sceneIndex] || null;
        const visualHintBlock = visualHint
          ? `BRIEF VISUAL HINT (operator-provided priority subject for this scene): ${visualHint}. This subject must dominate the composition; the mascot is supporting.`
          : '';

        // 5. Emotion overlay (G3, 2026-05-16) — character-dna v10 emotion_pack 자동 적용.
        //    CHARACTERIZE 캐리커처(character_override) 씬은 인물 표정이 우선이라 emotion overlay skip.
        const emotionKey = (dnaUsed && !scene.character_override) ? selectEmotionForScene(scene) : null;
        const emotionBlock = emotionKey ? EMOTION_OVERLAYS[emotionKey] : '';

        // 6. Compose final prompt: char + emotion + palette + visual hint + scene image_prompt
        const parts = [charPrefix, emotionBlock, paletteBlock, visualHintBlock, cleanedPrompt].filter(Boolean);
        const fullPrompt = parts.join('\n\n');

        await generateImageGemini({
          prompt: fullPrompt,
          outPath,
          aspectRatio,
          resolution,
          costContext: {
            episode: meta.episode_id || null,
            stage: 'S6c',
            note: `scene_${scene.scene_id}`,
          },
        });
        const paletteTag = palettePick ? ` [palette:${palettePick}${tokenPalette ? '' : ' auto'}]` : '';
        const dnaTag = scene.character_override && !dnaUsed ? ' [dna:bypassed]' : '';
        console.log(`  ✅ Scene ${scene.scene_id}${paletteTag}${overrideTag}${dnaTag}`);
      }
      console.log(`\n🎨 All images saved in ${outDir}`);
    } else {
      console.error('Usage: generate-image-gemini.js --prompt "..." --out path.png [--aspect 9:16|16:9]');
      console.error('   or: generate-image-gemini.js --script 30_script.md --out-dir assets/images/ [--force]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ Gemini image gen failed: ${e.message}`);
    process.exit(1);
  }
}
