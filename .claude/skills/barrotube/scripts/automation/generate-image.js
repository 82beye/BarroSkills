#!/usr/bin/env node

/**
 * generate-image.js — FAL AI 이미지 생성 (flux-schnell 기본)
 *
 * Usage:
 *   node generate-image.js --prompt "..." --out path/scene_001.png
 *   node generate-image.js --script <episode_dir>/30_script.md --out-dir <assets>/images/ --style-prefix "..."
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';

// 모델 선택: 'flux-schnell' (photorealism), 'recraft-v3' (cartoon/vector), 'ideogram-v2' (illustration+text)
const FAL_MODEL_MAP = {
  'flux-schnell': 'fal-ai/flux/schnell',
  'recraft-v3': 'fal-ai/recraft-v3',
  'ideogram-v2': 'fal-ai/ideogram/v2',
};
const FAL_MODEL_NAME = process.env.FAL_MODEL || 'recraft-v3';
const FAL_URL = `https://fal.run/${FAL_MODEL_MAP[FAL_MODEL_NAME] || FAL_MODEL_MAP['recraft-v3']}`;

export async function generateImage({ prompt, outPath, imageSize = { width: 1080, height: 1920 }, numSteps = 4 }) {
  const apiKey = getSecret('FAL_API_KEY');
  if (!apiKey) throw new Error('FAL_API_KEY not set in .env');

  // 모델별 페이로드 포맷 차이 처리
  let body;
  if (FAL_MODEL_NAME === 'recraft-v3') {
    // digital_illustration — Shorts에서 검증된 최적 스타일 (stick figure + line art)
    // (vector_illustration은 SVG 반환 + 과한 캐릭터 디테일로 역효과)
    body = {
      prompt,
      image_size: imageSize,
      style: 'digital_illustration',
    };
  } else if (FAL_MODEL_NAME === 'ideogram-v2') {
    body = {
      prompt,
      aspect_ratio: '9:16',
      style: 'design',
    };
  } else {
    body = {
      prompt,
      image_size: imageSize,
      num_inference_steps: numSteps,
      num_images: 1,
      enable_safety_checker: true,
    };
  }

  const res = await fetch(FAL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`FAL image gen failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const imgUrl = data.images?.[0]?.url;
  if (!imgUrl) throw new Error(`No image URL in FAL response: ${JSON.stringify(data).slice(0, 200)}`);

  // 이미지 다운로드
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

  mkdirSync(dirname(outPath), { recursive: true });

  // Recraft vector_illustration style returns SVG — rasterize to PNG for ffmpeg compat
  const isSvg = imgBuffer.slice(0, 512).toString('utf-8').match(/<svg[\s>]/);
  if (isSvg && outPath.endsWith('.png')) {
    const { execSync } = await import('node:child_process');
    const svgTmp = outPath.replace(/\.png$/, '.tmp.svg');
    writeFileSync(svgTmp, imgBuffer);
    try {
      const w = imageSize?.width || 1920;
      const h = imageSize?.height || 1080;
      execSync(`rsvg-convert -w ${w} -h ${h} -o "${outPath}" "${svgTmp}"`);
    } catch (e) {
      throw new Error(`SVG→PNG conversion failed (install librsvg?): ${e.message}`);
    } finally {
      const { unlinkSync } = await import('node:fs');
      try { unlinkSync(svgTmp); } catch {}
    }
    const { statSync } = await import('node:fs');
    return { path: outPath, bytes: statSync(outPath).size, sourceUrl: imgUrl, format: 'svg→png' };
  }

  writeFileSync(outPath, imgBuffer);
  return { path: outPath, bytes: imgBuffer.length, sourceUrl: imgUrl };
}

function parseFrontmatter(mdPath) {
  const content = readFileSync(mdPath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No YAML frontmatter');
  return parseYAML(match[1]);
}

/**
 * channel style-guide.md에서 ### Style Prefix 블록 추출
 */
