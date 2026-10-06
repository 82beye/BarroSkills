// 성장 매니저 — LLM 이 가설·처방을 설계하고, 결정론이 거르고·켜고·판정한다.
// 2026-10-06 운영자: "KPI 성장 관리가 되지 않고 있다. 분석하고 계속 추적하면서 업데이트가 돼야 한다.
// 단순 자동화로는 안 될 것 같다." — 판단은 LLM 에 주되, 무엇을 얼마나 바꿀 수 있는지는 여기서 잠근다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildPrompt, validatePlan, applyPlan, journalMarkdown, telegramText, LIMITS } from '../scripts/automation/lib/growth-manager.js';
import { planRemediation, emptyState, measure, activeRemedies, remedySection, remediesApplied } from '../scripts/automation/lib/growth-remediation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const NOW = new Date('2026-10-06T10:40:00Z');
const SLOTS = { 'us-close': {}, 'kr-close': {}, omnibus: {}, realestate: {} };
const FIXED = JSON.parse(read('config/growth.json')).remedies;
const CATALOG = { ...FIXED };
delete CATALOG._comment;
const LIKE_ON = { ...emptyState(), active: [{ remedy: 'R-LIKE-CTA', status: 'active', started_at: NOW.toISOString(), baseline: { value: 0.007, episodes: 25 } }] };

const remedy = (over = {}) => ({
  id: 'R-AI-hook-why', label: '훅에 왜를 먼저', mode: 'auto', target: 'script',
  directive: '첫 문장에서 오늘 숫자 대신 "왜 그렇게 움직였나"를 먼저 묻고, 근거는 둘째 문장에 둔다.',
  slots: ['us-close'], metric: 'views48', min_episodes: 2, max_episodes: 99, keep_if_lift: 3, hypothesis: 'H-hook', rationale: 'r', ...over,
});

test('지시문: 허용 레버·한도·근거 규칙을 말하고 자료집을 통째로 넘긴다', () => {
  const { system, user } = buildPrompt({ date: '2026-10-06', kpi_today: [{ id: 'like_rate_7d' }] });
  assert.match(system, /target=script/);
  assert.match(system, /target=closing/);
  assert.match(system, /mode=propose 로만/, '포맷·편성·코드는 설계서로만');
  assert.match(system, /자료집에 없는 수치·사실/, '숫자를 만들지 않는다');
  assert.match(system, new RegExp(`최대 ${LIMITS.newAutoPerRun}개`));
  // 첫 실행(10-06)에서 「표본 부족 — 가설만」으로 처방을 미뤘다. 처방이 곧 실험이고 되돌리기는 엔진 몫이다
  assert.match(system, /확정될 때까지 기다리지 마라/);
  assert.ok(user.includes('"like_rate_7d"'), '자료집이 그대로 들어간다');
});

test('검증: 맞는 처방은 통과하고 판정 기준은 한도 안으로 당겨진다', () => {
  const { plan, rejected } = validatePlan({ summary: 's', remedies: [remedy()] }, { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW });
  assert.deepEqual(rejected, []);
  const def = plan.remedies[0].def;
  assert.equal(def.eval.min_episodes, LIMITS.minEpisodes[0], 'min_episodes 하한');
  assert.equal(def.eval.max_episodes, LIMITS.maxEpisodes, 'max_episodes 상한');
  assert.equal(def.eval.keep_if_lift, LIMITS.liftRange[1], 'keep_if_lift 상한');
  assert.deepEqual(def.slots, ['us-close']);
});

