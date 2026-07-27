#!/usr/bin/env node

/**
 * channel-migrate.js — scattered channel data -> federated channel manifests.
 *
 * Dry-run is the default. `--write` creates only registry metadata and missing
 * series indexes; it never moves or rewrites production assets.
 */

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createChannelRegistry } from './lib/channel-registry.js';

const SKILL_ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = join(SKILL_ROOT, 'workspace');
const DATA_ROOT = resolve(process.env.BARROTUBE_DATA || '/Users/beye/BarroTubeData');
const FACTORY_ROOT = resolve(process.env.BARRO_AI_FACTORY || '/Users/beye/BarroAiFactory');
const CHANNELS_ROOT = join(DATA_ROOT, 'workspace', 'channels');

const { values } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'refresh-series': { type: 'boolean', default: false },
    channel: { type: 'string', default: 'all' },
    report: { type: 'string' },
  },
});

function conflict(field, reason, candidates = []) {
  return { field, reason, candidates, resolution: null };
}

function tokenPath(root, rel = '') {
  const clean = String(rel).replace(/^\/+/, '');
  return clean ? `${root}/${clean}` : root;
}

function commonManifest(id) {
  return {
    schema_version: 1,
    id,
    revision: 1,
    status: 'needs_review',
    identity: {
      display_name: id,
      description: '',
      owner: 'beye',
      language: 'ko',
      timezone: 'Asia/Seoul',
    },
    platforms: {},
    formats: { enabled: [], default: null },
    cadence: {},
    pipeline: { profile: null, additional_profiles: [] },
    paths: { reference_docs: [], character_sheets: [], style_guides: {}, policies: [] },
    document: { title: `${id} 영상 제작·관리 설계문서`, output_path: null },
    credentials: {},
    migration: {
      imported_at: new Date().toISOString(),
      reviewed_at: null,
      sources: [],
      conflicts: [],
    },
  };
}

function econDailyManifest() {
  const m = commonManifest('econ-daily');
  m.identity.handle = '@barrotube';
  m.identity.description = '경제 뉴스·교육형 YouTube 채널';
  m.platforms.youtube = {
    channel_id: null,
    default_privacy: null,
    category_id: null,
  };
  m.formats = { enabled: ['shorts', 'long-3min'], default: 'shorts' };
  m.pipeline = {
    profile: 'barrotube-s12',
    additional_profiles: [],
    // Existing S12 episode briefs predate channel_id. This explicit opt-in is
    // required when adopting otherwise unassigned episodes from a shared root.
    legacy_default_channel: 'econ-daily',
  };
  m.paths = {
    project_root: '${BARROTUBE_DATA}/workspace/channels/econ-daily',
    episodes_root: '${BARROTUBE_DATA}/workspace/episodes',
    series_index: '${BARROTUBE_DATA}/workspace/channels/econ-daily/series/index.json',
    brand: '${BARROTUBE_DATA}/workspace/channels/econ-daily/brand.md',
    character_dna: '${BARROTUBE_DATA}/workspace/channels/econ-daily/character-dna.md',
    character_sheets: [],
    style_guides: {
      shorts: '${BARROTUBE_DATA}/workspace/channels/econ-daily/style-guide-shorts.md',
      'long-3min': '${BARROTUBE_DATA}/workspace/channels/econ-daily/style-guide-long.md',
    },
    policies: [
      '${BARROTUBE_DATA}/workspace/channels/econ-daily/policies/public-figures-policy.md',
      '${BARROTUBE_DATA}/workspace/channels/econ-daily/policies/public-figures.md',
    ],
    reference_docs: [
      '${BARROTUBE_DATA}/workspace/channels/econ-daily/role.md',
      '${BARROTUBE_DATA}/workspace/channels/econ-daily/intro-thumbnail-guide.md',
      '${BARROTUBE_DATA}/workspace/channels/econ-daily/scene-backgrounds.md',
    ],
  };
  m.document.output_path = '${BARROTUBE_DATA}/workspace/channels/econ-daily/econ-daily-영상제작-설계문서.html';
  m.credentials.youtube = {
    client_id_env: 'YOUTUBE_ECON_DAILY_OAUTH_CLIENT_ID',
    client_secret_env: 'YOUTUBE_ECON_DAILY_OAUTH_CLIENT_SECRET',
    refresh_token_env: 'YOUTUBE_ECON_DAILY_OAUTH_REFRESH_TOKEN',
  };
  m.migration.sources = [
    'workspace/channels/econ-daily/*.md',
    'config/formats.json', 'config/personas.json', 'config/budget-policy.json',
    'config/company.json', 'workspace/episodes/*',
  ];
  m.migration.conflicts = [
    conflict('identity.display_name', '채널 표시명이 서로 다릅니다.', [
      { value: '오늘의 경제 브리핑', source: 'brand.md' },
      { value: '바로경제', source: 'role.md / BarroTubeData/CLAUDE.md' },
    ]),
    conflict('cadence', 'Shorts와 Long 발행 일정이 formats/style/curriculum에서 서로 다릅니다.', [
      { value: 'shorts 11:30, long Tue/Thu 07:00', source: 'config/formats.json' },
      { value: 'long Tue/Thu 19:00 + Sun 11:00', source: 'style-guide-long.md' },
    ]),
    conflict('paths.character_dna', '실행 DNA는 v12인데 일부 스타일 문서가 v9 stick figure를 정본으로 설명합니다.'),
    conflict('platforms.youtube', '템플릿과 publisher의 privacy/category 기본값이 다르고 실제 channel_id가 등록되지 않았습니다.'),
    conflict('credentials.youtube', '채널별 OAuth 환경변수로 복사하고 실제 YouTube channel_id를 검증해야 합니다.'),
  ];
  return m;
}

