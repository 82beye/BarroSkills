import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { createBoardServer, executeActionSpec, listenBoardServer } from '../tools/board/server.js';
import { sha256File } from '../scripts/automation/lib/publish-approval.js';

const CHANNEL_ID = 'board-test';
const EPISODE_ID = 'EP-2026-0001';
const SESSION_TOKEN = 'board-test-session-token';

async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

function responseRecord(projectRoot, overrides = {}) {
  const status = overrides.status || 'needs_review';
  const manifest = {
    schema_version: 1,
    id: CHANNEL_ID,
    revision: 7,
    status,
    identity: { display_name: 'Board Test', language: 'ko' },
    pipeline: { profile: 'barrotube-s12' },
    formats: { enabled: ['shorts'], default: 'shorts' },
    paths: {
      project_root: projectRoot,
      episodes_root: join(projectRoot, 'workspace', 'episodes'),
    },
    migration: { conflicts: [] },
  };

  return {
    id: CHANNEL_ID,
    revision: manifest.revision,
    status,
    manifest,
    context: {
      ...manifest,
      channel_id: CHANNEL_ID,
      project_root: projectRoot,
      episodes_root: manifest.paths.episodes_root,
      pipeline_profile: 'barrotube-s12',
      format_ids: ['shorts'],
    },
    conflicts: [],
    unresolvedConflicts: [],
    provenance: { identity: 'memory:test' },
  };
}

async function fixture(t, options = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'barrotube-channel-board-'));
  if (options.setup) {
    await options.setup(projectRoot);
  } else {
    await put(
      join(projectRoot, 'workspace', 'episodes', EPISODE_ID, '00_brief.md'),
      [
        '---',
        `channel_id: ${CHANNEL_ID}`,
        'format: shorts',
        'topic: 보드 테스트 에피소드',
        '---',
      ].join('\n'),
    );
  }

  let record = options.recordFactory
    ? options.recordFactory(projectRoot)
    : responseRecord(projectRoot);
  const calls = {
    create: [],
    update: [],
    activate: [],
    execute: [],
  };
  const registry = {
    channelsRoot: '/memory/channels',
    async listChannels() {
      return [record];
    },
    async getChannel(id) {
      assert.equal(id, CHANNEL_ID);
      return record;
    },
    async createChannel(manifest) {
      calls.create.push(manifest);
      return record;
    },
    async updateChannel(id, patch, options) {
      calls.update.push({ id, patch, options });
      record = {
        ...record,
        revision: options.expectedRevision + 1,
        manifest: {
          ...record.manifest,
          ...patch,
          revision: options.expectedRevision + 1,
        },
      };
      return record;
    },
    async activateChannel(id, options) {
      calls.activate.push({ id, options });
      return record;
    },
  };

  // createBoardServer's configured port is used only for Origin validation. The
  // listener itself uses port 0 so the OS allocates an isolated loopback port.
  const app = createBoardServer({
    port: 8933,
    token: SESSION_TOKEN,
    registry,
    async executeAction(spec) {
      calls.execute.push(spec);
      return executeActionSpec(spec);
    },
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    app.server.once('error', onError);
    app.server.listen(0, '127.0.0.1', () => {
      app.server.off('error', onError);
      resolve();
    });
  });
  const address = app.server.address();
  assert(address && typeof address === 'object');

  t.after(async () => {
    await new Promise((resolve, reject) => {
      app.server.close((error) => error ? reject(error) : resolve());
      app.server.closeAllConnections();
    });
    await rm(projectRoot, { recursive: true, force: true });
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    projectRoot,
  };
}

