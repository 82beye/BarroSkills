// 페이퍼클립 관제 계약 — 2026-10-07 launchd 크론을 페이퍼클립 루틴으로 옮기면서 생긴 경계.
// 어느 한 조각이 조용히 어긋나면 회차가 두 번 돌거나(중복 발행), 아예 안 돌거나, 토큰을 태운다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  adapterFor, claimMarker, classifyOutcome, findEp, incidentSignature, kstParts, markerKeyFor, markerPath, parseIssueAction, readMarker,
  resolveAction, runIssueSettled, runIssueSuperseded,
} from '../scripts/automation/paperclip/lib.js';
import { estimateCostUsd, levelFor, parseWindows, routineHeld, routingFor, variantFor, weekPaceAhead } from '../scripts/automation/paperclip/token-governor.js';
import { blockedPatch } from '../scripts/automation/paperclip/dispatch.js';
import { codexUsageFromJsonl, parseClaudeEnvelope } from '../scripts/automation/lib/llm-ledger.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const company = JSON.parse(read('config/paperclip/company.json'));
const actions = JSON.parse(read('config/paperclip/actions.json')).actions;
const policy = JSON.parse(read('config/paperclip/token-policy.json'));

// ── 이관 대응표: 2026-10-07 까지 launchd plist 가 돌리던 것 ─────────────────────
// 시각·요일이 하나라도 다르면 편성이 바뀐 것이다 — 바꾸려면 이 표와 company.json 을 같이 고친다.
const LAUNCHD_2026_10_07 = {
  'us-close': { action: 'slot:us-close', crons: ['0 6 * * *'], cmd: 'bash lib/auto-pipeline.sh --slot us-close', log: 'us-close' },
  omnibus: { action: 'slot:omnibus', crons: ['0 10 * * 1-4'], cmd: 'bash lib/auto-pipeline.sh --slot omnibus', log: 'omnibus' },
  realestate: { action: 'slot:realestate', crons: ['0 10 * * 5'], cmd: 'bash lib/auto-pipeline.sh --slot realestate', log: 'realestate' },
  'kr-close': { action: 'slot:kr-close', crons: ['0 16 * * 1-5'], cmd: 'bash lib/auto-pipeline.sh --slot kr-close', log: 'kr-close' },
  'publish-resume': { action: 'job:publish-resume', crons: ['30 7 * * *', '30 17 * * *'], cmd: 'bash lib/publish-resume.sh', log: 'publish-resume' },
  'market-map': { action: 'job:market-map', crons: ['0 8 * * *', '0 18 * * *'], cmd: 'bash lib/market-map-cron.sh', log: 'market-map' },
  'market-map-krclose': { action: 'job:market-map-krclose', crons: ['45 15 * * 1-5'], cmd: 'bash lib/market-map-krclose.sh', log: 'market-map-krclose' },
  'competitor-scan': { action: 'job:competitor-scan', crons: ['20 5 * * *', '20 15 * * *'], cmd: 'bash lib/competitor-pipeline.sh', log: 'competitor-scan' },
  'oauth-renew': { action: 'job:oauth-renew', crons: ['40 6 * * *'], cmd: 'node scripts/automation/renew-youtube-oauth.js', log: 'oauth-renew' },
  doctor: { action: 'job:doctor', crons: ['10 7 * * *'], cmd: 'bash lib/doctor-cli.sh', log: 'doctor-daily' },
  growth: { action: 'job:growth', crons: ['40 5 * * *', '40 15 * * *'], cmd: 'bash lib/growth-pipeline.sh', log: 'growth' },
  'weekly-marketing': { action: 'job:weekly-marketing', crons: ['0 9 * * 1'], cmd: 'bash lib/run-node.sh scripts/automation/marketing-fetch-local.js --source rss', log: 'weekly-marketing' },
  'growth-manager': { action: 'job:growth-manager', crons: ['40 19 * * *'], cmd: 'bash lib/run-node.sh scripts/automation/growth-manager.js', log: 'growth-manager' },
};

