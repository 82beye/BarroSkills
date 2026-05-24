#!/usr/bin/env node

/**
 * build-capcut-from-episode.js
 * 에피소드 디렉토리로부터 CapCut 프로젝트(자막 포함) 생성.
 * 사용자가 CapCut에서 열어 확인 후 수동 Export 가능.
 *
 * Usage:
 *   node build-capcut-from-episode.js --episode <dir> [--name <capcut_project_name>]
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { parse as parseYAML } from 'yaml';
import { buildCapCutProject } from '../../tools/capcut-builder/src/capcut-draft-builder.js';
import { resolvePaths, detectPrimaryPlatform } from './paths.js';

const CAPCUT_PROJECTS_DIR = join(homedir(), 'Movies/CapCut/User Data/Projects/com.lveditor.draft');

const { values } = parseArgs({
  options: {
    episode: { type: 'string', short: 'e' },
    name: { type: 'string', short: 'n' },
    platform: { type: 'string' },
  },
});

if (!values.episode) {
  console.error('Usage: build-capcut-from-episode.js --episode <dir> [--name <project>] [--platform long|shorts]');
  process.exit(1);
}

const episodeDir = resolve(values.episode);
const platform = values.platform || detectPrimaryPlatform(episodeDir);
const p = resolvePaths(episodeDir, platform);
const scriptPath = p.script;
const assetsDir = p.assetsDir;

if (!existsSync(scriptPath)) {
  console.error(`❌ Missing ${scriptPath}`);
  process.exit(1);
}

const md = readFileSync(scriptPath, 'utf-8');
const match = md.match(/^---\n([\s\S]*?)\n---/);
const meta = parseYAML(match[1]);

const projectName = values.name || `BT-${meta.episode_id || 'untitled'}`;
const projectDir = join(CAPCUT_PROJECTS_DIR, projectName);

// CapCut 샌드박스 이슈 회피: 자산을 프로젝트 내부 Resources/assets로 복사
const projectAssetsDir = join(projectDir, 'Resources', 'assets');
mkdirSync(join(projectAssetsDir, 'images'), { recursive: true });
mkdirSync(join(projectAssetsDir, 'tts'), { recursive: true });

console.log(`📋 Copying assets into CapCut project sandbox...`);
const scenes = meta.scenes.map(s => {
  const srcImg = join(assetsDir, 'images', `scene_${s.scene_id}.png`);
  const srcTts = join(assetsDir, 'tts', `scene_${s.scene_id}.wav`);
  if (!existsSync(srcImg)) throw new Error(`Missing image: ${srcImg}`);
  if (!existsSync(srcTts)) throw new Error(`Missing tts: ${srcTts}`);

  const dstImg = join(projectAssetsDir, 'images', `scene_${s.scene_id}.png`);
  const dstTts = join(projectAssetsDir, 'tts', `scene_${s.scene_id}.wav`);

  // ffmpeg으로 재인코딩 + CapCut이 인식하는 quarantine xattr 부여
  // (CapCut 샌드박스가 외부 복사 파일을 "파일에 액세스할 수 없음"으로 거부하는 이슈 회피)
  execSync(`ffmpeg -y -i "${srcImg}" "${dstImg}" -loglevel error`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -i "${srcTts}" "${dstTts}" -loglevel error`, { stdio: 'pipe' });
  execSync(`xattr -w com.apple.quarantine "0086;69e303e8;CapCut;" "${dstImg}"`, { stdio: 'pipe' });
  execSync(`xattr -w com.apple.quarantine "0086;69e303e8;CapCut;" "${dstTts}"`, { stdio: 'pipe' });

  return {
    imagePath: dstImg,
    ttsPath: dstTts,
    narration: s.narration,
    durationUs: (s.target_seconds || 12) * 1_000_000,
    imageWidth: 1080,
    imageHeight: 1920,
  };
});

const totalUs = scenes.reduce((a, s) => a + s.durationUs, 0);

const result = buildCapCutProject({
  projectName,
  scenes,
  bgmPath: null,
  subtitleStyle: { fontFamily: '', fontSize: 5, fontColor: '#FFFFFF' },
  totalDurationUs: totalUs,
  canvas: 'vertical',
  outputDir: projectDir,
});

console.log(`\n✅ CapCut project created: ${projectName}`);
console.log(`   📁 ${result.projectDir}`);
console.log(`   🎞 Scenes: ${result.scenesCount}`);
console.log(`   ⏱ Duration: ${result.totalDurationSec}s`);
console.log(`\n📋 CapCut 앱을 재시작 → 프로젝트 "${projectName}" 열기`);
