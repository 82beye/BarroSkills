/**
 * motion-verify.js — 만들어진 모션 클립이 진짜 규격에 맞는지 기계로 확인한다.
 *
 * 이 파이프라인의 원칙: 프롬프트는 신뢰할 수 없고 게이트는 신뢰할 수 있다.
 * 모션 클립에서 조용히 틀어질 수 있는 것은 세 가지다.
 *
 *  1) 길이  — render-direct 가 TTS 에 맞춰 리타임하므로 어긋나면 속도가 워프된다.
 *  2) 규격  — 1080x1920 이 아니면 뒤에서 crop 되어 구도가 잘린다.
 *  3) 움직임 — "모션 클립" 이라는 이름만 달고 사실은 정지 화면일 수 있다.
 *
 * 3번이 특히 위험하다. 파일이 존재하기만 하면 render-direct 는 Ken Burns 를 끄고
 * 그 클립을 그대로 쓴다(`videoPath` 가 있으면 "이미 움직임이 있으므로"). 정지 클립을
 * 넣으면 완전히 멈춘 씬이 나오는데, 파일 개수만 세는 QA 는 5/5 로 통과시킨다.
 * 그래서 앞·뒤 프레임을 실제로 비교한다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { diff, fingerprint } from './qa-frame-match.js';

/** 길이 허용 오차(초). 1 프레임(1/30s) 보다 넉넉하되 리타임이 눈에 띄지 않을 범위. */
export const DURATION_TOLERANCE_SEC = 0.15;

/**
 * 앞/뒤 프레임이 이만큼은 달라야 "움직였다"고 본다.
 *
 * 실측(2026-08-14, EP-0092 씬1 PNG 기준, 6초):
 *   같은 PNG 를 정지시킨 클립        0.0000
 *   ffmpeg Ken Burns 1.00→1.05      0.0218   ← 이 파이프라인이 내보내는 가장 얌전한 움직임
 *   HyperFrames scale 1.00→1.09     0.0209
 * 0.008 은 정지(0)와 확실히 떨어지고 실제 움직임보다는 한참 아래다.
 */
export const MOTION_MIN_DIFF = 0.008;

export function probe(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=0',
    videoPath,
    // 깨진 파일이면 ffprobe 가 stderr 로 떠드는데, 그 문구는 아래에서 reasons 로 다시
    // 만들어 주므로 부모 프로세스 출력까지 더럽힐 이유가 없다.
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pick = (k) => {
    const m = out.match(new RegExp(`^${k}=(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  return {
    width: Number(pick('width')) || 0,
    height: Number(pick('height')) || 0,
    duration: Number(pick('duration')) || 0,
  };
}

/**
 * 클립 안에서 실제로 화면이 변하는지 본다.
 * 앞뒤 10% 지점을 뜬다 — 0s/끝 프레임은 인코더 경계라 값이 튄다.
 */
export function motionDistance(videoPath, durationSec) {
  const a = Math.max(0.05, durationSec * 0.1);
  const b = Math.max(a + 0.2, durationSec * 0.9);
  return diff(fingerprint(videoPath, a), fingerprint(videoPath, b));
}

/**
 * expectW/expectH/expectDurationSec 에 null 을 주면 그 항목은 보지 않는다 — 다른 엔진이
 * 만든 클립(Grok 은 720x1264 · 10.04s 고정)에는 움직임 여부만 물어야 하기 때문이다.
 *
 * @returns {{ok: boolean, reasons: string[], width, height, duration, motion}}
 */
export function verifyMotionClip({ videoPath, expectDurationSec, expectW = 1080, expectH = 1920 }) {
  const reasons = [];
  if (!existsSync(videoPath)) return { ok: false, reasons: ['파일 없음'], width: 0, height: 0, duration: 0, motion: null };

  let width = 0; let height = 0; let duration = 0;
  try {
    ({ width, height, duration } = probe(videoPath));
  } catch (e) {
    return { ok: false, reasons: [`읽을 수 없는 파일: ${e.message.slice(0, 60)}`], width: 0, height: 0, duration: 0, motion: null };
  }

  if (expectW && expectH && (width !== expectW || height !== expectH)) {
    reasons.push(`규격 ${width}x${height} — ${expectW}x${expectH} 이어야 한다`);
  }
  if (expectDurationSec && Math.abs(duration - expectDurationSec) > DURATION_TOLERANCE_SEC) {
    reasons.push(`길이 ${duration.toFixed(2)}s — 목표 ${expectDurationSec.toFixed(2)}s 와 ${DURATION_TOLERANCE_SEC}s 넘게 다르다`);
  }

  let motion = null;
  try {
    motion = motionDistance(videoPath, duration || expectDurationSec || 1);
    if (motion < MOTION_MIN_DIFF) {
      reasons.push(`정지 화면(프레임 차이 ${motion.toFixed(4)} < ${MOTION_MIN_DIFF}) — 모션 클립이 아니다`);
    }
  } catch (e) {
    reasons.push(`프레임 비교 실패: ${e.message.slice(0, 80)}`);
  }

  return { ok: reasons.length === 0, reasons, width, height, duration, motion };
}