test('이관 — launchd 크론 13개가 같은 시각·명령·로그로 페이퍼클립 루틴에 있다', () => {
  for (const [key, want] of Object.entries(LAUNCHD_2026_10_07)) {
    const r = company.routines.find((x) => x.key === key);
    assert.ok(r, `루틴 누락: ${key}`);
    assert.equal(r.action, want.action, key);
    assert.deepEqual([...r.crons].sort(), [...want.crons].sort(), `${key} 시각`);
    const spec = actions[want.action];
    assert.ok(spec, `허용 목록 누락: ${want.action}`);
    assert.equal(spec.cmd.join(' '), want.cmd, `${key} 명령`);
    assert.equal(spec.log, want.log, `${key} 로그 이름 — incident-analyze·doctor 가 logs/cron/<이름> 을 본다`);
  }
});

test('이관 — 생산 슬롯은 Producer(process), 시각이 생명인 잡은 동시 실행 가능한 Ops Runner', () => {
  for (const key of ['us-close', 'omnibus', 'realestate', 'kr-close', 'publish-resume']) {
    assert.equal(company.routines.find((r) => r.key === key).agent, 'producer', key);
  }
  assert.equal(company.routines.find((r) => r.key === 'market-map-krclose').agent, 'ops');
  assert.ok(company.agents.ops.max_concurrent >= 2, '15:45 스냅샷이 15:20·15:40 잡 뒤에 줄 서면 시간외 단일가가 섞인다');
  assert.equal(company.agents.producer.max_concurrent, 1, '생산은 한 번에 한 회차');
  for (const r of company.routines) {
    assert.ok(company.agents[r.agent], `${r.key} 담당 에이전트 없음`);
    if (r.action) assert.ok(actions[r.action], `${r.key} 액션이 허용 목록에 없다`);
    else assert.equal(company.agents[r.agent].kind, 'llm', `${r.key} — 액션 없는 루틴은 LLM 에이전트 몫`);
  }
});

test('정해진 스케줄만 — LLM 에이전트는 타이머로 깨지 않고, 타이머는 토큰 0 인 거버너뿐', () => {
  for (const [key, a] of Object.entries(company.agents)) {
    if (a.timer_sec) assert.equal(a.kind, 'process', `${key} — 타이머로 깨는 건 process 에이전트만`);
    if (a.kind === 'llm') {
      assert.ok(!a.timer_sec, `${key} 타이머 금지`);
      assert.ok(a.daily_cost_cap_usd > 0, `${key} 하루 비용 상한`);
      assert.ok(a.max_turns > 0 && a.timeout_sec > 0, `${key} 턴·시간 상한`);
    }
  }
  assert.equal(company.agents.governor.wake_on_demand, false, '거버너는 이슈로 깨지 않는다');
});

test('역할별 공급자 — Claude 와 Codex 를 모두 쓰고, 리뷰어는 수리 담당과 다른 공급자다', () => {
  const llm = Object.values(company.agents).filter((a) => a.kind === 'llm');
  const homes = new Set(llm.map((a) => a.primary.adapterType));
  assert.ok(homes.has('claude_local') && homes.has('codex_local'));
  assert.notEqual(company.agents.sre.primary.adapterType, company.agents.reviewer.primary.adapterType);
  assert.equal(company.agents.cmo.primary.model, 'gpt-6.1-sol');
  assert.equal(company.agents.cmo.economy.model, 'gpt-6-luna');
  assert.equal(company.agents.sre.alternate.model, 'gpt-6.1-sol');
  assert.equal(company.agents.reviewer.primary.model, 'gpt-6.1-sol');
  assert.equal(company.agents.reviewer.economy.modelReasoningEffort, 'medium');
  for (const a of llm) {
    assert.notEqual(a.primary.adapterType, a.alternate.adapterType, `${a.name} 대체는 다른 공급자`);
    assert.equal(a.primary.adapterType, a.economy.adapterType, `${a.name} 절약은 같은 공급자의 가벼운 모델`);
  }
});

