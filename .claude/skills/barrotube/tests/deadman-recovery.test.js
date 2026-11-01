import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanExitStatus, runFacts } from '../scripts/automation/paperclip/dispatch.js';
import { closeRescued, pipelineQuotaOpen, planRescue, retargetShockDocuments, slotDeadline } from '../scripts/automation/paperclip/deadman-recover.js';

const NOON = Date.parse('2026-11-01T01:00:00Z');   // KST 10:00
const ago = (min) => new Date(NOON - min * 60_000).toISOString();
const run = (status, extra = {}) => ({ status, ep: 'EP-2026-0272', finishedAt: ago(120), ...extra });
const plan = (runs, extra = {}) => planRescue({ runs, now: NOON, deadline: NOON + 4 * 3600_000, ...extra });

test('halted, failed and lost runs are resumed on the same episode within the grace window', () => {
  for (const status of ['halted', 'failed', 'lost']) {
    assert.deepEqual(plan([run(status)]), { action: 'resume', ep: 'EP-2026-0272', attempts: 0 });
  }
});

test('finished runs are left alone — operator pass and guards count as finished', () => {
  for (const status of ['done', 'guarded']) assert.equal(plan([run(status)]).action, 'none');
  assert.equal(plan([run('failed'), run('running')]).reason, 'running');
  assert.equal(plan([]).action, 'none');
});

test('a run finished by a retry reports that it was rescued so its incidents can close', () => {
  assert.equal(plan([run('halted'), run('done')]).rescued, true);
  assert.equal(plan([run('done')]).rescued, false);
});

test('an idle run produced nothing, so it reruns instead of resuming the episode the log mentioned', () => {
  assert.deepEqual(plan([run('idle')]), { action: 'rerun', attempts: 0 });
});

test('a log mention of an older episode never resumes it', () => {
  assert.equal(plan([run('failed')], { epUsable: () => false }).action, 'rerun');
  assert.equal(plan([run('failed', { ep: null })]).action, 'rerun');
});

test('retries back off, and stop before the grace window ends so a render cannot overrun it', () => {
  assert.equal(plan([run('halted', { finishedAt: ago(5) })]).reason, 'backoff');
  assert.equal(plan([run('halted', { finishedAt: ago(14) })]).reason, 'backoff');
  assert.equal(plan([run('halted', { finishedAt: ago(16) })]).action, 'resume');
  assert.equal(plan([run('halted'), run('halted', { finishedAt: ago(16) })]).reason, 'backoff');
  assert.deepEqual(plan([run('halted')], { deadline: NOON + 59 * 60_000 }), { action: 'giveup', reason: 'grace', attempts: 0 });
  assert.equal(plan([run('halted')], { deadline: NOON + 61 * 60_000 }).action, 'resume');
});

test('retries end after the sixth attempt', () => {
  const failed = (n) => Array.from({ length: n }, () => run('failed'));
  assert.equal(plan(failed(6)).action, 'resume');
  assert.deepEqual(plan(failed(7)), { action: 'giveup', reason: 'attempts', attempts: 6 });
});

test('a quota denial waits without spending an attempt while every provider is closed', () => {
  const denied = run('halted', { quotaDenied: true });
  assert.deepEqual(plan([denied], { quotaOpen: false }), { action: 'wait', reason: 'quota', attempts: 0 });
  assert.equal(plan([denied], { quotaOpen: true }).action, 'resume');
  assert.equal(plan([run('failed', { quotaDenied: false })], { quotaOpen: false }).action, 'resume');
});

test('two content halts on one script rerun from the topic; quota halts do not count as content', () => {
  const stage = 'Phase 6 factcheck';
  assert.equal(plan([run('halted', { stage, quotaDenied: true }), run('halted', { stage, quotaDenied: true })]).action, 'resume');
  assert.equal(plan([run('halted', { stage, quotaDenied: true }), run('halted', { stage })]).action, 'resume');
  assert.deepEqual(plan([run('halted', { stage }), run('halted', { stage })]), { action: 'rerun', attempts: 1 });
  assert.equal(plan([run('failed', { stage: 'Phase 8 produce' }), run('failed', { stage: 'Phase 8 produce' })]).action, 'resume');
  assert.equal(plan([run('halted', { stage }), run('halted', { stage }), run('halted', { stage, ep: 'EP-2026-0273' })]).action, 'resume');
});

test('the rescue gate only closes when no provider can take a production call', () => {
  const open = (claude, codex, session = 0) => pipelineQuotaOpen({ providers: {
    claude: { weekUsedPercent: claude, sessionUsedPercent: session }, codex: { weekUsedPercent: codex, sessionUsedPercent: null } } });
  assert.equal(open(64, 55), true);
  assert.equal(open(71, 69), true);
  assert.equal(open(71, 70), false);
  assert.equal(open(50, 71, 100), false);
  assert.equal(pipelineQuotaOpen({}), true);
});

test('the deadline is the publish target plus the late grace, in KST', () => {
  const config = { slots: { 'us-close': { publish_at: '08:00' } }, guards: { publish_late_grace_hours: 6 } };
  assert.equal(new Date(slotDeadline(config, 'us-close', '2026-11-01')).toISOString(), '2026-11-01T05:00:00.000Z');
});

