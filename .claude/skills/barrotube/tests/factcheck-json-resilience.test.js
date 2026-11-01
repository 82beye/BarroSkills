import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { extractJSON } from '../scripts/automation/run-factcheck.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'automation', 'run-factcheck.js'), 'utf8');

test('깨진 응답은 엔진 실패로 처리돼 재시도·폴백을 탄다', () => {
  // 2026-09-23 us-close(EP-2026-0175)가 여기서 죽었다. 파싱이 엔진 폴백 루프 **밖**에
  // 있어서 모델이 깨진 JSON 을 한 번 뱉으면 다시 부르지도, 다음 엔진으로 넘어가지도
  // 못하고 exit(2) → 파이프라인이 회차 전체를 접었다.
  const loop = SRC.match(/for \(const \[i, name\] of chain\.entries\(\)\) \{[\s\S]*?\n  \}/);
  assert.ok(loop, '엔진 체인 루프가 사라졌다');
  assert.match(loop[0], /result = extractJSON\(resp\.text\)/,
    '파싱이 엔진 루프 밖으로 다시 나갔다 — 깨진 응답이 회차를 죽인다');
  assert.match(loop[0], /PARSE_ATTEMPTS/, '같은 엔진 재시도가 없다');

  // 루프 뒤에서 다시 파싱하면 안 된다 (중복 파싱 = 두 번째 기회를 날린다).
  const after = SRC.slice(SRC.indexOf('if (!Array.isArray(result.claims))'));
  assert.ok(!/extractJSON\(/.test(after), '루프 뒤에 중복 파싱이 남아 있다');
});

test('파싱 실패 에러는 원문을 실어 보낸다 — 로그 1000자 절단으로 원인을 못 봤다', () => {
  // 실제 실패는 3106번째 문자였는데 로그에는 1000자만 찍혔다.
  const broken = '{"summary":"x","claims":[{"a":1,}]}';   // 후행 쉼표
  try {
    extractJSON(broken);
    assert.fail('깨진 JSON 이 통과했다');
  } catch (e) {
    assert.ok(e.rawText, '에러에 원문이 없다 — 덤프가 빈 파일이 된다');
    assert.equal(e.rawText, broken);
  }
  assert.match(SRC, /function dumpRawOutput/, '원문 덤프 함수가 없다');
});

test('기존 \\u 중복 오타 수리는 그대로 산다', () => {
  // 2026-09-14 EP-2026-0154 회귀 방지.
  const typo = '{"summary":"6\\uuc5b5","claims":[]}';
  const out = extractJSON(typo);
  assert.equal(out.summary, '6억');
  assert.deepEqual(out.claims, []);
});

test('정상 응답과 코드펜스 응답은 그대로 파싱된다', () => {
  assert.deepEqual(extractJSON('{"claims":[]}').claims, []);
  assert.deepEqual(extractJSON('```json\n{"claims":[1]}\n```').claims, [1]);
  assert.equal(extractJSON('앞말 {"claims":[],"summary":"s"} 뒷말').summary, 's');
});

test('재시도 횟수는 환경변수로 조절되고 기본은 2다', () => {
  // 세 번째까지 끌면 팩트체크가 회차 예산을 먹는다.
  assert.match(SRC, /BT_FACTCHECK_PARSE_ATTEMPTS \|\| 2/);
});