test('허용 목록 — 액션·인자 검증, 임의 명령 거부', () => {
  const slots = ['us-close', 'omnibus', 'realestate', 'kr-close'];
  const r = resolveAction('resume', { slot: 'kr-close', ep: 'EP-2026-0215' }, { actions, slots });
  assert.deepEqual(r.cmd, ['bash', 'lib/auto-pipeline.sh', '--slot', 'kr-close']);
  assert.deepEqual(r.env, { RESUME_EP: 'EP-2026-0215' });
  assert.equal(r.log, 'kr-close-resume-0215', '기존 수동 재개 로그 이름 관례와 같다');
  assert.throws(() => resolveAction('resume', { slot: 'kr-close; rm -rf /', ep: 'EP-2026-0215' }, { actions, slots }), /알 수 없는 슬롯/);
  assert.throws(() => resolveAction('resume', { slot: 'kr-close', ep: '$(id)' }, { actions, slots }), /EP 형식/);
  assert.throws(() => resolveAction('bash -c id', {}, { actions, slots }), /허용 목록/);
  for (const [k, a] of Object.entries(actions)) {
    assert.ok(['bash', 'node'].includes(a.cmd[0]) || (k.startsWith('test:') && a.cmd[0] === 'osascript'), `${k} 실행기`);
    assert.ok(['daily', 'twice-daily', 'attempt', 'none'].includes(a.idempotency), k);
    if (k.startsWith('test:')) assert.equal(a.idempotency, 'none');
  }
});

test('이슈 본문 → 액션 (루틴 설명 첫 줄)', () => {
  assert.deepEqual(parseIssueAction('action: slot:us-close\n\n설명'), { action: 'slot:us-close', params: {} });
  assert.deepEqual(parseIssueAction('action: resume\nslot: us-close\nep: `EP-2026-0215`\n'), { action: 'resume', params: { slot: 'us-close', ep: 'EP-2026-0215' } });
  assert.equal(parseIssueAction('그냥 설명'), null);
  assert.equal(parseIssueAction('action: resume\naction: slot:kr-close').action, 'resume', '첫 줄이 이긴다');
});

test('회차 키 — 하루 한 번 · 오전/오후 · 재시도 번호', () => {
  const at = (h) => new Date(Date.parse(`2026-10-08T${String(h).padStart(2, '0')}:10:00+09:00`));
  const slot = resolveAction('slot:us-close', {}, { actions, slots: ['us-close'] });
  assert.equal(markerKeyFor(slot, { now: at(6) }), 'slot_us-close');
  assert.equal(markerKeyFor(slot, { now: at(6), rerun: true, attempt: 2 }), 'slot_us-close#2');
  const mm = resolveAction('job:market-map', {}, { actions, slots: [] });
  assert.equal(markerKeyFor(mm, { now: at(8) }), 'job_market-map@am');
  assert.equal(markerKeyFor(mm, { now: at(18) }), 'job_market-map@pm');
  const res = resolveAction('resume', { slot: 'us-close', ep: 'EP-2026-0215' }, { actions, slots: ['us-close'] });
  assert.equal(markerKeyFor(res, { attempt: 1 }), 'resume-EP-2026-0215#1');
  assert.equal(kstParts(new Date('2026-10-07T15:30:00Z')).date, '2026-10-08', 'KST 자정 넘김');
});

test('마커 선점은 한쪽만 이긴다 (페이퍼클립 catch-up 과 데드맨이 동시에 깨도)', () => {
  const date = '1999-01-01';
  try {
    assert.ok(claimMarker(date, 'race', { via: 'paperclip' }));
    assert.equal(claimMarker(date, 'race', { via: 'deadman' }), null);
    assert.equal(readMarker(date, 'race').via, 'paperclip');
  } finally {
    rmSync(dirname(markerPath(date, 'race')), { recursive: true, force: true });
  }
});

