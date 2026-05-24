#!/usr/bin/env node

/**
 * capcut-builder CLI — BarroTube
 * PRD §8.2: CapCut PC 호환 draft_content.json 빌더
 *
 * Usage:
 *   capcut-builder build \
 *     --script   workspace/episodes/EP-2026-0001/30_script.md \
 *     --assets   workspace/episodes/EP-2026-0001/40_assets \
 *     --style    workspace/channels/econ-daily/style-guide.md \
 *     --os       darwin \
 *     --out      workspace/episodes/EP-2026-0001/50_capcut_draft.json \
 *     --validate strict
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { platform } from 'node:os';

// ──────────────────────────────────────────────
// YAML frontmatter parser (minimal, no deps)
// ──────────────────────────────────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  // Simple YAML-to-JSON for our known schema
  // Handles nested arrays of objects with indentation
  return parseSimpleYaml(yaml);
}

function parseSimpleYaml(yaml) {
  const lines = yaml.split('\n');
  const result = {};
  let currentKey = null;
  let currentArray = null;
  let currentObj = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (kvMatch && !line.startsWith('  ')) {
      currentArray = null;
      currentObj = null;
      const [, key, val] = kvMatch;
      result[key] = parseValue(val);
      currentKey = key;
      continue;
    }

    // Top-level key with no value (start of array/object)
    const keyOnlyMatch = trimmed.match(/^(\w+):$/);
    if (keyOnlyMatch && !line.startsWith('  ')) {
      currentKey = keyOnlyMatch[1];
      result[currentKey] = [];
      currentArray = result[currentKey];
      currentObj = null;
      continue;
    }

    // Array item start
    if (trimmed.startsWith('- ') && currentArray !== null) {
      const itemKV = trimmed.match(/^-\s+(\w+):\s*(.+)$/);
      if (itemKV) {
        currentObj = {};
        currentObj[itemKV[1]] = parseValue(itemKV[2]);
        currentArray.push(currentObj);
      }
      continue;
    }

    // Nested key in current object
    if (currentObj && trimmed.match(/^\w+:\s*.+$/)) {
      const [, nk, nv] = trimmed.match(/^(\w+):\s*(.+)$/);
      currentObj[nk] = parseValue(nv);
      continue;
    }

    // Nested array in object
    if (currentObj && trimmed.match(/^\w+:$/)) {
      const nk = trimmed.replace(':', '');
      currentObj[nk] = [];
      continue;
    }
  }

  return result;
}

function parseValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  if (/^\d+\.\d+$/.test(val)) return parseFloat(val);
  if (val.startsWith('[') && val.endsWith(']')) {
    return val.slice(1, -1).split(',').map(s => parseValue(s.trim()));
  }
  return val.replace(/^["']|["']$/g, '');
}

// ──────────────────────────────────────────────
// Style guide parser
// ──────────────────────────────────────────────
function parseStyleGuide(stylePath) {
  const content = readFileSync(stylePath, 'utf-8');

  const defaults = {
    font_family: 'Pretendard',
    font_size: 48,
    font_color: '#FFFFFF',
    stroke_color: '#000000',
    stroke_width: 2,
    position: 'bottom_center',
    margin_bottom: 80,
  };

  // Extract font family
  const fontMatch = content.match(/Font Family[:\s]*(\w+)/i);
  if (fontMatch) defaults.font_family = fontMatch[1];

  // Extract font size
  const sizeMatch = content.match(/Font Size[:\s]*(\d+)/i);
  if (sizeMatch) defaults.font_size = parseInt(sizeMatch[1], 10);

  // Extract colors
  const colorMatch = content.match(/Color[:\s]*(#[0-9A-Fa-f]{6})/i);
  if (colorMatch) defaults.font_color = colorMatch[1];

  return defaults;
}

// ──────────────────────────────────────────────
// Path converter (FR-CC-002)
// ──────────────────────────────────────────────
function convertPath(filePath, targetOS) {
  const absPath = isAbsolute(filePath) ? filePath : resolve(filePath);

  if (targetOS === 'win32' || targetOS === 'windows') {
    return absPath.replace(/\//g, '\\');
  }
  return absPath; // macOS/Linux paths are already correct
}

// ──────────────────────────────────────────────
// Draft builder
// ──────────────────────────────────────────────
function buildDraft(scriptPath, assetsDir, stylePath, targetOS, validateMode) {
  // 1. Parse script
  const scriptContent = readFileSync(scriptPath, 'utf-8');
  const frontmatter = parseFrontmatter(scriptContent);

  if (!frontmatter || !frontmatter.scenes) {
    throw new Error('Script frontmatter missing or no scenes array found');
  }

  const scenes = frontmatter.scenes;
  const subtitleStyle = parseStyleGuide(stylePath);

  // 2. Load asset manifest
  const manifestPath = join(assetsDir, 'asset_manifest.json');
  let manifest = null;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  }

  // 3. Build materials
  const materials = { videos: [], audios: [], texts: [] };
  let cumulativeTime = 0; // in microseconds

  for (const scene of scenes) {
    const sceneId = scene.scene_id;
    const imgPath = join(assetsDir, 'images', `scene_${sceneId}.png`);
    const ttsPath = join(assetsDir, 'tts', `scene_${sceneId}.wav`);

    // Get TTS length from manifest or use target_seconds
    let durationSeconds = scene.target_seconds;
    if (manifest) {
      const assetInfo = manifest.assets?.find(a => a.scene_id === sceneId);
      if (assetInfo?.tts_length_seconds) {
        durationSeconds = assetInfo.tts_length_seconds;
      }
    }

    const durationUs = Math.round(durationSeconds * 1_000_000);

    // Image material
    materials.videos.push({
      id: `mat_img_${sceneId}`,
      type: 'photo',
      path: convertPath(imgPath, targetOS),
      width: 1920,
      height: 1080,
    });

    // TTS material
    materials.audios.push({
      id: `mat_tts_${sceneId}`,
      type: 'audio',
      path: convertPath(ttsPath, targetOS),
      duration: durationUs,
    });

    // Subtitle material
    materials.texts.push({
      id: `mat_sub_${sceneId}`,
      type: 'subtitle',
      content: scene.narration,
      font: subtitleStyle.font_family,
      color: subtitleStyle.font_color,
      size: subtitleStyle.font_size,
    });
  }

  // BGM material
  const bgmPath = join(assetsDir, 'bgm.wav');
  const totalDurationUs = scenes.reduce((sum, s) => {
    let dur = s.target_seconds;
    if (manifest) {
      const a = manifest.assets?.find(a2 => a2.scene_id === s.scene_id);
      if (a?.tts_length_seconds) dur = a.tts_length_seconds;
    }
    return sum + Math.round(dur * 1_000_000);
  }, 0);

  materials.audios.push({
    id: 'mat_bgm',
    type: 'audio',
    path: convertPath(bgmPath, targetOS),
    duration: totalDurationUs,
  });

  // 4. Build tracks
  const videoTrack = { type: 'video', segments: [] };
  const audioTrack = { type: 'audio', segments: [] };
  const bgmTrack = { type: 'audio', attribute: 'bgm', segments: [] };
  const subtitleTrack = { type: 'text', attribute: 'subtitle', segments: [] };

  cumulativeTime = 0;
  for (const scene of scenes) {
    const sceneId = scene.scene_id;
    let durationSeconds = scene.target_seconds;
    if (manifest) {
      const assetInfo = manifest.assets?.find(a => a.scene_id === sceneId);
      if (assetInfo?.tts_length_seconds) durationSeconds = assetInfo.tts_length_seconds;
    }
    const durationUs = Math.round(durationSeconds * 1_000_000);

    videoTrack.segments.push({
      material_id: `mat_img_${sceneId}`,
      target_timerange: { start: cumulativeTime, duration: durationUs },
    });

    audioTrack.segments.push({
      material_id: `mat_tts_${sceneId}`,
      target_timerange: { start: cumulativeTime, duration: durationUs },
    });

    subtitleTrack.segments.push({
      material_id: `mat_sub_${sceneId}`,
      target_timerange: { start: cumulativeTime, duration: durationUs },
    });

    cumulativeTime += durationUs;
  }

  bgmTrack.segments.push({
    material_id: 'mat_bgm',
    target_timerange: { start: 0, duration: totalDurationUs },
    volume: 0.15,
  });

  // 5. Assemble draft
  const draft = {
    materials,
    tracks: [videoTrack, audioTrack, bgmTrack, subtitleTrack],
    extra_material_refs: {
      subtitle_style: subtitleStyle,
    },
    canvas_config: {
      width: 1920,
      height: 1080,
      ratio: '16:9',
    },
  };

  // 6. Validate if strict mode
  if (validateMode === 'strict') {
    const errors = validateDraft(draft, assetsDir);
    if (errors.length > 0) {
      console.error('\n❌ Validation failed (--validate strict):');
      for (const err of errors) {
        console.error(`   • ${err}`);
      }
      process.exit(1);
    }
    console.log('✅ Validation passed (strict mode)');
  }

  return draft;
}

// ──────────────────────────────────────────────
// Validator (FR-CC-002 --validate strict)
// ──────────────────────────────────────────────
function validateDraft(draft, assetsDir) {
  const errors = [];

  // 1. Check all asset paths exist
  for (const mat of [...draft.materials.videos, ...draft.materials.audios]) {
    const p = mat.path.replace(/\\/g, '/'); // normalize for check
    if (!existsSync(p)) {
      errors.push(`Missing asset: ${mat.path} (id: ${mat.id})`);
    }
  }

  // 2. Check all segments have positive duration
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      if (seg.target_timerange.duration <= 0) {
        errors.push(`Zero/negative duration: ${seg.material_id} (${seg.target_timerange.duration})`);
      }
    }
  }

  // 3. Check no time overlaps within same track
  for (const track of draft.tracks) {
    const sorted = [...track.segments].sort(
      (a, b) => a.target_timerange.start - b.target_timerange.start
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevEnd = prev.target_timerange.start + prev.target_timerange.duration;
      if (prevEnd > curr.target_timerange.start) {
        errors.push(
          `Time overlap on track "${track.type}": ${prev.material_id} ends at ${prevEnd} but ${curr.material_id} starts at ${curr.target_timerange.start}`
        );
      }
    }
  }

  return errors;
}

// ──────────────────────────────────────────────
// CLI Entry
// ──────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'build') {
    console.log('capcut-builder v1.0.0 — BarroTube CapCut Draft Builder');
    console.log('');
    console.log('Usage:');
    console.log('  capcut-builder build [options]');
    console.log('');
    console.log('Options:');
    console.log('  --script   Path to 30_script.md');
    console.log('  --assets   Path to 40_assets/ directory');
    console.log('  --style    Path to style-guide.md');
    console.log('  --os       Target OS (darwin | win32)');
    console.log('  --out      Output path for draft JSON');
    console.log('  --validate Validation mode (strict | warn | none)');
    process.exit(0);
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      script: { type: 'string' },
      assets: { type: 'string' },
      style: { type: 'string' },
      os: { type: 'string', default: platform() },
      out: { type: 'string' },
      validate: { type: 'string', default: 'warn' },
    },
  });

  if (!values.script || !values.assets || !values.style || !values.out) {
    console.error('Missing required options. Run `capcut-builder` for help.');
    process.exit(1);
  }

  // Resolve paths
  const scriptPath = resolve(values.script);
  const assetsDir = resolve(values.assets);
  const stylePath = resolve(values.style);
  const outPath = resolve(values.out);
  const targetOS = values.os;

  console.log(`\n🎬 capcut-builder v1.0.0`);
  console.log(`   Script: ${scriptPath}`);
  console.log(`   Assets: ${assetsDir}`);
  console.log(`   Style:  ${stylePath}`);
  console.log(`   OS:     ${targetOS}`);
  console.log(`   Output: ${outPath}`);
  console.log(`   Validate: ${values.validate}`);

  // Verify inputs exist
  if (!existsSync(scriptPath)) {
    console.error(`❌ Script not found: ${scriptPath}`);
    process.exit(1);
  }
  if (!existsSync(assetsDir)) {
    console.error(`❌ Assets directory not found: ${assetsDir}`);
    process.exit(1);
  }
  if (!existsSync(stylePath)) {
    console.error(`❌ Style guide not found: ${stylePath}`);
    process.exit(1);
  }

  const draft = buildDraft(scriptPath, assetsDir, stylePath, targetOS, values.validate);
  writeFileSync(outPath, JSON.stringify(draft, null, 2), 'utf-8');

  const scenesCount = draft.materials.videos.length;
  const totalDurationS = draft.tracks[0].segments.reduce(
    (s, seg) => s + seg.target_timerange.duration, 0
  ) / 1_000_000;

  console.log(`\n✅ Draft generated successfully!`);
  console.log(`   Scenes: ${scenesCount}`);
  console.log(`   Total duration: ${totalDurationS.toFixed(1)}s (${(totalDurationS / 60).toFixed(1)}min)`);
  console.log(`   Materials: ${draft.materials.videos.length} images, ${draft.materials.audios.length} audio, ${draft.materials.texts.length} subtitles`);
  console.log(`   Tracks: ${draft.tracks.length}`);
  console.log(`   Output: ${outPath}`);
}

main();
