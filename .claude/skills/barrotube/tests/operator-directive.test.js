import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { directiveBlock, directivePath, readOperatorDirective } from '../scripts/automation/lib/operator-directive.js';
import { buildDeskPrompt } from '../scripts/automation/desk-briefing.js';

test('운영자 지시는 그날·그 슬롯 파일만 읽고, 없으면 프롬프트에 아무것도 넣지 않는다', () => {
  // 2026-10-15 운영자: 「국장 마감 회차는 오늘 반도체·지수 폭락으로」 — FORCE_TOPIC 은 리서치를 건너뛰어 쓸 수 없었다.
  const root = mkdtempSync(join(tmpdir(), 'bt-directive-'));
  mkdirSync(join(root, 'workspace', 'ops', 'directives'), { recursive: true });
  writeFileSync(directivePath(root, '2026-10-15', 'kr-close'), '주제는 반도체와 지수의 폭락이다.\n');
  assert.equal(readOperatorDirective(root, '2026-10-15', 'kr-close'), '주제는 반도체와 지수의 폭락이다.');
  assert.equal(readOperatorDirective(root, '2026-10-15', 'us-close'), '', '다른 슬롯에 새지 않는다');
  assert.equal(readOperatorDirective(root, '2026-10-16', 'kr-close'), '', '다음 날에 새지 않는다');
  assert.equal(directiveBlock(''), '');
  assert.match(directiveBlock('주제는 폭락', '에디터: topic 은 이 주제'), /운영자 지시[\s\S]*주제는 폭락[\s\S]*에디터: topic[\s\S]*최근 회차와 소재가 겹쳐도/);
});

test('데스크 기자 프롬프트에 운영자 지시가 들어간다', () => {
  const reporter = { id: 'equities', label: '증시 데스크', beat: '코스피', question: '?', symbols: [], search_hints: [] };
  const base = { reporter, slot: { label: '국내 증시 마감' }, date: '2026-10-15', snapshot: null, outDir: '/tmp', newsPath: 'n', competitorPath: 'c', social: '' };
  assert.doesNotMatch(buildDeskPrompt(base), /운영자 지시/);
  assert.match(buildDeskPrompt({ ...base, directive: '주제는 반도체와 지수의 폭락' }), /운영자 지시[\s\S]*반도체와 지수의 폭락/);
});
