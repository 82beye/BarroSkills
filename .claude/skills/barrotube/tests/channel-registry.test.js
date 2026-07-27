import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stringify as stringifyYaml } from 'yaml';

import {
  ChannelRegistryError,
  createChannelRegistry,
  resolveManifestPaths,
  validateChannelManifest,
  validateSeriesIndex,
} from '../scripts/automation/lib/channel-registry.js';

async function makeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'barrotube-channel-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const skillRoot = path.join(root, 'skill');
  const dataRoot = path.join(root, 'data');
  const factoryRoot = path.join(root, 'factory');
  const homeRoot = path.join(root, 'home');
  const configDir = path.join(skillRoot, 'config');
  const channelsRoot = path.join(dataRoot, 'workspace', 'channels');
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(channelsRoot, { recursive: true }),
    mkdir(factoryRoot, { recursive: true }),
    mkdir(homeRoot, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(path.join(configDir, 'company.json'), JSON.stringify({
      company: { name: 'Global Studio', codename: 'BarroTube' },
      defaults: {
        language: 'ko',
        canvas: { width: 1920, height: 1080, ratio: '16:9' },
      },
      pipeline_stages: { S0: 'brief', S11: 'publish' },
      governance: { board_approval_required: ['S10_publish'] },
    })),
    writeFile(path.join(configDir, 'formats.json'), JSON.stringify({
      formats: [
        {
          id: 'reel',
          duration: { target_seconds: 30, tolerance_seconds: 2 },
          canvas: { width: 1080, height: 1920, ratio: '9:16' },
          default_persona: 'cat-narrator',
        },
        {
          id: 'carousel',
          slide_count: 5,
          canvas: { width: 1080, height: 1350, ratio: '4:5' },
        },
      ],
      channel_format_mapping: {
        'today.myo': {
          enabled_formats: ['reel'],
          weekly_schedule: { reel: { cadence: 'daily', time_kst: '18:00' } },
        },
      },
    })),
    writeFile(path.join(configDir, 'personas.json'), JSON.stringify({
      personas: [
        { id: 'cat-narrator', voice: { speed: 1 }, color: '#f0c' },
        { id: 'barro-alert', voice: { speed: 1.05 }, color: '#f00' },
      ],
    })),
  ]);

  const registry = createChannelRegistry({
    skillRoot,
    dataRoot,
    factoryRoot,
    channelsRoot,
    configDir,
    homeRoot,
    env: {
      HOME: homeRoot,
      BARROTUBE_DATA: dataRoot,
      BARRO_AI_FACTORY: factoryRoot,
    },
    allowedRoots: [skillRoot, dataRoot, factoryRoot, homeRoot],
    lockTimeoutMs: 1_000,
  });

  return {
    root,
    skillRoot,
    dataRoot,
    factoryRoot,
    homeRoot,
    configDir,
    channelsRoot,
    registry,
  };
}

function channelManifest(overrides = {}) {
  return {
    schema_version: 1,
    id: 'today.myo',
    revision: 99,
    status: 'needs_review',
    identity: {
      display_name: '오늘묘',
      language: 'ja',
    },
    platforms: {
      instagram: { enabled: true, account_id: 'today.myo' },
    },
    pipeline: {
      profile: 'media-render-r11',
      supported_actions: ['inspect', 'render'],
    },
    formats: [
      {
        id: 'reel',
        duration: { target_seconds: 35 },
        persona: 'cat-narrator',
      },
    ],
    cadence: {
      reel: { time_kst: '19:30' },
    },
    paths: {
      project_root: '${BARRO_AI_FACTORY}/today.myo',
      episodes_root: 'barrotube',
      series_index: 'series/index.json',
      reference_docs: [
        '${BARROTUBE_DATA}/workspace/reference/channel.md',
        '~/shared/reference.md',
      ],
      style_guides: {
        reel: 'style/reel.md',
      },
    },
    document: {
      output_path: '오늘묘-영상제작-설계문서.html',
    },
    credentials: {
      instagram: {
        access_token_env: 'TODAY_MYO_INSTAGRAM_ACCESS_TOKEN',
      },
    },
    migration: {
      sources: ['legacy-html'],
      provenance: { identity: 'legacy-html#channel-name' },
      conflicts: [],
    },
    ...overrides,
  };
}

