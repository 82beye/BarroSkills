/**
 * qa-frame-match.js — 렌더된 영상을 실제로 "보고" 검수한다.
 *
 * 왜 필요한가: 기존 QA 는 ffprobe 메타데이터(길이·코덱·라우드니스)만 봤다. 그러면
 * 인트로·아웃트로가 실제로 붙었는지 알 수 없다 — 카드가 빠지면 목표 길이도 같이
 * 줄어들어 Duration 검사가 통과해 버린다. EP-2026-0092 가 아웃트로 없이 QA PASS 로
 * 게시 직전까지 갔다(2026-08-14, 사람이 렌더 결과를 보고 발견).
 *
 * 아이디어 출처: "동영상을 1초 단위로 캡처해서 사람이 본 것과 같은 형태로 검수" —
 * 다만 모델에게 보여주는 대신, 카드 이미지와 프레임을 직접 비교해 결정론으로 만든다.
 * 모델 판정은 흔들리지만 픽셀 비교는 매번 같은 답을 준다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 비교 해상도. 작을수록 인코딩 노이즈에 둔감하고 구도 차이에는 민감하다. */
const GRID = 24;

/**
 * 이 값을 넘으면 다른 그림이다.
 *
 * 실측(2026-08-14 EP-0092): 올바른 카드는 diff 0.000, 인트로 카드를 아웃트로 자리에
 * 바꿔 넣으면 0.106. 처음 잡았던 0.18 은 그 바꿔치기를 통과시켰다 — 같은 채널 카드끼리는
 * 배경 톤이 비슷해 차이가 작게 나온다. 정답이 0 이라 여유가 크므로 0.08 로 조인다.
 */
export const FRAME_DIFF_THRESHOLD = 0.08;

/** 프레임 한 장을 GRID×GRID 그레이스케일 밝기 배열로 만든다. */
function fingerprint(inputPath, seekSec = null) {
  const args = [];
  if (seekSec !== null) args.push('-ss', String(seekSec));
  args.push('-i', inputPath, '-frames:v', '1',
    '-vf', `scale=${GRID}:${GRID}:force_original_aspect_ratio=disable,format=gray`,
    '-f', 'rawvideo', '-');
  const buf = execFileSync('ffmpeg', ['-v', 'error', ...args], {
    maxBuffer: 4 * 1024 * 1024, encoding: 'buffer',
  });
  if (buf.length < GRID * GRID) throw new Error(`프레임을 못 읽었다: ${inputPath}`);
  return Array.from(buf.subarray(0, GRID * GRID));
}

/**
 * 구도 차이와 밝기 차이를 반반 섞은 거리(0~1).
 *
 * 평균을 뺀 형태 비교만 쓰면 균등한 색 화면끼리는 둘 다 0 이 되어 구분이 안 된다
 * (빨강 단색 vs 파랑 단색 → diff 0). 검은 화면이 카드로 통과하는 것도 같은 이유다.
 * 그래서 밝기 평균 차이를 같은 비중으로 더한다.
 */
function diff(a, b) {
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const [ma, mb] = [mean(a), mean(b)];
  let shape = 0;
  for (let i = 0; i < a.length; i++) shape += Math.abs((a[i] - ma) - (b[i] - mb));
  shape = shape / a.length / 255;
  const brightness = Math.abs(ma - mb) / 255;
  return 0.5 * shape + 0.5 * brightness;
}

/**
 * 영상의 앞·뒤 프레임이 인트로·아웃트로 카드와 같은 그림인지 확인한다.
 *
 * @returns {{intro: object|null, outro: object|null}} 각 항목은
 *   { checked, matched, diff, reason } — 카드 파일이 없으면 checked=false.
 */
export function matchIntroOutro({ videoPath, baseDir, durationSec, introOffset = 1.0, outroOffset = 1.0 }) {
  const out = { intro: null, outro: null };
  if (!existsSync(videoPath) || !durationSec || durationSec < 3) return out;

  const cards = {
    intro: ['45_intro.png'].map(f => join(baseDir, f)).find(existsSync),
    outro: ['48_outro.png', '48_endcard.png'].map(f => join(baseDir, f)).find(existsSync),
  };
  const seeks = { intro: introOffset, outro: Math.max(0, durationSec - outroOffset) };

  const tmp = mkdtempSync(join(tmpdir(), 'bt-frame-'));
  try {
    for (const slot of ['intro', 'outro']) {
      if (!cards[slot]) { out[slot] = { checked: false, matched: false, diff: null, reason: '카드 파일 없음' }; continue; }
      try {
        const d = diff(fingerprint(videoPath, seeks[slot]), fingerprint(cards[slot]));
        out[slot] = {
          checked: true,
          matched: d <= FRAME_DIFF_THRESHOLD,
          diff: Number(d.toFixed(3)),
          reason: d <= FRAME_DIFF_THRESHOLD ? '' : `${seeks[slot].toFixed(1)}s 프레임이 카드와 다르다`,
        };
      } catch (e) {
        out[slot] = { checked: false, matched: false, diff: null, reason: e.message.slice(0, 80) };
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}
