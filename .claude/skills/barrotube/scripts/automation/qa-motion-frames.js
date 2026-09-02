#!/usr/bin/env node

/**
 * qa-motion-frames.js — 모션 클립의 프레임 단위 캐릭터 무결성 검사 (CLI)
 *
 * I2V 모델이 모션 도중 마스코트 얼굴을 다시 그려 뭉개버리는 결함을 잡는다. 2026-09-02
 * 파일럿 실측에서 65프레임 중 1장의 눈이 노치 파인 사각형이 됐고, 재생성본에서는 입이
 * 흰 격자 막대가 됐다 — 사람이 프레임을 하나씩 넘겨야만 발견됐다. 60초 5클립이면
 * 매번 300여 장이라 사람이 못 한다.
 *
 * 2단계 구조 (설계 근거는 lib/motion-qa.js 헤더 참조):
 *   1) 고전 선별 — 얼굴 ROI 검출, 파국적 실패(얼굴 소실·드리프트 급등)를 무료로 즉시 잡는다.
 *   2) 비전 판정 — 얼굴만 크게 잘라 격자 시트로 붙이고 비전 모델에 묻는다. **이쪽이 정본**이다.
 *      정상 깜빡임과 붕괴를 가르는 건 고전 지표로 안 된다는 걸 실측으로 확인했다.
 *
 * 비전 판정기를 못 부르면 PASS 시키지 않는다 — 검사 실패를 통과로 오해하면 QA 가 없느니만
 * 못하다. exit 2(검사 불가)로 떨어뜨려 호출부가 사람을 부르게 한다.
 *
 * 출력: <video>.qa.json  (+ --sheet 로 결함 프레임 컨택트시트)
 * 종료코드: 0 = PASS · 1 = FAIL(결함) · 2 = 검사 불가
 *
 * Usage:
 *   node qa-motion-frames.js --video clip.mp4 --reference scene_001.png
 *   node qa-motion-frames.js --video clip.mp4 --reference scene_001.png --sheet defects.png
 *   node qa-motion-frames.js --video clip.mp4 --reference scene_001.png --screen-only  # 비전 생략(무료)
 */

import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import {
  toGray, findHeadRoi, faceMetrics, faceSignature, signatureDrift,
  screenFrames, judgeFrames, planSheets, parseVisionVerdict, tilesToFrames, repairHint,
} from './lib/motion-qa.js';

const TILE = 190;
/**
 * 시트당 타일 수. 클립당 비전 호출 수를 결정하는 유일한 손잡이다 —
 * 81프레임이면 24타일에서 4회, 60타일에서 2회다.
 *
 * 2026-09-02 실측: 같은 클립에 24타일 131초 / 60타일 26초 — **5배 빠른데 검출 결함 수는
 * 같았다**(둘 다 3개, f76 공통). 호출당 고정 비용이 지배적이라 시트를 줄이는 게 곧 속도다.
 * 에피소드 1편(5씬×최대3시도)이면 40분 대 8분 차이라 크론 예산에 직결된다.
 * 더 키우면 모델이 격자 번호를 헷갈릴 수 있으니 검증 없이 올리지 말 것.
 */
const PER_SHEET = Number(process.env.BT_QA_PER_SHEET) || 60;
const SHEET_COLS = Number(process.env.BT_QA_SHEET_COLS) || 10;

const VISION_PROMPT = [
  '이 이미지는 한 애니메이션 클립에서 뽑은 만화 캐릭터 얼굴 프레임을 격자로 붙인 것이다.',
  `타일 번호는 왼쪽 위부터 행 우선으로 1번씩 증가한다 (한 행 ${SHEET_COLS}개).`,
  '',
  '결함으로 볼 것 — 캐릭터 얼굴이 그리기 오류로 뭉개진 경우:',
  '- 눈이 각진 사각형·직사각형이 되거나 노치(베어 문 자국)가 파임',
  '- 눈이 한쪽만 사라지거나 좌우 모양이 확연히 다름',
  '- 입이 흰 격자·막대·이빨 같은 이물로 뭉개짐',
  '- 얼굴 피처가 번지거나 뭉개져 형체를 잃음',
  '',
  '결함이 아닌 것 — 정상적인 애니메이션 변화:',
  '- 눈 감기·깜빡임 (두 눈이 함께 호(弧) 모양이 되는 것)',
  '- 입이 벌어지거나 다물어지는 크기·모양 변화',
  '- 고개 각도·위치의 미세한 이동, 배경 변화',
  '',
  '결함 타일 번호만 골라 JSON 한 줄로만 답하라. 설명 금지.',
  '{"broken":[번호…]}',
  '결함이 없으면 {"broken":[]}',
].join('\n');

