#!/usr/bin/env node

/**
 * validate-ltx-motion.js — LTX-2.3 를 정본 모션 엔진으로 승격하기 전 1회성 검증.
 *
 * 2026-09-02 파일럿에서 LTX 는 얼굴 보존이 완벽했지만(193프레임 무결함) **카메라 줌인이
 * 과했다** — "gentle slow push-in" 을 문자 그대로 받아 8초 내내 밀고 들어가 끝에는 눈
 * 하나가 화면을 채웠다. 그 한 가지가 프롬프트로 잡히는지가 승격의 마지막 관문이다.
 *
 * 두 가지를 잰다:
 *   1) 얼굴 무결성 — qa-motion-frames.js (기존 게이트 그대로)
 *   2) 프레임 이탈 — 마스코트 얼굴 ROI 가 첫 프레임 대비 얼마나 커졌나.
 *      줌인이 심하면 ROI 면적이 계속 커진다. 이건 QA 가 안 보는 축이라 여기서 따로 잰다.
 *
 * Usage:
 *   node validate-ltx-motion.js --image scene_001.png --out-dir /tmp/ltx-val
 *   node validate-ltx-motion.js --image s.png --out-dir /tmp/v --duration 8 --seed 4242
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { generateClip, downloadClip, DEFAULT_PROMPT, PORTRAIT } from './lib/ltx-hf.js';
import { getSecret } from './config-loader.js';
import { toGray, findHeadRoi } from './lib/motion-qa.js';

const HERE = resolve(import.meta.dirname);

/**
 * 배경 움직임 하한. Grok(정본이던 엔진) 실측 0.695 를 기준으로 잡았다 —
 * 그보다 낮으면 배경이 멎어 보인다. Wan 1.689 · HyperFrames 1.647 은 화면 전체가
 * 밀려서 높게 나온 값이라 상한 기준으로 쓰지 않는다.
 */
const BG_FLOOR = 0.6;

