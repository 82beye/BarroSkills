import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { matchIntroOutro, FRAME_DIFF_THRESHOLD } from '../scripts/automation/lib/qa-frame-match.js';

const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
};

/**
 * QA 가 메타데이터만 보면 "카드 파일은 있는데 렌더에는 안 붙은" 상태를 구분하지 못한다.
 * EP-2026-0092 가 그 상태로 게시 직전까지 갔다(2026-08-14). 여기서 프레임 대조가
 * 실제로 그걸 잡는지 고정한다.
 */
test('frame match separates the real card from a different one', (t) => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('ffmpeg unavailable');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'bt-framematch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '55_render'), { recursive: true });

  // 인트로=빨강, 아웃트로=파랑 카드. 영상은 빨강 2초 → 초록 2초 → 파랑 2초.
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', join(dir, '45_intro.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '1', join(dir, '48_outro.png')]);
  const video = join(dir, '55_render/video.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=green:s=64x64:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=2',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);

  const ok = matchIntroOutro({ videoPath: video, baseDir: dir, durationSec: 6 });
  assert.equal(ok.intro.checked, true);
  assert.equal(ok.intro.matched, true, `인트로 프레임이 카드와 같아야 한다 (diff ${ok.intro.diff})`);
  assert.equal(ok.outro.matched, true, `아웃트로 프레임이 카드와 같아야 한다 (diff ${ok.outro.diff})`);

  // 아웃트로 카드를 인트로 그림으로 바꾸면 잡혀야 한다.
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', join(dir, '48_outro.png')]);
  const bad = matchIntroOutro({ videoPath: video, baseDir: dir, durationSec: 6 });
  assert.equal(bad.outro.matched, false, `다른 카드는 걸러야 한다 (diff ${bad.outro.diff})`);
});

test('the threshold keeps real room between a match and a mismatch', () => {
  // 실측: 정답 0.000, 같은 채널의 다른 카드 0.106. 0.18 로 잡았더니 바꿔치기를 통과시켰다.
  assert.ok(FRAME_DIFF_THRESHOLD < 0.106,
    '같은 채널 카드끼리는 배경 톤이 비슷해 diff 가 작다 — 임계가 그보다 낮아야 한다');
  assert.ok(FRAME_DIFF_THRESHOLD > 0.02, '인코딩 노이즈까지 실패로 만들 만큼 조이면 안 된다');
});
