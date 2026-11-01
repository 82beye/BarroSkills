import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'automation', 'set-video-privacy.js'), 'utf8');

test('미완성 영상은 공개로 넘기지 않는다', () => {
  // 2026-09-23~25 에 같은 사고가 두 번 났다(EP-2026-0176·0177). 업로드가 네트워크
  // 중단으로 끊겼는데 유튜브에는 영상 리소스가 이미 있었고 **공개 상태**였다.
  // 길이 0초 깨진 영상이 채널에 떠 있었다.
  assert.match(SRC, /contentDetails,processingDetails/, '완성도 판정에 필요한 part 를 안 받아온다');
  assert.match(SRC, /const incomplete =/, '완성도 판정이 없다');
  assert.match(SRC, /privacy === 'public' && incomplete && !values\.force/, '공개 게이트가 없다');
  assert.match(SRC, /process\.exit\(4\)/, '게이트가 막아도 종료코드로 드러나지 않는다');
});

test('판정은 길이와 uploadStatus 두 값으로 한다', () => {
  // 둘 다 유튜브가 바이트를 다 받아 인코딩을 마쳐야 나온다.
  assert.match(SRC, /uploadStatus !== 'processed'/);
  assert.ok(SRC.includes('^PT(?='), '길이 판정 정규식이 바뀌었다');

  // ISO8601 duration 판정이 실제로 맞는지
  const re = /^PT(?=.*\d)/;
  assert.equal(re.test('PT58S'), true);
  assert.equal(re.test('PT1M6S'), true);
  assert.equal(re.test('P0D'), false, '0초 영상을 온전하다고 봤다');
  assert.equal(re.test(''), false);
  assert.equal(re.test('PT'), false);
});

test('private 로 내리는 것은 게이트가 막지 않는다', () => {
  // 사고가 났을 때 가장 먼저 해야 하는 일이다 — 막으면 안 된다.
  const gate = SRC.match(/if \(privacy === 'public' && incomplete && !values\.force\)/);
  assert.ok(gate, '게이트 조건이 public 한정이 아니다');
});

test('--force 로 넘길 수 있고, 넘길 때는 경고를 남긴다', () => {
  assert.match(SRC, /force: \{ type: 'boolean', default: false \}/);
  assert.match(SRC, /⚠ --force/, 'force 통과가 조용하다');
  assert.match(SRC, /\[--force\]/, 'usage 에 안 적혀 있다');
});