function extractFrames(video, dir) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', video, join(dir, 'f%04d.png')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 프레임 추출 실패: ${r.stderr?.slice(0, 200)}`);
  return readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
}

/**
 * 한 프레임의 얼굴 지표 + 서명.
 *
 * ROI 를 못 찾으면 `fallbackRoi`(직전 프레임 것)로 그 자리를 계속 잰다. findHeadRoi 는
 * '눈 2개'로 얼굴을 식별하는데, 깜빡이거나 피처가 지워진 프레임에는 눈이 0~1개라 null 이
 * 된다 — 그런데 **그게 바로 우리가 잡으려는 결함**이다. 여기서 null 을 돌리면 검사를
 * 포기하게 되고, 결함 프레임이 많을수록 '검사 불가'로 빠져나간다. 구도가 고정된 클립에서
 * 직전 ROI 는 유효하므로, 그 자리를 재서 featureRatio 가 0 에 수렴하는 걸 결함으로 잡는다.
 * (2026-09-02: 5초 Wan 클립이 깜빡임 때문에 ROI 미검출 26% 로 통째로 기권했다.)
 */
async function analyze(path, resizeTo = null, fallbackRoi = null) {
  let img = sharp(path).removeAlpha();
  if (resizeTo) img = img.resize(resizeTo.width, resizeTo.height, { fit: 'cover' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const gray = toGray(data, info.width, info.height, info.channels);
  const found = findHeadRoi(gray, info.width, info.height);
  const roi = found ?? fallbackRoi;
  if (!roi) return null;
  return {
    ...faceMetrics(gray, info.width, info.height, roi),
    roiCarried: !found,
    signature: faceSignature(gray, info.width, info.height, roi, 32),
  };
}

/** 프레임들의 얼굴 ROI 를 잘라 격자 시트 한 장으로 붙인다. */
async function buildSheet(dir, files, frames, metrics, outPath, fallbackRoi) {
  const tiles = [];
  for (const f of frames) {
    const roi = metrics[f - 1]?.roi ?? fallbackRoi;
    if (!roi) continue;
    tiles.push(await sharp(join(dir, files[f - 1]))
      .extract({ left: roi.x, top: roi.y, width: roi.w, height: roi.h })
      .resize(TILE, TILE, { fit: 'fill' }).png().toBuffer());
  }
  if (!tiles.length) return 0;
  const cols = Math.min(SHEET_COLS, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const pad = 4;
  await sharp({ create: {
    width: cols * (TILE + pad) + pad, height: rows * (TILE + pad) + pad,
    channels: 3, background: '#00c000',
  } })
    .composite(tiles.map((input, i) => ({
      input,
      left: (i % cols) * (TILE + pad) + pad,
      top: Math.floor(i / cols) * (TILE + pad) + pad,
    })))
    .png().toFile(outPath);
  return tiles.length;
}

/**
 * 비전 판정기 호출. claude CLI 를 쓴다 — 대본·팩트체크와 같은 구독 경로라
 * 선불 크레딧이 마르지 않는다. 응답을 못 읽으면 null (호출부가 '검사 불가'로 처리).
 */
function callVisionJudge(sheetPath, timeoutMs = 240_000, tries = 3) {
  // CLI 호출은 간헐적으로 실패한다 — 2026-09-02 5씬 검증에서 마지막 씬의 시트 하나가
  // 그렇게 죽어 **클립은 멀쩡한데 전체 실행이 검사 불가로 중단**됐다. 판정 실패를
  // 결함 없음으로 오해하면 안 되지만, 단발 플레이크로 크론을 세우는 것도 안 된다.
  for (let i = 1; i <= tries; i++) {
    const r = spawnSync('claude', ['-p', '--output-format', 'json', `${VISION_PROMPT}\n\n@${sheetPath}`], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout) {
      let text = r.stdout;
      try { text = JSON.parse(r.stdout).result ?? r.stdout; } catch { /* 평문 폴백 */ }
      const v = parseVisionVerdict(text);
      if (v !== null) return v;
    }
    if (i < tries) console.error(`   · 비전 판정 재시도 ${i}/${tries - 1}`);
  }
  return null;
}

async function main() {
  const { values } = parseArgs({ options: {
    video: { type: 'string' },
    reference: { type: 'string' },
    sheet: { type: 'string' },
    'screen-only': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  } });

  if (!values.video || !values.reference) {
    console.error('Usage: qa-motion-frames.js --video <clip.mp4> --reference <scene.png> [--sheet defects.png] [--screen-only]');
    process.exit(2);
  }
  for (const p of [values.video, values.reference]) {
    if (!existsSync(p)) { console.error(`❌ 없는 파일: ${p}`); process.exit(2); }
  }

  const dir = mkdtempSync(join(tmpdir(), 'motion-qa-'));
  const reportPath = `${values.video.replace(/\.mp4$/i, '')}.qa.json`;
  const finish = (report, code) => {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    rmSync(dir, { recursive: true, force: true });
    if (values.json) console.log(JSON.stringify({ pass: report.pass, defectCount: report.defectCount, inspectable: report.inspectable }));
    process.exit(code);
  };

  try {
    const files = extractFrames(values.video, dir);
    if (!files.length) { console.error('❌ 프레임이 없습니다'); process.exit(2); }
    const meta = await sharp(join(dir, files[0])).metadata();
    const ref = await analyze(values.reference, { width: meta.width, height: meta.height });
    if (!ref) {
      console.error('⚠️  기준 이미지에서 얼굴 ROI 미검출 — 검사 불가 (밝은 배경 씬일 수 있음)');
      finish({ schema_version: 1, video: resolve(values.video), pass: false, inspectable: false,
        reason: 'reference_roi_not_found', defectCount: 0, defects: [] }, 2);
    }

    const metrics = [];
    let lastRoi = ref.roi;   // 첫 프레임이 실패해도 기준 이미지 ROI 로 시작한다
    for (const f of files) {
      const m = await analyze(join(dir, f), null, lastRoi);
      if (m && !m.roiCarried) lastRoi = m.roi;
      metrics.push(m ? { ...m, drift: signatureDrift(ref.signature, m.signature) } : null);
    }
    const carried = metrics.filter((m) => m?.roiCarried).length;
    if (carried) console.log(`   · ${carried}프레임은 직전 ROI 로 측정 (얼굴 피처 소실 — 결함 판정 대상)`);

    const screen = screenFrames(metrics, ref);
    console.log(`🔎 고전 선별 — ${files.length}프레임 · 확정결함 ${screen.defects.length} · 후보 ${screen.suspects.length} · 중앙드리프트 ${screen.medianDrift}`);
    if (!screen.inspectable) {
      console.error(`⚠️  얼굴 ROI 미검출 프레임이 ${(screen.noRoiFrac * 100).toFixed(0)}% — 검사 불가`);
      finish({ schema_version: 1, video: resolve(values.video), pass: false, inspectable: false,
        reason: 'roi_not_detectable', defectCount: 0, defects: [] }, 2);
    }

    let visionFrames = [];
    let visionOk = true;
    if (!values['screen-only']) {
      const sheets = planSheets(files.length, PER_SHEET);
      for (let s = 0; s < sheets.length; s++) {
        const sheetPath = join(dir, `sheet_${s}.png`);
        const n = await buildSheet(dir, files, sheets[s], metrics, sheetPath, ref.roi);
        if (!n) continue;
        const tiles = callVisionJudge(sheetPath);
        if (tiles === null) { visionOk = false; console.error(`⚠️  비전 판정 실패 (시트 ${s + 1}/${sheets.length})`); break; }
        const frames = tilesToFrames(tiles, sheets[s]);
        visionFrames.push(...frames);
        console.log(`   시트 ${s + 1}/${sheets.length} (f${sheets[s][0]}~f${sheets[s].at(-1)}) → 결함 ${frames.length}개${frames.length ? ': f' + frames.join(', f') : ''}`);
      }
    }

    if (!values['screen-only'] && !visionOk) {
      finish({ schema_version: 1, video: resolve(values.video), pass: false, inspectable: false,
        reason: 'vision_judge_unavailable', defectCount: 0, defects: [] }, 2);
    }

    const verdict = judgeFrames(screen, visionFrames, files.length);
    const hint = repairHint(verdict.defects);
    const report = {
      schema_version: 1,
      video: resolve(values.video),
      reference: resolve(values.reference),
      generated_at: new Date().toISOString(),
      vision_used: !values['screen-only'],
      ...verdict,
      repair_hint: hint || null,
    };

    if (values.sheet && verdict.defects.length) {
      const n = await buildSheet(dir, files, verdict.defects.map((d) => d.frame), metrics, values.sheet, ref.roi);
      if (n) { report.defect_sheet = resolve(values.sheet); console.log(`   결함 시트: ${values.sheet}`); }
    }

    if (!values.json) {
      console.log(`${verdict.pass ? '✅' : '❌'} 프레임 QA — ${verdict.frameCount}프레임 중 결함 ${verdict.defectCount}개`);
      for (const d of verdict.defects.slice(0, 15)) console.log(`   f${String(d.frame).padStart(3)} ${d.kind}`);
      if (hint) console.log(`   재생성 힌트: ${hint}`);
      console.log(`   리포트: ${reportPath}`);
    }
    finish(report, verdict.pass ? 0 : 1);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    console.error('❌', e.message);
    process.exit(2);
  }
}

main();
