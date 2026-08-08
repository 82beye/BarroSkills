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
