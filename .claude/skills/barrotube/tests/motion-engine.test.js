import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildSceneComposition, CANVAS, MOVES, moveFor } from '../scripts/automation/lib/motion-composition.js';
import { MOTION_MIN_DIFF, motionDistance, verifyMotionClip } from '../scripts/automation/lib/motion-verify.js';

const ROOT = join(import.meta.dirname, '..');
const GEN_SRC = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-motion.js'), 'utf-8');

const comp = (over = {}) => buildSceneComposition({
  imageRel: 'assets/scene.png', gsapRel: 'assets/gsap.min.js', durationSec: 6, index: 0, ...over,
});

test('컴포지션은 window.__timelines 를 반드시 등록한다', () => {
  // 2026-08-14: 이걸 빼먹었더니 렌더가 180프레임 중 0장을 뜨고 무한 대기했다.
  // 6개 워커가 전부 "Attempted to use detached Frame" 로 죽는데, 에러가 프레임 캡처
  // 계층에서 나와 원인이 안 보인다. hyperframes lint 는 경고로만 알려준다.
  const html = comp();
  assert.match(html, /window\.__timelines\["main"\] = tl;/);
  assert.match(html, /gsap\.timeline\(\{ paused: true \}\)/,
    '타임라인은 paused 여야 렌더러가 프레임 단위로 seek 할 수 있다');
});

test('gsap 은 로컬 파일에서 온다 — CDN 을 참조하면 안 된다', () => {
  // hyperframes init 스캐폴드 기본값이 jsdelivr CDN 이다. 그대로 두면 무인 cron 이
  // 네트워크에 묶이고, 버전이 올라가면 같은 입력에서 다른 영상이 나온다.
  const html = comp();
  assert.doesNotMatch(html, /https?:\/\//, '컴포지션에 외부 URL 이 있으면 안 된다');
  assert.match(html, /<script src="assets\/gsap\.min\.js">/);
});

test('컷마다 카메라 무브가 달라진다 — 슬라이드쇼처럼 보이지 않도록', () => {
  const first = comp({ index: 0 });
  const second = comp({ index: 1 });
  assert.notEqual(first, second, '연속 두 씬이 완전히 같은 무브면 안 된다');
  assert.equal(moveFor(0), MOVES[0]);
  assert.equal(moveFor(MOVES.length), MOVES[0], '인덱스는 순환한다');
  assert.equal(moveFor(-1), MOVES[MOVES.length - 1], '음수도 안전하게 감싼다');
});

test('화면에 텍스트를 얹지 않는다', () => {
  // render-direct.js 는 이미 subtitle_text 를 하단 자막으로 시간 분할해 굽는다
  // (`narration: scene.subtitle_text || scene.narration`). 같은 문구를 위에 또 띄우면
  // 같은 화면에 같은 말이 두 번 나온다.
  const html = comp();
  const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
  assert.doesNotMatch(body, /font-family|font-size/, '컴포지션에 타이포 레이어가 없어야 한다');
});

test('캔버스는 render-direct 의 세로 규격과 같다', () => {
  assert.deepEqual([CANVAS.w, CANVAS.h, CANVAS.fps], [1080, 1920, 30]);
  assert.match(comp(), /data-width="1080"[\s\S]*data-height="1920"/);
});

test('durationSec 이 없으면 만들지 않는다', () => {
  assert.throws(() => comp({ durationSec: 0 }), /durationSec/);
  assert.throws(() => buildSceneComposition({ gsapRel: 'g.js', durationSec: 3 }), /imageRel/);
});

test('엔진 바이너리는 고정 설치본을 쓴다 — npx 로 매번 받아오지 않는다', () => {
  // npx 는 버전이 올라가면 조용히 다른 렌더러를 쓰고, 오프라인에서는 실패한다.
  assert.doesNotMatch(GEN_SRC, /spawnSync\((['"])npx\1/, 'npx 로 실행하면 결정론이 깨진다');
  assert.match(GEN_SRC, /node_modules', 'hyperframes'/, '스킬의 고정 설치본을 찾아야 한다');
});

test('기본값(워커 auto · beginFrame)으로 렌더하지 않는다', () => {
  // 실측: 기본값은 이 맥에서 6워커가 전부 detached frame 으로 죽고 프레임 0장이 나온다.
  assert.match(GEN_SRC, /'--low-memory-mode'/,
    'screenshot 캡처 + 1워커로 고정해야 프레임이 나온다');
});

test('다른 엔진이 만든 클립을 --force 없이 덮어쓰지 않는다', () => {
  // Grok 클립은 720x1264 · 10.04s 고정이라 우리 규격 검사를 통과할 수 없다.
  // 그걸 "실패" 로 보고 다시 만들면 사람이 브라우저로 받아온 클립이 사라진다.
  assert.match(GEN_SRC, /--force 를 명시하세요/);
  assert.match(GEN_SRC, /manifest\[sceneId\]\?\.engine === 'hyperframes'/);
});

// ── 실물 클립 검사 ────────────────────────────────────────────────────────

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
}

test('정지 클립은 모션 클립으로 인정하지 않는다', (t) => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('ffmpeg unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'bt-motion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const still = join(dir, 'still.mp4');
  const moving = join(dir, 'moving.mp4');
  // 같은 그림이 4초 동안 그대로 — 파일은 존재하고 ffprobe 도 통과한다.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x123456:s=240x426:r=30:d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', still]);
  // 실제로 움직이는 클립.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=240x426:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', moving]);

  const dead = motionDistance(still, 4);
  const alive = motionDistance(moving, 4);
  assert.ok(dead < MOTION_MIN_DIFF, `정지 클립이 ${dead.toFixed(4)} — 문턱 ${MOTION_MIN_DIFF} 아래여야 한다`);
  assert.ok(alive > MOTION_MIN_DIFF, `움직이는 클립이 ${alive.toFixed(4)} — 문턱 위여야 한다`);

  const v = verifyMotionClip({ videoPath: still, expectDurationSec: null, expectW: null, expectH: null });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /정지 화면/);
});

test('규격·길이는 우리 클립에만 묻는다', (t) => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return t.skip('ffmpeg unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'bt-motion-spec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const foreign = join(dir, 'grok-like.mp4');   // 720x1264 · 10s — Grok 이 내놓는 모양
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=720x1264:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', foreign]);

  const strict = verifyMotionClip({ videoPath: foreign, expectDurationSec: 9.9 });
  assert.equal(strict.ok, false);
  assert.match(strict.reasons.join(' '), /규격 720x1264/);
  assert.match(strict.reasons.join(' '), /길이/);

  const lenient = verifyMotionClip({ videoPath: foreign, expectDurationSec: null, expectW: null, expectH: null });
  assert.equal(lenient.ok, true, '움직이기만 하면 다른 엔진 클립도 통과해야 한다');
});

test('읽을 수 없는 파일은 조용히 통과하지 않는다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-motion-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bogus = join(dir, 'scene_001.mp4');
  spawnSync('sh', ['-c', `printf present > ${JSON.stringify(bogus)}`]);
  const v = verifyMotionClip({ videoPath: bogus, expectDurationSec: null, expectW: null, expectH: null });
  assert.equal(v.ok, false);
});
