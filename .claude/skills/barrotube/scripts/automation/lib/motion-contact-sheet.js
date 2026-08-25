/**
 * motion-contact-sheet.js — 모션 클립을 **눈으로 확인할 수 있게** 한 장으로 펼친다.
 *
 * 왜 지표가 아니라 시트인가: 기존 Motion liveness 는 앞/뒤가 "다른지"만 본다. 모델이
 * 캐릭터를 뭉개도 그건 변화라서 통과한다. EP-2026-0100 씬7 은 13.8초부터 마시의 눈·입이
 * 통째로 지워졌는데 QA 전 항목이 PASS 였고, 사람이 완성본을 보고 발견했다.
 *
 * 그래서 처음엔 "흰 머리 위 검은 잉크량" 지표로 자동 판정을 시도했다. 실패했다 —
 * 임계를 느슨히 잡으면 밝은 배경의 다리·윤곽이 얼굴 손실을 덮었고(씬7 통과), 조이면
 * 멀쩡한 컷을 오탐했다(씬2). 한 스칼라로 "캐릭터가 캐릭터인가"를 재려던 게 무리였다.
 * **불안정한 게이트는 없느니만 못하다** — 통과 도장을 찍어 주기 때문이다.
 *
 * 대신 확실한 걸 한다: 컷마다 프레임을 균등 샘플해 한 장에 깔고, **마지막 프레임을
 * 반드시 포함**한다. 판정은 사람(또는 시각 능력이 있는 에이전트)이 한다. 임계값이 없으니
 * 오탐도 없고, 뭉개짐·손 이상·자막 겹침처럼 스칼라로 못 잡는 것까지 같이 보인다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 컷당 뽑는 프레임 수. 6 이면 15초 클립에서 2.5초 간격 — 뭉개짐이 시작되는 지점이 보인다. */
export const FRAMES_PER_CLIP = 6;
/** 시트에 들어가는 프레임 한 장의 폭(px). */
const THUMB_W = 150;

function probeDuration(p) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', p], { encoding: 'utf-8' });
  return parseFloat(out.trim()) || 0;
}

/**
 * 모션 클립들을 한 장의 컨택트 시트로 만든다. 한 줄이 한 컷이고, 왼쪽에서 오른쪽이 시간순.
 * @returns {{ok:boolean, path:string|null, clips:number, reason:string|null}}
 */
export function buildMotionContactSheet(clipPaths, outPath) {
  const clips = clipPaths.filter(p => p && existsSync(p));
  if (!clips.length) return { ok: false, path: null, clips: 0, reason: '모션 클립이 없다' };

  const work = mkdtempSync(join(tmpdir(), 'bt-sheet-'));
  try {
    const rows = [];
    for (const [i, clip] of clips.entries()) {
      const dur = probeDuration(clip);
      // 마지막 프레임은 필수다 — 뭉개짐은 끝에서 난다. 0.05s 는 EOF 안전 여유.
      const stamps = Array.from({ length: FRAMES_PER_CLIP }, (_, k) =>
        Math.max(0, (dur - 0.05) * (k / (FRAMES_PER_CLIP - 1))));
      const shots = stamps.map((t, k) => {
        const png = join(work, `c${i}_${k}.png`);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t.toFixed(2)), '-i', clip,
          '-frames:v', '1', '-vf', `scale=${THUMB_W}:-1`, png], { stdio: 'ignore' });
        return png;
      });
      const row = join(work, `row${i}.png`);
      execFileSync('ffmpeg', ['-v', 'error', '-y',
        ...shots.flatMap(s => ['-i', s]),
        '-filter_complex', `hstack=inputs=${shots.length}`, row], { stdio: 'ignore' });
      rows.push(row);
    }
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      ...rows.flatMap(r => ['-i', r]),
      '-filter_complex', rows.length > 1 ? `vstack=inputs=${rows.length}` : 'null',
      outPath], { stdio: 'ignore' });
    return { ok: true, path: outPath, clips: clips.length, reason: null };
  } catch (e) {
    return { ok: false, path: null, clips: clips.length, reason: e.message.slice(0, 160) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
