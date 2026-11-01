import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse as parseYAML } from 'yaml';
import { reviewSummaryBrief, reviewSummaryMetadata, reviewSummarySpine, spineGaps } from '../scripts/automation/lib/editorial-spine.js';
import { isRepeatStory } from '../scripts/automation/lib/topic-fallback.js';
import { evidenceRefs } from '../scripts/automation/generate-summary-script.js';

const path = (...parts) => join(import.meta.dirname, '..', ...parts);
const spine = {
  observation: '유가가 오르는 동안 미국 기술주는 약세였습니다.',
  mechanism: '보도된 휴전 불안이 원유 가격에 반영됐다는 해석입니다.',
  transmission: '유가 상승이 이어지면 운송과 원재료 비용에 부담이 옮겨갑니다.',
  viewer_result: '한국 수입기업의 비용 압박은 유가가 높게 유지될 때의 조건부 결과입니다.',
  watch_signal: '다음 원유 정산가와 기업의 원가 설명이 같은 방향인지 확인합니다.',
  evidence_refs: ['summary-us.json'],
};
const draft = (open, macro, schedule, editorial_spine = spine) => ({
  editorial_spine,
  scenes: [
    { role: 'open', narration: open },
    { role: 'korea', narration: macro },
    { role: 'next', narration: schedule },
  ],
});

test('real October summaries reveal spoken index and cross-asset lists', () => {
  for (const [episode, expected] of [[220, 2], [223, 2], [228, 3]]) {
    const file = path('workspace', 'episodes', `EP-2026-${String(episode).padStart(4, '0')}`,
      'platforms', 'shorts', '30_script.md');
    const fm = parseYAML(readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]);
    const issues = reviewSummarySpine({ scenes: fm.scenes, editorial_spine: spine }, spine.evidence_refs);
    assert.equal(issues.length, expected, `${episode}: ${issues.join(' / ')}`);
  }
});

test('a focused conditional explanation passes without a forced price forecast', () => {
  const result = reviewSummarySpine(draft(
    '시월 십이일 미국 증시 요약입니다. 에너지 휴전이 흔들리며 유가 부담이 다시 쟁점입니다.',
    '유가 상승이 이어지면 수입 원가에 압박이 옮겨갈 수 있습니다. 아직 한국 기업 실적에 드러나지는 않았습니다.',
    '다음 원유 정산가와 기업의 원가 설명을 보겠습니다. 유가가 되돌아가면 비용 압박 해석도 약해집니다.'),
  spine.evidence_refs);
  assert.deepEqual(result, []);
});

test('copied editorial fields and invented source URLs fail; labels alone cannot establish truth', () => {
  const copied = { ...spine, observation: '영향이 있을 수 있습니다.', mechanism: '영향이 있을 수 있습니다.',
    transmission: '영향이 있을 수 있습니다.', evidence_refs: ['https://invented.invalid/story'] };
  const issues = reviewSummarySpine(draft('미국 증시 요약입니다.', '유가가 상승했습니다.',
    '다음 자료를 확인합니다.', copied), ['summary-us.json']);
  assert.ok(issues.some((item) => item.includes('같은 문장')));
  assert.ok(issues.some((item) => item.includes('실제 존재하는 근거')));
  // Distinct, well-shaped sentences could still assert a false economic cause.
  // The test deliberately does not claim this checker proves factual accuracy.
});

test('adversarially plausible but unsupported causation can pass structural checks', () => {
  const falseSpine = {
    observation: '유가가 오르고 반도체주는 내렸습니다.',
    mechanism: '유가 상승이 반도체 하락의 유일한 원인입니다.',
    transmission: '원유 가격이 모든 반도체 회사의 매출을 즉시 줄입니다.',
    viewer_result: '국내 반도체 회사의 이익 감소가 이미 확정됐습니다.',
    watch_signal: '다음 기업 발표에서 매출을 확인할 수 있습니다.',
    evidence_refs: ['summary-us.json'],
  };
  const result = reviewSummarySpine(draft('미국 증시 요약입니다. 에너지와 반도체가 갈렸습니다.',
    '유가가 올랐고 두 업종의 움직임이 달랐습니다.', '기업 발표에서 매출을 확인합니다.', falseSpine),
  ['summary-us.json']);
  assert.deepEqual(result, [], '구조·URL 참조 검사는 이런 허위 인과를 입증하거나 반박하지 못한다');
});

test('repetition compares the viewer question, explanation, result and new fact', () => {
  const old = { question: '연체 증가가 미국 소비를 줄일까요?', mechanism: '상환 부담이 가계 현금 흐름을 압박합니다.',
    viewer_result: '소비 감소가 기업 매출을 압박할 수 있습니다.', new_fact: '연체 가구 비중이 스무 퍼센트에 가까워졌습니다.' };
  assert.equal(isRepeatStory({ ...old }, [{ story_spine: old }]), true);
  assert.equal(isRepeatStory({ ...old, new_fact: '새 소비기업 실적에서 매출 감소가 확인됐습니다.' },
    [{ story_spine: old }]), false, '새로운 사실이면 같은 주제라도 허용한다');
  assert.equal(isRepeatStory({ ...old, question: '대출 금리는 언제 낮아질까요?' },
    [{ story_spine: old }]), false, '새로운 질문이면 허용한다');
});