test('결과 분류 — halt 는 exit 0 이어도 멈춤이다', () => {
  assert.equal(classifyOutcome({ exitCode: 0 }), 'done');
  assert.equal(classifyOutcome({ exitCode: 0, newIncidents: [{ kind: 'halt' }] }), 'halted');
  assert.equal(classifyOutcome({ exitCode: 1 }), 'failed');
  assert.equal(classifyOutcome({ exitCode: null }), 'lost');
  assert.equal(findEp('EP-2026-0214 … 재개 EP-2026-0215 완료'), 'EP-2026-0215');
});

test('실패 이슈는 막고 있는 것을 명시하고 배정을 푼다 (배정 복구 재실행 방지)', () => {
  const withSre = blockedPatch([{ issueId: 'a' }]);
  assert.deepEqual(withSre, { status: 'blocked', blockedByIssueIds: ['a'], assigneeAgentId: null });
  const alone = blockedPatch([]);
  assert.equal(alone.unblockDescriptor.owner, 'board');
  assert.equal(alone.assigneeAgentId, null);
});

// 2026-10-19: EP-2026-0219 업로드 락 하나로 doctor 가 열하루 연속 실패했고, 날마다 새 SRE 이슈가 열려 같은 진단을 반복했다.
test('같은 원인 재발 — doctor 는 RED 묶음이 지문이다 (다른 줄의 숫자는 무시, RED 가 늘면 새 장애)', () => {
  const doctor = (extra = '') => [
    '  "growth_kpi": {"status": "GREEN", "detail": "observation age=1.5h; performance=RED"}',
    '  "in_flight_lock": {"status": "YELLOW", "detail": "STALE EP-2026-0241 (PID=84993 dead)"}',
    extra,
    '  "publish_reconciliation": {"status": "RED", "detail": "EP-2026-0219"}',
    '  "audit_today": {"status": "INFO", "detail": "36 entries"}',
  ].join('\n');
  const day1 = incidentSignature({ id: 'PX-20261018-job_doctor', ep: 'EP-2026-0219' }, { action: 'job:doctor', text: doctor() });
  const day2 = incidentSignature({ id: 'PX-20261019-job_doctor', ep: 'EP-2026-0241' }, { action: 'job:doctor', text: doctor().replace('1.5h', '9.9h').replace('36', '12') });
  assert.equal(day1, 'job:doctor|publish_reconciliation=EP-2026-0219');
  assert.equal(day2, day1, 'RED 가 같으면 EP 추정·다른 검사 수치가 달라도 같은 장애');
  const more = incidentSignature({ id: 'PX-20261020-job_doctor' }, { action: 'job:doctor', text: doctor('  "youtube_oauth": {"status": "RED", "detail": "refresh token 만료"}') });
  assert.notEqual(more, day1, '새 RED 가 붙으면 새 장애다');
  const ageA = incidentSignature({ id: 'PX-1' }, { action: 'job:doctor', text: '"growth_kpi": {"status": "RED", "detail": "observation age=25.3h"}' });
  const ageB = incidentSignature({ id: 'PX-2' }, { action: 'job:doctor', text: '"growth_kpi": {"status": "RED", "detail": "observation age=31.0h"}' });
  assert.equal(ageA, ageB, 'RED 내용의 숫자만 바뀐 건 같은 장애');
  assert.notEqual(
    incidentSignature({ id: 'PX-3' }, { action: 'job:doctor', text: '"publish_reconciliation": {"status": "RED", "detail": "EP-2026-0219"}' }),
    incidentSignature({ id: 'PX-4' }, { action: 'job:doctor', text: '"publish_reconciliation": {"status": "RED", "detail": "EP-2026-0250"}' }),
    'EP 번호는 원인의 일부다',
  );
});