async function readJson(response) {
  return { response, body: await response.json() };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function boardClientContext() {
  const html = await readFile(new URL('../tools/board/index.html', import.meta.url), 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert(match, 'board client script must exist');
  const source = match[1].replace(/bindEvents\(\);\s*loadAll\(\);\s*$/, '');
  const context = {
    document: {
      querySelector() { return null; },
    },
    URLSearchParams,
  };
  runInNewContext(source, context);
  return { context, html };
}

test('board uses a compact channel selector and modal-only registration/settings', async () => {
  const { html } = await boardClientContext();
  assert.match(html, /<select id="channelSelect"/);
  assert.match(html, /<dialog id="newDialog"/);
  assert.match(html, /<dialog id="settingsDialog"/);
  assert.match(html, /<dialog id="assetDialog" class="asset-dialog"/);
  assert.match(html, /id="assetTabs"[^>]*role="tablist"/);
  assert.match(html, /id="assetPanel"[^>]*role="tabpanel"/);
  assert.match(html, /<video[^>]*controls[^>]*playsinline/);
  assert.match(html, /<audio[^>]*controls/);
  assert.match(html, /<tbody id="episodes"/);
  assert.match(html, /id="episodeCards" class="episode-cards"/);
  assert.match(html, /<th scope="colgroup" colspan="4" class="generation-head">영상 생성<\/th>/);
  assert.match(html, /@media \(max-width: 1024px\)/);
  assert.doesNotMatch(html, /id="cards"/);
  assert.doesNotMatch(html, /class="ep-tools"/);
  assert.match(html, /requestAnimationFrame\(function \(\) \{[\s\S]*replacement\.focus\(\)/);
});

test('asset modal merges related groups and builds a profile/platform-bound preview URL', async () => {
  const { context } = await boardClientContext();
  assert.deepEqual(
    Array.from(context.ASSET_TABS, tab => tab.id),
    ['script', 'images', 'videos', 'audio', 'distribution', 'documents'],
  );
  const data = {
    groups: {
      script: [{ rel: '30_script.md', name: '30_script.md', size: 10, type: 'text/markdown' }],
      images: [{ rel: '40_assets/images/scene.png', name: 'scene.png', size: 20, type: 'image/png' }],
      cards: [{ rel: '47_thumbnail.png', name: '47_thumbnail.png', size: 30, type: 'image/png' }],
      videos: [{ rel: '40_assets/videos/clip.mp4', name: 'clip.mp4', size: 40, type: 'video/mp4' }],
      render: [{ rel: '55_render/video.mp4', name: 'video.mp4', size: 50, type: 'video/mp4' }],
    },
  };

  assert.deepEqual(
    Array.from(context.assetFilesForTab(data, 'images'), file => `${file.asset_group}:${file.rel}`),
    ['images:40_assets/images/scene.png', 'cards:47_thumbnail.png'],
  );
  assert.deepEqual(
    Array.from(context.assetFilesForTab(data, 'videos'), file => `${file.asset_group}:${file.rel}`),
    ['render:55_render/video.mp4', 'videos:40_assets/videos/clip.mp4'],
  );

  const url = new URL(context.assetFileUrl(data.groups.render[0], {
    context: {
      channelId: 'today.myo',
      episodeId: 'EP-2026-0068',
      sourceProfile: 'barrotube-s12',
      platform: 'shorts',
    },
  }), 'http://127.0.0.1');
  assert.equal(url.pathname, '/api/channels/today.myo/asset/file');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    episode_id: 'EP-2026-0068',
    source_profile: 'barrotube-s12',
    path: '55_render/video.mp4',
    platform: 'shorts',
  });
});

test('episode UI groups one logical id into one row and preserves profile variants', async () => {
  const { context } = await boardClientContext();
  const groups = context.groupEpisodes([
    {
      id: 'BT-SHARED',
      title: 'R11 variant',
      source_profile: 'media-render-r11',
      lifecycle_stage: 'render',
      supported_actions: ['status'],
    },
    {
      id: 'BT-SHARED',
      title: 'C4 variant',
      source_profile: 'carousel-c4',
      lifecycle_stage: 'approval',
      supported_actions: ['qa'],
    },
    {
      id: 'BT-DUPLICATE',
      source_profile: 'media-render-r11',
      supported_actions: ['status'],
    },
    {
      id: 'BT-DUPLICATE',
      source_profile: 'media-render-r11',
      supported_actions: ['sync'],
    },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    Array.from(groups[0].variants, (episode) => episode.source_profile),
    ['media-render-r11', 'carousel-c4'],
  );
  assert.deepEqual(Array.from(groups[1].duplicateProfiles), ['media-render-r11']);

  const sharedRow = context.episodeRowHtml(groups[0], 0);
  const duplicateRow = context.episodeRowHtml(groups[1], 1);
  assert.equal((sharedRow.match(/<tr\b/g) || []).length, 1);
  assert.match(sharedRow, /data-role="profile"/);
  assert.match(sharedRow, /media-render-r11/);
  assert.match(sharedRow, /carousel-c4/);
  context.VARIANT_BY_EPISODE['BT-SHARED'] = 'carousel-c4';
  assert.equal(context.selectedVariant(groups[0]).source_profile, 'carousel-c4');
  assert.match(context.episodeRowHtml(groups[0], 0), /<option value="qa">qa<\/option>/);
  assert.equal((duplicateRow.match(/<tr\b/g) || []).length, 1);
  assert.match(duplicateRow, /동일 파이프라인 중복 · 실행 차단/);
  assert.match(duplicateRow, / disabled/);
});

test('reference-style episode rows show partial stages, carousel N/A, and disable plan-only work', async () => {
  const { context } = await boardClientContext();
  const [partial, carousel, planned] = context.groupEpisodes([
    {
      id: 'BT-EP04', episode_no: 4, weekday: '목', title: '마음의 빗장 풀림', format: 'reel',
      source_profile: 'media-render-r11', observed: true, assets_available: true,
      supported_actions: ['status'], artifacts: { script: true, images: 0, videos: 6, render: true },
      planned_counts: { cuts: 7, images: 6, videos: 6 },
      planned_stages: { script: true, image: false, video: false, render: true },
      qa_check_count: 7, qa_checked_count: 0,
    },
    {
      id: 'BT-EP07', episode_no: 7, weekday: '일', title: '우리가 만난 일주일', format: 'carousel',
      source_profile: 'carousel-c4', observed: true, assets_available: true,
      supported_actions: ['qa'], artifacts: { script: true, images: 5, render: true },
      planned_counts: { cuts: 5, slides: 5 },
      planned_stages: { script: true, image: true },
      qa_check_count: 5, qa_checked_count: 0,
    },
    {
      id: 'PLAN-008', episode_no: 8, weekday: '월', title: '거울 속 저 녀석', format: 'reel',
      source_profile: 'media-render-r11', observed: false, assets_available: false,
      supported_actions: [], artifacts: { script: false, images: 0, videos: 0, render: false },
      planned_counts: { cuts: 0, images: 0, videos: 0 },
      planned_stages: { script: false, image: false, video: false, render: false },
      qa_check_count: 7, qa_checked_count: 0,
    },
  ]);

  const partialRow = context.episodeRowHtml(partial, 0);
  assert.match(partialRow, /Day 4 · 목/);
  assert.match(partialRow, /이미지 6\/7/);
  assert.match(partialRow, /영상 6\/7/);
  assert.match(partialRow, /렌더 ✓/);
  assert.match(partialRow, />제작중<\/span>/);

  const carouselRow = context.episodeRowHtml(carousel, 1);
  assert.equal((carouselRow.match(/class="stage-chip na"/g) || []).length, 2);
  assert.match(carouselRow, /이미지 5\/5/);

  const plannedRow = context.episodeRowHtml(planned, 2);
  assert.equal((plannedRow.match(/<tr\b/g) || []).length, 1);
  assert.match(plannedRow, /class="planned-row"/);
  assert.match(plannedRow, /실측 후 실행 가능/);
  assert.equal((plannedRow.match(/ disabled/g) || []).length, 4);
  assert.match(context.episodeCardHtml(planned, 2), /<article class="episode-card planned-row"/);
});

test('settings modal keeps manifest conflict indexes stable and runtime conflicts read-only', async () => {
  const { context } = await boardClientContext();
  const manifest = {
    migration: {
      conflicts: [
        { field: 'first', resolution: 'already resolved' },
        { field: 'second', resolution: null },
      ],
    },
  };
  const detail = {
    conflicts: [
      { field: 'first', resolution: 'already resolved' },
      { field: 'second', resolution: null },
      { code: 'RUNTIME_ONLY', field: 'paths.project_root', message: 'runtime conflict' },
    ],
    unresolved_conflicts: [
      { field: 'second', resolution: null },
      { code: 'RUNTIME_ONLY', field: 'paths.project_root', message: 'runtime conflict' },
    ],
  };
  const entries = context.conflictEntries(manifest, detail);
  assert.deepEqual(Array.from(entries, (entry) => entry.manifestIndex), [0, 1, null]);

  const box = { innerHTML: '' };
  context.document.getElementById = () => box;
  context.renderConflicts(entries);
  assert.match(box.innerHTML, /data-manifest-resolution="0"/);
  assert.match(box.innerHTML, /data-manifest-resolution="1"/);
  assert.doesNotMatch(box.innerHTML, /data-manifest-resolution="2"/);
  assert.match(box.innerHTML, /자동 진단 충돌입니다/);
});

test('default board listener selects another loopback port when the preferred port is occupied', async (t) => {
  const blocker = createHttpServer((_req, res) => res.end('occupied'));
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const occupied = blocker.address();
  assert(occupied && typeof occupied === 'object');

  const app = createBoardServer({ port: occupied.port, token: SESSION_TOKEN });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(blocker);
  });

  const binding = await listenBoardServer(app, { autoPort: true, maxAttempts: 20 });
  assert.equal(binding.requested_port, occupied.port);
  assert.equal(binding.fallback_used, true);
  assert(binding.port > occupied.port);

  const response = await fetch(`http://127.0.0.1:${binding.port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /BarroTube Channel Board/);
});

test('an explicitly requested occupied port rejects cleanly', async (t) => {
  const blocker = createHttpServer((_req, res) => res.end('occupied'));
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const occupied = blocker.address();
  assert(occupied && typeof occupied === 'object');
  t.after(() => closeServer(blocker));

  const app = createBoardServer({ port: occupied.port, token: SESSION_TOKEN });
  await assert.rejects(
    listenBoardServer(app, { autoPort: false }),
    (error) => error.code === 'EADDRINUSE' && error.port === occupied.port,
  );
});

test('board HTML injects its per-session mutation token', async (t) => {
  const { baseUrl } = await fixture(t);
  const response = await fetch(`${baseUrl}/`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    body,
    new RegExp(`<meta name="barrotube-board-token" content="${SESSION_TOKEN}">`),
  );
});

test('mutation without the session token is rejected before registry access', async (t) => {
  const { baseUrl, calls } = await fixture(t);
  const { response, body } = await readJson(await fetch(`${baseUrl}/api/channels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { id: 'should-not-be-created' } }),
  }));

  assert.equal(response.status, 403);
  assert.equal(body.code, 'INVALID_BOARD_TOKEN');
  assert.equal(calls.create.length, 0);
});

