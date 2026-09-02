#!/usr/bin/env node

/**
 * generate-motion-ltx.js — LTX-2.3(HF Space)로 씬 모션을 굽고 QA 통과까지 재생성한다.
 *
 * 2026-09-02 실측으로 Wan 2.2 를 밀어내고 정본이 됐다:
 *
 *              해상도        fps  최대길이  오디오   얼굴 결함
 *   Wan 2.2    480×832       16   5초      없음    생성 4회 중 3회
 *   LTX-2.3   1024×1536      24  10초      AAC     193프레임 무결함
 *
 * 결정적이었던 건 **길이**다. 씬은 6.6~11.5초인데 Wan 4초 클립은 렌더에서 1.63~2.83배
 * 늘어나 슬로모션이 됐다. LTX 는 씬 길이를 그대로 요청할 수 있어 리타임이 1.0 에 붙는다.
 * 그래서 이 스크립트는 **TTS 길이를 읽어 클립 길이로 넘긴다** — 그게 이 엔진의 요점이다.
 *
 * 카메라는 프롬프트로 반드시 묶어야 한다. 안 묶으면 8초 내내 밀고 들어가 마지막엔 눈
 * 하나가 화면을 채운다(실측). lib/ltx-hf.js 의 DEFAULT_PROMPT 가 그 구속을 담고 있고,
 * 검증에서 줌 1.02배·프레임 이탈 0% 로 확인했다.
 *
 * 한계 — 두 I2V 모델 공통: 씬 이미지에 그려 넣은 **평면 그래픽(화살표·라벨)이 사라진다.**
 * LTX 는 그 외 요소(균열·표정·화풍)를 보존하지만 화살표는 못 지킨다. 지시선이 꼭 필요한
 * 컷은 모션 뒤에 오버레이로 얹는 편이 안전하다.
 *
 * Usage:
 *   node generate-motion-ltx.js --episode <episode_dir> --platform shorts
 *   node generate-motion-ltx.js --episode <dir> --scene 003 --force
 *   node generate-motion-ltx.js --image scene_001.png --out clip.mp4 --duration 8
 *
 * 종료코드: 0 = 전 씬 QA 통과 · 1 = 일부 실패(최선본 보존) · 2 = 검사 불가·쿼터 소진·입력 오류
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import * as ltx from './lib/ltx-hf.js';
import { getSecret } from './config-loader.js';
import {
  produceScene, assetDirs, listScenes, sceneDuration, recordManifest,
} from './lib/motion-retry.js';
import { ENGINE_MANIFEST } from './generate-motion.js';

const ENGINE = {
  name: 'LTX-2.3',
  generateClip: ltx.generateClip,
  downloadClip: ltx.downloadClip,
  withRepairHint: ltx.withRepairHint,
  DEFAULT_PROMPT: ltx.DEFAULT_PROMPT,
};

async function main() {
  const { values } = parseArgs({ options: {
    image: { type: 'string' },
    out: { type: 'string' },
    episode: { type: 'string' },
    platform: { type: 'string', default: 'shorts' },
    scene: { type: 'string' },
    attempts: { type: 'string', default: '2' },
    duration: { type: 'string' },
    seed: { type: 'string', default: '1000' },
    prompt: { type: 'string' },
    force: { type: 'boolean', default: false },
    'skip-qa': { type: 'boolean', default: false },
  } });

  if (!getSecret('HF_TOKEN')) {
    console.error('❌ HF_TOKEN 이 없습니다. LTX 는 호출당 150 GPU초를 요청해 익명 쿼터(120초)로는 한 컷도 못 굽습니다.');
    console.error('   PRO 구독 계정 토큰을 .env 의 HF_TOKEN 또는 키체인에 넣으세요.');
    process.exit(2);
  }

  // 재시도가 2회인 이유: LTX 는 첫 시도 통과율이 높고 호출당 GPU 가 비싸다(150초).
  // Wan(3회)과 달리 3회까지 태우면 하루 쿼터를 금방 먹는다.
  const common = {
    engine: ENGINE,
    attempts: Math.max(1, Number(values.attempts) || 2),
    seed: Number(values.seed) || 1000,
    basePrompt: values.prompt || null,
    skipQa: values['skip-qa'],
  };

  // ── 단일 이미지 모드 ──
  if (values.image && values.out) {
    if (!existsSync(values.image)) { console.error(`❌ 없는 이미지: ${values.image}`); process.exit(2); }
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    const r = await produceScene({
      ...common, image: values.image, out: values.out,
      duration: ltx.clampDuration(Number(values.duration) || 8),
      sheetDir: dirname(resolve(values.out)),
    });
    if (r.reason === 'generate_failed' || r.reason === 'quota_exhausted' || r.reason === 'uninspectable') process.exit(2);
    process.exit(r.pass ? 0 : 1);
  }

  // ── 에피소드 모드 (S6c 정본 경로) ──
  if (!values.episode) {
    console.error('Usage: generate-motion-ltx.js (--episode <dir> [--platform shorts] [--scene 003] | --image <png> --out <mp4>)');
    process.exit(2);
  }
  const epDir = resolve(values.episode);
  const { images, videos } = assetDirs(epDir, values.platform);
  const all = listScenes(images);
  if (!all.length) { console.error(`❌ 씬 이미지가 없습니다: ${images}`); process.exit(2); }
  const targets = values.scene ? all.filter((id) => id === String(values.scene).padStart(3, '0')) : all;
  if (!targets.length) { console.error(`❌ 씬 ${values.scene} 이미지가 없습니다`); process.exit(2); }
  mkdirSync(videos, { recursive: true });

  console.log(`🎬 LTX-2.3 모션 — ${targets.length}씬 (${epDir})`);
  const results = [];
  for (const id of targets) {
    const image = join(images, `scene_${id}.png`);
    const out = join(videos, `scene_${id}.mp4`);
    if (existsSync(out) && !values.force) {
      console.log(`\n⏭  씬 ${id} — 이미 있음 (덮어쓰려면 --force)`);
      results.push({ id, pass: true, skipped: true });
      continue;
    }
    // 클립 길이를 TTS 에 맞춘다 — 렌더 리타임을 1.0 에 붙이는 것이 LTX 채택 이유다.
    const tts = sceneDuration(epDir, values.platform, id);
    const dur = ltx.clampDuration(Number(values.duration) || tts || 8);
    console.log(`\n── 씬 ${id} ── (TTS ${tts ? tts.toFixed(1) + '초' : '미상'} → 클립 ${dur}초)`);

    const r = await produceScene({ ...common, image, out, duration: dur, sheetDir: videos });
    results.push({ id, ...r });
    if (r.pass || existsSync(out)) {
      recordManifest(videos, ENGINE_MANIFEST, id, {
        engine: 'ltx-2.3-hf',
        source_image: `images/scene_${id}.png`,
        duration_sec: dur,
        tts_sec: tts ? Number(tts.toFixed(2)) : null,
        retime_factor: tts ? Number((tts / dur).toFixed(2)) : null,
        qa_pass: r.pass,
        qa_defects: Number.isFinite(r.defects) ? r.defects : null,
        attempts: r.attemptsUsed,
        rendered_at: new Date().toISOString(),
      });
    }
    if (r.reason === 'uninspectable' || r.reason === 'quota_exhausted') {
      console.error(`⛔ ${r.reason === 'quota_exhausted' ? 'GPU 쿼터 소진' : '검사 불가'} — 남은 씬을 굽지 않고 멈춥니다`);
      break;
    }
  }

  const done = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length ? '❌' : '✅'} LTX 모션 ${done}/${targets.length} 통과`);
  for (const f of failed) {
    console.error(`   씬 ${f.id}: 결함 ${Number.isFinite(f.defects) ? f.defects : '?'}개 (${f.reason ?? 'qa_fail'})`);
  }
  if (failed.some((f) => ['uninspectable', 'generate_failed', 'quota_exhausted'].includes(f.reason))) process.exit(2);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(2); });