test('같은 원인 재발 — 그 밖의 잡은 액션·EP·마지막 로그 줄, 장애 분석기 기록(IR-)은 매번 새 장애', () => {
  const oauth = (sec) => ({ id: 'PX-20261012-job_oauth-renew', root_cause: `종료코드 1 — 장애 분석기 기록 없음. 로그 꼬리:\n준비\nError: OAuth 동의 콜백 ${sec}초 시간 초과` });
  assert.equal(incidentSignature(oauth(180), { action: 'job:oauth-renew' }), incidentSignature(oauth(240), { action: 'job:oauth-renew' }));
  assert.notEqual(
    incidentSignature(oauth(180), { action: 'job:oauth-renew' }),
    incidentSignature({ ...oauth(180), root_cause: 'invalid_grant' }, { action: 'job:oauth-renew' }),
  );
  assert.equal(incidentSignature({ id: 'IR-20261013-1602', ep: 'EP-2026-0230' }, { action: 'slot:kr-close' }), null);
});

test('막던 장애가 닫힌 실패 회차 이슈는 정리 대상 — 담당이 있거나 사람이 만든 이슈는 손대지 않는다', () => {
  const run = { status: 'blocked', assigneeAgentId: null, originKind: 'routine_execution', blockedBy: [{ status: 'done' }, { status: 'cancelled' }] };
  assert.equal(runIssueSettled(run), true);
  assert.equal(runIssueSettled({ ...run, blockedBy: [{ status: 'done' }, { status: 'blocked' }] }), false, '하나라도 열려 있으면 그대로');
  assert.equal(runIssueSettled({ ...run, blockedBy: [] }), false, '운영자 확인 대기(unblockDescriptor)는 사람 몫');
  assert.equal(runIssueSettled({ ...run, assigneeAgentId: 'sre' }), false, '담당이 있으면 페이퍼클립이 깨운다');
  assert.equal(runIssueSettled({ ...run, originKind: 'manual' }), false);
  assert.equal(runIssueSettled({ ...run, status: 'todo' }), false);
});

// ── 토큰 거버너 ──────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-07T12:00:00Z');
const quota = (claudeS, claudeW, codexW) => [
  { provider: 'anthropic', ok: true, windows: [
    { label: 'Current session', usedPercent: claudeS, resetsAt: '2026-10-07T15:00:00Z' },
    { label: 'Current week (all models)', usedPercent: claudeW, resetsAt: '2026-10-13T15:00:00Z' },
    { label: 'Extra usage', usedPercent: null },
  ] },
  { provider: 'openai', ok: true, windows: [{ label: '5h limit', usedPercent: codexW, resetsAt: '2026-10-14T03:51:39Z' }, { label: 'Credits', usedPercent: null }] },
];

test('한도 창 — 이름보다 리셋까지 남은 시간으로 세션/주간을 가른다 (Codex "5h limit" 은 주간이었다)', () => {
  const m = parseWindows(quota(49, 28, 11), policy, NOW);
  assert.deepEqual([m.claude.session, m.claude.week], [49, 28]);
  assert.equal(m.codex.session, null);
  assert.equal(m.codex.week, 11);
});

test('공급자 상태 — 임계·주간 속도·회복 지연', () => {
  const th = policy.thresholds;
  const lv = (s, w, prev) => levelFor({ ok: true, session: s, week: w, weekResetAt: '2026-10-13T15:00:00Z' }, th, prev, NOW);
  assert.equal(lv(10, 20), 'green');
  assert.equal(lv(72, 20), 'yellow');
  assert.equal(lv(91, 20), 'red');
  assert.equal(lv(10, 93), 'red');
  // 주간 창 경과 ≈ 14% 인데 60% 를 썼다 → 속도 초과
  assert.ok(weekPaceAhead({ week: 60, weekResetAt: '2026-10-13T15:00:00Z' }, th, NOW));
  assert.equal(lv(10, 60), 'yellow');
  // 회복은 hysteresis 만큼 더 내려가야
  assert.equal(lv(87, 20, 'red'), 'red');
  assert.equal(lv(80, 20, 'red'), 'yellow');
  assert.equal(lv(67, 20, 'yellow'), 'yellow');
  assert.equal(lv(60, 20, 'yellow'), 'green');
  assert.equal(levelFor({ ok: false, session: null, week: null }, th, 'yellow', NOW), 'yellow', '못 읽으면 직전 상태 유지');
});