test('non-loopback Host is rejected to prevent DNS-rebinding access', async (t) => {
  const { baseUrl } = await fixture(t);
  const target = new URL('/api/channels', baseUrl);
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { Host: 'attacker.example' },
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'INVALID_HOST');
});

test('channel list, detail, and episodes expose stable response envelopes', async (t) => {
  const { baseUrl } = await fixture(t);
  const list = await readJson(await fetch(`${baseUrl}/api/channels`));
  const detail = await readJson(await fetch(`${baseUrl}/api/channels/${CHANNEL_ID}`));
  const episodes = await readJson(await fetch(`${baseUrl}/api/channels/${CHANNEL_ID}/episodes`));

  assert.equal(list.response.status, 200);
  assert.equal(list.body.channels_root, '/memory/channels');
  assert.equal(list.body.channels.length, 1);
  assert.deepEqual(
    {
      id: list.body.channels[0].id,
      status: list.body.channels[0].status,
      episode_count: list.body.channels[0].episode_count,
      published_count: list.body.channels[0].published_count,
    },
    { id: CHANNEL_ID, status: 'needs_review', episode_count: 1, published_count: 0 },
  );

  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.channel.id, CHANNEL_ID);
  assert.equal(detail.body.manifest.revision, 7);
  assert.deepEqual(detail.body.conflicts, []);
  assert.equal(detail.body.unresolved, 0);

  assert.equal(episodes.response.status, 200);
  assert.equal(episodes.body.channel_id, CHANNEL_ID);
  assert.equal(episodes.body.episodes.length, 1);
  assert.deepEqual(
    {
      id: episodes.body.episodes[0].id,
      title: episodes.body.episodes[0].title,
      source_profile: episodes.body.episodes[0].source_profile,
    },
    {
      id: EPISODE_ID,
      title: '보드 테스트 에피소드',
      source_profile: 'barrotube-s12',
    },
  );
});

