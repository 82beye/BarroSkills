#!/usr/bin/env node
/**
 * 사용법:
 *   node bin/caption-reel.mjs <spec.json>
 * spec.json 예:
 * {
 *   "projectName": "BT-EP01-FirstEyeContact",
 *   "animation": "chalk_in",
 *   "bgmPath": "/abs/path/bgm.wav",
 *   "clips": [
 *     { "videoPath": "/abs/ep01-cut1.mp4", "caption": "어… 뭐야 저 인간" },
 *     { "videoPath": "/abs/ep01-cut2.mp4", "caption": "너로 정했다." }
 *   ]
 * }
 * 길이는 ffprobe로 자동 산출(없으면 clip.durationUs 명시).
 */
import { readFileSync } from 'node:fs';
import { buildCaptionReel, loadAnimations } from '../src/caption-reel-builder.js';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node bin/caption-reel.mjs <spec.json>');
  console.error('등록된 애니메이션:', Object.keys(loadAnimations()).join(', ') || '(없음)');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
const r = buildCaptionReel(spec);
console.log('✅ CapCut 드래프트 생성:', r.projectDir);
console.log(`   길이 ${(r.durationUs/1e6).toFixed(2)}s · 자막/클립 ${r.clips}개 · 애니메이션 ${r.animation}`);
console.log('   → CapCut 재시작 후 프로젝트 목록에서 열기');