test('엔진 순서 — RED 공급자를 뒤로, 둘 다 GREEN/RED 면 기본값', () => {
  assert.deepEqual(routingFor({ claude: 'green', codex: 'green' }, policy), {});
  assert.deepEqual(routingFor({ claude: 'red', codex: 'red' }, policy), {});
  const r = routingFor({ claude: 'red', codex: 'green' }, policy);
  assert.equal(r.BT_SCRIPT_ENGINE_CHAIN, 'codex,gemini,claude');
  assert.equal(r.BT_FACTCHECK_ENGINE_CHAIN, 'gemini,codex,claude');
  assert.equal(r.BT_GROWTH_MANAGER_CHAIN, undefined, '이미 codex 우선인 체인은 그대로');
  const c = routingFor({ claude: 'green', codex: 'yellow' }, policy);
  assert.equal(c.BT_GROWTH_MANAGER_CHAIN, 'claude,codex');
});

test('에이전트 변형 — 기본 → 절약 → 다른 공급자 → 정지', () => {
  const sre = company.agents.sre;
  assert.equal(variantFor(sre, { claude: 'green', codex: 'green' }), 'primary');
  assert.equal(variantFor(sre, { claude: 'yellow', codex: 'green' }), 'economy');
  assert.equal(variantFor(sre, { claude: 'red', codex: 'yellow' }), 'alternate');
  assert.equal(variantFor(sre, { claude: 'red', codex: 'red' }), 'paused');
  assert.equal(variantFor(sre, { claude: 'green', codex: 'green' }, true), 'paused', '하루 상한');
  assert.equal(variantFor(company.agents.cmo, { claude: 'green', codex: 'red' }), 'alternate');
});

test('루틴 보류 — 생산·수집은 절대 보류하지 않는다', () => {
  const allRed = { claude: 'red', codex: 'red' };
  for (const r of company.routines.filter((x) => x.tier === 0)) assert.equal(routineHeld(r, allRed, company.agents[r.agent]), false, r.key);
  const gm = company.routines.find((r) => r.key === 'growth-manager');
  assert.equal(routineHeld(gm, { claude: 'red', codex: 'green' }, company.agents.ops), false);
  assert.equal(routineHeld(gm, allRed, company.agents.ops), true);
  const ceo = company.routines.find((r) => r.key === 'ceo-weekly');
  const cmo = company.routines.find((r) => r.key === 'cmo-weekly');
  assert.equal(routineHeld(ceo, { claude: 'yellow', codex: 'green' }, company.agents.ceo), true);
  assert.equal(routineHeld(ceo, { claude: 'green', codex: 'green' }, company.agents.ceo), false);
  assert.equal(routineHeld(cmo, { claude: 'red', codex: 'green' }, company.agents.cmo), false, 'Codex 담당 루틴은 Claude 한도와 독립');
  assert.equal(routineHeld(ceo, { claude: 'red', codex: 'green' }, company.agents.ceo), true);
  for (const key of ['us-close', 'omnibus', 'realestate', 'kr-close', 'market-map', 'growth', 'doctor', 'oauth-renew']) {
    assert.equal(company.routines.find((r) => r.key === key).tier, 0, key);
  }
});

test('어댑터 설정 — Claude 는 턴·노력·비대화형, Codex 샌드박스 우회는 SRE 만', () => {
  const c = adapterFor(company.agents.ceo, 'primary', { instructionsFilePath: '/x/AGENTS.md' }, company.env);
  assert.equal(c.adapterType, 'claude_local');
  assert.equal(c.adapterConfig.model, 'claude-opus-5-5');
  assert.equal(c.adapterConfig.instructionsFilePath, '/x/AGENTS.md', '지침 번들 경로를 이어받는다');
  assert.equal(c.adapterConfig.maxTurnsPerRun, 60);
  assert.equal(adapterFor(company.agents.reviewer, 'primary', {}, {}).adapterConfig.dangerouslyBypassApprovalsAndSandbox, false);
  assert.equal(adapterFor(company.agents.sre, 'alternate', {}, {}).adapterConfig.dangerouslyBypassApprovalsAndSandbox, true);
  assert.equal(adapterFor(company.agents.producer, null, {}, {}).adapterType, 'process');
});

