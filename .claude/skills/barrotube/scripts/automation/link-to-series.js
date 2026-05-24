#!/usr/bin/env node

/**
 * link-to-series.js — 기존 EP를 시리즈에 사후 연결 (품질 권고 #4)
 *
 * 목적:
 *   create-episode.js --series 로 시작되지 않은 단발 EP를
 *   사후에 시리즈 멤버로 등록(series_link.json 생성).
 *   미니시리즈 즉석 생성도 지원.
 *
 * Usage:
 *   # 기존 시리즈에 연결
 *   node scripts/automation/link-to-series.js --ep EP-2026-0043 --series sp500-basic
 *   node scripts/automation/link-to-series.js --ep EP-2026-0043 --series econ-daily-2026-q2 --episode-number 5
 *
 *   # 시리즈가 없으면 신규 미니시리즈로 생성하며 연결
 *   node scripts/automation/link-to-series.js --ep EP-2026-0043 --series econ-daily-2026-q2 --create
 *
 *   # 시리즈 목록 조회
 *   node scripts/automation/link-to-series.js --list
 *
 *   --help     사용법
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(ROOT, 'workspace');
const SERIES_REGISTRY = join(ROOT, 'paperclip/config/series.json');

const HELP = `
link-to-series.js — 기존 EP를 시리즈에 사후 연결

Usage:
  node scripts/automation/link-to-series.js --ep <EP-id> --series <series-id> [--episode-number N]
  node scripts/automation/link-to-series.js --ep <EP-id> --series <series-id> --create
  node scripts/automation/link-to-series.js --list

Options:
  --ep <id>                EP id (workspace/episodes/<id>/)
  --series <id>            시리즈 id (paperclip/config/series.json 의 series[].id)
  --episode-number <N>     시리즈 내 슬롯 번호 (생략 시 자동: 마지막 + 1)
  --create                 시리즈가 없으면 신규 미니시리즈로 생성
  --channel <id>           --create 시 사용 (기본: EP brief의 channel_id)
  --total <N>              --create 시 시리즈 총 편수 (기본: 5)
  --list                   등록된 시리즈 목록 출력
  --help                   이 도움말

산출물:
  workspace/episodes/<EP>/series_link.json
    {
      "seriesId": "...",
      "episodeNumber": N,
      "linkedAt": "ISO-8601",
      "series_id": "...",          // create-episode.js 호환 키
      "series_episode": N,
      "series_total": M,
      "series_name": "...",
      "parent_long_id": "<EP>"
    }
`;

function loadSeriesRegistry() {
  if (!existsSync(SERIES_REGISTRY)) {
    return { version: '1.1', series: [] };
  }
  try {
    return JSON.parse(readFileSync(SERIES_REGISTRY, 'utf-8'));
  } catch (e) {
    const msg = `[ERROR] paperclip/config/series.json 이 유효한 JSON이 아닙니다.\n        ${e.message}\n        파일을 먼저 수정한 후 재시도 하세요. 백업: paperclip/config/series.json.bak.*`;
    throw new Error(msg);
  }
}

function saveSeriesRegistry(reg) {
  // 백업
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${SERIES_REGISTRY}.bak.${ts}`;
  if (existsSync(SERIES_REGISTRY)) {
    writeFileSync(bak, readFileSync(SERIES_REGISTRY, 'utf-8'), 'utf-8');
  }
  writeFileSync(SERIES_REGISTRY, JSON.stringify(reg, null, 2) + '\n', 'utf-8');
  return bak;
}

function listSeries() {
  const reg = loadSeriesRegistry();
  if (!Array.isArray(reg.series) || reg.series.length === 0) {
    console.log('(등록된 시리즈가 없습니다)');
    return;
  }
  console.log(`\n등록 시리즈 (${reg.series.length}건):`);
  console.log('─'.repeat(72));
  for (const s of reg.series) {
    console.log(`  ${s.id.padEnd(28)} ${(s.name || '').slice(0, 30)}`);
    console.log(`    channel=${s.channel || '?'}  format=${s.format || '?'}  total=${s.total_episodes || '?'}  status=${s.status || 'active'}`);
  }
  console.log('');
}

function readBriefFrontmatter(epDir) {
  const briefPath = join(epDir, '00_brief.md');
  if (!existsSync(briefPath)) return null;
  const md = readFileSync(briefPath, 'utf-8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (mm) {
      let v = mm[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fm[mm[1]] = v;
    }
  }
  return fm;
}

function nextEpisodeSlot(seriesId) {
  // 다른 EP들의 series_link.json을 스캔해서 같은 series에 속한 마지막 episode 번호 + 1
  const epsDir = join(WORKSPACE, 'episodes');
  if (!existsSync(epsDir)) return 1;
  let maxN = 0;
  for (const ep of readdirSync(epsDir)) {
    const p = join(epsDir, ep, 'series_link.json');
    if (!existsSync(p)) continue;
    try {
      const link = JSON.parse(readFileSync(p, 'utf-8'));
      const sid = link.series_id || link.seriesId;
      const n = link.series_episode ?? link.episodeNumber;
      if (sid === seriesId && Number.isFinite(n)) {
        if (n > maxN) maxN = n;
      }
    } catch {}
  }
  return maxN + 1;
}

function createMiniSeries({ id, name, channel, total }) {
  const reg = loadSeriesRegistry();
  if (!Array.isArray(reg.series)) reg.series = [];
  if (reg.series.some(s => s.id === id)) {
    throw new Error(`이미 존재하는 시리즈: ${id}`);
  }
  const newSeries = {
    id,
    name: name || id,
    display_name_short: (name || id).replace(/\s\d+편$/, ''),
    channel: channel || 'econ-daily',
    format: 'long-3min',
    persona: 'barro-teacher',
    total_episodes: total || 5,
    cadence: { days: ['tue', 'thu', 'sun'], time_kst: '19:00' },
    status: 'planned',
    source: { kind: 'manual-mini-series', created_at: new Date().toISOString() },
    learning_arc: [],
    thumbnail_specs: [],
    branding_outputs: { layout_version: 'v2' },
    required_disclaimer: true,
  };
  reg.series.push(newSeries);
  const bak = saveSeriesRegistry(reg);
  return { series: newSeries, backup: bak };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ep:               { type: 'string' },
        series:           { type: 'string' },
        'episode-number': { type: 'string' },
        create:           { type: 'boolean', default: false },
        channel:          { type: 'string' },
        total:            { type: 'string' },
        list:             { type: 'boolean', default: false },
        help:             { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`[ERROR] 인자 파싱 실패: ${e.message}`);
    console.error(HELP);
    process.exit(1);
  }

  if (values.list) {
    listSeries();
    process.exit(0);
  }

  if (!values.ep || !values.series) {
    console.error('[ERROR] --ep 와 --series 는 필수입니다.\n');
    console.error(HELP);
    process.exit(1);
  }

  const epId = values.ep;
  const seriesId = values.series;
  const epDir = join(WORKSPACE, 'episodes', epId);

  if (!existsSync(epDir)) {
    console.error(`[ERROR] EP 디렉토리가 없습니다: ${epDir}`);
    process.exit(1);
  }

  const linkPath = join(epDir, 'series_link.json');
  if (existsSync(linkPath)) {
    console.error(`[WARN] 이미 series_link.json 존재: ${linkPath}`);
    const existing = JSON.parse(readFileSync(linkPath, 'utf-8'));
    console.error(`       기존 연결: series_id=${existing.series_id || existing.seriesId}, episode=${existing.series_episode ?? existing.episodeNumber}`);
    console.error('       덮어쓰려면 기존 파일을 삭제 후 재실행 하세요.');
    process.exit(1);
  }

  // 시리즈 조회
  const reg = loadSeriesRegistry();
  let series = (reg.series || []).find(s => s.id === seriesId);

  if (!series) {
    if (!values.create) {
      console.error(`[ERROR] 시리즈를 찾을 수 없습니다: ${seriesId}`);
      console.error('        등록된 시리즈 확인: --list');
      console.error('        신규 미니시리즈 생성: --create [--channel <id>] [--total N]');
      process.exit(1);
    }
    // brief에서 channel 추출
    const fm = readBriefFrontmatter(epDir);
    const channel = values.channel || fm?.channel_id || 'econ-daily';
    const total = parseInt(values.total || '5', 10);

    console.log(`[INFO] 신규 미니시리즈 생성: ${seriesId}`);
    const { series: newSeries, backup } = createMiniSeries({
      id: seriesId,
      name: seriesId,
      channel,
      total,
    });
    series = newSeries;
    console.log(`       backup: ${backup}`);
    console.log(`       channel=${channel}, total=${total}, status=planned`);
  }

  // episodeNumber 결정
  let episodeNumber;
  if (values['episode-number']) {
    episodeNumber = parseInt(values['episode-number'], 10);
    if (!Number.isFinite(episodeNumber) || episodeNumber < 1) {
      console.error(`[ERROR] --episode-number 는 1 이상의 정수여야 합니다.`);
      process.exit(1);
    }
  } else {
    episodeNumber = nextEpisodeSlot(seriesId);
  }

  // series_link.json 작성 (요청 스펙 + create-episode.js 호환 키 둘 다 채움)
  const linkedAt = new Date().toISOString();
  const seriesLink = {
    seriesId,
    episodeNumber,
    linkedAt,
    // create-episode.js / produce-episode.js 호환 키
    series_id: seriesId,
    series_episode: episodeNumber,
    series_total: series.total_episodes || 5,
    series_name: series.name || seriesId,
    parent_long_id: epId,
    linked_via: 'link-to-series.js',
  };
  writeFileSync(linkPath, JSON.stringify(seriesLink, null, 2) + '\n', 'utf-8');

  console.log(`\n[OK] 시리즈 연결 완료`);
  console.log(`     EP            : ${epId}`);
  console.log(`     series        : ${seriesId} (${series.name || ''})`);
  console.log(`     episodeNumber : ${episodeNumber} / ${series.total_episodes || '?'}`);
  console.log(`     linkedAt      : ${linkedAt}`);
  console.log(`     path          : ${linkPath}`);
  console.log('');
  console.log('확인:');
  console.log(`  cat ${linkPath}`);
  console.log(`  node scripts/automation/episode-status.js --episode ${epId}`);

  // 결과 JSON
  console.log(`\n<!--RESULT-->${JSON.stringify({
    episode_id: epId,
    series_id: seriesId,
    episode_number: episodeNumber,
    linked_at: linkedAt,
    series_link_path: linkPath,
  })}<!--/RESULT-->`);
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