function todayMyoManifest() {
  const m = commonManifest('today.myo');
  m.identity = {
    ...m.identity,
    display_name: '오늘묘',
    handle: '@todaymyo',
    description: 'AI 실사 새끼고양이 오늘(Oneul)의 일생을 연재하는 Instagram 채널',
  };
  m.platforms.instagram = { handle: '@todaymyo', account_id: null };
  m.formats = { enabled: ['reels', 'carousel'], default: 'reels' };
  m.pipeline = { profile: 'media-render-r11', additional_profiles: ['carousel-c4'] };
  m.paths = {
    project_root: '${BARRO_AI_FACTORY}/today.myo',
    episodes_root: '${BARRO_AI_FACTORY}/today.myo/barrotube',
    carousel_root: '${BARRO_AI_FACTORY}/today.myo/daily',
    series_index: '${BARRO_AI_FACTORY}/today.myo/series/index.json',
    brand: '${BARRO_AI_FACTORY}/today.myo/README.md',
    character_dna: '${BARRO_AI_FACTORY}/today.myo/character_dna.md',
    character_sheets: [
      '${BARRO_AI_FACTORY}/today.myo/character-sheet/oneul-character-sheet-v1.png',
      '${BARRO_AI_FACTORY}/today.myo/character-sheet/family-dad-sheet-v1.png',
      '${BARRO_AI_FACTORY}/today.myo/character-sheet/family-mom-sheet-v1.png',
      '${BARRO_AI_FACTORY}/today.myo/character-sheet/family-son-sheet-v1.png',
    ],
    style_guides: {},
    policies: [],
    reference_docs: [
      '${BARRO_AI_FACTORY}/today.myo/오늘묘-설계문서.html',
    ],
  };
  m.document = {
    title: '오늘묘 에피소드 영상 제작·관리 설계문서',
    output_path: '${BARRO_AI_FACTORY}/today.myo/오늘묘-영상제작-설계문서.html',
  };
  m.credentials.instagram = { browser_profile_env: 'INSTAGRAM_TODAYMYO_BROWSER_PROFILE' };
  m.migration.sources = ['README.md', 'character_dna.md', 'series/index.json', 'tools/bridge.py', 'tools/commands.json'];
  m.migration.conflicts = [
    conflict('identity.character_name', 'README는 모모, 현행 DNA와 설계문서는 오늘(Oneul)을 사용합니다.', [
      { value: '모모', source: 'README.md' },
      { value: '오늘(Oneul)', source: 'character_dna.md' },
    ]),
    conflict('qa.checklist', '기존 commands.json은 6항목, 현재 설계문서는 7항목입니다.'),
    conflict('paths.carousel_root', 'README의 날짜 기반 경로와 실제 슬러그 기반 경로가 다릅니다.'),
    conflict('security.bridge_token', '공유 문서에 노출된 기존 브리지 토큰을 폐기·재발급해야 합니다.'),
  ];
  return m;
}

