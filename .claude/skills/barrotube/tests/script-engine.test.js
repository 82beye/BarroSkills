import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isExhausted } from '../scripts/automation/generate-script.js';

const ROOT = join(import.meta.dirname, '..');

test('credit exhaustion is recognised across the shapes Google returns', () => {
  // 2026-08-13 실측: 선불 크레딧이 마르면 429 + 이 문구가 온다.
  // 재시도해도 안 풀리므로 다른 엔진으로 넘어가야 한다.
  assert.equal(isExhausted(new Error('Gemini 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}')), true);
  assert.equal(isExhausted(new Error('Your prepayment credits are depleted.')), true);
  assert.equal(isExhausted(new Error('quotaExceeded')), true);
  assert.equal(isExhausted('Gemini 429'), true);

  // 다른 실패는 폴백 대상이 아니다 — 조용히 엔진을 바꾸면 원인을 숨긴다
  assert.equal(isExhausted(new Error('Gemini 400: invalid request')), false);
  assert.equal(isExhausted(new Error('No content')), false);
  assert.equal(isExhausted(new Error('socket hang up')), false);
});

test('the script step is not bound to a single provider', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-script.js'), 'utf-8');
  assert.match(src, /callClaudeCode/, 'claude -p must be an available engine');
  assert.match(src, /callCodex/, 'codex exec must be an available engine');
  assert.match(src, /engine:\s*\{\s*type:\s*'string'/, '--engine must be selectable');
  assert.match(src, /BT_SCRIPT_ENGINE/, 'env override for unattended runs');

  // 메인 세션이 쓰는 구독 CLI 가 앞이고, 선불 크레딧이 필요한 Gemini 가 뒤다.
  // 순서가 뒤집히면 2026-08-13 파이프라인을 세운 그 실패로 돌아간다.
  assert.match(src, /BT_SCRIPT_ENGINE_CHAIN \|\| 'claude,codex,gemini'/,
    'default chain order: subscription CLIs first, prepaid API last');

  // 명시 지정은 존중한다 — --engine gemini 로 부른 사람은 실패를 보고 싶은 것이다
  assert.match(src, /requested === 'auto' \? ENGINE_CHAIN : \[requested\]/,
    'an explicit --engine must yield a one-element chain (no silent fallback)');
});

test('the chain records which engine actually wrote the script', () => {
  // frontmatter 가 항상 (gemini) 라고 적혀 있으면 폴백이 일어난 EP 를 사후에 못 가린다.
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-script.js'), 'utf-8');
  assert.match(src, /writer: `writer-agent \(\$\{engineUsed\}\)`/,
    'the artifact must name the engine that produced it');
  assert.match(src, /fallback from/, 'a fallback must be visible in the artifact');
  assert.doesNotMatch(src, /writer-agent \(gemini\)/, 'no hardcoded provider name');
});

test('codex runs read-only and hands the reply back through a temp file', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-script.js'), 'utf-8');

  // 대본 생성은 파일을 쓸 일이 없다. 쓰게 두면 image_prompt·TTS 계약 게이트를 우회한다.
  assert.match(src, /'-s',\s*'read-only'/, 'codex must not be able to write files');
  assert.match(src, /'-a',\s*'never'/, 'non-interactive — nobody is there to approve');

  // stdout 에는 진행 로그가 섞여 나온다 — -o 로 마지막 응답만 받아야 파싱이 성립한다
  assert.match(src, /'-o',\s*outFile/, 'the reply comes from --output-last-message');
  assert.match(src, /finally \{\s*try \{ unlinkSync\(outFile\)/, 'the temp file must not leak');
});

test('claude -p runs without tools and never writes files', () => {
  // 대본은 stdout 으로 받아 기존 계약 검증(image_prompt·TTS)을 통과시켜야 한다.
  // 모델이 파일을 직접 쓰면 그 게이트를 우회한다.
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-script.js'), 'utf-8');
  assert.match(src, /'--allowed-tools',\s*''/, 'no tools — text generation only');
  assert.match(src, /파일을 쓰지 마라/, 'the prompt must forbid file writes');
  assert.match(src, /const fenced =/, 'code fences must be stripped from the reply');
});

test('the generated script still passes the machine gates', () => {
  // EP-2026-0091 은 claude -p 로 만들어졌고 두 게이트를 통과했다.
  // 엔진이 바뀌어도 산출물 계약은 같아야 한다.
  const ep = join(ROOT, 'workspace', 'episodes', 'EP-2026-0091', 'platforms', 'shorts', '30_script.md');
  let md;
  try { md = readFileSync(ep, 'utf-8'); } catch { return; }   // EP 가 정리됐으면 건너뛴다
  assert.match(md, /scenes:/, 'frontmatter must carry scenes');
  assert.match(md, /image_prompt/, 'each scene needs an image_prompt');
  const scenes = (md.match(/- scene_id:/g) || []).length;
  assert.equal(scenes, 5, 'shorts is a 5-scene format');
});