test('검증: 형식·범위·한도를 어긴 처방은 이유와 함께 거른다', () => {
  const v = (remedies, state = emptyState()) => validatePlan({ remedies }, { catalog: CATALOG, state, slots: SLOTS, now: NOW });
  assert.match(v([remedy({ id: 'hook' })]).rejected[0].reason, /id 형식/);
  assert.match(v([remedy({ id: 'R-LIKE-CTA' })]).rejected[0].reason, /id 형식|이미 있는/);
  assert.match(v([remedy({ slots: ['night'] })]).rejected[0].reason, /모르는 슬롯/);
  assert.match(v([remedy({ target: 'thumbnail' })]).rejected[0].reason, /target/);
  assert.match(v([remedy({ target: 'closing', closing_cta: '좋아요 1번만 눌러 주세요' })]).rejected[0].reason, /숫자 없이/);
  const two = v([remedy(), remedy({ id: 'R-AI-second', metric: 'like_rate', slots: ['kr-close'] })]);
  assert.equal(two.plan.remedies.length, 1);
  assert.match(two.rejected[0].reason, /한 번에 1개/);
  // 좋아요율을 재는 R-LIKE-CTA 가 켜져 있으면 같은 지표의 새 처방은 효과를 가를 수 없다
  assert.match(v([remedy({ metric: 'like_rate' })], LIKE_ON).rejected[0].reason, /같은 지표/);
  assert.match(v([remedy({ target: 'closing', closing_cta: '저장해 두세요.', metric: 'views48' })], LIKE_ON).rejected[0].reason, /마무리 문장 처방/);
  const exp = { id: 'EXP-02-title-number', target: 'metadata' };
  assert.match(validatePlan({ remedies: [remedy({ target: 'metadata' })] }, { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW, experiment: exp })
    .rejected[0].reason, /주간 실험 EXP-02-title-number/, '제목 실험 주간에 제목 처방을 켜면 둘이 섞인다');
  assert.equal(validatePlan({ remedies: [remedy()] }, { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW, experiment: exp }).plan.remedies.length, 1);
  // 10-06 두 번째 실행: us-close 「미국 증시 요약」 도입부를 바꾸는 대본 처방 — 그 포맷은 씬 1 이 계약으로 고정이고 대본 처방을 안 읽는다
  const SUMMARY_SLOTS = { ...SLOTS, 'us-close': { form: 'market-summary' } };
  assert.match(validatePlan({ remedies: [remedy()] }, { catalog: CATALOG, state: emptyState(), slots: SUMMARY_SLOTS, now: NOW }).rejected[0].reason,
    /us-close 는 대본 고정 포맷\(market-summary\)/);
  assert.equal(validatePlan({ remedies: [remedy({ mode: 'propose' })] }, { catalog: CATALOG, state: emptyState(), slots: SUMMARY_SLOTS, now: NOW })
    .plan.remedies.length, 1, '설계서로는 낼 수 있다 — 포맷은 사람이 바꾼다');
  assert.equal(validatePlan({ remedies: [remedy({ slots: ['kr-close'] })] }, { catalog: CATALOG, state: emptyState(), slots: SUMMARY_SLOTS, now: NOW })
    .plan.remedies.length, 1);
  const full = { ...emptyState(), active: ['R-A', 'R-B', 'R-C'].map((id) => ({ remedy: id, status: 'active', started_at: NOW.toISOString() })) };
  const cat3 = { ...CATALOG, 'R-A': { eval: { metric: 'like_rate' } }, 'R-B': { eval: { metric: 'like_rate' } }, 'R-C': { eval: { metric: 'like_rate' } } };
  assert.match(validatePlan({ remedies: [remedy()] }, { catalog: cat3, state: full, slots: SLOTS, now: NOW }).rejected[0].reason, /이미 3개/);
  assert.match(validatePlan({ retire: [{ id: 'R-LIKE-CTA', reason: 'x' }] }, { catalog: CATALOG, state: LIKE_ON, slots: SLOTS, now: NOW }).rejected[0].reason, /R-AI-/,
    '사람이 정한 처방은 매니저가 끌 수 없다');
  const h = validatePlan({ hypotheses: [{ id: 'bad', statement: 'xxxxx' }, { id: 'H-ok', statement: '긴 영상은 덜 퍼진다', confidence: 9 }] },
    { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW });
  assert.equal(h.plan.hypotheses.length, 1);
  assert.equal(h.plan.hypotheses[0].status, 'open');
  assert.equal(h.plan.hypotheses[0].confidence, 1);
});

