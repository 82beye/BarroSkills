/**
 * 운영자 지시 — 그날 한 회차의 주제를 사람이 정한다.
 *
 * FORCE_TOPIC 은 리서치(데스크·리서처)를 통째로 건너뛰어 대본이 근거 없이 쓰인다. 이 파일은 리서치를
 * 그대로 돌리면서 주제만 묶는다: 데스크 기자·에디터·리서처가 읽고, 최근 회차 중복 검사는 이 지시 앞에서
 * 물러난다(운영자가 연속 소재를 알고 정한 것이다).
 * 2026-10-15 운영자: 「국장 마감 회차는 오늘 반도체·지수 폭락으로」 — 10-13·10-14 도 코스피 하락이 주제였다.
 *
 * 위치: workspace/ops/directives/<KST 날짜>-<slot>.md — 본문을 그대로 프롬프트에 넣는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function directivePath(root, date, slot) {
  return join(root, 'workspace', 'ops', 'directives', `${date}-${slot}.md`);
}

export function readOperatorDirective(root, date, slot) {
  const p = directivePath(root, date, slot);
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : '';
}

/** 프롬프트에 넣을 절. 지시가 없으면 빈 문자열. who 는 그 절을 읽는 역할에 맞춘 한 줄. */
export function directiveBlock(text, who = '') {
  if (!text) return '';
  return `\n## 운영자 지시 — 오늘 이 회차의 주제 (최우선, 그대로 따른다)\n${text}\n${who ? `${who}\n` : ''}`
    + '최근 회차와 소재가 겹쳐도 지시가 우선한다 — 오늘의 새 사실(낙폭·순위·처음 있는 일)로 차별화하라. 수치는 여전히 출처가 있는 것만 쓴다.\n';
}
