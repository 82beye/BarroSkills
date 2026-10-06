import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  alertLine, buildAnalysisPrompt, codeExcerpt, envAnalysis, errorLines, findMessageSources, incidentId,
  incidentMarkdown, matchEnvFailure, needleOf, needlesOf, NEXT_RUN, parseAnalysis, runSlice, sameStageHistory, shouldSkipStage, stopMarkers,
} from '../scripts/automation/lib/incident-analysis.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 2026-10-07 EP-2026-0214 의 실제 stderr 꼬리를 줄인 것 — 이 사건이 분석기의 기준 사례다.
const ERR = [
  '🔍 Factcheck: EP-2026-0209 (engine=claude, force_grounding=true)',
  '❌ 요약 대본 계약을 맞추지 못했다',
  '🔍 Factcheck: EP-2026-0214 (engine=claude, force_grounding=true)',
  'ℹ️  URL 실존 검증으로 grounded 인정 — 2/4건 확인 (backend=claude-websearch).',
  '   ↻ narration 에 아라비아 숫자가 남았다 — 씬 006 (TTS 표기 정본 위반) — 재시도 2/2',
  '   ❌ [씬 006] spoken-number-budget: 씬 006: 말한 수치 10개 (상한 6) — 이팔이, 삼 퍼센트',
  '❌ 수정본이 품질 계약 error 1건 — 원본을 남기고 중단한다',
  '🖐  Phase 6 재작성: MED 부정확 또는 미접지(grounded=false) 주장을 대본에 반영하지 못했습니다.',
].join('\n');

test('환경 실패는 LLM 없이 환경으로 분류하고, 가드·게시 이후 단계는 분석하지 않는다', () => {
  assert.equal(matchEnvFailure('claude -p 종료코드 1: Not logged in · Please run /login'), 'Not logged in');
  assert.equal(matchEnvFailure('⚠ gemini: Gemini 402: { prepayment credits are depleted'), 'Gemini 402');
  assert.equal(matchEnvFailure('Unexpected token at position 402'), null, '숫자 402 는 환경 실패가 아니다');
  assert.equal(matchEnvFailure(ERR), null, '계약 위반은 코드 문제다');
  assert.equal(envAnalysis('Not logged in').class, 'env');
  assert.ok(shouldSkipStage('Phase 0 guards'));
  assert.ok(shouldSkipStage('Phase 12 publish'));
  assert.ok(!shouldSkipStage('Phase 6 재작성'));
});

test('크론 로그에서 이번 회차 구간만 자른다 — 지난 회차 오류가 원인으로 섞이지 않는다', () => {
  const slice = runSlice(ERR, 'EP-2026-0214');
  assert.ok(!slice.includes('EP-2026-0209'), '이전 회차 줄은 버린다');
  assert.ok(!slice.includes('요약 대본 계약을 맞추지 못했다'));
  assert.match(slice, /원본을 남기고 중단한다/);
  assert.equal(runSlice('a\nb\nc', 'EP-X', { fallback: 2 }), 'b\nc', 'EP 언급이 없으면 꼬리');
  // 소급 분석: 그 회차 뒤에 다음 회차가 이어 써져 있다 — 다음 Phase 0 배너에서 자른다.
  const log = ['🚦 Phase 0 — 가드', 'EP-2026-0198 생성', '❌ FAIL at Phase 8 produce', '🚦 Phase 0 — 가드', 'EP-2026-0199 생성', '❌ 다른 회차 실패'].join('\n');
  const old = runSlice(log, 'EP-2026-0198', { until: NEXT_RUN.log });
  assert.match(old, /Phase 8 produce/);
  assert.doesNotMatch(old, /EP-2026-0199|다른 회차/, '다음 회차 줄이 섞이면 안 된다');
  // stderr 는 배너가 없다 — 그 회차를 끝낸 FAIL 줄에서 자른다(뒤에 붙은 수동 재개 줄 제외).
  const err = ['🔍 Factcheck: EP-2026-0202', '❌ JSON parse failed (after fix-up): Unexpected', '❌ FAIL at Phase 8 produce: produce-episode.js 실패', '⏱  목표 18:00 를 놓쳤습니다 — 즉시 공개'].join('\n');
  const cut = runSlice(err, 'EP-2026-0202', { until: NEXT_RUN.err, stopAt: stopMarkers('Phase 8 produce') });
  assert.match(cut, /FAIL at Phase 8 produce/);
  assert.doesNotMatch(cut, /즉시 공개/);
  assert.equal(needlesOf('❌ JSON parse failed (after fix-up): Unexpected non-whitespace character after JSON at position 1873')[1],
    'JSON parse failed', 'V8 문구(가장 긴 구간) 다음 후보로 코드 문구를 찾는다');
  const src = [{ path: 'm.js', text: "  console.error('❌ JSON parse failed (after fix-up):', e.message);" },
    { path: 'x.js', text: 'const Metadata = 1;' }];
  assert.deepEqual(findMessageSources(['Metadata', ...needlesOf('❌ JSON parse failed (after fix-up): Unexpected non-whitespace character')], src)
    .map((h) => h.path), ['m.js'], '짧은 일반 단어는 건너뛰고 코드 문구를 찾는다');
  const lines = errorLines(slice);
  assert.ok(lines.at(-1).startsWith('🖐'), '가장 최근 실패 줄이 끝에 온다');
  assert.ok(lines.some((l) => l.includes('spoken-number-budget')));
});

