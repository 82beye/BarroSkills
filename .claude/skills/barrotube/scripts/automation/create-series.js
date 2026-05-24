#!/usr/bin/env node

/**
 * create-series.js — 시리즈 전체 에피소드 일괄 부트스트랩
 *
 * paperclip/config/series.json에서 시리즈 메타 읽기 →
 * workspace/channels/{channel}/series/{series_id}/ep-N-brief.md 5개 기반으로
 * workspace/episodes/EP-YYYY-NNNN/ 디렉토리 5개 + 00_brief.md 일괄 생성.
 *
 * 이후 각 에피소드는 기존 파이프라인 (run-episode.js, produce-episode.js) 재진입.
 *
 * Usage:
 *   node create-series.js --series sp500-basic
 *   node create-series.js --series sp500-basic --dry-run
 *   node create-series.js --series sp500-basic --start-from EP-2026-0010
 *
 * Flags:
 *   --series <id>        (required) series.json에 등록된 시리즈 ID
 *   --dry-run            파일 쓰지 않고 계획만 출력
 *   --start-from <id>    할당 시작 에피소드 ID 강제 지정 (기본: 최댓값+1)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(PROJECT_ROOT, 'workspace');
const PAPERCLIP_CONFIG = resolve(PROJECT_ROOT, 'paperclip/config');

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  try { return parseYAML(m[1]) || {}; } catch { return {}; }
}

function generateNextEpisodeIds(startFrom, count) {
  const year = new Date().getFullYear();
  const episodesDir = join(WORKSPACE, 'episodes');

  let startNum;
  if (startFrom) {
    const m = startFrom.match(/^EP-\d{4}-(\d{4})$/);
    if (!m) throw new Error(`Invalid --start-from: ${startFrom}`);
    startNum = parseInt(m[1], 10);
  } else {
    if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });
    const existing = readdirSync(episodesDir)
      .filter(d => d.startsWith(`EP-${year}-`))
      .sort();
    startNum = existing.length > 0
      ? parseInt(existing[existing.length - 1].split('-')[2], 10) + 1
      : 1;
  }

  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(`EP-${year}-${String(startNum + i).padStart(4, '0')}`);
  }
  return ids;
}

function loadSeriesBriefs(series) {
  const briefs = [];
  for (const briefPath of series.brief_paths) {
    const abs = resolve(PROJECT_ROOT, briefPath);
    if (!existsSync(abs)) {
      throw new Error(`Brief file missing: ${briefPath}`);
    }
    const raw = readFileSync(abs, 'utf-8');
    const fm = parseFrontmatter(raw);
    briefs.push({ path: briefPath, fm, raw });
  }
  return briefs;
}

function buildEpisodeBrief(episodeId, series, seriesBrief) {
  const fm = {
    episode_id: episodeId,
    channel_id: series.channel,
    format: series.format,
    persona: series.persona,
    series_id: series.id,
    series_episode: seriesBrief.fm.series_episode,
    series_total: series.total_episodes,
    theme_axis: seriesBrief.fm.theme_axis,
    topic: seriesBrief.fm.topic,
    target_length_seconds: series.defaults?.target_length_seconds || seriesBrief.fm.target_length_seconds,
    required_disclaimer: seriesBrief.fm.required_disclaimer ?? true,
    created_at: new Date().toISOString(),
    status: 'created',
  };

  const body = [
    '---',
    stringifyYAML(fm).trim(),
    '---',
    '',
    `# Episode Brief — ${episodeId}`,
    '',
    `## 주제`,
    seriesBrief.fm.topic,
    '',
    `## 시리즈`,
    `- **시리즈**: ${series.name} (${series.id})`,
    `- **편**: ${seriesBrief.fm.series_episode} / ${series.total_episodes}`,
    `- **학습 아크**: ${seriesBrief.fm.theme_axis}`,
    `- **포맷**: ${series.format} (target ${fm.target_length_seconds}s)`,
    `- **페르소나**: ${series.persona}`,
    '',
    `## 기획 문서 참조`,
    `이 에피소드의 상세 기획 (Hook·씬 구조·데이터·이미지·썸네일)은 다음 문서를 참조:`,
    ``,
    `\`${seriesBrief.path}\``,
    '',
    `## 커리큘럼`,
    `\`${series.curriculum_path}\``,
    '',
    '## 워크플로우',
    '- [x] S0: Brief 작성 (create-series로 자동 생성됨)',
    '- [ ] S1: CEO → PD 티켓 생성',
    series.format === 'shorts' ? '- [~] S2: Market Research (shorts는 skip)' : '- [ ] S2: Market Research (시리즈 컨텍스트 자동 로드)',
    series.format === 'shorts' ? '- [~] S3: Strategy (shorts는 skip)' : '- [ ] S3: Strategy',
    '- [ ] S4: Script',
    '- [ ] S5: Fact Check',
    '- [ ] S6: Asset Generation',
    '- [ ] S7: CapCut Composition',
    '- [ ] S8: QA Review',
    '- [ ] S9: Metadata',
    '- [ ] S10: Board Approval',
    '- [ ] S11: Publish',
    series.auto_derive_shorts ? '- [ ] S12: Derive Shorts (자동, 발행 +3h)' : '',
    '',
  ].filter(Boolean).join('\n');

  return body;
}

async function main() {
  const { values } = parseArgs({
    options: {
      series: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
      'start-from': { type: 'string' },
    },
  });
  if (!values.series) {
    console.error('Usage: create-series.js --series <id> [--dry-run] [--start-from EP-YYYY-NNNN]');
    process.exit(1);
  }

  const seriesConfigPath = join(PAPERCLIP_CONFIG, 'series.json');
  if (!existsSync(seriesConfigPath)) {
    console.error(`❌ Missing ${seriesConfigPath}`);
    process.exit(1);
  }
  const seriesConfig = readJSON(seriesConfigPath);
  const series = seriesConfig.series?.find(s => s.id === values.series);
  if (!series) {
    console.error(`❌ Series not found: ${values.series}`);
    console.error(`   Available: ${seriesConfig.series?.map(s => s.id).join(', ') || 'none'}`);
    process.exit(1);
  }

  console.log(`📚 Loading series: ${series.id} — ${series.name}`);
  console.log(`   Channel: ${series.channel} | Format: ${series.format} | Persona: ${series.persona}`);
  console.log(`   Total episodes: ${series.total_episodes}`);

  // 시리즈 brief 로드 + 유효성 검증
  const briefs = loadSeriesBriefs(series);
  if (briefs.length !== series.total_episodes) {
    console.error(`❌ Brief count mismatch: expected ${series.total_episodes}, found ${briefs.length}`);
    process.exit(1);
  }

  // series_episode 순서 검증
  briefs.sort((a, b) => (a.fm.series_episode || 0) - (b.fm.series_episode || 0));
  for (let i = 0; i < briefs.length; i++) {
    if (briefs[i].fm.series_episode !== i + 1) {
      console.error(`❌ Brief ${briefs[i].path}: expected series_episode=${i+1}, got ${briefs[i].fm.series_episode}`);
      process.exit(1);
    }
  }

  // 에피소드 ID 할당
  const episodeIds = generateNextEpisodeIds(values['start-from'], series.total_episodes);

  console.log('');
  console.log(`📋 Episode assignment plan:`);
  const plan = briefs.map((b, i) => ({
    episodeId: episodeIds[i],
    seriesEp: b.fm.series_episode,
    topic: b.fm.topic,
    briefPath: b.path,
  }));
  plan.forEach(p => {
    console.log(`   ${p.episodeId}  ←  EP${String(p.seriesEp).padStart(2, '0')}: ${p.topic}`);
  });

  if (values['dry-run']) {
    console.log('');
    console.log('🧪 DRY RUN — no files written. Remove --dry-run to execute.');
    return;
  }

  // 실제 생성
  console.log('');
  console.log(`✏️  Writing ${episodeIds.length} episode directories...`);
  for (let i = 0; i < briefs.length; i++) {
    const episodeId = episodeIds[i];
    const epDir = join(WORKSPACE, 'episodes', episodeId);

    if (existsSync(epDir)) {
      console.error(`❌ Already exists: ${epDir}. Aborting to prevent overwrite.`);
      process.exit(1);
    }

    mkdirSync(epDir, { recursive: true });
    mkdirSync(join(epDir, 'assets'), { recursive: true });

    const briefBody = buildEpisodeBrief(episodeId, series, briefs[i]);
    writeFileSync(join(epDir, '00_brief.md'), briefBody, 'utf-8');

    console.log(`   ✅ ${episodeId} → ${epDir}`);
  }

  console.log('');
  console.log(`🎉 Series ${series.id} bootstrapped: ${episodeIds.length} episodes ready for S1+`);
  console.log(`   Next: node run-episode.js --episode ${episodeIds[0]}`);
  console.log(`   Or batch: for ep in ${episodeIds.join(' ')}; do node run-episode.js --episode $ep; done`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