function takitaniManifest() {
  const m = commonManifest('takitani.lab');
  m.identity = {
    ...m.identity,
    display_name: 'takitani.lab',
    handle: '@takitani.lab',
    description: '조선 인물이 현대 공간에 등장하는 AI Instagram Reels 채널',
  };
  m.platforms.instagram = { handle: '@takitani.lab', account_id: null };
  m.formats = { enabled: ['reels'], default: 'reels' };
  m.pipeline = { profile: 'media-render-r11', additional_profiles: [] };
  m.paths = {
    project_root: '${BARRO_AI_FACTORY}/takitani.lab',
    episodes_root: '${BARRO_AI_FACTORY}/takitani.lab/barrotube',
    series_index: '${BARROTUBE_DATA}/workspace/channels/takitani.lab/series/index.json',
    brand: '${BARROSKILLS_HOME}/docs/10-Channels/takitani-lab/index.md',
    character_dna: null,
    character_sheets: [],
    style_guides: {},
    policies: [],
    reference_docs: [
      '${BARROSKILLS_HOME}/docs/10-Channels/takitani-lab/instagram-reels-playbook.md',
      '${BARROSKILLS_HOME}/docs/10-Channels/takitani-lab/episode-backlog.md',
      '${BARROSKILLS_HOME}/docs/10-Channels/takitani-lab/content-calendar.md',
    ],
  };
  m.document = {
    title: 'takitani.lab 영상 제작·관리 설계문서',
    output_path: '${BARRO_AI_FACTORY}/takitani.lab/takitani.lab-영상제작-설계문서.html',
  };
  m.credentials.instagram = { browser_profile_env: 'INSTAGRAM_TAKITANI_LAB_BROWSER_PROFILE' };
  m.migration.sources = ['BarroAiFactory/takitani.lab/barrotube/*', 'docs/10-Channels/takitani-lab/*'];
  m.migration.conflicts = [
    conflict('paths.series_index', '구조화된 시리즈 인덱스가 없어 문서 백로그에서 최초 등록을 검토해야 합니다.'),
    conflict('paths.character_dna', '채널 공통 character DNA 파일이 등록되지 않았습니다.'),
    conflict('platforms.instagram.account_id', '발행 대상 Instagram 계정 ID를 검증해야 합니다.'),
  ];
  return m;
}

const BUILDERS = {
  'econ-daily': econDailyManifest,
  'today.myo': todayMyoManifest,
  'takitani.lab': takitaniManifest,
};

