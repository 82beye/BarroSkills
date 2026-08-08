import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'automation', 'render-direct.js');
const BUNDLED_BGM = join(HERE, '..', 'assets', 'bgm', 'analysis.mp3');

function makeEpisode(root, { motion }) {
  const episode = join(root, motion ? 'motion' : 'missing-motion');
  const assets = join(episode, '40_assets');
  mkdirSync(join(assets, 'images'), { recursive: true });
  mkdirSync(join(assets, 'tts'), { recursive: true });
  mkdirSync(join(assets, 'videos'), { recursive: true });
  writeFileSync(join(episode, '30_script.md'), `---
format: shorts
persona: barro-teacher
channel_id: renderer-test
scenes:
  - scene_id: "001"
    target_seconds: 6
    narration: ""
---
`);
  writeFileSync(join(assets, 'images', 'scene_001.png'), 'image');
  writeFileSync(join(assets, 'tts', 'scene_001.wav'), 'tts');
  if (motion) writeFileSync(join(assets, 'videos', 'scene_001.mp4'), 'video');
  return episode;
}

test('render-direct hardens motion, paths, timing, and one-pass audio encoding', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bt-render-direct-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const externalCwd = join(root, 'external-cwd');
  const ffmpegLog = join(root, 'ffmpeg.jsonl');
  mkdirSync(bin);
  mkdirSync(join(externalCwd, 'assets', 'bgm'), { recursive: true });
  mkdirSync(join(externalCwd, 'config'), { recursive: true });
  writeFileSync(join(externalCwd, 'assets', 'bgm', 'analysis.mp3'), 'cwd-decoy');
  writeFileSync(join(externalCwd, 'config', 'subtitles.json'), JSON.stringify({ default: { mode: 'karaoke' } }));

  writeFileSync(join(bin, 'ffmpeg'), `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(process.env.BT_TEST_FFMPEG_LOG, JSON.stringify(args) + '\\n');
const output = args.at(-1);
if (output && !output.startsWith('-')) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, 'fake');
}
`, { mode: 0o755 });
  writeFileSync(join(bin, 'ffprobe'), `#!/usr/bin/env node
const input = process.argv.at(-1);
if (process.argv.includes('-select_streams')) process.exit(0);
if (input.endsWith('scene_001.mp4')) console.log('10');
else if (input.endsWith('scene_001.wav')) console.log('4');
else if (input.endsWith('clip_001.mov')) console.log('6');
else console.log('7');
`, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    BT_TEST_FFMPEG_LOG: ffmpegLog,
    BT_NO_CLIP_AMBIENT: '1',
  };
  const missingEpisode = makeEpisode(root, { motion: false });
  const { renderDirect } = await import(`${pathToFileURL(SCRIPT).href}?missing-motion`);
  assert.throws(
    () => renderDirect({ episodeDir: missingEpisode, outPath: join(root, 'missing.mp4') }),
    error => error.code === 3 && error.exitCode === 3 && /001/.test(error.message),
  );

  const missingCli = spawnSync(process.execPath, [SCRIPT,
    '--episode', missingEpisode,
    '--out', join(root, 'missing-cli.mp4'),
  ], { cwd: externalCwd, env, encoding: 'utf8' });
  assert.equal(missingCli.status, 3, missingCli.stderr);
  assert.equal(existsSync(ffmpegLog), false, 'motion gate must run before ffmpeg');

  const allowedStill = spawnSync(process.execPath, [SCRIPT,
    '--episode', missingEpisode,
    '--out', join(root, 'allowed-still.mp4'),
    '--allow-stills',
  ], { cwd: externalCwd, env, encoding: 'utf8' });
  assert.equal(allowedStill.status, 0, allowedStill.stderr);
  rmSync(ffmpegLog);

  const motionEpisode = makeEpisode(root, { motion: true });
  const output = join(root, 'rendered.mp4');
  const rendered = spawnSync(process.execPath, [SCRIPT,
    '--episode', motionEpisode,
    '--out', output,
  ], { cwd: externalCwd, env, encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /global-analysis/);
  assert.doesNotMatch(rendered.stdout, /Subtitle: karaoke/);

  const calls = readFileSync(ffmpegLog, 'utf8').trim().split('\n').map(JSON.parse);
  const scene = calls.find(args => args.at(-1).endsWith('clip_001.mov'));
  assert.ok(scene, 'scene must render to MOV');
  assert.equal(scene.includes('-stream_loop'), false, '10s clip retimed to 6s without looping');
  assert.ok(scene.some(arg => arg.includes('setpts=0.600000*(PTS-STARTPTS)')));
  assert.ok(scene.some(arg => arg.includes('apad=pad_dur=6,atrim=duration=6')));
  assert.deepEqual(scene.slice(scene.indexOf('-c:a'), scene.indexOf('-c:a') + 8),
    ['-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', '-t', '6']);

  const concat = calls.find(args => args.at(-1).endsWith('concat.mov'));
  assert.ok(concat);
  assert.deepEqual(concat.slice(concat.indexOf('-c'), concat.indexOf('-c') + 2), ['-c', 'copy']);

  const final = calls.find(args => args.at(-1) === output);
  assert.ok(final);
  assert.ok(final.includes(BUNDLED_BGM), 'BGM path must resolve from the skill, not cwd');
  assert.equal(final.includes(join(externalCwd, 'assets', 'bgm', 'analysis.mp3')), false);
  assert.ok(final.some(arg => arg.includes('alimiter=limit=0.841395:level=false')));
  assert.deepEqual(final.slice(final.indexOf('-c:v'), final.indexOf('-c:v') + 6),
    ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k']);
  assert.equal(calls.filter(args => args[args.indexOf('-c:a') + 1] === 'aac').length, 1,
    'only the final MP4 encodes AAC');
  assert.ok(calls.filter(args => args[args.indexOf('-c:a') + 1] === 'pcm_s16le').length >= 2,
    'scene and outro intermediates stay lossless');
});