test('summary evidence references are limited to supplied URLs and local data', () => {
  assert.deepEqual(evidenceRefs({ reasons: { X: { url: 'https://example.com/earnings' } } },
    { desk: 'https://example.com/report', research: '', topic: '' }),
  ['summary-us.json', 'https://example.com/report', 'https://example.com/earnings']);
});

test('the pipeline preserves a content failure instead of invoking the generic fallback', () => {
  const shell = readFileSync(path('lib', 'auto-pipeline.sh'), 'utf8');
  assert.match(shell, /\[ "\$summary_status" = "3" \]/);
  assert.match(shell, /return 3/);
});

test('selected Korea/US contrast must survive the summary writer with correct time order', () => {
  const topic = '미국 S&P 500은 보합인데 코스피만 -5.46% 급락, 외국인 4.5조 원 순매도가 겹쳤다.';
  const missing = reviewSummaryBrief({ scenes: [
    { narration: '미국 증시 요약입니다. 마이크론이 하락했습니다.', subtitle_text: '마이크론 -3.62%' },
  ] }, topic);
  assert.equal(missing.length, 5, missing.join(' / '));
  const corrected = reviewSummaryBrief({ scenes: [
    { narration: '코스피가 크게 내렸습니다. 한국 장 마감 뒤 그날 밤 미국 장에서는 다른 모습이었습니다.',
      subtitle_text: '코스피 -5.46%' },
    { narration: '외국인 순매도 규모도 컸습니다.', subtitle_text: '외국인 4.5조 원 순매도' },
  ] }, topic);
  assert.deepEqual(corrected, []);
  assert.deepEqual(reviewSummaryBrief({ scenes: [] }, '미국 반도체주 약세'), [], '한국 대비가 아닌 회차는 영향 없음');
});

test('summary distribution copy cannot promise numbers absent from the video', () => {
  const scenes = [{ narration: '코스피가 내렸습니다.', subtitle_text: '코스피 약세' }];
  const meta = { summary: '코스피는 5.46% 급락, 외국인 4.5조 원 순매도와 겹친 결과입니다.',
    platforms: { tiktok: { caption: '코스피 -5.46% 급락' } } };
  const problems = reviewSummaryMetadata(meta, scenes);
  assert.ok(problems.some((p) => p.includes('외국인')));
  assert.ok(problems.some((p) => p.includes('코스피 5.46%')));
  assert.deepEqual(reviewSummaryMetadata({ summary: '코스피는 5.46% 하락했습니다.' },
    [{ narration: '코스피가 내렸습니다.', subtitle_text: '코스피 -5.46%' }]), []);
});

test('saved summary metadata is checked again on a resumed episode without a model call', () => {
  const episode = mkdtempSync(join(tmpdir(), 'barrotube-summary-meta-'));
  const media = join(episode, 'platforms', 'shorts');
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, '30_script.md'), `---\nform: market-summary\nscenes:\n  - role: open\n    narration: 코스피가 내렸습니다.\n    subtitle_text: 코스피 약세\n---\n`);
  const metaPath = join(media, '70_publish_meta.json');
  const cli = path('scripts', 'automation', 'generate-metadata.js');
  const run = () => spawnSync(process.execPath, [cli, '--episode', episode, '--platform', 'shorts', '--validate'], { encoding: 'utf8' });
  try {
    writeFileSync(metaPath, JSON.stringify({ summary: '코스피 5.46% 급락, 외국인 순매도' }));
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /배포 메타데이터 검증 실패/);
    writeFileSync(metaPath, JSON.stringify({ summary: '코스피가 내렸습니다.' }));
    result = run();
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(episode, { recursive: true, force: true });
  }
});

test('story_spine 근거 URL 은 리서치 본문에 있는지로 본다 — 표기 차이로 멀쩡한 리서치를 버리지 않는다', () => {
  const spine = { question: 'q', new_fact: 'n', observation: 'o', mechanism: 'm', transmission: 't', viewer_result: 'v',
    failure_condition: 'f', watch_signal: 'w', evidence_urls: ['https://a.example/x'] };
  assert.deepEqual(spineGaps(spine, '근거: `https://a.example/x`.'), []);
  assert.deepEqual(spineGaps(spine, '다른 기사만 인용'), ['미인용 https://a.example/x']);
  assert.deepEqual(spineGaps({ ...spine, mechanism: ' ' }, 'https://a.example/x'), ['mechanism']);
  assert.deepEqual(spineGaps({ ...spine, evidence_urls: [] }, ''), ['evidence_urls']);
  assert.deepEqual(spineGaps(null, ''), ['story_spine']);
});
