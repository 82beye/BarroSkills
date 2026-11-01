import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplicateStills } from '../scripts/automation/lib/duplicate-stills.js';

test('앞 씬의 바이트 복사본만 중복으로 본다 — 원본은 남긴다 (게이트와 같은 판정)', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'bt-dup-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, 'scene_001.png'), 'a');
  writeFileSync(join(d, 'scene_002.png'), 'b');
  writeFileSync(join(d, 'scene_003.png'), 'b');   // 002 의 복사본
  writeFileSync(join(d, 'scene_004.png'), 'c');
  writeFileSync(join(d, 'scene_005.png'), 'a');   // 001 의 복사본
  assert.deepEqual([...duplicateStills(d, ['001', '002', '003', '004', '005'])].sort(), ['003', '005']);
});

test('없는 스틸·빈 파일은 중복으로 세지 않는다 — 그건 누락이다', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'bt-dup-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, 'scene_001.png'), '');
  writeFileSync(join(d, 'scene_002.png'), '');
  assert.equal(duplicateStills(d, [1, 2, 3]).size, 0);
});

test('두 폴백이 모두 중복 스틸을 "있음"으로 건너뛰지 않는다', () => {
  // 2026-09-26 EP-2026-0184: 게이트는 중복이라 폴백을 불렀는데 codex·재사용 폴백이 둘 다
  // "파일이 있다"며 건너뛰어 슬롯을 잃었다.
  const reuse = readFileSync(new URL('../scripts/automation/reuse-scene-assets.js', import.meta.url), 'utf8');
  const gen = readFileSync(new URL('../scripts/automation/generate-image-gemini.js', import.meta.url), 'utf8');
  assert.match(reuse, /dupStills\.has\(s\.sceneId\)/);
  assert.match(gen, /!dupStills\.has\(/);
});
