import test from 'node:test';
import assert from 'node:assert/strict';
import { check, severity } from '../scripts/automation/qa-economic-accuracy.js';

const scene = (narration, subtitle) => `  - scene_id: "001"
    role: hook
    narration: ${narration}
      이어지는 낭독 줄에도 오백억 원이 있습니다.
    subtitle_text: |-
      ${subtitle}
    target_seconds: 10
`;

test('낭독문의 한글 숫자는 TTS 규칙이다 — 여러 줄이어도 HIGH 가 아니다', () => {
  const findings = check(`scenes:\n${scene('외국인은 일조 육천억 원 넘게 순매도했습니다.', '외국인 순매도')}`);
  assert.deepEqual(findings.hangul_number, []);
  assert.equal(severity(findings), 'LOW');
});

test('화면 표준 표기와 어림수는 통과한다', () => {
  for (const text of ['1조 6천억 원', '3백억 원', '57.2조 원', '100억 원', '수천억 원', '몇백억 달러']) {
    assert.deepEqual(check(`scenes:\n${scene('낭독', text)}`).hangul_number, [], text);
  }
});

test('화면에 나온 한글 숫자 금액은 그대로 HIGH 다', () => {
  for (const text of ['오십조 원', '일조 오천억 원', '삼백억 달러']) {
    const findings = check(`scenes:\n${scene('낭독', text)}`);
    assert.ok(findings.hangul_number.length > 0, text);
    assert.equal(severity(findings), 'HIGH');
  }
});