function readTitle(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const topic = text.match(/^topic:\s*["']?(.+?)["']?\s*$/m)?.[1];
    const heading = text.match(/^#\s+(.+)$/m)?.[1];
    return topic || heading || null;
  } catch { return null; }
}

function readFrontmatterValue(path, key) {
  try {
    const text = readFileSync(path, 'utf8');
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm'));
    if (!match) return null;
    return match[1]
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2') || null;
  } catch { return null; }
}

function buildEconSeriesIndex() {
  const root = join(DATA_ROOT, 'workspace', 'channels', 'econ-daily', 'series');
  const series = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(d => {
      const dir = join(root, d.name);
      const episodes = readdirSync(dir)
        .filter(n => /^ep-\d+-brief\.md$/.test(n))
        .sort()
        .map((name, index) => {
          const briefPath = join(dir, name);
          const parsedNumber = Number(/^ep-(\d+)-brief\.md$/.exec(name)?.[1]);
          const episodeNo = Number.isInteger(parsedNumber) && parsedNumber > 0 ? parsedNumber : index + 1;
          const slug = readFrontmatterValue(briefPath, 'slug') || name.replace(/-brief\.md$/, '');
          const format = readFrontmatterValue(briefPath, 'format') || 'long-3min';
          return {
            id: `${d.name}-${String(episodeNo).padStart(2, '0')}`,
            episode_no: episodeNo,
            title: readTitle(briefPath) || slug,
            slug,
            format,
            folder: tokenPath('${BARROTUBE_DATA}', `workspace/channels/econ-daily/series/${d.name}`),
            brief_path: tokenPath('${BARROTUBE_DATA}', `workspace/channels/econ-daily/series/${d.name}/${name}`),
            manual_qa: { checks: [] },
            risk_flags: [],
          };
        });
      return { id: d.name, title: readTitle(join(dir, 'curriculum.md')) || d.name, status: 'needs_review', episodes };
    }) : [];
  return { schema_version: 2, channel_id: 'econ-daily', revision: 1, series };
}

function buildTakitaniSeriesIndex() {
  const root = join(FACTORY_ROOT, 'takitani.lab', 'barrotube');
  const dirs = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !['Image', 'video'].includes(d.name))
    .sort((a, b) => a.name.localeCompare(b.name)) : [];
  const episodes = dirs.map((d, index) => ({
    id: d.name,
    episode_no: index + 1,
    title: d.name.replace(/[_-]+/g, ' '),
    slug: d.name,
    format: 'reels',
    folder: tokenPath('${BARRO_AI_FACTORY}', `takitani.lab/barrotube/${d.name}`),
    manual_qa: { checks: [] },
    risk_flags: ['migration-review'],
  }));
  return {
    schema_version: 2,
    channel_id: 'takitani.lab',
    revision: 1,
    series: [{ id: 'current', title: 'Current productions', status: 'needs_review', episodes }],
  };
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function writeSeriesIndex(path, value, { refresh = false } = {}) {
  if (!existsSync(path)) {
    atomicJson(path, value);
    return { status: 'created', backup_path: null };
  }
  if (!refresh) return { status: 'skipped-existing', backup_path: null };

  let current;
  try { current = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Refusing to refresh invalid series index ${path}: ${error.message}`); }
  if (Number(current.schema_version) !== 2 || current.channel_id !== value.channel_id) {
    throw new Error(`Refusing to refresh non-generated series index: ${path}`);
  }
  if (JSON.stringify(current) === JSON.stringify(value)) {
    return { status: 'unchanged', backup_path: null };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.bak.${stamp}`;
  copyFileSync(path, backupPath);
  atomicJson(path, value);
  return { status: 'refreshed', backup_path: backupPath };
}

async function main() {
  if (values.write && values['dry-run']) throw new Error('Use either --write or --dry-run, not both.');
  if (values['refresh-series'] && !values.write) throw new Error('--refresh-series requires --write.');
  const ids = values.channel === 'all' ? Object.keys(BUILDERS) : [values.channel];
  const unknown = ids.filter(id => !BUILDERS[id]);
  if (unknown.length) throw new Error(`Unknown channel(s): ${unknown.join(', ')}`);

  const manifests = ids.map(id => BUILDERS[id]());
  const report = {
    schema: 'barrotube.channel_migration.v1',
    generated_at: new Date().toISOString(),
    mode: values.write ? 'write' : 'dry-run',
    roots: { data: '${BARROTUBE_DATA}', factory: '${BARRO_AI_FACTORY}', skill: '${BARROSKILLS_HOME}' },
    channels: manifests.map(m => ({
      id: m.id,
      status: m.status,
      conflict_count: m.migration.conflicts.length,
      unresolved_count: m.migration.conflicts.filter(c => !c.resolution).length,
      conflicts: m.migration.conflicts,
    })),
  };

  if (!values.write) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  mkdirSync(CHANNELS_ROOT, { recursive: true });
  const registry = createChannelRegistry({
    channelsRoot: CHANNELS_ROOT,
    skillRoot: SKILL_ROOT,
    dataRoot: DATA_ROOT,
    factoryRoot: FACTORY_ROOT,
    allowedRoots: [DATA_ROOT, FACTORY_ROOT, resolve(SKILL_ROOT, '../../..')],
  });

  // Materialize generated series indexes before registry records so dynamic
  // validation and migration-report counts describe the same final filesystem.
  if (ids.includes('econ-daily')) {
    const p = join(CHANNELS_ROOT, 'econ-daily', 'series', 'index.json');
    report.channels.find(c => c.id === 'econ-daily').series = writeSeriesIndex(
      p,
      buildEconSeriesIndex(),
      { refresh: values['refresh-series'] },
    );
  }
  if (ids.includes('takitani.lab')) {
    const p = join(CHANNELS_ROOT, 'takitani.lab', 'series', 'index.json');
    report.channels.find(c => c.id === 'takitani.lab').series = writeSeriesIndex(
      p,
      buildTakitaniSeriesIndex(),
      { refresh: values['refresh-series'] },
    );
  }

  for (const manifest of manifests) {
    const item = report.channels.find(c => c.id === manifest.id);
    try {
      const existing = await registry.getChannel(manifest.id);
      item.write = 'skipped-existing';
      item.status = existing.status;
      item.conflicts = existing.conflicts;
      item.conflict_count = existing.conflicts.length;
      item.unresolved_count = existing.unresolvedConflicts.length;
    } catch (error) {
      if (error.code !== 'NOT_FOUND') throw error;
      const created = await registry.createChannel(manifest);
      item.write = 'created';
      item.status = created.status;
      item.conflicts = created.conflicts;
      item.conflict_count = created.conflicts.length;
      item.unresolved_count = created.unresolvedConflicts.length;
    }
  }

  const reportPath = resolve(values.report || join(CHANNELS_ROOT, 'migration-report.json'));
  if (!reportPath.startsWith(`${CHANNELS_ROOT}/`)) throw new Error('Report path must stay inside channels root');
  atomicJson(reportPath, report);
  process.stdout.write(`${JSON.stringify({ ok: true, report: reportPath, channels: report.channels }, null, 2)}\n`);
}

main().catch(error => {
  console.error(`channel-migrate: ${error.message}`);
  process.exitCode = 1;
});