test('적용: auto 는 켜고(기준선 포함) propose 는 설계서로, 가설 장부·일지에 남기고, 끌 것은 끈다', () => {
  const videos = [];
  const { plan } = validatePlan({
    summary: '긴 영상의 48h 가 낮다', bottleneck: { kpi: 'views_48h_index_7d', why: 'w' },
    hypotheses: [{ id: 'H-hook', kpi: 'views_48h_index_7d', statement: '숫자로 여는 훅이 이탈을 부른다', evidence: 'e', status: 'open', confidence: 0.4 }],
    remedies: [remedy(), remedy({ id: 'R-AI-shorter', label: '미국 요약 90초', mode: 'propose', target: 'script', directive: '미국 요약형을 90초로 줄인다' })],
    proposals: [{ title: '썸네일 재설계', body: 'b', kpi: 'views_48h_index_7d' }],
  }, { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW });
  const out = applyPlan(plan, { dynamic: {}, state: emptyState(), strategy: {}, videos, now: NOW, date: '2026-10-06' });
  assert.equal(out.state.active[0].remedy, 'R-AI-hook-why');
  assert.equal(out.dynamic['R-AI-hook-why'].created_by, 'growth-manager');
  assert.ok(out.dynamic['R-AI-shorter'], 'propose 처방도 정의는 남는다(사람이 켤 수 있게)');
  assert.deepEqual(out.proposals.map((p) => p.title), ['미국 요약 90초', '썸네일 재설계']);
  assert.equal(out.strategy.hypotheses['H-hook'].history.length, 1);
  assert.equal(out.strategy.journal.at(-1).bottleneck, 'views_48h_index_7d');
  // 같은 날 다시 판단(--force)하면 그날 기록을 갈아 끼운다 — 장부에 하루가 두 번 남지 않는다
  const again = applyPlan({ ...plan, remedies: [], proposals: [] }, { dynamic: out.dynamic, state: out.state, strategy: out.strategy, videos, now: NOW, date: '2026-10-06' });
  assert.equal(again.strategy.journal.filter((j) => j.date === '2026-10-06').length, 1);
  assert.equal(again.strategy.hypotheses['H-hook'].history.length, 1);

  const retire = validatePlan({ retire: [{ id: 'R-AI-hook-why', reason: '훅 처방이 이탈을 키웠다' }] },
    { catalog: { ...CATALOG, ...out.dynamic }, state: out.state, slots: SLOTS, now: NOW });
  const off = applyPlan(retire.plan, { dynamic: out.dynamic, state: out.state, strategy: out.strategy, videos, now: NOW, date: '2026-10-07' });
  assert.equal(off.state.active.length, 0);
  assert.equal(off.state.history.at(-1).verdict, 'retired');
  assert.match(journalMarkdown({ date: '2026-10-06', plan, rejected: [{ item: 'R-AI-x', reason: 'r' }], events: out.events, progress: [], engine: 'codex' }), /거른 것/);
  assert.match(telegramText({ date: '2026-10-06', plan, events: out.events, proposals: out.proposals, progress: [] }), /새 처방 켬: R-AI-hook-why/);
});

