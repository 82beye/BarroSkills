import { scoreSentimentRegex } from './lib/sentiment.js';

// [입력, 기대값] — 핵심: 부정/반전 문맥 (기존 단순매칭이 오판하던 케이스)
const cases = [
  // 단순 신호 (회귀 방지)
  ['코스피 폭락, 패닉 셀', 'bearish'],
  ['삼성전자 신고가 돌파 랠리', 'bullish'],
  ['코스피 7000 돌파', 'bullish'],
  // 반전 — 기존엔 오판
  ['폭락 우려 해소되며 안도', 'bullish'],
  ['낙폭 축소, 하락 멈춤', 'bullish'],
  ['상승세 꺾여 약세 전환', 'bearish'],
  ['급등세 멈춰', 'bearish'],
  // 부정 — 기존엔 오판
  ['우려와 달리 하락하지 않았다', 'bullish'],
  // 이중 부정 (반전+부정 = 원복) — 어려운 케이스
  ['하락 멈추지 않아', 'bearish'],
  // 중립
  ['오늘의 환율과 금리 점검', null],
  ['', null],
];

let pass = 0, fail = 0;
for (const [text, expected] of cases) {
  const got = scoreSentimentRegex(text);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} "${text}" → ${got}  (기대: ${expected})`);
}
console.log(`\n${pass}/${cases.length} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