test('channel schema accepts dotted/hyphenated ids and rejects traversal or uppercase ids', async () => {
  const valid = await validateChannelManifest(channelManifest({ id: 'cat-lab.v2' }));
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  const identityNameAlias = await validateChannelManifest(channelManifest({
    identity: { name: 'legacy identity alias' },
  }));
  assert.equal(identityNameAlias.valid, true, JSON.stringify(identityNameAlias.errors));

  for (const id of ['../escape', 'Today.Myo', '-leading', 'trailing-', 'a/b']) {
    const result = await validateChannelManifest(channelManifest({ id }));
    assert.equal(result.valid, false, `expected ${id} to fail`);
  }
});

test('series schema accepts canonical v2 and today.myo legacy v1', async () => {
  const canonical = {
    schema_version: 2,
    channel_id: 'today.myo',
    revision: 1,
    series: [{
      id: 'season-1',
      title: '첫 번째 계절',
      status: 'planned',
      season: 1,
      episodes: [{
        id: 'EP-001',
        episode_no: 1,
        title: '첫 만남',
        slug: 'first-meeting',
        format: 'reel',
        folder: 'barrotube/ep01_first-meeting',
        manual_qa: { checks: [false, { id: 'character', passed: false }] },
        risk_flags: [],
      }],
    }],
  };
  const legacy = {
    schema: 'todaymyo.series.index.v1',
    season: 1,
    generation: 1,
    episodes: [{
      episode_no: 1,
      title: '첫 만남',
      slug: 'first-meeting',
      format: 'reel',
      folder: 'barrotube/ep01_first-meeting',
      qa_checks: [false, true],
    }],
  };

  assert.deepEqual(await validateSeriesIndex(canonical), {
    valid: true,
    kind: 'canonical',
    errors: [],
  });
  assert.deepEqual(await validateSeriesIndex(legacy), {
    valid: true,
    kind: 'today.myo-legacy',
    errors: [],
  });
});

test('create/get resolves paths and merges global company, formats, personas, and cadence', async (t) => {
  const fixture = await makeFixture(t);
  await Promise.all([
    mkdir(path.join(fixture.factoryRoot, 'today.myo', 'series'), { recursive: true }),
    mkdir(path.join(fixture.homeRoot, 'shared'), { recursive: true }),
  ]);
  await writeFile(path.join(fixture.factoryRoot, 'today.myo', 'series', 'index.json'), JSON.stringify({
    schema_version: 2,
    channel_id: 'today.myo',
    revision: 1,
    series: [],
  }));

  const created = await fixture.registry.createChannel(channelManifest());
  assert.equal(created.revision, 1, 'registry owns the initial revision');
  assert.equal(created.context.id, 'today.myo');
  assert.equal(created.context.channel_id, 'today.myo');
  assert.equal(created.context.identity.language, 'ja', 'manifest overrides company language');
  assert.equal(created.context.company.name, 'Global Studio');
  assert.equal(created.context.defaults.canvas.width, 1920);
  assert.equal(created.context.pipeline.stages.S0, 'brief');
  assert.equal(created.context.pipeline_profile, 'media-render-r11');
  assert.equal(created.context.formats_by_id.reel.duration.target_seconds, 35);
  assert.equal(created.context.formats_by_id.reel.duration.tolerance_seconds, 2);
  assert.equal(created.context.formats_by_id.reel.canvas.ratio, '9:16');
  assert.equal(created.context.personas_by_id['cat-narrator'].voice.speed, 1);
  assert.deepEqual(created.context.cadence.reel, { cadence: 'daily', time_kst: '19:30' });
  assert.equal(created.context.project_root, path.join(fixture.factoryRoot, 'today.myo'));
  assert.equal(created.context.episodes_root, path.join(fixture.factoryRoot, 'today.myo', 'barrotube'));
  assert.equal(created.context.series_index, path.join(fixture.factoryRoot, 'today.myo', 'series/index.json'));
  assert.equal(
    created.context.reference_docs[0],
    path.join(fixture.dataRoot, 'workspace/reference/channel.md'),
  );
  assert.equal(created.context.reference_docs[1], path.join(fixture.homeRoot, 'shared/reference.md'));
  assert.equal(
    created.context.document_output_path,
    path.join(fixture.factoryRoot, 'today.myo', '오늘묘-영상제작-설계문서.html'),
  );
  assert.deepEqual(created.context.supported_actions, ['inspect', 'render']);
  assert.equal(created.unresolvedConflicts.length, 0);
  assert.equal(created.provenance.migration.identity, 'legacy-html#channel-name');
  assert.equal(created.provenance.fields.formats.length, 2);

  const persisted = await readFile(
    path.join(fixture.channelsRoot, 'today.myo', 'channel.yaml'),
    'utf8',
  );
  assert.match(persisted, /^schema_version:/);
  assert.match(persisted, /id: today\.myo/);
  assert.doesNotMatch(persisted, /^channel:/m, 'canonical writes never persist legacy channel.id');
  assert.match(persisted, /revision: 1/);
  const files = await readdir(path.join(fixture.channelsRoot, 'today.myo'));
  assert.deepEqual(files, ['channel.yaml'], 'atomic temp and lock files are cleaned up');
});

