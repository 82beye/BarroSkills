import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveContentMode } from '../scripts/automation/fetch-market-snapshot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = join(ROOT, 'lib', 'auto-pipeline.sh');
const INSTALL = join(ROOT, 'lib', 'install-cron.sh');
const PRODUCE = join(ROOT, 'scripts', 'automation', 'produce-episode.js');
const ROUTINES = join(ROOT, 'config', 'routines.json');
const RESEARCH = join(ROOT, 'scripts', 'automation', 'research-brief.js');
const SCRIPT = join(ROOT, 'scripts', 'automation', 'generate-script.js');
const FACTCHECK = join(ROOT, 'scripts', 'automation', 'run-factcheck.js');

test('cron pipeline keeps browser assets, render, and publish in fail-closed order', () => {
  const source = readFileSync(AUTO, 'utf8');
  const syntax = spawnSync('bash', ['-n', AUTO], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const chatgpt = source.indexOf('1. Chrome의 ChatGPT');
  const grok = source.indexOf('2. 위 이미지가 모두 저장된 뒤에만 Chrome의 Grok');
  const render = source.indexOf('run_or_echo node scripts/automation/produce-episode.js');
  const publish = source.indexOf('run_or_echo node scripts/automation/run-episode.js');
  assert.ok(chatgpt >= 0 && chatgpt < grok && grok < render && render < publish);

  for (const required of [
    '40_assets/images/scene_${id}.png',
    '40_assets/videos/scene_${id}.mp4',
    '45_intro.png',
    '47_thumbnail.png',
    '바로경제_캐릭터시트.png',
    'MED 부정확 또는 미접지(grounded=false)',
    'ffprobe -v error',
    '-select_streams a:0',
    'shasum -a 256',
    'duplicate bytes',
    'Video audio 버튼이 aria-pressed=true',
    'Remove image/thumbnail',
    'programmatic download 폴백',
    'marker보다 새 파일만 수락한다',
    '같은 허용을 다시 묻지 말고 계속한다',
    '프로필+composer',
    'S10 사람 승인 대기',
    'publish_remains_human_only',
    'exec --ephemeral',
    '--episode "$EP_ID" --platform "$PLATFORM" --from S11',
    '10_market_research.md',
    '20_strategy.md',
  ]) assert.ok(source.includes(required), `missing cron contract: ${required}`);
  assert.doesNotMatch(source, /scheduled-auto|S10 자율 승인/);

  const install = readFileSync(INSTALL, 'utf8');
  assert.match(install, /CODEX_BIN=.*which codex/);
  assert.doesNotMatch(install, /^\s*auto-pipeline\)$/m,
    'generic routine without --slot must not be installable');

  const produce = readFileSync(PRODUCE, 'utf8');
  assert.match(produce, /sceneIds\.every\(id => exists\(join\(p\.assetsDir, 'videos'/);
  assert.match(produce, /'--platform', platform/);
});

test('closed markets switch research to current issues and Sunday pre-open mode', () => {
  const routines = JSON.parse(readFileSync(ROUTINES, 'utf8'));
  for (const slot of Object.values(routines.slots)) {
    assert.match(slot.closed_market_policy, /최신 주식·경제 이슈/);
    assert.match(slot.closed_market_policy, /토요일/);
    assert.match(slot.closed_market_policy, /일요일/);
  }

  const research = readFileSync(RESEARCH, 'utf8');
  assert.match(research, /휴장일·주말 대체 규칙/);
  assert.match(research, /content_mode.*sunday_preopen/);
  assert.match(research, /traded_at/);
  assert.match(research, /strategy-\$\{slotName\}\.md/);

  const script = readFileSync(SCRIPT, 'utf8');
  assert.match(script, /\[MARKET RESEARCH\]/);
  assert.match(script, /\[CONTENT STRATEGY\]/);

  const pipeline = readFileSync(AUTO, 'utf8');
  assert.match(pipeline, /최신 주식·경제 이슈:/);
  assert.match(pipeline, /다음 장 전 이슈 정리:/);
  assert.match(pipeline, /auto_pipeline_content_mode/);
});

test('research fallback always creates S2 and S3 inputs from collected data', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'barrotube-research-'));
  try {
    writeFileSync(join(outDir, 'market-us-close.json'), JSON.stringify({
      content_mode: 'closed_market_issue',
      quotes: [{ symbol: '.INX', name: 'S&P 500', price_text: '1,234.56', change_pct: 0.5, traded_at: '2026-08-07' }],
    }));
    writeFileSync(join(outDir, 'news.json'), JSON.stringify({
      sources: [{ items: [{ title: 'Weekend market issue', link: 'https://example.com/issue', description: 'A sourced summary.' }] }],
    }));

    const result = spawnSync('node', [RESEARCH, '--slot', 'us-close', '--date', '2026-08-08', '--out-dir', outDir, '--fallback'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(outDir, 'research-us-close.md'), 'utf8'), /Weekend market issue/);
    assert.match(readFileSync(join(outDir, 'strategy-us-close.md'), 'utf8'), /# 콘텐츠 전략/);
    const topic = JSON.parse(readFileSync(join(outDir, 'topic-us-close.json'), 'utf8'));
    assert.equal(topic.content_mode, 'closed_market_issue');
    assert.equal(topic.fallback, true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('factcheck binds market claims to the episode research date', () => {
  const source = readFileSync(FACTCHECK, 'utf8');
  assert.match(source, /\[AUTHORITATIVE PIPELINE MARKET RESEARCH\]/);
  assert.match(source, /10_market_research\.md/);
  assert.match(source, /exact date\/traded_at/);
  assert.match(source, /Never substitute the previous trading day's close/);
});

test('market snapshot resolves weekends and exchange holidays without a calendar dependency', () => {
  const required = ['.INX', '.IXIC', '.DJI'];
  const quotes = (date) => required.map((symbol) => ({ symbol, traded_at: `${date}T16:00:00-04:00` }));

  assert.equal(resolveContentMode('us-close', '2026-08-08', quotes('2026-08-07'), required).content_mode, 'closed_market_issue');
  assert.equal(resolveContentMode('us-close', '2026-08-09', quotes('2026-08-07'), required).content_mode, 'sunday_preopen');
  assert.equal(resolveContentMode('us-close', '2026-08-11', quotes('2026-08-10'), required).content_mode, 'market_close');
  assert.equal(resolveContentMode('us-close', '2026-09-08', quotes('2026-09-04'), required).content_mode, 'closed_market_issue');
  assert.equal(resolveContentMode('kr-close', '2026-08-17', [
    { symbol: 'KOSPI', traded_at: '2026-08-14T18:59:00+09:00' },
    { symbol: 'KOSDAQ', traded_at: '2026-08-14T18:59:00+09:00' },
  ], ['KOSPI', 'KOSDAQ']).content_mode, 'closed_market_issue');
});

test('competitor intel runs before research and never blocks the pipeline', () => {
  const source = readFileSync(AUTO, 'utf8');

  // Phase 1 catch-up: 수집 → 분석 → (이후) 리서치 순서
  const fetchIdx = source.indexOf('fetch-competitor-stats.js');
  const analyzeIdx = source.indexOf('analyze-competitors.js');
  const researchIdx = source.indexOf('research-brief.js');
  assert.ok(fetchIdx >= 0, 'auto-pipeline must reference the competitor fetcher');
  assert.ok(fetchIdx < analyzeIdx, 'fetch must precede analyze');
  assert.ok(analyzeIdx < researchIdx, 'intel must land before research consumes it');

  // fail-soft: 경쟁 블록 안에는 fail_with_alert 가 없어야 한다.
  // 인텔은 EP 생산의 보조 입력이지 선행 조건이 아니다.
  // (앞뒤 단계는 fail-closed 라 블록 경계를 정확히 잘라야 한다)
  // COMPETITOR_SCAN 은 로그 줄에도 등장하므로 fetch 지점에서 역방향으로 if 문을 찾는다
  const scanStart = source.lastIndexOf('if [ "$COMPETITOR_SCAN"', fetchIdx);
  const scanEnd = source.indexOf('Phase 2', fetchIdx);
  assert.ok(scanStart >= 0 && scanEnd > scanStart, 'competitor scan block must be locatable');
  assert.doesNotMatch(source.slice(scanStart, scanEnd), /fail_with_alert/,
    'intel failure must not halt the pipeline');

  // 05:20 정기 스캔 산출물이 있으면 재사용해 쿼터를 이중 지출하지 않는다
  assert.match(source, /analysis-\$\{TODAY\}\.json/);
  assert.match(source, /경쟁 인텔 재사용/);
});

test('competitor-scan routine is installable and runs fail-soft', () => {
  const install = readFileSync(INSTALL, 'utf8');
  assert.match(install, /^\s*competitor-scan\)$/m, 'install-cron must know the routine');
  assert.match(install, /competitor-pipeline\.sh/);
  assert.match(install, /사용 가능:.*competitor-scan/, 'usage text must list it');

  const pipeline = join(ROOT, 'lib', 'competitor-pipeline.sh');
  const syntax = spawnSync('bash', ['-n', pipeline], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const src = readFileSync(pipeline, 'utf8');
  assert.match(src, /exit 0\s*$/m, 'pipeline must end with a hard exit 0');
  // 관측(수집·분석)은 autonomy-pause 와 무관하게 돈다 — 게이트는 핸드오프에만 있다
  assert.doesNotMatch(src, /^\s*guard_master_switch \|\| exit 0/m,
    'collection must not be gated by the publish pause; the gate belongs in intel-handoff.js');
});

test('intel handoff gates on autonomy-pause and stays off the Paperclip API', () => {
  const handoff = join(ROOT, 'scripts', 'automation', 'intel-handoff.js');
  const src = readFileSync(handoff, 'utf8');
  assert.match(src, /autonomy-pause\.json/, 'handoff must read the pause switch');
  assert.match(src, /queue\.jsonl/, 'handoff must record idempotency keys');
  assert.match(src, /status:\s*'planned'|planned/, 'series must land as planned, never auto-produced');
});

test('new competitor scripts never leak the Paperclip control-plane URL', () => {
  // doctor-cli.sh 가 격리 밖의 localhost:3100 을 YELLOW 로 판정한다.
  for (const f of ['analyze-competitors.js', 'intel-handoff.js', 'fetch-competitor-stats.js',
                   'resolve-competitor-channels.js', 'lib/competitor-analytics.js']) {
    const src = readFileSync(join(ROOT, 'scripts', 'automation', f), 'utf8');
    assert.doesNotMatch(src, /(localhost|127\.0\.0\.1):3100/, `${f} leaks the Paperclip API`);
  }
});

test('research-brief consumes competitor intel and records what it used', () => {
  const src = readFileSync(RESEARCH, 'utf8');
  assert.match(src, /경쟁 인텔 분석/, 'analysis file must be a declared input');
  assert.match(src, /content_gaps/, 'prompt must direct the model at the gaps');
  assert.match(src, /competitor_gap_used/, 'topic json must record the gap it acted on');
  assert.match(src, /avoided_duplicates/);
  assert.match(src, /competitor_intel_at/);
});

test('install-cron supports multiple daily times via a StartCalendarInterval array', () => {
  // launchd 는 dict 배열도 받는다. 인자가 같은 루틴은 라벨을 나눌 필요가 없다.
  const src = readFileSync(INSTALL, 'utf8');
  assert.match(src, /StartCalendarInterval<\/key>\s*\n\s*<array>/,
    'array form must be generated for comma-separated times');
  assert.match(src, /time_display/, 'the original spec must survive for output');
  assert.doesNotMatch(src, /schedule: \$time_spec/,
    'the __multi__ sentinel must never reach the operator');
});

test('competitor-scan runs twice daily, ahead of both briefing slots', () => {
  const policy = JSON.parse(readFileSync(join(ROOT, 'config', 'competitor-channels.json'), 'utf8'));
  const times = policy.tracking?.scan_times_kst ?? [];
  assert.deepEqual(times, ['05:20', '15:20'], 'one scan before each slot');

  const routines = JSON.parse(readFileSync(ROUTINES, 'utf8'));
  const slots = routines.routines ?? routines.slots ?? {};
  for (const [slot, cfg] of Object.entries(slots)) {
    const publishHour = parseInt(String(cfg.publish_at ?? '').slice(0, 2), 10);
    if (!Number.isFinite(publishHour)) continue;
    // 각 슬롯보다 앞선 스캔이 하나는 있어야 인텔이 그날 리서치에 닿는다
    const cronHour = slot === 'us-close' ? 6 : 16;
    assert.ok(times.some((t) => parseInt(t.slice(0, 2), 10) < cronHour),
      `no scan precedes ${slot} (cron ${cronHour}:00)`);
  }
});

test('quota target accounts for the twice-daily cadence', () => {
  const metrics = readFileSync(join(ROOT, 'scripts', 'automation', 'intel-metrics.js'), 'utf8');
  const m = /quota_per_day:\s*\{\s*max:\s*(\d+)/.exec(metrics);
  assert.ok(m, 'quota target must be declared');
  const target = Number(m[1]);
  const policy = JSON.parse(readFileSync(join(ROOT, 'config', 'competitor-channels.json'), 'utf8'));
  const channels = (policy.channels ?? []).filter((c) => c.active !== false).length;
  const perDay = channels * 3 * (policy.tracking?.scan_times_kst?.length ?? 1);
  assert.ok(target >= perDay,
    `target ${target} must cover the routine cost ${perDay} (${channels}ch × 3u × ${policy.tracking.scan_times_kst.length} scans)`);
  assert.ok(perDay < policy.quota.daily_cap_units, 'routine cost must stay under the self-imposed cap');
});

test('publishing cadence is 2 on weekdays and 1 on weekends', () => {
  const routines = JSON.parse(readFileSync(ROUTINES, 'utf8'));
  assert.deepEqual(
    { weekday: routines.publishing_cadence?.weekday, weekend: routines.publishing_cadence?.weekend },
    { weekday: 2, weekend: 1 });

  // us-close 는 매일 (토=금요일 미국장, 일=sunday_preopen)
  assert.equal(routines.slots['us-close'].cron, '06:00');
  // kr-close 는 평일만 — 토요일 16:00 은 이미 하루 지난 금요일 종가라 새 정보가 없다
  assert.equal(routines.slots['kr-close'].cron, 'Mon-Fri 16:00');
});

test('install-cron expands a weekday range without bash 4 associative arrays', () => {
  // macOS 기본 bash 는 3.2 다. declare -A 를 쓰면 조용히 분기를 건너뛴다 (실측).
  const src = readFileSync(INSTALL, 'utf8');
  assert.match(src, /weekday_index\(\)/, 'range mapping must use a case-based helper');
  assert.doesNotMatch(src, /local -A |declare -A /, 'bash 3.2 has no associative arrays');
  assert.match(src, /Mon\|Tue\|Wed\|Thu\|Fri\|Sat\|Sun\)-\(/, 'range form must be parsed');
});

test('a weekday-ranged install produces one calendar entry per day', () => {
  const out = mkdtempSync(join(tmpdir(), 'bt-cron-'));
  try {
    const r = spawnSync('bash', [INSTALL, 'install', 'kr-close', 'Mon-Fri 16:00'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, DRY_RUN: '1', HOME: out },
    });
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(
      join(out, 'Library', 'LaunchAgents', 'com.barroskills.barrotube.kr-close.plist'), 'utf8');
    assert.match(plist, /<array>/, 'must emit an array, not a single dict');
    const weekdays = [...plist.matchAll(/<key>Weekday<\/key>\s*<integer>(\d)<\/integer>/g)].map((m) => m[1]);
    assert.deepEqual(weekdays, ['1', '2', '3', '4', '5'], 'Mon..Fri');
    assert.doesNotMatch(plist, /__multi__/, 'the sentinel must not leak into the plist');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
