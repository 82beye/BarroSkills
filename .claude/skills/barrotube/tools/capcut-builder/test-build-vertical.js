#!/usr/bin/env node

/**
 * CapCut Builder — 9:16 세로 포맷 테스트 빌드
 * YouTube Shorts / TikTok / Reels 공용 마스터 생성 검증
 */

import { buildCapCutProject } from './src/capcut-draft-builder.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const PROJECT_NAME = 'BT-Vertical-60s';
const PROJECT_DIR = join(
  homedir(),
  'Movies/CapCut/User Data/Projects/com.lveditor.draft',
  PROJECT_NAME
);
const ASSETS_DIR = join(PROJECT_DIR, 'Resources', 'assets');

mkdirSync(join(ASSETS_DIR, 'images'), { recursive: true });
mkdirSync(join(ASSETS_DIR, 'tts'), { recursive: true });

console.log('🔨 Creating vertical (9:16) test assets...');
console.log(`   ${ASSETS_DIR}`);

// 숏폼은 3~5씬, 총 45~60초가 최적
const scenesMeta = [
  { color: '#1E3A5F', duration: 10, text: '2026년, AI가 경제를 바꾸는 핵심 3가지' },
  { color: '#F4A261', duration: 14, text: 'IMF 예측: 글로벌 GDP에 4.4조 달러 추가' },
  { color: '#E63946', duration: 12, text: '가장 큰 수혜는 반도체·클라우드·자율주행' },
  { color: '#2A9D8F', duration: 14, text: '한국은 AI 반도체 수출이 핵심 동력' },
  { color: '#264653', duration: 10, text: '변화를 아는 것이 준비의 시작입니다' },
];

// 1080x1920 더미 이미지
scenesMeta.forEach((s, i) => {
  const p = join(ASSETS_DIR, 'images', `scene_${String(i + 1).padStart(3, '0')}.png`);
  if (!existsSync(p)) {
    try {
      execSync(
        `ffmpeg -y -f lavfi -i color=c='${s.color}':size=1080x1920:d=1 -frames:v 1 "${p}" 2>/dev/null`,
        { stdio: 'pipe' }
      );
    } catch {
      writeFileSync(p, Buffer.alloc(100));
    }
  }
});

// 무음 TTS
scenesMeta.forEach((s, i) => {
  const p = join(ASSETS_DIR, 'tts', `scene_${String(i + 1).padStart(3, '0')}.wav`);
  if (!existsSync(p)) {
    try {
      execSync(
        `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${s.duration} "${p}" 2>/dev/null`,
        { stdio: 'pipe' }
      );
    } catch {
      writeFileSync(p, Buffer.alloc(100));
    }
  }
});

const totalSec = scenesMeta.reduce((a, s) => a + s.duration, 0);
const bgmPath = join(ASSETS_DIR, 'bgm.wav');
if (!existsSync(bgmPath)) {
  try {
    execSync(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${totalSec} "${bgmPath}" 2>/dev/null`,
      { stdio: 'pipe' }
    );
  } catch {
    writeFileSync(bgmPath, Buffer.alloc(100));
  }
}

console.log('✅ Assets created');

const scenes = scenesMeta.map((s, i) => ({
  imagePath: join(ASSETS_DIR, 'images', `scene_${String(i + 1).padStart(3, '0')}.png`),
  ttsPath: join(ASSETS_DIR, 'tts', `scene_${String(i + 1).padStart(3, '0')}.wav`),
  narration: s.text,
  durationUs: s.duration * 1_000_000,
  imageWidth: 1080,
  imageHeight: 1920,
}));

console.log('\n🎬 Building vertical CapCut project...');

const result = buildCapCutProject({
  projectName: PROJECT_NAME,
  scenes,
  bgmPath,
  subtitleStyle: {
    fontFamily: '',
    fontSize: 7,  // 세로 포맷은 약간 크게
    fontColor: '#FFFFFF',
  },
  totalDurationUs: totalSec * 1_000_000,
  outputDir: PROJECT_DIR,
  canvas: 'vertical',
});

console.log(`\n✅ Vertical CapCut project created!`);
console.log(`   📁 Path: ${result.projectDir}`);
console.log(`   🎞 Scenes: ${result.scenesCount}`);
console.log(`   🎵 Tracks: ${result.tracksCount}`);
console.log(`   ⏱ Duration: ${result.totalDurationSec}s`);
console.log(`   📐 Canvas: 1080x1920 (9:16)`);
console.log(`\n📋 Restart CapCut and open "${PROJECT_NAME}"`);