test('실패 문구로 그 문구를 내는 코드 줄을 찾는다 — 주석 속 인용은 건너뛴다', () => {
  assert.equal(needleOf('❌ 수정본이 품질 계약 error 1건 — 원본을 남기고 중단한다'), '수정본이 품질 계약 error');
  const files = [
    { path: 'a.js', text: '// 예: 「원본을 남기고 중단한다」 가 뜨면\nconst x = 1;' },
    { path: 'b.js', text: 'line1\nline2\n  giveUp(`❌ 수정본이 품질 계약 error ${n}건 — 원본을 남기고 중단한다`);' },
  ];
  const hits = findMessageSources(['원본을 남기고 중단한다'], files);
  assert.deepEqual(hits.map((h) => [h.path, h.line]), [['b.js', 3]]);
  assert.match(codeExcerpt(files[1].text, 3, 1), /^\s+2 {2}line2\n\s+3 {2}\s+giveUp/);
});

test('같은 단계 이력은 감사 로그의 halt·fail 에서 단계 번호로 모은다', () => {
  const events = [
    { at: '2026-10-04T21:10:00Z', event: 'auto_pipeline_halt', detail: 'slot=us-close stage=Phase 5 계약 detail=…' },
    { at: '2026-10-06T21:15:00Z', event: 'auto_pipeline_halt', detail: 'slot=us-close stage=Phase 6 재작성 detail=…' },
    { at: '2026-09-30T21:15:00Z', event: 'auto_pipeline_fail', detail: 'slot=us-close ep=EP-2026-0196 stage=Phase 6 factcheck detail=…' },
    { at: '2026-10-06T21:20:00Z', event: 'auto_pipeline_stage', detail: 'slot=us-close Phase 6' },
  ];
  const h = sameStageHistory(events, 'Phase 6 재작성');
  assert.deepEqual(h.map((x) => x.kind), ['halt', 'fail']);
});

