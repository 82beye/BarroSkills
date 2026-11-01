// 성장 매니저 — LLM 이 가설·처방을 설계하고, 결정론이 거르고·켜고·판정한다.
// 2026-10-06 운영자: "KPI 성장 관리가 되지 않고 있다. 분석하고 계속 추적하면서 업데이트가 돼야 한다.
// 단순 자동화로는 안 될 것 같다." — 판단은 LLM 에 주되, 무엇을 얼마나 바꿀 수 있는지는 여기서 잠근다.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildPrompt, validatePlan, applyPlan, journalMarkdown, telegramText, LIMITS } from '../scripts/automation/lib/growth-manager.js';
import { recentIncidents, videoAnalyticsIndex, channelDesk } from '../scripts/automation/lib/growth-dossier.js';
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
  // 10-22 YOU-552: adopted 는 판정이 끝났다 — 한도 3칸을 영구히 차지하지 않는다
  const settled = { ...full, active: full.active.map((a, i) => (i ? a : { ...a, status: 'adopted' })) };
  assert.equal(validatePlan({ remedies: [remedy()] }, { catalog: cat3, state: settled, slots: SLOTS, now: NOW }).plan.remedies.length, 1);
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
      stats_history: [{ at: new Date(pub.getTime() + 48 * hour).toISOString(), views: v48 }] };
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

test('자료집: Analytics 영상별 리포트를 영상 id 로 묶어 시청 지속률·구독 전환을 붙인다', () => {
  // 2026-10-07: 일별 합계만으로는 48h 조회가 낮은 영상이 「끝까지 안 봤는지」 「봤는데 구독으로 안 갔는지」 가를 수 없었다.
  const report = {
    columnHeaders: ['video', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'likes', 'subscribersGained', 'shares']
      .map((name) => ({ name })),
    rows: [['vidA', 900, 120, 42, 71.234, 9, 3, 1], ['vidB', 200, 10, 15, 22.0, 1, 0, 0]],
  };
  const idx = videoAnalyticsIndex(report);
  assert.deepEqual(idx.get('vidA'), { avp: 71.2, avd: 42, subs: 3, shares: 1 });
  assert.equal(idx.get('vidB').avp, 22);
  assert.equal(videoAnalyticsIndex({}).size, 0, '리포트가 없으면 빈 값 — 스코프가 없을 때 자료집이 깨지지 않는다');
  const { system } = buildPrompt({ date: '2026-10-07', videos: [] });
  assert.match(system, /avp\(시청 지속률 %\)/, '매니저가 새 필드의 뜻과 읽는 법을 안다');
});

