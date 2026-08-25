import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const OPENAI = readFileSync(join(ROOT, 'scripts/automation/lib/image-engines/openai-gpt-image.js'), 'utf-8');
const SCENE = readFileSync(join(ROOT, 'scripts/automation/generate-image-gemini.js'), 'utf-8');
const INTRO_V10 = readFileSync(join(ROOT, 'scripts/automation/lib/image-engines/intro-v10.js'), 'utf-8');

test('OpenAI 경로도 캐릭터시트를 참조 이미지로 붙인다', () => {
  // 2026-08-14 실측: 시트를 붙이면 몸통/머리 0.64(발행본 밴드 0.57~0.68), 안 붙이면
  // 0.85~1.0 으로 뚱뚱해진다. 프롬프트 문구를 다섯 번 고쳐도 안 잡히던 값이다.
  // gemini 분기에는 시트가 있었고 openai 분기에만 없었다 — 엔진을 바꾸면 조용히 드리프트했다.
  assert.match(OPENAI, /images\/edits/, '시트가 있으면 edits 엔드포인트로 보내야 한다');
  assert.match(OPENAI, /form\.append\('image\[\]'/, '시트를 멀티파트로 실어야 한다');
  assert.match(OPENAI, /export function sheetPath/);

  // 모든 분기가 같은 채널 인자를 받아야 한다 — 하나라도 빠지면 엔진 전환이 곧 드리프트다.
  const start = SCENE.indexOf('generateImageOpenAI({');
  assert.ok(start > 0, '씬 생성기가 openai 엔진을 호출해야 한다');
  const openaiCall = SCENE.slice(start, start + 600);
  assert.match(openaiCall, /channel: meta\.channel_id/, 'openai 분기에도 channel 을 넘겨야 한다');

  // 2026-08-20: codex(내장 imagegen) 분기 추가 → 3개.
  const codexStart = SCENE.indexOf('generateImageCodex({');
  assert.ok(codexStart > 0, '씬 생성기가 codex 엔진을 호출해야 한다');
  assert.match(SCENE.slice(codexStart, codexStart + 400), /channel: meta\.channel_id/,
    'codex 분기에도 channel 을 넘겨야 한다');

  assert.equal(
    (SCENE.match(/channel: meta\.channel_id/g) || []).length, 3,
    'gemini·openai·codex 세 분기 모두에 있어야 한다');
});

test('codex 어댑터가 캐릭터·노출 고정 블록을 매 호출에 붙인다', async () => {
  // 2026-08-20 실측: 시트를 -i 로 붙여도 imagegen 은 비율을 재창작한다. 1차 시도에서
  // 캡슐 몸통이 사라지고 미튼이 손가락으로 변형됐다. 같은 프롬프트에 아래 블록만
  // 덧붙인 2차부터 5컷 연속 균일. 씬 프롬프트가 아니라 어댑터가 소유해야 하는 이유는
  // image-prompt-contract 길이 밴드(640~780자)를 깨기 때문이다.
  const { CHARACTER_LOCK, EXPOSURE_LOCK } = await import('../scripts/automation/lib/image-engines/codex-imagegen.js');
  assert.match(CHARACTER_LOCK, /VISIBLE SLIM CAPSULE BODY/, '몸통 소실이 1차 실패 모드였다');
  assert.match(CHARACTER_LOCK, /WHITE MITTENS with NO separated fingers/, '손가락 변형이 1차 실패 모드였다');
  assert.match(EXPOSURE_LOCK, /never a flat\n?\s*black field/, '배경이 순수 검정으로 가라앉는 게 codex 의 기본 경향이다');

  const ADAPTER = readFileSync(join(ROOT, 'scripts/automation/lib/image-engines/codex-imagegen.js'), 'utf-8');
  assert.match(ADAPTER, /mkdtempSync/, '에피소드 폴더를 열어주지 말고 빈 임시 디렉터리에서 생성해야 한다');
});

test('씬 프롬프트가 마스코트를 주어로 쓰면 "마스코트 없음" 지시를 보내지 않는다', () => {
  // 2026-08-14 EP-2026-0093: 계약(image-prompt-contract)은 마스코트가 씬 동작의 주어일 것을
  // BLOCK 으로 요구하는데, 이 파일은 "ABSENT by default + 구석에 작은 액센트 허용"을 함께
  // 보내고 있었다. 모델은 둘 다 그렸다 — 중앙에 하나, 오른쪽 아래에 또 하나. 5컷 중 4컷.
  // 발행본은 브라우저 경로라 이 코드를 안 거쳐서 여태 드러나지 않았다.
  assert.match(SCENE, /const promptNamesMascot = \/마시\|mascot\/i\.test/,
    '씬 프롬프트에 마스코트가 있는지 먼저 봐야 한다');
  assert.match(SCENE, /Draw EXACTLY ONE mascot/,
    '중복 마스코트를 명시적으로 금지해야 한다');
  assert.match(SCENE, /corner accent, sticker, logo or watermark/,
    '구석 스티커는 EP-0070 에서 5컷 전부를 망친 실패 모드다');

  // 조건 없이 ABSENT 를 보내던 형태로 돌아가면 안 된다.
  const clauseBlock = SCENE.slice(SCENE.indexOf('const promptNamesMascot'), SCENE.indexOf('charPrefix = framingOnlyPrefix'));
  assert.ok(clauseBlock.includes('? `MASCOT POLICY'), '마스코트 유무로 갈라져야 한다');
});

test('인트로 v10 은 채널을 받으면 마스코트와 시트를 함께 쓴다', () => {
  // 발행본 인트로(EP-0091·0092)에는 마시가 있다. v10 은 useMascot:false 로 고정돼 있어
  // 브라우저 경로에서 API 경로로 넘어가는 순간 마스코트가 사라졌다.
  assert.match(INTRO_V10, /useMascot: !!channel/);
  assert.match(INTRO_V10, /channel,\n\s*costContext/, '시트가 이미지 호출까지 전달돼야 한다');
});