// 2026-10-19: CMO·리뷰어가 댓글·상태를 못 남기고(PAPERCLIP_API_* 가 셸에서 지워짐) 산출물이 프로젝트 폴더(_default)에 갇혔다.
test('Codex 에이전트 — 실행 환경을 셸에 넘기고, 샌드박스여도 자기 폴더에는 어디서 깨든 쓴다', () => {
  for (const [key, variant] of [['cmo', 'primary'], ['reviewer', 'primary'], ['ceo', 'alternate'], ['sre', 'alternate']]) {
    const { adapterType, adapterConfig: c } = adapterFor(company.agents[key], variant, {}, {});
    assert.equal(adapterType, 'codex_local', key);
    assert.ok(c.extraArgs.includes('shell_environment_policy.inherit="all"'), `${key}: 운영자 ~/.codex 의 inherit="core" 를 덮는다`);
    assert.equal(c.extraArgs.filter((a) => a === '--skip-git-repo-check').length, 1, `${key}: 한 번만 (codex 는 중복이면 exit 2)`);
    const roots = c.extraArgs.find((a) => a.startsWith('sandbox_workspace_write.writable_roots='));
    if (company.agents[key].codex_bypass) assert.equal(roots, undefined, `${key}: 샌드박스 우회면 쓰기 범위가 필요 없다`);
    else assert.equal(roots, `sandbox_workspace_write.writable_roots=${JSON.stringify([company.agents[key].cwd])}`, key);
  }
});

test('프로젝트 작업 폴더는 두지 않는다 — 지정하면 git 체크아웃이 아닌 폴더에서 LLM 실행이 거부된다', () => {
  for (const [key, p] of Object.entries(company.projects)) assert.equal(p.cwd, undefined, `${key}: growth·ops/repairs 는 git 밖 (missing_git_metadata)`);
  assert.doesNotMatch(company.description, /13개|13명/, '4~5월 체제 소개가 조직도 머리에 남지 않게');
});

