/**
 * summary-title.js — 「미국 증시 요약」 제목 (config/market-summary.json title.template).
 *
 * 벤치마크 427편은 제목이 매일 같은 머리말 + 그날 사건 + 날짜라 시청자가 시리즈로 알아본다.
 * 날짜는 발행일이 아니라 **미국 장 날짜**다 — 08시에 올라가는 편은 전날 밤 마감을 다룬다.
 */

const DOW = '일월화수목금토';

export function summaryTitle(template, hook, session) {
  const [y, m, d] = String(session).split('-');
  const dow = DOW[new Date(`${session}T12:00:00Z`).getUTCDay()];
  return template
    .replace('{hook}', String(hook || '').trim())
    .replace('{yy}', y.slice(2)).replace('{mm}', m).replace('{dd}', d).replace('{dow}', dow);
}