test('자료집: 장애 분석에 처리 기록을 붙인다 — 고친 장애를 매니저가 다시 설계서로 올리지 않게', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-incidents-'));
  try {
    writeFileSync(join(dir, 'incidents.jsonl'), [
      { id: 'IR-1', at: '2026-10-06T22:14:00Z', ep: 'EP-2026-0214', stage: 'Phase 6 재작성', class: 'code', root_cause: '원자료 미전달' },
      { id: 'IR-0', at: '2026-09-01T00:00:00Z', ep: 'EP-OLD', stage: 'Phase 4', class: 'code', root_cause: '오래됨' },
      { type: 'resolution', id: 'IR-1', at: '2026-10-06T22:30:00Z', status: 'fixed', note: 'run-factcheck summaryDataText' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rows = recentIncidents(dir, new Date('2026-10-07T10:00:00Z'));
    assert.deepEqual(rows.map((r) => r.id), ['IR-1'], '14일 밖과 처리 기록 줄은 목록에서 뺀다');
    assert.equal(rows[0].resolution, 'fixed: run-factcheck summaryDataText');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-21 CMO 일일 채널 전략 데스크 (YOU-539) — 같은 매니저 호출이 처방 전에 채널 방향을 먼저 본다.
// 산수·경보는 코드가 판정하고, desk 출력이 없거나 깨져도 그날 처방 판단은 잃지 않는다.
const DESK_NOW = new Date('2026-10-21T10:40:00Z');   // 19:40 KST
const deskVid = (id, pubIso, { v48 = null, views, title }) => {
  const pub = Date.parse(pubIso);
  const hist = [];
  if (v48 !== null) hist.push({ at: new Date(pub + 48 * 3600_000).toISOString(), views: v48 });
  hist.push({ at: new Date(DESK_NOW.getTime() - 3600_000).toISOString(), views });
  return { videoId: id, title, publishedAt: pubIso, privacy: 'public', duration_s: 60, stats_history: hist, views };
};
const deskFacts = (kpiIndex = { '2026-10-19': 0.4, '2026-10-20': 0.45, '2026-10-21': 0.3 }) => channelDesk({
  videos: [
    { videoId: 'old', title: '옛 편', publishedAt: '2026-10-01T00:00:00Z', privacy: 'public',
      stats_history: [{ at: '2026-10-14T09:40:00Z', views: 1000 }, { at: '2026-10-21T09:40:00Z', views: 1500 }], views: 1500 },
    deskVid('a', '2026-10-17T23:00:00Z', { v48: 5, views: 5, title: '유가가 왜 #Shorts' }),           // 10-18 08:00 KST
    deskVid('b', '2026-10-18T03:00:00Z', { v48: 8, views: 8, title: '환율이 왜 #Shorts' }),           // 10-18 12:00 KST
    deskVid('c', '2026-10-18T23:00:00Z', { v48: 700, views: 760, title: '삼성전자 실적 좋은데 내 계좌는? #Shorts' }),
    deskVid('d', '2026-10-19T23:00:00Z', { views: 40, title: 'SK하이닉스만 빠진 이유 #Shorts' }),
    deskVid('e', '2026-10-20T23:00:00Z', { views: 3, title: '반도체 8일 연속 하락 #Shorts' }),
  ],
  episodes: [{ videoId: 'c', ep: 'EP-C', title: '삼성전자 실적 좋은데 내 계좌는? #Shorts' }],
  history: [{ at: '2026-10-14T10:00:00Z', subs: 100 }, { at: '2026-10-21T10:00:00Z', subs: 104 }],
  kpiIndex,
  state: { active: [{ remedy: 'R-LIKE-CTA', status: 'adopted' }, { remedy: 'R-AI-x', status: 'active' }, { remedy: 'R-AI-y', status: 'reverted' }] },
  experiment: { id: 'EXP-03-hook-question' },
  config: { kpis: { weekly_net_subs: { green: 10 }, publish_consistency_7d: { planned_per_week: 17 } } },
  now: DESK_NOW, date: '2026-10-21',
});

test('데스크 자료: 북극성 산수·72h 해부·미배포형·동시 진행을 코드가 센다', () => {
  const d = deskFacts();
  // 7d 조회 = (1500 + 5+8+760+40+3) − 1000 = 1316 · 순증 +4 → 전환 3.04/1k → +10 에는 3,290뷰 = 17편 기준 발행당 194
  assert.deepEqual(d.northstar, { views_7d: 1316, published_7d: 5, net_subs_7d: 4, subs_per_1k: 3.04, views_per_publish: 263,
    target_net_subs: 10, planned_per_week: 17, need_views_7d: 3290, need_views_per_publish: 194, gap_x: 0.74 });
  assert.deepEqual(d.recent72h.map((r) => [r.ep, r.views, r.basis]), [['EP-C', 700, '48h'], ['d', 40, '현재 36h'], ['e', 3, '현재 12h']],
    '48h 가 있으면 48h, 없으면 현재 조회와 그 나이');
  assert.equal(d.recent72h[0].title, '삼성전자 실적 좋은데 내 계좌는?');
  assert.deepEqual(d.zeroReach, { window_days: 7, max_views: 35, observed: 3, count: 2, eps: ['a', 'b'] });
  assert.deepEqual(d.concurrent, { remedies: ['R-LIKE-CTA', 'R-AI-x'], experiment: 'EXP-03-hook-question', total: 3 });
});

test('데스크 72h 해부는 공개분만 — 비공개·일부공개·사라짐·처리 중 업로드는 행·주제 반복에서 빠진다', () => {
  const at = '2026-10-20T03:00:00Z';
  const v = (id, privacy, upload_status) => ({ videoId: id, title: `반도체 ${id} #Shorts`, publishedAt: at, privacy, upload_status, views: 0, stats_history: [] });
  const d = channelDesk({
    videos: [v('pub', 'public', 'processed'), v('legacy', null, null), v('priv', 'private', 'processed'),
      v('unl', 'unlisted', 'processed'), v('gone', 'unavailable', 'processed'), v('proc', 'public', 'processing')],
    now: DESK_NOW, date: '2026-10-21',
  });
  assert.deepEqual(d.recent72h.map((r) => r.ep), ['pub', 'legacy'], '구 인덱스(상태 null)는 공개로 본다');
  assert.equal(d.northstar.published_7d, 2);
  assert.deepEqual(d.topicRepeats, [{ topic: '반도체', count: 2, eps: ['pub', 'legacy'] }]);
  assert.deepEqual(d.alerts.map((a) => a.id), [], '미공개분 4편이 반도체 반복 경보를 만들지 않는다');
});

test('데스크 경보 3종: 48h 지수 3일 연속 <0.5 · 하루 0~10뷰 2편 · 72h 같은 주제 3회', () => {
  const ids = (d) => d.alerts.map((a) => a.id);
  const d = deskFacts();
  assert.deepEqual(ids(d), ['index_low', 'dead_day', 'topic_repeat']);
  assert.match(d.alerts[0].text, /3일 연속 <0\.5 \(0\.40·0\.45·0\.30\)/);
  assert.match(d.alerts[1].text, /^10-18 공개 2편 중 2편이 48h 0~10뷰 \(a, b\)/);
  assert.match(d.alerts[2].text, /「반도체」 3회 \(EP-C, d, e\)/);
  assert.deepEqual(ids(deskFacts({ '2026-10-19': 0.4, '2026-10-21': 0.3 })), ['dead_day', 'topic_repeat'], '하루라도 비면 연속이 아니다');
  assert.deepEqual(ids(deskFacts({ '2026-10-19': 0.4, '2026-10-20': 0.5, '2026-10-21': 0.3 })), ['dead_day', 'topic_repeat'], '0.5 는 경보 아님');
});

test('데스크 출력: 지시문이 0) 채널 방향 점검을 시키고, 일지 맨 위 「## 채널 데스크」·경보는 텔레그램 한 줄', () => {
  const { system } = buildPrompt({ date: '2026-10-21' });
  assert.match(system, /0\) 채널 방향 점검/);
  assert.match(system, /"desk": \{ "thesis"/);
  assert.match(system, /없는 경보를 만들지 마라/);
  const facts = deskFacts();
  const raw = { summary: 's', remedies: [remedy()],
    desk: { thesis: '반도체 재탕이 도달을 깎는다', evidence: ['미배포 2/3편', '반도체 3회'], winners_vs_zero: '상위는 반전+숫자', confounds: '처방 3개 동시',
      next_week_candidates: ['점심 옴니버스 1주 휴식', { title: '미국 요약 제목 앞머리를 반전 한 줄로', why: '템플릿 제목 하락' }, { why: '제목 없음' }, 'x4', 'x5'] } };
  const { plan, rejected, warnings } = validatePlan(raw, { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW });
  assert.deepEqual([rejected, warnings], [[], []]);
  assert.equal(plan.desk.evidence, '미배포 2/3편 / 반도체 3회');
  assert.deepEqual(plan.desk.next_week_candidates.map((c) => c.title), ['점심 옴니버스 1주 휴식', '미국 요약 제목 앞머리를 반전 한 줄로', 'x4'], '제목 없는 후보는 빼고 3개까지');
  const md = journalMarkdown({ date: '2026-10-21', plan, rejected, events: [], progress: [], engine: 'codex', desk: facts });
  assert.ok(md.indexOf('## 채널 데스크\n') > 0 && md.indexOf('## 채널 데스크\n') < md.indexOf('## 결정'), '처방 결정보다 위');
  assert.match(md, /^- 산수: 7d 조회 1,316 \(5편\) × 전환 3\.04\/1k = 순증 4 · \+10 에는 주 3,290뷰 = 발행당 194 \(지금 263, 0\.74×\)$/m);
  assert.match(md, /^- 테제: \*\*반도체 재탕이 도달을 깎는다\*\*$/m);
  assert.match(md, /^- 교란: 처방 3개 동시 · 동시 진행 3개 \(R-LIKE-CTA, R-AI-x, EXP-03-hook-question\)$/m);
  assert.match(md, /^  - 미국 요약 제목 앞머리를 반전 한 줄로 — 템플릿 제목 하락$/m);
  assert.match(md, /^- 경보: ⚠ 48h 조회 지수/m);
  assert.match(md, /^\| 10-19 08:00 \| — \| 700 \| 48h \|/m, '72h 해부 표');
  const out = applyPlan(plan, { dynamic: {}, state: emptyState(), strategy: {}, videos: [], now: NOW, date: '2026-10-21' });
  assert.equal(out.strategy.journal.at(-1).thesis, '반도체 재탕이 도달을 깎는다', '다음 날 테제를 이어서 점검한다');
  assert.match(telegramText({ date: '2026-10-21', plan, events: [], proposals: [], progress: [], desk: facts }), /\n🚨 데스크 경보: 48h 조회 지수 .* · 10-18 공개/);
  const quiet = telegramText({ date: '2026-10-21', plan, events: [], proposals: [], progress: [], desk: { ...facts, alerts: [] } });
  assert.doesNotMatch(quiet, /경보/, '경보가 없으면 줄을 더하지 않는다');
});

test('데스크 누락·형식 오류: 경고만 남기고 처방 처리는 그대로 — 일지는 「산수만」 제목', () => {
  for (const desk of [undefined, '테제 문자열', { thesis: '' }, [1]]) {
    const { plan, rejected, warnings } = validatePlan({ summary: 's', remedies: [remedy()], desk }, { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW });
    assert.equal(plan.remedies.length, 1, '처방은 그대로 통과');
    assert.deepEqual(rejected, []);
    assert.equal(plan.desk, null);
    assert.equal(warnings.length, 1);
    const md = journalMarkdown({ date: '2026-10-21', plan, rejected, events: [], progress: [], engine: 'codex', desk: deskFacts(), warnings });
    assert.doesNotMatch(md, /^## 채널 데스크$/m, '성공 지표는 매니저 데스크가 있는 날만 센다');
    assert.match(md, /^## 채널 데스크 — 산수만 \(데스크 (출력|테제) 없음/m);
    assert.match(md, /^- 산수: /m);
    const out = applyPlan(plan, { dynamic: {}, state: emptyState(), strategy: {}, videos: [], now: NOW, date: '2026-10-21' });
    assert.equal(out.state.active[0].remedy, 'R-AI-hook-why');
    assert.equal('thesis' in out.strategy.journal.at(-1), false);
  }
  // 자료집 desk 도 없으면(계산 실패) 절 자체를 쓰지 않는다 — 기존 일지 그대로
  const { plan } = validatePlan({ summary: 's' }, { catalog: CATALOG, state: emptyState(), slots: SLOTS, now: NOW });
  assert.doesNotMatch(journalMarkdown({ date: '2026-10-21', plan, rejected: [], events: [], progress: [] }), /채널 데스크/);
  assert.doesNotMatch(telegramText({ date: '2026-10-21', plan, events: [], proposals: [], progress: [] }), /경보/);
});