test('LLM 분석 JSON 을 검증한다 — 원인이 없으면 버리고, 분류·목록은 정규화한다', () => {
  assert.equal(parseAnalysis('not json'), null);
  assert.equal(parseAnalysis({ class: 'code' }), null);
  const a = parseAnalysis(JSON.stringify({
    root_cause: '팩트체커가 요약 원자료(summary-us.json)를 받지 못해 맞는 수치를 HIGH 미확인으로 판정했다.',
    class: 'weird', confidence: 3, evidence: ['revise-script-factcheck.js:376', ''],
    fix: { summary: '원자료를 프롬프트에 붙인다', files: ['scripts/automation/run-factcheck.js'], steps: ['a'], test: 't' },
    resume: '리포트를 다시 만든 뒤 재개',
  }));
  assert.equal(a.class, 'code', '모르는 분류는 code');
  assert.equal(a.confidence, 1, '확신은 0~1');
  assert.deepEqual(a.evidence, ['revise-script-factcheck.js:376']);
  const md = incidentMarkdown('IR-20261007-0656', { ep: 'EP-2026-0214', stage: 'Phase 6 재작성', slot: 'us-close', kind: 'halt', at: 'x', detail: 'd' }, a);
  assert.match(md, /## 수정 설계/);
  assert.match(md, /코드는 바뀌지 않았다/, '설계서는 구현이 사람 몫임을 밝힌다');
  assert.match(md, /## 구현 요청[\s\S]*RESUME_EP=EP-2026-0214 --slot us-close/, '승인 세션에 붙여 넣을 요청을 준다');
  const done = incidentMarkdown('IR-1', { ep: 'EP-1', stage: 'Phase 8', slot: 'kr-close', kind: 'fail', at: 'x', detail: 'd' }, { ...a, status: 'already_fixed' });
  assert.doesNotMatch(done, /## 구현 요청/, '이미 고쳐진 건은 구현 요청이 없다');
  assert.match(alertLine('IR-20261007-0656', a), /^자동 분석\(코드\): .*run-factcheck\.js.*growth\/incidents\/IR-20261007-0656\.md$/);
  assert.equal(incidentId(new Date('2026-10-06T21:56:00Z')), 'IR-20261007-0656', 'KST 시각으로 이름 짓는다');
});

test('분석 프롬프트는 증거만 근거로 쓰게 하고, 게이트를 느슨하게 하는 설계를 수정으로 치지 않는다', () => {
  const { system, user } = buildAnalysisPrompt({
    incident: { ep: 'EP-2026-0214', stage: 'Phase 6 재작성' }, errLines: ['❌ x'], logTail: 'tail',
    excerpts: [{ path: 'b.js', line: 3, needle: 'n', excerpt: 'code' }], history: [], previous: [], stageCode: 'run-factcheck.js',
  });
  assert.match(system, /읽기 전용\)에 있는 것만 근거로/);
  assert.match(system, /막힌 판정.*옳았는지부터 확인/, '증상을 낸 마지막 단계가 아니라 판정이 옳았는지부터 본다');
  assert.match(system, /게이트.*끄거나 느슨하게 하는 것은 수정이 아니다/);
  assert.match(user, /### b\.js:3/);
});

test('파이프라인은 멈춤·실패 알림 전에 분석을 붙이고, 분석기는 코드를 쓰지 않는다', () => {
  const auto = readFileSync(join(ROOT, 'lib', 'auto-pipeline.sh'), 'utf8');
  for (const fn of ['fail_with_alert', 'halt_for_human']) {
    const body = auto.slice(auto.indexOf(`${fn}() {`), auto.indexOf('\n}', auto.indexOf(`${fn}() {`)));
    const call = body.indexOf('incident_analysis');
    const notify = body.indexOf('notify_telegram');
    assert.ok(call > 0 && call < notify, `${fn}: 분석이 알림보다 먼저여야 한다`);
    assert.match(body, /\$\{ia:\+\\n\\n🔎 \$ia\}/, `${fn}: 분석 한 줄을 알림에 싣는다`);
  }
  assert.match(auto, /BT_INCIDENT_ANALYSIS:-1/, '끌 수 있어야 한다');
  // 분석기가 쓰는 곳은 growth/incidents 뿐이다 — 코드·설정 파일을 고치는 경로가 없어야 한다.
  const cli = readFileSync(join(ROOT, 'scripts', 'automation', 'incident-analyze.js'), 'utf8');
  const writes = [...cli.matchAll(/(?:writeAtomic|appendFileSync|writeFileSync)\(([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(writes.length >= 2);
  for (const w of writes) assert.match(w, /GROWTH|^path$|^tmp$/, `분석기 쓰기 대상: ${w}`);
  assert.doesNotMatch(cli, /-s', 'workspace-write'|acceptEdits|--allowed-tools', 'Edit/, '쓰기 권한 엔진을 부르지 않는다');
});