test('a rescued run closes its environment incidents and leaves code defects with the SRE', async () => {
  const patched = [];
  const recorded = [];
  const closed = await closeRescued([
    { key: 'slot_us-close', incidentIds: ['IR-1', 'IR-2'], sreIssues: [{ incident: 'IR-1', issue: 'YOU-1', issueId: 'a' }, { incident: 'IR-2', issue: 'YOU-2', issueId: 'b' }] },
    { key: 'resume-EP-2026-0272#1', ep: 'EP-2026-0272', status: 'done' },
  ], {
    incidents: [{ id: 'IR-1', class: 'env' }, { id: 'IR-2', class: 'code' }],
    record: (row) => recorded.push(row), patch: async (id, body) => patched.push([id, body]),
  });
  assert.deepEqual(closed, ['YOU-1']);
  assert.deepEqual(recorded.map((r) => [r.type, r.id]), [['resolution', 'IR-1']]);
  assert.equal(patched[0][0], 'a');
  assert.equal(patched[0][1].status, 'done');
});

test('exit 0 without a video is not recorded as a finished run', () => {
  assert.equal(cleanExitStatus('❌ 안전한 폴백 토픽이 없습니다. topic-review 파일의 탈락 사유를 확인하세요.'), 'idle');
  assert.equal(cleanExitStatus('🛑 In-flight lock active: EP-2026-0272 (PID 1) — 다음 사이클 대기'), 'idle');
  assert.equal(cleanExitStatus('🛑 QA 판정·해시가 없거나 FAIL — publish 차단'), 'halted');
  assert.equal(cleanExitStatus('🛑 QA report 없음 — publish 차단'), 'halted');
});

test('deliberate stops stay guarded and an ordinary run stays done', () => {
  assert.equal(cleanExitStatus('🛑 일일 EP 상한 도달 (3/3) — 오늘 자동 발행 종료'), 'guarded');
  assert.equal(cleanExitStatus('🛑 Autonomy paused (status=paused) — 자율 작업 중단'), 'guarded');
  assert.equal(cleanExitStatus('🛑 운영자 패스'), 'guarded');
  assert.equal(cleanExitStatus('✅ 완료'), 'done');
});

test('a run records why it stopped for the next retry decision', () => {
  assert.deepEqual(runFacts('PAPERCLIP_RESERVE_GUARD: admission denied', [{ stage: 'Phase 6 factcheck' }]), { quotaDenied: true, stage: 'Phase 6 factcheck' });
  assert.deepEqual(runFacts('🛑 QA 판정·해시가 없거나 FAIL — publish 차단', []), { quotaDenied: false, stage: 'Phase 9 QA' });
  assert.deepEqual(runFacts('', []), { quotaDenied: false, stage: null });
});

test('a QA block retried twice on one episode starts over from the topic', () => {
  const stage = 'Phase 9 QA';
  assert.equal(plan([run('halted', { stage })]).action, 'resume');
  assert.equal(plan([run('halted', { stage }), run('halted', { stage })]).action, 'rerun');
});

test('a weekly slot with no desk still publishes a dated issue rather than going idle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-fallback-'));
  const fresh = new Date(Date.now() - 3600_000).toISOString();
  writeFileSync(join(dir, 'market-us-close.json'), JSON.stringify({ content_mode: 'weekly_preview', quotes: [] }));
  writeFileSync(join(dir, 'news.json'), JSON.stringify({ fetched_at: new Date().toISOString(), sources: [{ source_name: 'wire', items: [
    { title: 'Fed officials signal rate path as bond yields climb on inflation data', link: 'https://example.com/markets/fed-rate-path', pubDate: fresh, description: 'bond yields and inflation' },
  ] }] }));
  const script = new URL('../scripts/automation/research-brief.js', import.meta.url).pathname;
  execFileSync(process.execPath, [script, '--slot', 'us-close', '--date', '2026-10-26', '--out-dir', dir, '--fallback'], { stdio: 'pipe' });
  const topic = JSON.parse(readFileSync(join(dir, 'topic-us-close.json'), 'utf8'));
  assert.equal(topic.content_mode, 'closed_market_issue');
  assert.equal(topic.topic_source, 'headline');
});

test('failed pre-script episode is retargeted to the verified closing shock', () => {
  const updated = retargetShockDocuments({
    brief: 'topic: "금리 발언"\n## 주제\n금리 발언\n## 채널\necon-daily\n## 운영자 요구사항\n없음\n',
    research: '## 선정 토픽\n금리 발언\n## 시세 스냅샷\n- 코스피 6,035.35\n',
    strategy: '## 한 문장 앵글\n금리 발언\n## 시청자 가치\n퇴근길\n',
  }, { topic: '코스피 5.46% 급락, 6,035.35 마감', source_url: 'https://global.krx.co.kr/cn/main/main.jsp' });
  assert.match(updated.brief, /^topic: "코스피 5.46% 급락, 6,035.35 마감"/);
  assert.match(updated.research, /수집 뉴스와 연결되지 않은 하락 원인을 지어내지 않는다/);
  assert.match(updated.strategy, /코스피 5.46% 급락/);
  const rerun = retargetShockDocuments(updated, { topic: '코스피 5.46% 급락, 6,035.35 마감', source_url: 'https://global.krx.co.kr/cn/main/main.jsp' });
  assert.equal((rerun.research.match(/## 급락 자동 복구 근거/g) ?? []).length, 1);
  assert.equal((rerun.strategy.match(/## 급락 자동 복구 근거/g) ?? []).length, 1);
});
