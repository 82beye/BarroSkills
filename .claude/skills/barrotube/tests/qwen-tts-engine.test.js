import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCloneRef, QWEN_INSTRUCT } from '../scripts/automation/generate-tts.js';

const ROOT = join(import.meta.dirname, '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-tts.js'), 'utf-8');

test('engine selection is wired at BOTH entry points', () => {
  // 2026-08-14: --engine 을 --script 분기에만 걸어두는 바람에 --engine qwen 을 준
  // --text 호출이 조용히 ElevenLabs 로 나가 과금됐다. 분기보다 위에서 정해져야 한다.
  const declaration = SRC.indexOf("const engine = (opts.engine");
  const textBranch = SRC.indexOf('if (opts.text && opts.out)');
  const scriptBranch = SRC.indexOf("} else if (opts.script && opts['out-dir'])");

  assert.ok(declaration > 0, 'engine must be resolved from opts/env');
  assert.ok(declaration < textBranch, 'engine must be decided before the --text branch');
  assert.ok(textBranch < scriptBranch, 'sanity: --text branch comes first');
  assert.equal(SRC.split("const engine = (opts.engine").length - 1, 1,
    'engine 을 분기마다 다시 정하면 또 갈라진다 — 선언은 한 곳이어야 한다');
});

test('the qwen path keeps the TTS number policy', () => {
  // narration 의 아라비아 숫자 금지는 엔진과 무관한 계약이다(TTS 정책 v3.0).
  const qwenFn = SRC.slice(SRC.indexOf('export async function generateTTSQwen'));
  assert.match(qwenFn.slice(0, 400), /assertTtsNarration\(text\)/,
    'qwen 경로도 숫자 검증을 통과해야 한다');
});

test('the ending is protected — filler is spoken, then cut, and never re-trimmed', () => {
  // 이 모델은 마지막 음절의 여운을 만들지 않고 파일을 끝낸다(실측 -23dBFS,
  // ElevenLabs 는 -73dBFS). 필러를 붙여 여운을 얻고 그 앞에서 자른다.
  assert.match(SRC, /const QWEN_TAIL_FILLER = /, 'a trailing filler must exist');
  assert.match(SRC, /const spoken = `\$\{text\}\$\{QWEN_TAIL_FILLER\}`/,
    'the filler must actually be sent to the model');
  assert.match(SRC, /findTailCut\(rawPath, rawDuration\)/, 'the filler must be cut back off');
  assert.match(SRC, /afade=t=out/, 'the cut needs a short fade to avoid a click');

  // 뒤쪽 무음 트림이 돌아오면 애써 얻은 여운이 다시 사라진다.
  assert.doesNotMatch(SRC, /areverse/,
    '뒤에서부터 무음을 깎으면 한국어 종결어미의 여운(-45dB 이하)이 잘린다');
});

test('a cut that cannot be located leaves the audio alone', () => {
  // 경계를 못 찾았는데 감으로 자르면 내용을 잃는다. 그때는 그대로 두는 게 맞다.
  const fn = SRC.slice(SRC.indexOf('function findTailCut'), SRC.indexOf('export function loadCloneRef'));
  assert.match(fn, /return null/, 'detection must be able to fail');
  assert.match(SRC, /cutAt\s*\?/, 'the caller must branch on a failed detection');
});

test('runaway generation is detected and retried a bounded number of times', () => {
  // ryan 화자가 123자를 63.8초로 뱉은 적이 있다(정상 ~16초). 조용히 넘기면 규격이 깨진다.
  assert.match(SRC, /const QWEN_MIN_RATE = /, 'a plausibility floor must exist');
  assert.match(SRC, /attempt <= QWEN_MAX_ATTEMPTS/, 'retries must be bounded');
  assert.match(SRC, /rawDuration <= maxPlausible/, 'the guard must compare against text length');
});

test('clone needs both the reference audio and its transcript', () => {
  // 참조 음성과 대사가 어긋나면 복제 품질이 떨어진다. 둘 다 없으면 아예 안 쓴다.
  assert.equal(loadCloneRef(null), null);
  assert.equal(loadCloneRef('channel-that-does-not-exist'), null);
  assert.match(SRC, /voice-ref/, 'the reference lives in the channel directory');
});

test('persona tone survives the engine swap', () => {
  // ElevenLabs 의 stability/style 에 해당하는 것이 qwen 에서는 instruct 문구다.
  assert.ok(QWEN_INSTRUCT['barro-alert'], 'shorts persona needs a tone instruction');
  assert.ok(QWEN_INSTRUCT['barro-teacher'], 'long-form persona needs one too');
});

test('elevenlabs stays the default — the pilot must not hijack the pipeline', () => {
  assert.match(SRC, /\|\| 'elevenlabs'\)\.toLowerCase\(\)/,
    'omitting --engine must keep the existing ElevenLabs path');
});