function loadChannelStylePrefix(styleGuidePath) {
  const md = readFileSync(styleGuidePath, 'utf-8');
  const m = md.match(/###\s*Style Prefix[^\n]*\n```\n([\s\S]*?)\n```/);
  if (!m) return '';
  return m[1].trim();
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
    // boolean flag if next token is missing or is another --option
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }

  // FAL image_size — CLI --image-size가 최우선, 아니면 script format 기반 자동, default는 shorts 9:16
  let imageSize = null;
  if (opts['image-size']) {
    const m = opts['image-size'].match(/^(\d+)x(\d+)$/);
    if (m) imageSize = { width: Number(m[1]), height: Number(m[2]) };
    else imageSize = opts['image-size'];
  }

  try {
    if (opts.prompt && opts.out) {
      if (!imageSize) imageSize = { width: 1080, height: 1920 };
      const r = await generateImage({ prompt: opts.prompt, outPath: resolve(opts.out), imageSize });
      console.log(`✅ Image saved: ${opts.out} (${(r.bytes / 1024).toFixed(1)} KB)`);
    } else if (opts.script && opts['out-dir']) {
      const meta = parseFrontmatter(opts.script);
      const outDir = resolve(opts['out-dir']);
      const format = meta.format || 'shorts';

      // Character consistency: past Shorts (EP-2026-0002/0007/0008) were generated
      // by Gemini. To keep Long-form visually consistent with Shorts, Long routes
      // to the same Gemini model at the same 1K default resolution. The only
      // differences are aspect (16:9 vs 9:16) and bottom subtitle-reserve area.
      // Opt-out: --use-recraft forces Recraft V3 on this call.
      if (format === 'long-3min' && !opts['use-recraft']) {
        console.log(`📺 Long-form → routing to Gemini 3.1 Flash Image Preview (1K, matches Shorts)`);
        const { execSync } = await import('node:child_process');
        const geminiScript = join(import.meta.dirname, 'generate-image-gemini.js');
        const flags = [`--script "${opts.script}"`, `--out-dir "${opts['out-dir']}"`, `--resolution 1K`];
        if (opts.force) flags.push('--force');
        execSync(`node "${geminiScript}" ${flags.join(' ')}`, { stdio: 'inherit' });
        process.exit(0);
      }
      // Explicit --use-gemini (shorts opt-in for experiments)
      if (opts['use-gemini']) {
        console.log(`📺 --use-gemini → routing to Gemini 3.1 Flash Image Preview`);
        const { execSync } = await import('node:child_process');
        const geminiScript = join(import.meta.dirname, 'generate-image-gemini.js');
        const flags = [`--script "${opts.script}"`, `--out-dir "${opts['out-dir']}"`];
        if (opts.force) flags.push('--force');
        execSync(`node "${geminiScript}" ${flags.join(' ')}`, { stdio: 'inherit' });
        process.exit(0);
      }

      // Auto-infer imageSize from script format if not specified
      if (!imageSize) {
        imageSize = format === 'long-3min'
          ? { width: 1920, height: 1080 }   // 16:9
          : { width: 1080, height: 1920 };  // 9:16
        console.log(`📐 Format=${format} → imageSize=${imageSize.width}x${imageSize.height} (Recraft V3)`);
      }

      // style-prefix 우선순위: CLI > channel style-guide-{format}.md > style-guide.md > 빈 문자열
      let stylePrefix = opts['style-prefix'] || '';
      if (!stylePrefix && meta.channel_id) {
        const format = meta.format || 'shorts';
        const candidates = [
          resolve('workspace/channels', meta.channel_id, `style-guide-${format === 'long-3min' ? 'long' : 'shorts'}.md`),
          resolve('workspace/channels', meta.channel_id, 'style-guide.md'),
        ];
        for (const sg of candidates) {
          if (existsSync(sg)) {
            stylePrefix = loadChannelStylePrefix(sg);
            if (stylePrefix) {
              console.log(`📋 Style prefix loaded from: ${sg.split('/').slice(-3).join('/')}`);
              break;
            }
          }
        }
      }
      mkdirSync(outDir, { recursive: true });
      console.log(`🎨 Generating ${meta.scenes.length} images (${imageSize})...`);
      for (const scene of meta.scenes) {
        const outPath = join(outDir, `scene_${scene.scene_id}.png`);
        if (existsSync(outPath) && !opts.force) {
          console.log(`  ⏭  Scene ${scene.scene_id} exists`);
          continue;
        }
        const fullPrompt = stylePrefix ? `${stylePrefix}. ${scene.image_prompt}` : scene.image_prompt;
        await generateImage({ prompt: fullPrompt, outPath, imageSize });
        console.log(`  ✅ Scene ${scene.scene_id}`);
      }
      console.log(`\n🎨 All images generated in ${outDir}`);
    } else {
      console.error('Usage: generate-image.js --prompt "..." --out path.png [--image-size portrait_16_9]');
      console.error('   or: generate-image.js --script 30_script.md --out-dir assets/images/ [--style-prefix "..."] [--force]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ Image gen failed: ${e.message}`);
    process.exit(1);
  }
}