test('episodes keep observed-only compatibility while board rows include planned episodes', async (t) => {
  const seriesPath = (projectRoot) => join(projectRoot, 'series', 'index.json');
  const { baseUrl, calls } = await fixture(t, {
    async setup(projectRoot) {
      await put(
        join(projectRoot, 'workspace', 'episodes', EPISODE_ID, '00_brief.md'),
        [
          '---',
          `channel_id: ${CHANNEL_ID}`,
          'format: shorts',
          'topic: 관측된 에피소드',
          '---',
        ].join('\n'),
      );
      await put(seriesPath(projectRoot), JSON.stringify({
        schema_version: 2,
        channel_id: CHANNEL_ID,
        series: [{
          id: 'season-1',
          title: '시즌 1',
          episodes: [
            {
              id: EPISODE_ID,
              episode_no: 1,
              title: '계획과 연결된 에피소드',
              slug: 'observed-episode',
              format: 'shorts',
              weekday: '월',
              arc_beat: '관측 병합',
            },
            {
              id: 'PLAN-002',
              episode_no: 2,
              title: '아직 제작하지 않은 에피소드',
              slug: 'planned-only',
              format: 'shorts',
              weekday: '화',
              arc_beat: '계획 전용',
              stages: { script: false, image: false, video: false, render: false },
            },
          ],
        }],
      }, null, 2));
    },
    recordFactory(projectRoot) {
      const record = responseRecord(projectRoot);
      const path = seriesPath(projectRoot);
      record.manifest.paths.series_index = path;
      record.context.paths = { ...record.context.paths, series_index: path };
      record.context.series_index = path;
      return record;
    },
  });

  const list = await readJson(await fetch(`${baseUrl}/api/channels`));
  const response = await readJson(await fetch(`${baseUrl}/api/channels/${CHANNEL_ID}/episodes`));

  assert.equal(response.response.status, 200);
  assert.deepEqual(
    {
      observed_count: response.body.observed_count,
      planned_count: response.body.planned_count,
      unobserved_count: response.body.unobserved_count,
      episodes: response.body.episodes.length,
      board_episodes: response.body.board_episodes.length,
    },
    {
      observed_count: 1,
      planned_count: 2,
      unobserved_count: 1,
      episodes: 1,
      board_episodes: 2,
    },
  );

  assert.equal(response.body.episodes[0].id, EPISODE_ID);
  assert.equal(response.body.episodes[0].title, '관측된 에피소드');
  assert.equal(response.body.episodes[0].observed, undefined);
  assert.equal(response.body.episodes.some(episode => episode.id === 'PLAN-002'), false);

  const observed = response.body.board_episodes.find(episode => episode.id === EPISODE_ID);
  const plannedOnly = response.body.board_episodes.find(episode => episode.id === 'PLAN-002');
  assert.ok(observed);
  assert.deepEqual(
    {
      observed: observed.observed,
      assets_available: observed.assets_available,
      arc_beat: observed.arc_beat,
    },
    { observed: true, assets_available: true, arc_beat: '관측 병합' },
  );
  assert.ok(observed.supported_actions.length > 0);

  assert.ok(plannedOnly);
  assert.deepEqual(
    {
      observed: plannedOnly.observed,
      assets_available: plannedOnly.assets_available,
      supported_actions: plannedOnly.supported_actions,
      layout: plannedOnly.artifacts.layout,
    },
    {
      observed: false,
      assets_available: false,
      supported_actions: [],
      layout: 'planned',
    },
  );

  assert.deepEqual(
    {
      episode_count: list.body.channels[0].episode_count,
      board_episode_count: list.body.channels[0].board_episode_count,
      planned_count: list.body.channels[0].planned_count,
      unobserved_count: list.body.channels[0].unobserved_count,
    },
    {
      episode_count: 1,
      board_episode_count: 2,
      planned_count: 2,
      unobserved_count: 1,
    },
  );

  const plannedQuery = new URLSearchParams({
    episode_id: 'PLAN-002',
    source_profile: 'barrotube-s12',
  });
  const plannedAssets = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/assets?${plannedQuery}`,
  ));
  const plannedFile = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/asset/file?${new URLSearchParams({
      ...Object.fromEntries(plannedQuery),
      path: '00_brief.md',
    })}`,
  ));
  const plannedAction = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/actions/status`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-barrotube-token': SESSION_TOKEN,
      },
      body: JSON.stringify({
        episode_id: 'PLAN-002',
        source_profile: 'barrotube-s12',
        dry_run: false,
      }),
    },
  ));

  for (const blocked of [plannedAssets, plannedFile, plannedAction]) {
    assert.equal(blocked.response.status, 404);
    assert.equal(blocked.body.code, 'EPISODE_NOT_FOUND');
  }
  assert.equal(calls.execute.length, 0);
});

test('asset preview serves only listed files with seek-safe ranges and HEAD metadata', async (t) => {
  const { baseUrl, projectRoot } = await fixture(t);
  const episodeRoot = join(projectRoot, 'workspace', 'episodes', EPISODE_ID);
  await put(join(episodeRoot, 'private_bak.json'), '{"secret":true}');
  await put(join(episodeRoot, 'private_backup.json'), '{"secret":true}');
  const baseQuery = {
    episode_id: EPISODE_ID,
    source_profile: 'barrotube-s12',
    platform: '(v1-flat)',
  };
  const query = new URLSearchParams(baseQuery);
  const listed = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/assets?${query}`,
  ));

  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.source_profile, 'barrotube-s12');
  assert.equal(listed.body.platform, '(v1-flat)');
  assert.equal(listed.body.root, undefined);
  assert(listed.body.groups.script.some(file => file.rel === '00_brief.md'));
  assert(!Object.values(listed.body.groups).flat().some(file => file.rel === 'private_bak.json'));
  assert(!Object.values(listed.body.groups).flat().some(file => file.rel === 'private_backup.json'));

  const missingPlatform = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/assets?${new URLSearchParams({
      episode_id: EPISODE_ID,
      source_profile: 'barrotube-s12',
    })}`,
  ));
  assert.equal(missingPlatform.response.status, 400);
  assert.equal(missingPlatform.body.code, 'ASSET_PLATFORM_REQUIRED');

  const body = await readFile(join(episodeRoot, '00_brief.md'), 'utf8');
  const fileQuery = new URLSearchParams({ ...baseQuery, path: '00_brief.md' });
  const fileUrl = `${baseUrl}/api/channels/${CHANNEL_ID}/asset/file?${fileQuery}`;
  const complete = await fetch(fileUrl);
  assert.equal(complete.status, 200);
  assert.equal(complete.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(complete.headers.get('cache-control'), 'no-store');
  assert.equal(await complete.text(), body);

  const initial = await fetch(fileUrl, { headers: { range: 'bytes=0-4' } });
  assert.equal(initial.status, 206);
  assert.equal(initial.headers.get('content-range'), `bytes 0-4/${Buffer.byteLength(body)}`);
  assert.equal(await initial.text(), Buffer.from(body).subarray(0, 5).toString());

  const suffix = await fetch(fileUrl, { headers: { range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), Buffer.from(body).subarray(-4).toString());

  const head = await fetch(fileUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(body));
  assert.equal(await head.text(), '');

  const unsupportedRange = await fetch(fileUrl, { headers: { range: 'bytes=0-1,3-4' } });
  assert.equal(unsupportedRange.status, 416);
  assert.equal(unsupportedRange.headers.get('content-range'), `bytes */${Buffer.byteLength(body)}`);

  const hiddenQuery = new URLSearchParams({ ...baseQuery, path: 'private_bak.json' });
  const hidden = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/asset/file?${hiddenQuery}`,
  ));
  assert.equal(hidden.response.status, 400);
  assert.equal(hidden.body.code, 'INVALID_ASSET_PATH');

  const invalidPlatform = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/assets?${new URLSearchParams({
      ...baseQuery,
      platform: 'shorts',
    })}`,
  ));
  assert.equal(invalidPlatform.response.status, 400);
  assert.equal(invalidPlatform.body.code, 'INVALID_PLATFORM');
});

test('raw command endpoint stays removed even for an authorized session', async (t) => {
  const { baseUrl } = await fixture(t);
  const { response, body } = await readJson(await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-barrotube-token': SESSION_TOKEN,
    },
    body: JSON.stringify({ command: 'anything', args: ['--unsafe'] }),
  }));

  assert.equal(response.status, 410);
  assert.equal(body.code, 'RAW_RUN_REMOVED');
});

test('PUT forwards the client revision as an optimistic concurrency precondition', async (t) => {
  const { baseUrl, calls } = await fixture(t);
  const manifest = {
    schema_version: 1,
    id: CHANNEL_ID,
    revision: 7,
    status: 'needs_review',
    identity: { display_name: '수정된 채널 이름' },
  };
  const { response, body } = await readJson(await fetch(`${baseUrl}/api/channels/${CHANNEL_ID}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-barrotube-token': SESSION_TOKEN,
    },
    body: JSON.stringify({ manifest, expected_revision: 7 }),
  }));

  assert.equal(response.status, 200);
  assert.equal(calls.update.length, 1);
  assert.deepEqual(calls.update[0], {
    id: CHANNEL_ID,
    patch: manifest,
    options: { expectedRevision: 7 },
  });
  assert.equal(body.manifest.revision, 8);
});

