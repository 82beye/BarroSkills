import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseSpeed } from '../scripts/automation/generate-tts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TTS = join(ROOT, 'scripts/automation/generate-tts.js');
const QA = join(ROOT, 'scripts/automation/generate-qa-report.js');

test('TTS --speed validates the API range and overrides persona speed', (t) => {
  assert.equal(parseSpeed(undefined), null);
  assert.equal(parseSpeed('1.0'), 1);
  for (const invalid of [true, '', 'NaN', 'Infinity', '0.69', '1.21']) {
    assert.throws(() => parseSpeed(invalid), /between 0\.7 and 1\.2/);
  }

  const dir = mkdtempSync(join(tmpdir(), 'barrotube-tts-speed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outDir = join(dir, 'tts');
  mkdirSync(outDir);
  writeFileSync(join(outDir, 'scene_001.wav'), 'existing');
  const script = join(dir, '30_script.md');
  writeFileSync(script, `---
episode_id: EP-TEST
persona: barro-alert
scenes:
  - scene_id: "001"
    narration: test
---
`);

  const result = spawnSync(process.execPath, [TTS, '--script', script, '--out-dir', outDir, '--speed', '1.0'], { encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Persona=barro-alert .* speed=1(?:\.0)?/);
});

test('QA reports media/audio evidence and blocks missing motion or hot true peak', (t) => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('ffmpeg unavailable');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'barrotube-qa-hardening-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assets = join(dir, '40_assets');
  const render = join(dir, '55_render');
  for (const subdir of ['images', 'videos', 'tts']) mkdirSync(join(assets, subdir), { recursive: true });
  mkdirSync(render);
  writeFileSync(join(dir, '30_script.md'), `---
episode_id: EP-TEST
format: shorts
persona: barro-alert
scenes:
  - scene_id: "001"
    target_seconds: 2
    narration: 다음 영상도 구독해 주세요.
---
`);
  writeFileSync(join(assets, 'images/scene_001.png'), 'present');
  // 인트로·아웃트로 카드는 채널 표준이고 QA 가 존재를 BLOCK 으로 검사한다.
  // 2026-08-14: 이 검사가 없어서 EP-0092 가 아웃트로 없이 PASS 로 게시 직전까지 갔다.
  writeFileSync(join(dir, '45_intro.png'), 'present');
  writeFileSync(join(dir, '48_outro.png'), 'present');
  const motion = join(assets, 'videos/scene_001.mp4');
  writeFileSync(motion, 'present');

  const runFfmpeg = (args) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
  };
  // 씬 TTS 는 scene target_seconds(2s) 에 맞춘다. 아래 렌더 영상만 인트로·아웃트로를
  // 포함한 전체 길이(7.5s)다 — 둘을 같이 늘리면 TTS sync 검사가 깨진다.
  runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=1',
    '-c:a', 'pcm_s16le', join(assets, 'tts/scene_001.wav'),
  ]);

  const video = join(render, 'video.mp4');
  const renderVideo = (volume) => runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=7.5',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=7.5',
    '-filter:a', `volume=${volume}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '1', '-shortest', video,
  ]);
  const runQa = () => {
    const result = spawnSync(process.execPath, [QA, '--episode', dir], { cwd: dir, encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(join(dir, '60_qa_report.md'), 'utf-8');
  };

  renderVideo('0.1');
  let report = runQa();
  for (const row of ['Motion clips', 'BGM presence', 'AAC bitrate', 'Integrated loudness', 'True peak']) {
    assert.match(report, new RegExp(`\\| ${row} \\|`));
  }
  assert.match(report, /bundled-alert:/);
  // 인트로 2s + 아웃트로 2.5s 가 목표 길이에 포함된다 (카드가 픽스처에 있으므로).
  assert.match(report, /target 7\.50s \[scenes 2\.00s \+ intro 2s \+ pad 1s \+ endcard 2\.5s\]/);
  assert.match(report, /\*\*PASS\*\*/);

  rmSync(motion);
  report = runQa();
  assert.match(report, /\| Motion clips \| ❌ \| 0\/1 \|/);
  assert.match(report, /\*\*FAIL\*\*/);

  writeFileSync(motion, 'present');
  renderVideo('8');
  report = runQa();
  assert.match(report, /\| True peak \| ❌ \|/);
  assert.match(report, /\*\*FAIL\*\*/);
});