test('create canonicalizes identity.name to identity.display_name', async (t) => {
  const fixture = await makeFixture(t);
  const created = await fixture.registry.createChannel(channelManifest({
    id: 'identity-alias.channel',
    identity: { name: 'Alias Channel', language: 'ko' },
    paths: { project_root: '${CHANNEL_ROOT}' },
  }));
  assert.equal(created.manifest.identity.display_name, 'Alias Channel');
  assert.equal(created.context.identity.name, 'Alias Channel');
  assert.equal(Object.hasOwn(created.manifest.identity, 'name'), false);
});

test('create adopts an existing asset directory, preserves its contents, and rejects a manifest race', async (t) => {
  const fixture = await makeFixture(t);
  const channelDir = path.join(fixture.channelsRoot, 'econ-daily');
  const seriesDir = path.join(channelDir, 'series', 'existing-series');
  await mkdir(seriesDir, { recursive: true });
  await writeFile(path.join(channelDir, 'brand.md'), '# Existing brand\n');
  await writeFile(path.join(seriesDir, 'ep-01.md'), '# Existing episode\n');

  const manifest = channelManifest({
    id: 'econ-daily',
    identity: { display_name: '바로경제', language: 'ko' },
    paths: {
      project_root: '${CHANNEL_ROOT}',
      series_index: 'series/index.json',
    },
  });
  const results = await Promise.allSettled([
    fixture.registry.createChannel(manifest),
    fixture.registry.createChannel(manifest),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'ALREADY_EXISTS');
  assert.equal(await readFile(path.join(channelDir, 'brand.md'), 'utf8'), '# Existing brand\n');
  assert.equal(await readFile(path.join(seriesDir, 'ep-01.md'), 'utf8'), '# Existing episode\n');
  assert.equal((await fixture.registry.getChannel('econ-daily')).revision, 1);
  assert.deepEqual(
    (await readdir(channelDir)).sort(),
    ['brand.md', 'channel.yaml', 'series'],
    'create lock/temp files are removed without touching prior assets',
  );
});

test('unknown path placeholders are returned as unresolved conflicts and block activation', async (t) => {
  const fixture = await makeFixture(t);
  const manifest = channelManifest({
    id: 'unresolved.channel',
    paths: {
      project_root: '${CHANNEL_ROOT}',
      episodes_root: '${NOT_ALLOWED}/episodes',
    },
  });
  const created = await fixture.registry.createChannel(manifest);
  assert.equal(created.unresolvedConflicts.length, 1);
  assert.equal(created.unresolvedConflicts[0].code, 'UNRESOLVED_PATH_VARIABLE');
  assert.equal(created.context.can_activate, false);

  await assert.rejects(
    fixture.registry.activateChannel('unresolved.channel'),
    (error) => error instanceof ChannelRegistryError && error.code === 'UNRESOLVED_CONFLICTS',
  );
});

test('manifest-declared unresolved migration conflicts block activation', async (t) => {
  const fixture = await makeFixture(t);
  const manifest = channelManifest({
    id: 'review.channel',
    paths: { project_root: '${CHANNEL_ROOT}' },
    migration: {
      sources: [],
      provenance: {},
      conflicts: [
        { code: 'SCHEDULE_MISMATCH', field: 'cadence', resolved: false },
        { code: 'NAME_MISMATCH', field: 'identity.name', status: 'resolved' },
        { code: 'VOICE_MISMATCH', field: 'voice', resolution: '운영자 확인: 새 음성 사용' },
      ],
    },
  });
  const created = await fixture.registry.createChannel(manifest);
  assert.equal(created.conflicts.length, 3);
  assert.equal(created.unresolvedConflicts.length, 1);
  await assert.rejects(
    fixture.registry.activateChannel('review.channel'),
    (error) => error.code === 'UNRESOLVED_CONFLICTS',
  );
  await assert.rejects(
    fixture.registry.updateChannel(
      'review.channel',
      { status: 'active' },
      { expectedRevision: 1 },
    ),
    (error) => error.code === 'UNRESOLVED_CONFLICTS',
    'direct updates cannot bypass the activation conflict gate',
  );
  const unchanged = await fixture.registry.getChannel('review.channel');
  assert.equal(unchanged.status, 'needs_review');
  assert.equal(unchanged.revision, 1);
});

test('paths outside allowed roots and symlink escapes are rejected', async (t) => {
  const fixture = await makeFixture(t);
  const outside = path.join(fixture.root, 'outside');
  await mkdir(outside);

  await assert.rejects(
    fixture.registry.createChannel(channelManifest({
      id: 'outside.channel',
      paths: { project_root: outside },
    })),
    (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
  );

  const symlinkPath = path.join(fixture.factoryRoot, 'escape-link');
  await symlink(outside, symlinkPath);
  await assert.rejects(
    fixture.registry.createChannel(channelManifest({
      id: 'symlink.channel',
      paths: { project_root: symlinkPath },
    })),
    (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
  );

  assert.deepEqual(await fixture.registry.listChannels(), []);
});

test('credential environment references are accepted while raw or disguised secrets are rejected', async (t) => {
  const fixture = await makeFixture(t);
  const envReference = await validateChannelManifest(channelManifest());
  assert.equal(envReference.valid, true);

  await assert.rejects(
    fixture.registry.createChannel(channelManifest({
      id: 'raw-secret',
      paths: { project_root: '${CHANNEL_ROOT}' },
      credentials: { youtube: { refresh_token: 'raw-refresh-token-value' } },
    })),
    (error) => error.code === 'SECRET_VALUE_FORBIDDEN',
  );

  await assert.rejects(
    fixture.registry.createChannel(channelManifest({
      id: 'disguised-secret',
      paths: { project_root: '${CHANNEL_ROOT}' },
      metadata: { value: 'sk-1234567890abcdefghijklmnop' },
    })),
    (error) => error.code === 'SECRET_VALUE_FORBIDDEN',
  );
});

test('update performs revision CAS, increments revision, and rejects stale writers', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.registry.createChannel(channelManifest({
    id: 'revision.channel',
    paths: { project_root: '${CHANNEL_ROOT}' },
  }));

  const updated = await fixture.registry.updateChannel(
    'revision.channel',
    { identity: { description: 'new description' } },
    { expectedRevision: 1 },
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.manifest.identity.display_name, '오늘묘');
  assert.equal(updated.manifest.identity.description, 'new description');

  await assert.rejects(
    fixture.registry.updateChannel(
      'revision.channel',
      { identity: { description: 'stale overwrite' } },
      { expectedRevision: 1 },
    ),
    (error) => error.code === 'REVISION_CONFLICT'
      && error.details.actualRevision === 2
      && error.details.expectedRevision === 1,
  );
  assert.equal((await fixture.registry.getChannel('revision.channel')).revision, 2);
});

test('concurrent writers using one revision produce one success and one revision conflict', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.registry.createChannel(channelManifest({
    id: 'concurrent.channel',
    paths: { project_root: '${CHANNEL_ROOT}' },
  }));

  const results = await Promise.allSettled([
    fixture.registry.updateChannel(
      'concurrent.channel',
      { identity: { description: 'writer A' } },
      { expectedRevision: 1 },
    ),
    fixture.registry.updateChannel(
      'concurrent.channel',
      { identity: { description: 'writer B' } },
      { expectedRevision: 1 },
    ),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  assert.equal((await fixture.registry.getChannel('concurrent.channel')).revision, 2);
});

test('activate and archive preserve records; there is deliberately no hard-delete API', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.registry.createChannel(channelManifest({
    id: 'lifecycle.channel',
    paths: { project_root: '${CHANNEL_ROOT}' },
  }));
  const active = await fixture.registry.activateChannel('lifecycle.channel', { expectedRevision: 1 });
  assert.equal(active.status, 'active');
  assert.equal(active.revision, 2);

  const archived = await fixture.registry.archiveChannel('lifecycle.channel', { expectedRevision: 2 });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.revision, 3);
  assert.equal(typeof fixture.registry.delete, 'undefined');
  assert.equal((await fixture.registry.listChannels()).length, 1);
  assert.equal((await fixture.registry.listChannels({ includeArchived: false })).length, 0);
});

test('legacy channel.id manifests load but the next update writes canonical top-level fields', async (t) => {
  const fixture = await makeFixture(t);
  const channelDir = path.join(fixture.channelsRoot, 'legacy.channel');
  await mkdir(channelDir);
  await writeFile(path.join(channelDir, 'channel.yaml'), stringifyYaml({
    channel: {
      id: 'legacy.channel',
      name: 'Legacy Channel',
      language: 'ko',
    },
    status: 'needs_review',
    youtube: {
      channel_id: 'UC_LEGACY',
      default_privacy: 'unlisted',
    },
    formats: ['reel'],
    cadence: {},
    credentials: {
      youtube: { refresh_token_env: 'YOUTUBE_LEGACY_REFRESH_TOKEN' },
    },
  }));

  const loaded = await fixture.registry.getChannel('legacy.channel');
  assert.equal(loaded.provenance.manifest_shape, 'legacy');
  assert.equal(loaded.context.platforms.youtube.channel_id, 'UC_LEGACY');
  assert.equal(loaded.context.project_root, channelDir);

  const updated = await fixture.registry.updateChannel(
    'legacy.channel',
    { identity: { description: 'canonical now' } },
    { expectedRevision: 1 },
  );
  assert.equal(updated.revision, 2);
  const yaml = await readFile(path.join(channelDir, 'channel.yaml'), 'utf8');
  assert.match(yaml, /^schema_version:/);
  assert.match(yaml, /^id: legacy\.channel$/m);
  assert.doesNotMatch(yaml, /^channel:/m);
  assert.equal((await fixture.registry.getChannel('legacy.channel')).provenance.manifest_shape, 'canonical');
});

test('standalone path resolver handles CHANNEL_ROOT, configured roots, relative paths, and ~', async (t) => {
  const fixture = await makeFixture(t);
  const channelRoot = path.join(fixture.channelsRoot, 'paths.channel');
  await mkdir(channelRoot);
  const result = await resolveManifestPaths({
    id: 'paths.channel',
    paths: {
      project_root: '${CHANNEL_ROOT}',
      episodes_root: 'episodes',
      policies: '${BARROTUBE_DATA}/policies',
      character_sheets: ['~/characters/cat.png'],
      reference_docs: ['${BARROSKILLS_HOME}/docs/channel.md'],
    },
    document: { output_path: 'design.html' },
  }, {
    channelRoot,
    dataRoot: fixture.dataRoot,
    factoryRoot: fixture.factoryRoot,
    skillRoot: fixture.skillRoot,
    barroSkillsRoot: fixture.root,
    homeRoot: fixture.homeRoot,
    allowedRoots: [fixture.dataRoot, fixture.factoryRoot, fixture.homeRoot, fixture.root],
    env: { HOME: fixture.homeRoot },
  });

  assert.equal(result.paths.project_root, channelRoot);
  assert.equal(result.paths.episodes_root, path.join(channelRoot, 'episodes'));
  assert.equal(result.paths.policies, path.join(fixture.dataRoot, 'policies'));
  assert.equal(result.paths.character_sheets[0], path.join(fixture.homeRoot, 'characters/cat.png'));
  assert.equal(result.paths.reference_docs[0], path.join(fixture.root, 'docs/channel.md'));
  assert.equal(result.document.output_path, path.join(channelRoot, 'design.html'));
  assert.deepEqual(result.conflicts, []);
});

test('registry defaults data and factory roots under the configured portable home', async (t) => {
  const fixture = await makeFixture(t);
  const registry = createChannelRegistry({
    homeRoot: fixture.homeRoot,
    skillRoot: fixture.skillRoot,
    configDir: fixture.configDir,
  });
  assert.equal(registry.dataRoot, path.join(fixture.homeRoot, 'BarroTubeData'));
  assert.equal(registry.factoryRoot, path.join(fixture.homeRoot, 'BarroAiFactory'));
  assert.equal(
    registry.channelsRoot,
    path.join(fixture.homeRoot, 'BarroTubeData/workspace/channels'),
  );
});

test('activation rejects missing/unknown profiles and series indexes owned by another channel', async (t) => {
  const fixture = await makeFixture(t);
  const unknown = await validateChannelManifest(channelManifest({ pipeline: { profile: 'not-real' } }));
  assert.equal(unknown.valid, false);

  const missing = await fixture.registry.createChannel(channelManifest({
    id: 'missing-profile',
    pipeline: {},
    paths: { project_root: '${CHANNEL_ROOT}' },
  }));
  assert.ok(missing.unresolvedConflicts.some(item => item.code === 'PIPELINE_PROFILE_REQUIRED'));
  await assert.rejects(
    fixture.registry.activateChannel('missing-profile'),
    error => error.code === 'UNRESOLVED_CONFLICTS',
  );

  const channelDir = path.join(fixture.channelsRoot, 'series-owner');
  await mkdir(path.join(channelDir, 'series'), { recursive: true });
  await writeFile(path.join(channelDir, 'series', 'index.json'), JSON.stringify({
    schema_version: 2,
    channel_id: 'another.channel',
    revision: 1,
    series: [],
  }));
  const mismatch = await fixture.registry.createChannel(channelManifest({
    id: 'series-owner',
    paths: { project_root: '${CHANNEL_ROOT}', series_index: 'series/index.json' },
  }));
  assert.ok(mismatch.unresolvedConflicts.some(item => item.code === 'SERIES_CHANNEL_MISMATCH'));
  await assert.rejects(
    fixture.registry.activateChannel('series-owner'),
    error => error.code === 'UNRESOLVED_CONFLICTS',
  );
});

test('secret aliases and nested arrays cannot smuggle raw credential values', async () => {
  for (const payload of [
    { youtubeApiKey: 'plain-secret-value' },
    { servicePassword: 'plain-secret-value' },
    { authToken: 'plain-secret-value' },
    { accessTokenValue: 'plain-secret-value' },
    { apiKey: { value: 'plain-secret-value' } },
    { apiKey: ['plain-secret-value'] },
  ]) {
    const result = await validateChannelManifest(channelManifest({ custom: payload }));
    assert.equal(result.valid, false, JSON.stringify(payload));
    assert.ok(result.errors.some(error => error.keyword === 'noSecrets'));
  }
  const braced = await validateChannelManifest(channelManifest({
    credentials: { youtube: { refresh_token_env: '${YOUTUBE_REFRESH_TOKEN}' } },
  }));
  assert.equal(braced.valid, false, 'canonical credential references are raw env names, not ${...} path syntax');
});

test('malformed placeholders, unsafe document destinations, and stale locks fail closed', async (t) => {
  const fixture = await makeFixture(t);
  const malformed = await fixture.registry.createChannel(channelManifest({
    id: 'malformed-path',
    paths: { project_root: '${CHANNEL_ROOT}', episodes_root: '${lower}/episodes' },
  }));
  assert.ok(malformed.unresolvedConflicts.some(item => item.code === 'UNRESOLVED_PATH_VARIABLE'));

  const collisionDir = path.join(fixture.channelsRoot, 'document-collision');
  await mkdir(collisionDir, { recursive: true });
  await writeFile(path.join(collisionDir, 'source.html'), '<p>source</p>');
  const collision = await fixture.registry.createChannel(channelManifest({
    id: 'document-collision',
    paths: { project_root: '${CHANNEL_ROOT}', reference_docs: ['source.html'] },
    document: { output_path: 'source.html' },
  }));
  assert.equal(collision.context.document_output_safe, false);
  assert.ok(collision.unresolvedConflicts.some(item => item.code === 'DOCUMENT_OUTPUT_COLLISION'));

  const lockTarget = await fixture.registry.createChannel(channelManifest({
    id: 'stale-lock',
    paths: { project_root: '${CHANNEL_ROOT}' },
  }));
  const lockPath = path.join(fixture.channelsRoot, 'stale-lock', '.channel.yaml.lock');
  await writeFile(lockPath, `99999999 2000-01-01T00:00:00.000Z\n`);
  const old = new Date('2000-01-01T00:00:00.000Z');
  const { utimes } = await import('node:fs/promises');
  await utimes(lockPath, old, old);
  fixture.registry.staleLockMs = 1;
  const updated = await fixture.registry.updateChannel(
    'stale-lock',
    { identity: { description: 'recovered' } },
    { expectedRevision: lockTarget.revision },
  );
  assert.equal(updated.manifest.identity.description, 'recovered');

  await writeFile(lockPath, `99999999 2000-01-01T00:00:00.000Z\n`);
  await utimes(lockPath, old, old);
  const contenders = await Promise.allSettled([
    fixture.registry.updateChannel('stale-lock', { cadence: { slot: 'A' } }, { expectedRevision: updated.revision }),
    fixture.registry.updateChannel('stale-lock', { cadence: { slot: 'B' } }, { expectedRevision: updated.revision }),
  ]);
  assert.equal(contenders.filter(item => item.status === 'fulfilled').length, 1);
  const staleLoser = contenders.find(item => item.status === 'rejected');
  assert.equal(staleLoser.reason.code, 'REVISION_CONFLICT');
});