test('지침 — 위임은 네 경로뿐(막힘 점검 포함), 옛 체제 서술 없음, 모든 LLM 에이전트에 지침 파일', () => {
  const common = read('scripts/automation/paperclip/instructions/_common.md');
  assert.match(common, /위임은 네 경로뿐/);
  assert.match(common, /CEO → SRE·Code Reviewer·CMO : 막힘 점검/);
  assert.match(common, /blockedByIssueIds/);
  for (const a of Object.values(company.agents)) {
    const p = `scripts/automation/paperclip/instructions/${a.instructions}`;
    assert.ok(existsSync(join(ROOT, p)), p);
    assert.doesNotMatch(read(p), /13명|heartbeat 마다|매 5분/);
    if (a.kind === 'llm') assert.doesNotMatch(read(p), /(^|[`\s(])workspace\/(growth|ops|intel)\//m, `${p}: 작업 경로는 $BT/ 절대 경로로`);
  }
  assert.match(read('scripts/automation/paperclip/instructions/sre.md'), /owner` 는 반드시 `"board"`/, '사람 몫을 SRE 자기 몫으로 걸지 않는다');
});

test('LLM 장부 — Claude 봉투·Codex JSONL 사용량', () => {
  const env = parseClaudeEnvelope(JSON.stringify({ type: 'result', result: '{"ok":true}', is_error: false, total_cost_usd: 0.17,
    usage: { input_tokens: 3, cache_creation_input_tokens: 40000, cache_read_input_tokens: 10000, output_tokens: 9 }, modelUsage: { 'claude-sonnet-5-5': {} } }));
  assert.deepEqual([env.text, env.input, env.cached, env.output, env.costUsd, env.model], ['{"ok":true}', 40003, 10000, 9, 0.17, 'claude-sonnet-5-5']);
  assert.equal(parseClaudeEnvelope('평문 응답').text, '평문 응답', '봉투가 아니면 원문');
  const cx = codexUsageFromJsonl('{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":20000,"cached_input_tokens":12000,"output_tokens":5,"reasoning_output_tokens":7}}\n');
  assert.deepEqual(cx, { input: 8000, cached: 12000, output: 12 });
});

test('guards.sh — 거버너 엔진 순서 > .env, 명시 환경변수가 제일 앞', () => {
  const T = mkdtempSync(join(tmpdir(), 'bt-route-'));
  try {
    mkdirSync(join(T, 'workspace', 'ops'), { recursive: true });
    writeFileSync(join(T, 'workspace', 'ops', 'engine-routing.env'), '# head\nBT_SCRIPT_ENGINE_CHAIN=codex,claude\nBT_X=routing\n');
    writeFileSync(join(T, '.env'), 'BT_X=dotenv\nBT_Y=dotenv\nOPENAI_API_KEY=leak\n');
    const run = (pre) => spawnSync('bash', ['-c', `${pre} source lib/guards.sh >/dev/null 2>&1; echo "$BT_SCRIPT_ENGINE_CHAIN|$BT_X|$BT_Y|\${OPENAI_API_KEY:-none}"`],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BARROTUBE_HOME: T, BT_SCRIPT_ENGINE_CHAIN: '', BT_X: '', BT_Y: '', OPENAI_API_KEY: '' } }).stdout.trim();
    assert.equal(run(''), 'codex,claude|routing|dotenv|none');
    assert.equal(run('export BT_X=explicit;'), 'codex,claude|explicit|dotenv|none');
  } finally { rmSync(T, { recursive: true, force: true }); }
});

test('Codex 실행은 환산 비용이 비어 와서 토큰으로 추정한다 — 하루 상한이 Codex 에도 걸린다', () => {
  // 2026-10-07 리뷰어 점검 실행 실측: 입력 129,193 (캐시 104,832) · 출력 867, costUsd 없음
  const usd = estimateCostUsd({ inputTokens: 129193, cachedInputTokens: 104832, outputTokens: 867 }, policy.cost_estimate_per_mtok.codex);
  assert.ok(usd > 0.04 && usd < 0.07, String(usd));
  assert.equal(estimateCostUsd({ inputTokens: 10 }, undefined), 0);
});

test('후속 회차가 성공한 실패 회차 이슈는 대체로 정리한다 — 장애가 in_review 에 남아도', () => {
  const run = { status: 'blocked', assigneeAgentId: null, originKind: 'routine_execution', originId: 'routine-a', createdAt: '2026-10-27T07:00:00Z', blockedBy: [{ status: 'in_review' }] };
  const later = { identifier: 'YOU-760', originKind: 'routine_execution', originId: 'routine-a', createdAt: '2026-10-28T07:00:00Z', status: 'done' };
  assert.equal(runIssueSuperseded(run, { 'routine-a': later }), later);
  assert.equal(runIssueSuperseded(run, { 'routine-a': { ...later, createdAt: '2026-10-26T07:00:00Z' } }), null, '더 이른 성공은 대체가 아니다');
  assert.equal(runIssueSuperseded(run, { 'routine-b': later }), null, '다른 루틴');
  assert.equal(runIssueSuperseded({ ...run, assigneeAgentId: 'sre' }, { 'routine-a': later }), null, '담당이 있으면 손대지 않는다');
  assert.equal(runIssueSuperseded({ ...run, originKind: 'manual' }, { 'routine-a': later }), null);
  assert.equal(runIssueSuperseded({ ...run, status: 'todo' }, { 'routine-a': later }), null);
});
