#!/usr/bin/env node

/**
 * CapCut Builder v2 — 테스트 빌드
 * 더미 이미지/오디오로 CapCut 프로젝트를 생성하고 CapCut에서 열 수 있는지 검증
 */

import { buildCapCutProject } from './src/capcut-draft-builder.js';
import { writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const PROJECT_NAME = 'BT-Rich5';
const PROJECT_DIR = join(
  homedir(),
  'Movies/CapCut/User Data/Projects/com.lveditor.draft',
  PROJECT_NAME
);
const ASSETS_DIR = join(PROJECT_DIR, 'Resources', 'assets');

// 1. 프로젝트 내부에 자산 디렉터리 생성
mkdirSync(join(ASSETS_DIR, 'images'), { recursive: true });
mkdirSync(join(ASSETS_DIR, 'tts'), { recursive: true });

console.log('🔨 Creating test assets inside project dir...');
console.log(`   ${ASSETS_DIR}`);

// 더미 이미지 생성 (1920x1080 컬러 이미지)
const colors = ['#1E3A5F', '#F4A261', '#E63946', '#2A9D8F', '#264653'];
for (let i = 0; i < 5; i++) {
  const imgPath = join(ASSETS_DIR, 'images', `scene_${String(i + 1).padStart(3, '0')}.png`);
  if (!existsSync(imgPath)) {
    try {
      execSync(
        `ffmpeg -y -f lavfi -i color=c='${colors[i]}':size=1920x1080:d=1 -frames:v 1 "${imgPath}" 2>/dev/null`,
        { stdio: 'pipe' }
      );
    } catch {
      writeFileSync(imgPath, Buffer.alloc(100));
    }
  }
}

// 더미 오디오 생성 (무음 WAV)
const durations = [10, 15, 12, 18, 8];
for (let i = 0; i < 5; i++) {
  const ttsPath = join(ASSETS_DIR, 'tts', `scene_${String(i + 1).padStart(3, '0')}.wav`);
  if (!existsSync(ttsPath)) {
    try {
      execSync(
        `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${durations[i]} "${ttsPath}" 2>/dev/null`,
        { stdio: 'pipe' }
      );
    } catch {
      writeFileSync(ttsPath, Buffer.alloc(100));
    }
  }
}

// 더미 BGM
const bgmPath = join(ASSETS_DIR, 'bgm.wav');
if (!existsSync(bgmPath)) {
  try {
    execSync(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t 63 "${bgmPath}" 2>/dev/null`,
      { stdio: 'pipe' }
    );
  } catch {
    writeFileSync(bgmPath, Buffer.alloc(100));
  }
}

console.log('✅ Test assets created');

// 2. 씬 데이터 (프로젝트 내부 절대 경로)
const scenes = durations.map((dur, i) => ({
  imagePath: join(ASSETS_DIR, 'images', `scene_${String(i + 1).padStart(3, '0')}.png`),
  ttsPath: join(ASSETS_DIR, 'tts', `scene_${String(i + 1).padStart(3, '0')}.wav`),
  narration: [
    '2026년, AI가 세계 경제를 어떻게 바꾸고 있을까요?',
    'IMF에 따르면 AI는 글로벌 GDP에 4조 4천억 달러를 추가할 전망입니다.',
    '특히 반도체, 클라우드, 자율주행 산업이 가장 큰 수혜를 받고 있습니다.',
    '한국 경제에도 AI 반도체 수출이 핵심 성장 동력이 되고 있는데요.',
    '변화를 아는 것, 그것이 준비의 시작입니다.',
  ][i],
  durationUs: dur * 1_000_000,
}));

const totalDurationUs = durations.reduce((s, d) => s + d, 0) * 1_000_000;

// 3. CapCut 프로젝트 생성 (이미 만든 디렉터리에)
console.log('\n🎬 Building CapCut project...');

const result = buildCapCutProject({
  projectName: PROJECT_NAME,
  scenes,
  bgmPath,
  subtitleStyle: {
    fontFamily: '',
    fontSize: 5,
    fontColor: '#FFFFFF',
  },
  totalDurationUs,
  outputDir: PROJECT_DIR,
});

console.log(`\n✅ CapCut project created!`);
console.log(`   📁 Path: ${result.projectDir}`);
console.log(`   🎞 Scenes: ${result.scenesCount}`);
console.log(`   🎵 Tracks: ${result.tracksCount}`);
console.log(`   ⏱ Duration: ${result.totalDurationSec}s`);
console.log(`\n📋 Restart CapCut and open "${PROJECT_NAME}"`);