/** 프레임별 얼굴 ROI 면적 추이 → 줌인 강도. 첫 프레임 대비 마지막 프레임 배수. */
async function zoomProfile(video) {
  const dir = mkdtempSync(join(tmpdir(), 'ltx-zoom-'));
  try {
    // 8프레임마다 하나씩만 본다 — 추세만 보면 되고 전수는 느리다.
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', video,
      '-vf', "select='not(mod(n\\,8))'", '-vsync', '0', join(dir, 'z%03d.png')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`프레임 추출 실패: ${r.stderr?.slice(0, 200)}`);
    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const areas = [];
    for (const f of files) {
      const { data, info } = await sharp(join(dir, f)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const gray = toGray(data, info.width, info.height, info.channels);
      const roi = findHeadRoi(gray, info.width, info.height);
      areas.push(roi ? (roi.w * roi.h) / (info.width * info.height) : null);
    }
    const seen = areas.filter((a) => a !== null);
    if (seen.length < 2) return { measurable: false, samples: areas.length, found: seen.length };
    return {
      measurable: true,
      samples: areas.length,
      found: seen.length,
      first: Number(seen[0].toFixed(4)),
      last: Number(seen[seen.length - 1].toFixed(4)),
      max: Number(Math.max(...seen).toFixed(4)),
      growth: Number((Math.max(...seen) / seen[0]).toFixed(2)),
      // 얼굴을 끝까지 못 찾은 프레임이 많으면 프레임 밖으로 나갔다는 뜻이다.
      lostFrac: Number(((areas.length - seen.length) / areas.length).toFixed(3)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 배경(상단 40%) 프레임간 움직임. 캐릭터가 없는 영역만 재서 **배경이 살아 있는지**를 본다.
 *
 * 전체 프레임 차이로는 이게 안 보인다 — 카메라를 묶으면 화면 전체가 안 밀려 수치가
 * 떨어지는데, 그게 '배경이 정지했다'와 구분되지 않는다. 2026-09-02 실측에서 카메라
 * 고정 프롬프트가 배경 모션을 1.527 → 0.066 로 23배 죽였는데 전체 지표로는 통과했다.
 */
function backgroundMotion(video) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', video,
    '-vf', 'crop=iw:ih*0.40:0:0,scale=240:-1,format=gray,tblend=all_mode=difference,'
      + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'], { encoding: 'utf8' });
  const xs = [...String(r.stderr || '').matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  const ys = [...String(r.stdout || '').matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  const all = xs.concat(ys).filter(Number.isFinite);
  return all.length ? Number((all.reduce((a, b) => a + b, 0) / all.length).toFixed(3)) : null;
}

function runQa(video, reference, sheet) {
  const args = [join(HERE, 'qa-motion-frames.js'), '--video', video, '--reference', reference];
  if (sheet) args.push('--sheet', sheet);
  const r = spawnSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  const p = `${video.replace(/\.mp4$/i, '')}.qa.json`;
  let report = null;
  if (existsSync(p)) { try { report = JSON.parse(readFileSync(p, 'utf-8')); } catch { /* 무시 */ } }
  return { code: r.status ?? 2, report };
}

/** 비교할 프롬프트 변형. 카메라 구속 강도를 달리해 어디까지가 필요한지 본다. */
const VARIANTS = [
  {
    id: 'cinemagraph',
    label: '시네마그래프 (정지 프레임 + 살아있는 배경)',
    prompt: [
      'cinemagraph: the framing is completely static and the character stays in place,',
      'while the thick black smoke billows and churns upward continuously,',
      'the orange flames flicker and dance, and the dark water surface ripples with moving waves.',
      'flat 2D cartoon vector illustration, clean line art.',
    ].join(' '),
  },
  {
    id: 'motion-first',
    label: '배경 모션 우선 (카메라 구속은 뒤에)',
    prompt: [
      'thick smoke billows upward in constant churning motion, flames flicker and lick rapidly,',
      'ocean waves roll in and the water surface ripples continuously with reflections shimmering.',
      'the character stands in place with a small idle sway.',
      'flat 2D cartoon vector illustration.',
      'fixed camera framing, no zoom in or out.',
    ].join(' '),
  },
];

async function main() {
  const { values } = parseArgs({ options: {
    image: { type: 'string' },
    'out-dir': { type: 'string' },
    duration: { type: 'string', default: '8' },
    seed: { type: 'string', default: '4242' },
  } });

  if (!values.image || !values['out-dir']) {
    console.error('Usage: validate-ltx-motion.js --image <scene.png> --out-dir <dir> [--duration 8] [--seed 4242]');
    process.exit(2);
  }
  if (!existsSync(values.image)) { console.error(`❌ 없는 이미지: ${values.image}`); process.exit(2); }
  if (!getSecret('HF_TOKEN')) {
    console.error('❌ HF_TOKEN 이 없습니다. LTX 는 호출당 150 GPU초를 요청해 익명 쿼터(120초)로는 한 컷도 못 굽습니다.');
    console.error('   .env 에 HF_TOKEN=hf_… 를 넣으세요 (PRO 구독 계정의 토큰).');
    process.exit(2);
  }

  const outDir = resolve(values['out-dir']);
  mkdirSync(outDir, { recursive: true });
  const buf = readFileSync(values.image);
  const results = [];

  for (const v of VARIANTS) {
    console.log(`\n━━ ${v.label} ━━`);
    const out = join(outDir, `ltx-${v.id}.mp4`);
    let t0 = Date.now();
    try {
      const { url, seed } = await generateClip({
        imageBuffer: buf, prompt: v.prompt,
        duration: Number(values.duration), seed: Number(values.seed),
        width: PORTRAIT.width, height: PORTRAIT.height,
      });
      writeFileSync(out, await downloadClip(url));
      console.log(`  ✓ 생성 ${((Date.now() - t0) / 1000).toFixed(0)}초 · seed=${seed}`);
    } catch (e) {
      console.error(`  ❌ 생성 실패: ${e.message}`);
      results.push({ ...v, error: e.message });
      continue;
    }

    const { code, report } = runQa(out, values.image, join(outDir, `ltx-${v.id}.defects.png`));
    const zoom = await zoomProfile(out);
    const bg = backgroundMotion(out);
    results.push({
      id: v.id, label: v.label, video: out,
      qaPass: code === 0, defects: report?.defectCount ?? null, frames: report?.frameCount ?? null,
      zoom, backgroundMotion: bg,
    });
    console.log(`  줌 프로파일: 얼굴 면적 ${zoom.measurable ? `${zoom.first} → ${zoom.last} (최대 ${zoom.growth}배)` : '측정 불가'}`
      + (zoom.measurable ? ` · 프레임 이탈 ${(zoom.lostFrac * 100).toFixed(0)}%` : '')
      + ` · 배경 움직임 ${bg ?? '?'} (기준 ≥${BG_FLOOR})`);
  }

  const summary = join(outDir, 'validation.json');
  writeFileSync(summary, JSON.stringify({ image: resolve(values.image), duration: Number(values.duration), results }, null, 2));

  console.log('\n━━━━ 판정 ━━━━');
  // 승격 조건: 얼굴 QA 통과 + 얼굴 면적 성장 1.6배 이내 + 프레임 이탈 10% 이내.
  // 1.6배는 EP-0131 실측 씬에서 마스코트가 화면 밖으로 밀려나기 시작하는 지점이다.
  const passes = (r) => r.qaPass && r.zoom?.measurable && r.zoom.growth <= 1.6
    && r.zoom.lostFrac <= 0.1 && (r.backgroundMotion ?? 0) >= BG_FLOOR;
  const ok = results.filter(passes);
  for (const r of results) {
    if (r.error) { console.log(`  ❌ ${r.label} — 생성 실패`); continue; }
    console.log(`  ${passes(r) ? '✅' : '❌'} ${r.label} — QA ${r.qaPass ? '통과' : `결함 ${r.defects}`}`
      + ` · 줌 ${r.zoom?.growth ?? '?'}배 · 배경 ${r.backgroundMotion ?? '?'}`);
  }
  console.log(`\n리포트: ${summary}`);
  if (!ok.length) {
    console.error('\n프롬프트로 카메라가 잡히지 않았습니다. LTX 승격을 보류하고 Wan 을 유지하세요.');
    process.exit(1);
  }
  console.log(`\n채택 가능한 프롬프트: ${ok.map((r) => r.id).join(', ')}`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(2); });
