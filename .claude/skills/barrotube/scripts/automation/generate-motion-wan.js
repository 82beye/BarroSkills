#!/usr/bin/env node

/**
 * generate-motion-wan.js — Wan 2.2(HF Space)로 씬 모션을 굽고, QA 통과할 때까지 재생성한다.
 *
 * **정본 엔진이다.** 2026-09-02 에 Wan·LTX-2.3·Grok·HyperFrames 를 같은 씬 이미지로 돌려
 * 두 축으로 쟀다 — 배경이 살아있는가(상단 40% 프레임간 움직임), 구도를 지키는가(끝/첫
 * 얼굴면적 비). Wan 만 둘 다 만족했다:
 *
 *   엔진          배경    구도유지
 *   Wan 2.2      1.689     1.01     ← 둘 다 만족하는 유일한 엔진
 *   Grok         1.647     1.22     (게시분 18클립 전수로는 중앙값 1.77, 범위 0.17~6.99)
 *   LTX-2.3      1.321     0.74     얼굴 보존은 최고지만 캐릭터가 34~42% 축소된다
 *   HyperFrames  0.439     1.18     스틸에 팬·줌만 — 피사체가 안 움직인다
 *
 * Wan 의 약점은 **얼굴이 뭉개지는 것**(생성 4회 중 3회)인데, 그건 프레임 QA 로 잡고
 * 시드를 바꿔 다시 구우면 된다 — 구도가 밀리는 건 그렇게 못 고친다. 그래서 Wan 이다.
 *
 * 길이 기본은 **4초**다. 5초(Space 상한)로 구우면 렌더 슬로모션이 1.63~2.83배에서
 * 1.31~2.27배로 줄어 좋아 보이지만, 실측에서 얼굴 결함이 크게 늘었다 —
 * 4초는 시도 2회에 결함 0을 찍었는데 5초는 3회를 태워도 3~5개가 남았다
 * (2026-09-02, 같은 씬·같은 시드로 두 번 확인). 짧은 얼굴 붕괴가 전 구간 슬로모션보다
 * 눈에 띈다는 판단이다. --duration 으로 올릴 수 있다.
 *
 * 슬로모션이 거슬리면 길이를 늘리는 대신 BT_CLIP_FIT_MODE=loop 를 쓰는 길도 있다 —
 * 클립을 늘이지 않고 반복해 씬을 채우므로 모션 속도가 원본 그대로 남는다.
 *
 * Usage:
 *   node generate-motion-wan.js --episode <episode_dir> --platform shorts   # S6c 정본 경로
 *   node generate-motion-wan.js --episode <dir> --scene 003 --force
 *   node generate-motion-wan.js --image scene_001.png --out clip.mp4
 *   node generate-motion-wan.js --episode <dir> --post-720p                 # 24fps·720p 후처리
 *
 * 종료코드: 0 = 전 씬 QA 통과 · 1 = 일부 실패(최선본 보존) · 2 = 검사 불가·쿼터 소진·입력 오류
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import * as wan from './lib/wan-hf.js';
import {
  produceScene, assetDirs, listScenes, sceneDuration, recordManifest, post720p,
} from './lib/motion-retry.js';
import { ENGINE_MANIFEST } from './generate-motion.js';

const ENGINE = {
  name: 'Wan 2.2',
  generateClip: wan.generateClip,
  downloadClip: wan.downloadClip,
  withRepairHint: wan.withRepairHint,
  DEFAULT_PROMPT: wan.DEFAULT_PROMPT,
};

async function main() {
  const { values } = parseArgs({ options: {
    image: { type: 'string' },
    out: { type: 'string' },
    episode: { type: 'string' },
    platform: { type: 'string', default: 'shorts' },
    scene: { type: 'string' },
    attempts: { type: 'string', default: process.env.BT_WAN_ATTEMPTS || '3' },
    duration: { type: 'string' },
    steps: { type: 'string', default: '6' },
    seed: { type: 'string', default: '1000' },
    prompt: { type: 'string' },
    force: { type: 'boolean', default: false },
    'post-720p': { type: 'boolean', default: false },
    'skip-qa': { type: 'boolean', default: false },
  } });

  const common = {
    engine: ENGINE,
    attempts: Math.max(1, Number(values.attempts) || 3),
    seed: Number(values.seed) || 1000,
    basePrompt: values.prompt || null,
    skipQa: values['skip-qa'],
    extra: { steps: Number(values.steps) || 6 },
  };

  // ── 단일 이미지 모드 ──
  if (values.image && values.out) {
    if (!existsSync(values.image)) { console.error(`❌ 없는 이미지: ${values.image}`); process.exit(2); }
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    const r = await produceScene({
      ...common, image: values.image, out: values.out,
      duration: wan.clampDuration(Number(values.duration) || wan.DEFAULT_DURATION),
      sheetDir: dirname(resolve(values.out)),
    });
    if (['generate_failed', 'quota_exhausted', 'uninspectable'].includes(r.reason)) process.exit(2);
    if (values['post-720p'] && existsSync(values.out)) {
      const up = values.out.replace(/\.mp4$/i, '.720p24.mp4');
      post720p(values.out, up);
      console.log(`  ✓ 후처리: ${up} (720p·24fps)`);
    }
    process.exit(r.pass ? 0 : 1);
  }

  // ── 에피소드 모드 (S6c 정본 경로) ──
  if (!values.episode) {
    console.error('Usage: generate-motion-wan.js (--episode <dir> [--platform shorts] [--scene 003] | --image <png> --out <mp4>)');
    process.exit(2);
  }
  const epDir = resolve(values.episode);
  const { images, videos } = assetDirs(epDir, values.platform);
  const all = listScenes(images);
  if (!all.length) { console.error(`❌ 씬 이미지가 없습니다: ${images}`); process.exit(2); }
  const targets = values.scene ? all.filter((id) => id === String(values.scene).padStart(3, '0')) : all;
  if (!targets.length) { console.error(`❌ 씬 ${values.scene} 이미지가 없습니다`); process.exit(2); }
  mkdirSync(videos, { recursive: true });

  console.log(`🎬 Wan 2.2 모션 — ${targets.length}씬 (${epDir})`);
  const results = [];
  for (const id of targets) {
    const image = join(images, `scene_${id}.png`);
    const out = join(videos, `scene_${id}.mp4`);
    if (existsSync(out) && !values.force) {
      console.log(`\n⏭  씬 ${id} — 이미 있음 (덮어쓰려면 --force)`);
      results.push({ id, pass: true, skipped: true });
      continue;
    }
    // 씬 길이에 맞추되 Space 상한 5초로 자른다 — 리타임 배수를 최대한 1 에 붙인다.
    const tts = sceneDuration(epDir, values.platform, id);
    const dur = wan.clampDuration(Number(values.duration) || wan.DEFAULT_DURATION);
    const retime = tts ? (tts / dur) : null;
    console.log(`\n── 씬 ${id} ── (TTS ${tts ? tts.toFixed(1) + '초' : '미상'} → 클립 ${dur}초${retime ? `, 렌더 ${retime.toFixed(2)}배` : ''})`);

    const r = await produceScene({ ...common, image, out, duration: dur, sheetDir: videos });
    results.push({ id, ...r });
    if (r.pass || existsSync(out)) {
      recordManifest(videos, ENGINE_MANIFEST, id, {
        engine: 'wan2.2-hf',
        source_image: `images/scene_${id}.png`,
        duration_sec: dur,
        tts_sec: tts ? Number(tts.toFixed(2)) : null,
        retime_factor: retime ? Number(retime.toFixed(2)) : null,
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

  if (values['post-720p']) {
    for (const r of results.filter((x) => x.pass && !x.skipped)) {
      const v = join(videos, `scene_${r.id}.mp4`);
      if (existsSync(v)) post720p(v, v.replace(/\.mp4$/i, '.720p24.mp4'));
    }
  }

  const done = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length ? '❌' : '✅'} Wan 모션 ${done}/${targets.length} 통과`);
  for (const f of failed) {
    console.error(`   씬 ${f.id}: 결함 ${Number.isFinite(f.defects) ? f.defects : '?'}개 (${f.reason ?? 'qa_fail'})`);
  }
  if (failed.some((f) => ['uninspectable', 'generate_failed', 'quota_exhausted'].includes(f.reason))) process.exit(2);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(2); });
