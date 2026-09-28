import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
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

/**
 * 규격에 맞는 진짜 PNG 한 장 (941x1672, 대각 그라디언트).
 * 화소 난수를 쓰면 축소 과정에서 평균으로 뭉개져 FLAT_IMAGE 로 잡힌다.
 */
function scenePng() {
  const w = 941, h = 1672;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / w) * 128 + (y / h) * 127);
      const i = (y * w + x) * 3;
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
  }
  return sharpSync(px, w, h);
}

/** sharp 는 비동기라 동기 픽스처에서 쓸 수 없다 — 최소 PNG 를 직접 인코딩한다. */
function sharpSync(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

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
  // 픽셀 QA(lib/image-quality.js)가 실제로 디코딩하므로 진짜 PNG 여야 한다.
  // 'present' 같은 문자열 스텁은 UNREADABLE 로 잡혀 리포트가 FAIL 로 떨어진다 —
  // 그게 올바른 운영 동작이라 스텁 쪽을 진짜 이미지로 바꾼다.
  writeFileSync(join(assets, 'images/scene_001.png'), scenePng());
  // 인트로·아웃트로 카드는 채널 표준이고 QA 가 존재를 BLOCK 으로 검사한다.
  // 2026-08-14: 이 검사가 없어서 EP-0092 가 아웃트로 없이 PASS 로 게시 직전까지 갔다.
  writeFileSync(join(dir, '45_intro.png'), 'present');
  writeFileSync(join(dir, '48_outro.png'), 'present');
  const motion = join(assets, 'videos/scene_001.mp4');

  const runFfmpeg = (args) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
  };
  // 진짜로 움직이는 클립이어야 한다. 예전엔 'present' 라는 글자를 .mp4 로 써 뒀는데,
  // QA 가 파일 존재만 세던 시절엔 통과했다. 지금은 앞뒤 프레임을 실제로 비교한다.
  const writeMotionClip = () => runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', motion,
  ]);
  writeMotionClip();
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
  for (const row of ['Motion clips', 'Motion liveness', 'BGM presence', 'AAC bitrate', 'Integrated loudness', 'True peak']) {
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

  writeMotionClip();
  renderVideo('8');
  report = runQa();
  assert.match(report, /\| True peak \| ❌ \|/);
  assert.match(report, /\*\*FAIL\*\*/);
});