test('production action is blocked while its channel still needs review', async (t) => {
  const { baseUrl } = await fixture(t);
  const { response, body } = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/actions/script`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-barrotube-token': SESSION_TOKEN,
      },
      body: JSON.stringify({ episode_id: EPISODE_ID, dry_run: true }),
    },
  ));

  assert.equal(response.status, 409);
  assert.equal(body.code, 'CHANNEL_NOT_ACTIVE');
});

test('multi-profile dry-runs select the requested R11 or C4 script and root', async (t) => {
  const sharedEpisode = 'BT-SHARED';
  const { baseUrl } = await fixture(t, {
    async setup(projectRoot) {
      await put(
        join(projectRoot, 'barrotube', 'reel-root', 'render-job.json'),
        JSON.stringify({ schema: 'barrotube.render_job.v1', episode: sharedEpisode }),
      );
      await put(join(projectRoot, 'barrotube', 'reel-root', 'script.md'), '# reel');
      await put(
        join(projectRoot, 'daily', 'carousel-root', 'carousel-job.json'),
        JSON.stringify({ schema: 'barrotube.carousel_job.v1', episode: sharedEpisode }),
      );
      await put(join(projectRoot, 'daily', 'carousel-root', 'script.md'), '# carousel');
    },
    recordFactory(projectRoot) {
      const base = responseRecord(projectRoot, { status: 'active' });
      const pipeline = { profile: 'media-render-r11', additional_profiles: ['carousel-c4'] };
      return {
        ...base,
        manifest: {
          ...base.manifest,
          pipeline,
          paths: { project_root: projectRoot },
        },
        context: {
          ...base.context,
          pipeline,
          pipeline_profile: 'media-render-r11',
          project_root: projectRoot,
          paths: { project_root: projectRoot },
        },
      };
    },
  });
  const post = async body => readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/actions/sync`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-barrotube-token': SESSION_TOKEN,
      },
      body: JSON.stringify({ episode_id: sharedEpisode, dry_run: true, ...body }),
    },
  ));

  const ambiguous = await post({});
  assert.equal(ambiguous.response.status, 409);
  assert.equal(ambiguous.body.code, 'AMBIGUOUS_EPISODE');

  const reel = await post({ source_profile: 'media-render-r11' });
  assert.equal(reel.response.status, 200);
  assert.equal(reel.body.command.script, 'render_reel_job.py');
  assert.deepEqual(reel.body.command.args, ['sync', '<resolved:reel-root>']);

  const carousel = await post({ source_profile: 'carousel-c4' });
  assert.equal(carousel.response.status, 200);
  assert.equal(carousel.body.command.script, 'carousel_job.py');
  assert.deepEqual(carousel.body.command.args, ['sync', '<resolved:carousel-root>', '--json']);
});