test('매니저 처방도 같은 엔진이 판정한다 — 48h 조회 지표·슬롯 범위', () => {
  const hour = 3600_000;
  const vid = (id, slot, hoursAfterStart, v48, remedies = ['R-AI-x']) => {
    const pub = new Date(NOW.getTime() + hoursAfterStart * hour);
    return { videoId: id, slot, privacy: 'public', publishedAt: pub.toISOString(), views: v48, likes: 1, remedies,
      stats_history: [{ at: new Date(pub.getTime() + 40 * hour).toISOString(), views: v48 }] };
  };
  const def = { label: 'x', mode: 'auto', target: 'script', directive: 'd', slots: ['us-close'],
    eval: { metric: 'views48', min_episodes: 4, max_episodes: 8, keep_if_lift: 1.2 } };
  const state = { ...emptyState(), active: [{ remedy: 'R-AI-x', status: 'active', started_at: NOW.toISOString(), baseline: { value: 500, episodes: 6 } }] };
  const later = new Date(NOW.getTime() + 20 * 86400_000);
  const videos = [1, 2, 3, 4].map((i) => vid(`u${i}`, 'us-close', i * 24, 700))
    .concat([1, 2, 3].map((i) => vid(`k${i}`, 'kr-close', i * 24, 50)))     // 범위 밖 슬롯은 판정에 안 들어간다
    .concat([5, 6].map((i) => vid(`s${i}`, 'us-close', i * 24, 30, [])));    // 처방을 안 받은 회차도 안 들어간다
  assert.equal(measure('views48', videos, { now: later, filter: (v) => v.slot === 'us-close' && v.remedies.includes('R-AI-x') }).value, 700);
  const r = planRemediation({ findings: [], state, catalog: { 'R-AI-x': def }, videos, now: later });
  assert.equal(r.state.active[0].status, 'adopted', '700 / 500 = 1.4× ≥ 1.2');
  assert.equal(r.state.active[0].result.episodes, 4);

  // 소비처: 슬롯 범위 밖이면 그 슬롯 대본·지시에 안 들어간다
  assert.equal(activeRemedies(state, { 'R-AI-x': def }, { slot: 'kr-close' }).length, 0);
  assert.equal(activeRemedies(state, { 'R-AI-x': def }, { slot: 'us-close' }).length, 1);
  assert.match(remedySection(activeRemedies(state, { 'R-AI-x': def }, { slot: 'us-close' })).join('\n'), /적용 대상: 대본/);
});

test('받은 처방 기록: 프롬프트에 들어간 지시·실제로 넣은 마무리 문장만, 생성기마다 자기 자리만', () => {
  const like = { remedy: 'R-LIKE-CTA', def: CATALOG['R-LIKE-CTA'] };
  const hook = { remedy: 'R-AI-hook', def: { target: 'script', directive: 'd' } };
  const title = { remedy: 'R-AI-title', def: { target: 'metadata', directive: 'd' } };
  const prompt = remedySection([hook, title]).join('\n');
  const scenes = [{ narration: '…' }, { narration: `오늘은 여기까지. ${CATALOG['R-LIKE-CTA'].closing_cta} 팔로우하세요.` }];
  assert.deepEqual(remediesApplied([like, hook, title], { targets: ['script', 'closing'], prompt, scenes }), ['R-LIKE-CTA', 'R-AI-hook']);
  assert.deepEqual(remediesApplied([like, hook, title], { targets: ['metadata'], prompt }), ['R-AI-title']);
  assert.deepEqual(remediesApplied([like, hook], { targets: ['script', 'closing'], prompt: '', scenes: [{ narration: '팔로우하세요.' }] }), [],
    '지시가 프롬프트에 없고 마무리 문장도 없으면 받은 것이 아니다');
  // 소비처가 실제로 기록을 남긴다
  assert.match(read('scripts/automation/generate-script.js'), /outFM\.growth_remedies = growthRemedies/);
  assert.match(read('scripts/automation/generate-summary-script.js'), /remediesApplied\(remedies, \{ targets: \['closing'\]/);
  assert.match(read('scripts/automation/generate-metadata.js'), /meta\.growth_remedies = titleRemedies/);
});

test('배선: 저녁 크론·codex 우선·처방 알림은 등급과 무관·제목 생성기도 처방을 읽는다', () => {
  assert.match(read('lib/install-cron.sh'), /growth-manager\)[\s\S]{0,600}scripts\/automation\/growth-manager\.js/);
  const cli = read('scripts/automation/growth-manager.js');
  assert.match(cli, /'codex,claude'/, '새벽 회차의 claude 한도를 아낀다');
  assert.match(cli, /validatePlan\(raw/, 'LLM 출력은 반드시 검증을 거친다');
  const pipe = read('lib/growth-pipeline.sh');
  assert.match(pipe, /KPI_SENT/, 'KPI 알림이 안 나가는 오후에도 처방 소식은 나간다');
  assert.match(read('scripts/automation/generate-metadata.js'), /'자동 처방' 중 적용 대상이 제목/);
  assert.match(read('scripts/automation/generate-script.js'), /readActiveRemedies\(ROOT, \{ slot: values\.slot \}\)/);
});
