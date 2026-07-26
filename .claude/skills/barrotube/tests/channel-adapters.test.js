import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';

import {
  listChannelAssets,
  resolveEpisodeRoot,
  resolveSafeAssetPath,
  scanChannelEpisodes,
} from '../scripts/automation/lib/channel-adapters.js';

const temporaryRoots = [];

function temporaryProject() {
  const root = mkdtempSync(join(tmpdir(), 'barrotube-channel-adapter-'));
  temporaryRoots.push(root);
  return root;
}

function put(root, relativePath, contents = '') {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return path;
}

function s12Context(root) {
  return {
    id: 'econ-daily',
    project_root: root,
    pipeline: { profile: 'barrotube-s12' },
  };
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

test('barrotube-s12 handles flat/v2 layouts, missing status, all publish schemas, and channel filtering', () => {
  const root = temporaryProject();
  const episodes = join(root, 'workspace', 'episodes');
  put(root, 'series/index.json', {
    schema_version: 2,
    channel_id: 'econ-daily',
    revision: 1,
    series: [{
      id: 'rates-basics',
      title: '금리 기초',
      status: 'active',
      episodes: [{
        id: 'rates-basics-01', episode_no: 1, title: '첫 번째 경제 영상',
        slug: 'base-rate', format: 'shorts', folder: 'series/rates-basics',
        manual_qa: { checks: [] }, risk_flags: [],
      }],
    }],
  });

  put(episodes, 'EP-2026-0001/00_brief.md', [
    '---', 'channel_id: econ-daily', 'series_id: rates-basics', 'series_episode: 1',
    'format: shorts', 'topic: 첫 번째 경제 영상', '---',
  ].join('\n'));
  put(episodes, 'EP-2026-0001/.episode_status.json', { current_stage: 'S3', channel_id: 'econ-daily' });
  put(episodes, 'EP-2026-0001/30_script.md', '# script');
  put(episodes, 'EP-2026-0001/40_assets/images/scene_001.png', 'png');
  put(episodes, 'EP-2026-0001/55_render/video.mp4', 'mp4');
  put(episodes, 'EP-2026-0001/60_qa_report.md', '## Verdict\n**PASS**');
  put(episodes, 'EP-2026-0001/70_publish_meta.json', {});
  put(episodes, 'EP-2026-0001/75_board_approval.json', { approved: true });
  put(episodes, 'EP-2026-0001/80_publish_result.json', {
    targets: { youtube: { videoId: 'schemaA', url: 'https://youtu.be/schemaA' } },
  });

  // v2, no .episode_status.json. Root-level script is shared by its platform.
  put(episodes, 'EP-2026-0002/00_brief.md', [
    '---', 'channel_id: econ-daily', 'format: shorts', 'topic: 두 번째 경제 영상', '---',
  ].join('\n'));
  put(episodes, 'EP-2026-0002/30_script.md', '# shared script');
  put(episodes, 'EP-2026-0002/platforms/shorts/55_render/video.mp4', 'mp4');
  put(episodes, 'EP-2026-0002/platforms/long/55_render/video.mp4', 'long');
  put(episodes, 'EP-2026-0002/platforms/reels/55_render/video.mp4', 'distribution-only');
  put(episodes, 'EP-2026-0002/platforms/tiktok/55_render/video.mp4', 'distribution-only');
  put(episodes, 'EP-2026-0002/platforms/shorts/80_publish_result.json', {
    targets: { youtube: { video_id: 'schemaB' } },
  });

  put(episodes, 'EP-2026-0003/00_brief.md', [
    '---', 'channel_id: econ-daily', 'format: long-3min', 'topic: 세 번째 경제 영상', '---',
  ].join('\n'));
  put(episodes, 'EP-2026-0003/80_publish_result.json', {
    status: 'scheduled', videoId: 'schemaC', privacyStatus: 'private',
  });

  // Brief provenance wins a conflicting status channel and excludes this episode.
  put(episodes, 'EP-2026-0004/00_brief.md', [
    '---', 'channel_id: another-channel', 'topic: 다른 채널 영상', '---',
  ].join('\n'));
  put(episodes, 'EP-2026-0004/.episode_status.json', {
    current_stage: 'S11', channel_id: 'econ-daily', video_id: 'wrong-channel',
  });

  // A reported S11 without a publish identifier/result must not override disk truth.
  put(episodes, 'EP-2026-0005/00_brief.md', [
    '---', 'channel_id: econ-daily', 'topic: 아직 기획만', '---',
  ].join('\n'));
  put(episodes, 'EP-2026-0005/.episode_status.json', {
    current_stage: 'S11', status: 'completed', channel_id: 'econ-daily',
  });

  const result = scanChannelEpisodes(s12Context(root));
  assert.deepEqual(result.map(episode => episode.id), [
    'EP-2026-0005', 'EP-2026-0003', 'EP-2026-0002', 'EP-2026-0001',
  ]);

  const flat = result.find(episode => episode.id === 'EP-2026-0001');
  assert.equal(flat.artifacts.layout, 'v1');
  assert.equal(flat.native_stage, 'S11');
  assert.equal(flat.lifecycle_stage, 'published');
  assert.equal(flat.publish.video_id, 'schemaA');
  assert.equal(flat.qa.passed, true);
  assert.equal(flat.series_id, 'rates-basics');
  assert.equal(flat.episode_no, 1);
  assert.equal(flat.plan_id, 'rates-basics-01');
  assert.equal(flat.slug, 'base-rate');

  const v2 = result.find(episode => episode.id === 'EP-2026-0002');
  assert.equal(v2.artifacts.layout, 'v2');
  assert.equal(v2.artifacts.platforms.shorts.script, true);
  assert.deepEqual(Object.keys(v2.artifacts.platforms).sort(), ['long', 'shorts']);
  assert.equal(
    resolveEpisodeRoot(s12Context(root), 'EP-2026-0002', 'reels', 'barrotube-s12'),
    null,
  );
  assert.equal(
    resolveEpisodeRoot(s12Context(root), 'EP-2026-0002', 'tiktok', 'barrotube-s12'),
    null,
  );
  assert.equal(v2.publish.video_id, 'schemaB');
  assert.equal(v2.lifecycle_stage, 'published');

  const rootSchema = result.find(episode => episode.id === 'EP-2026-0003');
  assert.equal(rootSchema.publish.video_id, 'schemaC');
  assert.equal(rootSchema.publish.privacy, 'private');

  const stale = result.find(episode => episode.id === 'EP-2026-0005');
  assert.equal(stale.native_stage, 'S0');
  assert.equal(stale.lifecycle_stage, 'planned');
  assert.equal(stale.publish.published, false);
});

test('one channel context combines media-render-r11 reels and carousel-c4 jobs', () => {
  const root = temporaryProject();
  put(root, 'series/index.json', {
    episodes: [
      { episode_no: 1, episode_id: 'BT-EP01', title: '운명의 첫 눈맞춤', format: 'reel', folder: 'barrotube/ep01-first' },
      { episode_no: 2, episode_id: 'BT-EP02', title: '상태만 앞선 영상', format: 'reel', folder: 'barrotube/ep02-stale' },
      { episode_no: 7, episode_id: 'BT-EP07', title: '우리가 만난 일주일', format: 'carousel', folder: 'daily/first-week' },
    ],
  });

  put(root, 'barrotube/ep01-first/render-job.json', {
    schema: 'barrotube.render_job.v1', episode: 'BT-EP01', updated_at: '2026-07-15T01:00:00+09:00',
    stages: [{ stage: 'R10', status: 'completed' }],
  });
  put(root, 'barrotube/ep01-first/script.md', '# fallback title');
  put(root, 'barrotube/ep01-first/Image/cut1.png', 'png');
  put(root, 'barrotube/ep01-first/video/cut1.mp4', 'clip');
  put(root, 'barrotube/ep01-first/56_capcut_export/video.mp4', 'master');
  put(root, 'barrotube/ep01-first/60_qa_report.media.json', { ok: true });
  put(root, 'barrotube/ep01-first/70_publish_meta.instagram.json', { channel_id: 'today.myo', format: 'reels' });
  put(root, 'barrotube/ep01-first/80_publish_result.instagram.json', {
    schema: 'barrotube.publish_result.instagram.v1', published: true,
    permalink: 'https://instagram.example/p/one',
  });

  // The job says R10, but no corresponding milestone exists on disk.
  put(root, 'barrotube/ep02-stale/render-job.json', {
    schema: 'barrotube.render_job.v1', episode: 'BT-EP02',
    stages: [{ stage: 'R10', status: 'completed' }],
  });
  put(root, 'barrotube/ep02-stale/script.md', '# 상태만 앞선 영상');

  put(root, 'daily/first-week/carousel-job.json', {
    schema: 'barrotube.carousel_job.v1', episode: 'BT-EP07',
    title: 'EP07 · 우리가 만난 일주일', stage_status: { C4: 'hitl' },
  });
  put(root, 'daily/first-week/script.md', '# 캐러셀');
  put(root, 'daily/first-week/slides/slide-1.png', 'png');
  put(root, 'daily/first-week/60_qa_report.carousel.json', { ok: true });
  put(root, 'daily/first-week/70_publish_meta.instagram.json', {
    publish: { status: 'ready', requires_human_approval: true },
  });

  const context = {
    id: 'today.myo',
    project_root: root,
    pipeline: { profile: 'media-render-r11', additional_profiles: ['carousel-c4'] },
  };
  const result = scanChannelEpisodes(context);
  assert.equal(result.length, 3);

  const reel = result.find(episode => episode.id === 'BT-EP01');
  assert.equal(reel.title, '운명의 첫 눈맞춤');
  assert.equal(reel.native_stage, 'R10');
  assert.equal(reel.lifecycle_stage, 'published');
  assert.equal(reel.publish.url, 'https://instagram.example/p/one');
  assert.equal(reel.episode_no, 1);
  assert.equal(reel.plan_id, 'BT-EP01');
  assert.deepEqual(reel.supported_actions, ['status', 'sync', 'autopilot']);

  const stale = result.find(episode => episode.id === 'BT-EP02');
  assert.equal(stale.native_stage, 'R1');
  assert.equal(stale.lifecycle_stage, 'script');

  const carousel = result.find(episode => episode.id === 'BT-EP07');
  assert.equal(carousel.format, 'carousel');
  assert.equal(carousel.native_stage, 'C4');
  assert.equal(carousel.lifecycle_stage, 'approval');
  assert.equal(carousel.qa.passed, true);
  assert.equal(carousel.episode_no, 7);
  assert.equal(carousel.plan_id, 'BT-EP07');
  assert.deepEqual(carousel.supported_actions, ['sync', 'build', 'qa', 'meta', 'autopilot']);

  const assets = listChannelAssets(context, 'BT-EP01');
  assert.equal(assets.source_profile, 'media-render-r11');
  assert.equal(assets.groups.render.some(item => item.rel === '56_capcut_export/video.mp4'), true);
});

test('canonical series entries are flattened and correlated by tokenized folder paths', () => {
  const root = temporaryProject();
  put(root, 'series/index.json', {
    schema_version: 2,
    channel_id: 'takitani.lab',
    revision: 1,
    series: [{
      id: 'current',
      title: '현재 제작',
      status: 'needs_review',
      episodes: [{
        id: 'school-guardian', episode_no: 5, title: '교권 보호관',
        slug: 'school-guardian', format: 'reels',
        folder: '${BARRO_AI_FACTORY}/takitani.lab/barrotube/ep04_school_guardian_reel',
        manual_qa: { checks: [] }, risk_flags: [],
      }],
    }],
  });
  put(root, 'barrotube/ep04_school_guardian_reel/render-job.json', {
    schema: 'barrotube.render_job.v1', episode: 'BT-EP04',
  });
  put(root, 'barrotube/ep04_school_guardian_reel/script.md', '# 교권 보호관');

  const [episode] = scanChannelEpisodes({
    id: 'takitani.lab',
    project_root: root,
    pipeline: { profile: 'media-render-r11' },
  });

  assert.equal(episode.id, 'BT-EP04');
  assert.equal(episode.series_id, 'current');
  assert.equal(episode.episode_no, 5);
  assert.equal(episode.plan_id, 'school-guardian');
  assert.equal(episode.slug, 'school-guardian');
});

test('duplicate R11/C4 episode ids require source_profile for roots and assets', () => {
  const root = temporaryProject();
  const episodeId = 'BT-SHARED';
  const reelRoot = join(root, 'barrotube', 'reel-root');
  const carouselRoot = join(root, 'daily', 'carousel-root');

  put(root, 'barrotube/reel-root/render-job.json', {
    schema: 'barrotube.render_job.v1', episode: episodeId,
  });
  const reelAsset = put(root, 'barrotube/reel-root/Image/reel.png', 'reel');
  put(root, 'daily/carousel-root/carousel-job.json', {
    schema: 'barrotube.carousel_job.v1', episode: episodeId, title: '같은 ID 캐러셀',
  });
  const carouselAsset = put(root, 'daily/carousel-root/slides/card.png', 'carousel');

  const context = {
    id: 'today.myo',
    project_root: root,
    pipeline: { profile: 'media-render-r11', additional_profiles: ['carousel-c4'] },
  };
  const matches = scanChannelEpisodes(context).filter(episode => episode.id === episodeId);
  assert.deepEqual(matches.map(episode => episode.source_profile).sort(), [
    'carousel-c4',
    'media-render-r11',
  ]);

  assert.equal(resolveEpisodeRoot(context, episodeId), null);
  assert.equal(listChannelAssets(context, episodeId), null);
  assert.equal(resolveSafeAssetPath(context, episodeId, 'Image/reel.png'), null);

  assert.equal(
    resolveEpisodeRoot(context, episodeId, null, 'media-render-r11'),
    realpathSync(reelRoot),
  );
  assert.equal(
    resolveEpisodeRoot(context, episodeId, null, 'carousel-c4'),
    realpathSync(carouselRoot),
  );
  assert.equal(
    resolveSafeAssetPath(context, episodeId, 'Image/reel.png', null, 'media-render-r11'),
    realpathSync(reelAsset),
  );
  assert.equal(
    resolveSafeAssetPath(context, episodeId, 'slides/card.png', null, 'carousel-c4'),
    realpathSync(carouselAsset),
  );
  assert.equal(
    resolveSafeAssetPath(context, episodeId, 'Image/reel.png', null, 'carousel-c4'),
    null,
  );

  const reelAssets = listChannelAssets(context, episodeId, null, 'media-render-r11');
  const carouselAssets = listChannelAssets(context, episodeId, null, 'carousel-c4');
  assert.equal(reelAssets.source_profile, 'media-render-r11');
  assert.equal(reelAssets.groups.images.some(asset => asset.rel === 'Image/reel.png'), true);
  assert.equal(carouselAssets.source_profile, 'carousel-c4');
  assert.equal(carouselAssets.groups.images.some(asset => asset.rel === 'slides/card.png'), true);
});

test('asset helpers enforce realpath containment, extension allowlist, and platform boundaries', () => {
  const root = temporaryProject();
  const episodes = join(root, 'workspace', 'episodes');
  put(episodes, 'EP-2026-0010/00_brief.md', [
    '---', 'channel_id: econ-daily', 'format: shorts', 'topic: 안전한 자산', '---',
  ].join('\n'));
  const safe = put(episodes, 'EP-2026-0010/platforms/shorts/40_assets/images/scene.png', 'png');
  put(episodes, 'EP-2026-0010/platforms/shorts/55_render/video.mp4', 'shorts video');
  put(episodes, 'EP-2026-0010/platforms/shorts/40_assets/images/scene_backup.png', 'old png');
  put(episodes, 'EP-2026-0010/platforms/shorts/private.sh', 'echo no');
  const privateJson = put(episodes, 'EP-2026-0010/platforms/shorts/private.json', '{"private":true}');
  const otherPlatform = put(episodes, 'EP-2026-0010/platforms/long/40_assets/images/other.png', 'png');
  put(episodes, 'EP-2026-0010/55_render/video.mp4', 'legacy root video');
  put(episodes, 'EP-2026-0010/distribution/reels/video.mp4', 'distributed video');
  const legacyReels = put(episodes, 'EP-2026-0010/platforms/reels/video_vertical.mp4', 'legacy reels video');
  const outside = put(root, 'outside/secret.txt', 'secret');
  symlinkSync(outside, join(episodes, 'EP-2026-0010/platforms/shorts/escaped.txt'));
  symlinkSync(privateJson, join(episodes, 'EP-2026-0010/platforms/shorts/cover.png'));
  symlinkSync(otherPlatform, join(episodes, 'EP-2026-0010/platforms/shorts/cross-platform.png'));

  const context = s12Context(root);
  assert.equal(
    resolveEpisodeRoot(context, 'EP-2026-0010', 'shorts'),
    realpathSync(join(episodes, 'EP-2026-0010/platforms/shorts')),
  );
  assert.equal(
    resolveSafeAssetPath(context, 'EP-2026-0010', 'platforms/shorts/40_assets/images/scene.png', 'shorts'),
    realpathSync(safe),
  );
  assert.equal(resolveSafeAssetPath(context, 'EP-2026-0010', '../../outside/secret.txt'), null);
  assert.equal(resolveSafeAssetPath(context, 'EP-2026-0010', outside), null);
  assert.equal(resolveSafeAssetPath(context, 'EP-2026-0010', 'platforms/shorts/private.sh'), null);
  assert.equal(resolveSafeAssetPath(context, 'EP-2026-0010', 'platforms/shorts/escaped.txt'), null);
  assert.equal(
    resolveSafeAssetPath(context, 'EP-2026-0010', 'platforms/reels/video_vertical.mp4', 'shorts'),
    realpathSync(legacyReels),
  );
  assert.equal(resolveSafeAssetPath(context, 'EP-2026-0010', 'platforms/shorts/cover.png', 'shorts'), null);
  assert.equal(resolveSafeAssetPath(context, 'EP-2026-0010', 'platforms/shorts/cross-platform.png', 'shorts'), null);
  assert.equal(
    resolveSafeAssetPath(context, 'EP-2026-0010', 'platforms/long/40_assets/images/other.png', 'shorts'),
    null,
  );

  const assets = listChannelAssets(context, 'EP-2026-0010', 'shorts');
  const listed = Object.values(assets.groups).flat().map(item => item.rel);
  assert.equal(listed.includes('platforms/shorts/40_assets/images/scene.png'), true);
  assert.equal(listed.includes('platforms/shorts/40_assets/images/scene_backup.png'), false);
  assert.equal(listed.includes('platforms/long/40_assets/images/other.png'), false);
  assert.equal(listed.includes('platforms/shorts/private.sh'), false);
  assert.equal(listed.includes('platforms/shorts/escaped.txt'), false);
  assert.equal(listed.includes('platforms/shorts/cover.png'), false);
  assert.equal(listed.includes('platforms/shorts/cross-platform.png'), false);
  assert.equal(assets.groups.render.some(item => item.rel === 'platforms/shorts/55_render/video.mp4'), true);
  assert.equal(assets.groups.render.some(item => item.rel === '55_render/video.mp4'), false);
  assert.deepEqual(
    assets.groups.distribution.map(item => item.rel),
    ['55_render/video.mp4', 'distribution/reels/video.mp4', 'platforms/reels/video_vertical.mp4'],
  );
});