test('S12 publish dry-run binds every channel and episode identity argument', async (t) => {
  const { baseUrl } = await fixture(t, {
    async setup(projectRoot) {
      const episodeRoot = join(projectRoot, 'workspace', 'episodes', EPISODE_ID);
      const platformRoot = join(episodeRoot, 'platforms', 'long');
      const video = join(platformRoot, '55_render', 'video.mp4');
      const meta = join(platformRoot, '70_publish_meta.json');
      const qa = join(platformRoot, '60_qa_report.md');
      const approval = join(platformRoot, '75_board_approval.json');
      await put(join(episodeRoot, '00_brief.md'), [
        '---',
        `channel_id: ${CHANNEL_ID}`,
        'format: long',
        'topic: 게시 인자 테스트',
        '---',
      ].join('\n'));
      await put(video, 'approved-video');
      await put(meta, JSON.stringify({ channel_id: CHANNEL_ID, title: '게시 인자 테스트', categoryId: '22' }));
      await put(qa, [
        '# QA Report',
        `**Video SHA-256**: \`${sha256File(video)}\``,
        '**Risk**: `LOW`',
        '',
        '## Verdict',
        '**PASS** (risk: LOW)',
        '',
      ].join('\n'));
      await put(approval, JSON.stringify({
        approved: true,
        channel_id: CHANNEL_ID,
        episode_id: EPISODE_ID,
        channel_revision: 7,
        youtube_channel_id: 'UC_BOARD_TEST',
        effective_upload: { privacyStatus: 'private', categoryId: '22', publishAt: null },
        platform: 'long',
        layout: 'v2',
        video_sha256: sha256File(video),
        metadata_sha256: sha256File(meta),
        qa_sha256: sha256File(qa),
        thumbnail_sha256: null,
      }));
    },
    recordFactory(projectRoot) {
      const base = responseRecord(projectRoot, { status: 'active' });
      return {
        ...base,
        manifest: {
          ...base.manifest,
          platforms: {
            youtube: {
              enabled: true,
              channel_id: 'UC_BOARD_TEST',
              default_privacy: 'private',
              category_id: '22',
            },
          },
          credentials: {
            youtube: {
              client_id_env: 'BOARD_TEST_YOUTUBE_CLIENT_ID',
              client_secret_env: 'BOARD_TEST_YOUTUBE_CLIENT_SECRET',
              refresh_token_env: 'BOARD_TEST_YOUTUBE_REFRESH_TOKEN',
            },
          },
        },
      };
    },
  });

  const { response, body } = await readJson(await fetch(
    `${baseUrl}/api/channels/${CHANNEL_ID}/actions/publish`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-barrotube-token': SESSION_TOKEN,
      },
      body: JSON.stringify({
        episode_id: EPISODE_ID,
        source_profile: 'barrotube-s12',
        platform: 'long',
        dry_run: true,
        confirm: 'PUBLISH',
      }),
    },
  ));

  assert.equal(response.status, 200, body.error);
  assert.equal(body.command.script, 'publish-youtube.js');
  const args = body.command.args;
  const valueAfter = flag => args[args.indexOf(flag) + 1];
  for (const flag of [
    '--channel', '--episode-id', '--platform', '--layout', '--episode-root', '--out',
  ]) assert.notEqual(args.indexOf(flag), -1, `${flag} must be present`);
  assert.equal(valueAfter('--channel'), CHANNEL_ID);
  assert.equal(valueAfter('--episode-id'), EPISODE_ID);
  assert.equal(valueAfter('--platform'), 'long');
  assert.equal(valueAfter('--layout'), 'v2');
  assert.equal(valueAfter('--episode-root'), `<resolved:${EPISODE_ID}>`);
  assert.equal(valueAfter('--out'), '<resolved:80_publish_result.json>');
});

test('action timeout terminates descendants that ignore SIGTERM', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'barrotube-process-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeat = join(root, 'heartbeat.txt');
  const grandchild = join(root, 'grandchild.mjs');
  const wrapper = join(root, 'wrapper.mjs');
  await writeFile(grandchild, [
    "import { appendFileSync } from 'node:fs';",
    'const heartbeat = process.argv[2];',
    "process.on('SIGTERM', () => {});",
    "setInterval(() => appendFileSync(heartbeat, '.'), 25);",
  ].join('\n'));
  await writeFile(wrapper, [
    "import { spawn } from 'node:child_process';",
    'spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: \'ignore\' });',
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  const result = await executeActionSpec({
    executable: process.execPath,
    args: [wrapper, grandchild, heartbeat],
    cwd: root,
  }, { timeoutMs: 350, killDelayMs: 150, outputLimit: 1024 });
  assert.equal(result.timed_out, true);
  await new Promise(resolve => setTimeout(resolve, 400));
  const stoppedSize = (await readFile(heartbeat, 'utf8')).length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await readFile(heartbeat, 'utf8')).length, stoppedSize);
});
