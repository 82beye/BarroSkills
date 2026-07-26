import test from 'node:test';
import assert from 'node:assert/strict';

import { renderChannelDocument } from '../scripts/automation/lib/channel-document.js';

function readSnapshot(html) {
  const match = html.match(/<script id="channel-snapshot" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match, 'redacted snapshot script must exist');
  return JSON.parse(match[1]);
}

function executableScript(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(match => !/application\/json/.test(match[1]));
  assert.equal(scripts.length, 1);
  return scripts[0][2];
}

test('escapes visible values and makes script-breaking input inert', () => {
  const html = renderChannelDocument({
    channel: {
      id: 'today.myo',
      identity: {
        display_name: '오늘묘 <img src=x onerror="alert(1)">',
        description: '고양이 & 사람의 하루',
      },
      purpose: ['</script><script>globalThis.pwned = true</script>'],
    },
    episodes: [{ id: 'EP-1', title: '<svg onload=alert(2)>', current_stage: 'R2' }],
  });

  assert.match(html, /오늘묘 &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /고양이 &amp; 사람의 하루/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<svg onload/);
  assert.doesNotMatch(html, /<\/script><script>globalThis\.pwned/);

  const snapshot = readSnapshot(html);
  assert.equal(snapshot.channel.name, '오늘묘 <img src=x onerror="alert(1)">');
  assert.equal(snapshot.episodes[0].title, '<svg onload=alert(2)>');
});

test('removes credential fields and redacts references, tokens, and absolute paths', () => {
  const html = renderChannelDocument({
    channel: {
      id: 'secure-channel',
      identity: { display_name: 'Secure' },
      project_root: '/Users/beye/private/channel',
      document_output: 'C:\\Users\\beye\\private\\channel.html',
      credential_env: 'YOUTUBE_OAUTH_REFRESH_TOKEN',
      credentials: { youtube: 'TOP_SECRET_VALUE' },
      upload_auth: { token: 'another-secret' },
      apiKey: 'CAMEL_CASE_SECRET',
      youtubeRefreshTokenEnv: 'YOUTUBE_REFRESH_TOKEN',
      notes: 'uses GOOGLE_AI_API_KEY and sk-abcdefghijklmnop at /srv/private/project',
    },
    series: {
      id: 'S1',
      api_key: 'SERIES_API_SECRET',
      source: 'file:///Users/beye/private/series.json',
    },
    episodes: [{
      id: 'EP-1',
      title: 'safe title',
      access_token: 'EPISODE_ACCESS_SECRET',
      provenance: '/private/episode/status.json',
    }],
  });

  for (const forbidden of [
    '/Users/beye/private/channel',
    'C:\\Users\\beye\\private\\channel.html',
    'YOUTUBE_OAUTH_REFRESH_TOKEN',
    'TOP_SECRET_VALUE',
    'another-secret',
    'CAMEL_CASE_SECRET',
    'GOOGLE_AI_API_KEY',
    'sk-abcdefghijklmnop',
    '/srv/private/project',
    'SERIES_API_SECRET',
    'file:///Users/beye/private/series.json',
    'EPISODE_ACCESS_SECRET',
    '/private/episode/status.json',
  ]) assert.equal(html.includes(forbidden), false, `must not expose ${forbidden}`);

  const snapshot = readSnapshot(html);
  assert.equal(Object.hasOwn(snapshot.channel, 'credential_env'), false);
  assert.equal(Object.hasOwn(snapshot.channel, 'credentials'), false);
  assert.equal(Object.hasOwn(snapshot.channel, 'upload_auth'), false);
  assert.equal(Object.hasOwn(snapshot.channel, 'apiKey'), false);
  assert.equal(Object.hasOwn(snapshot.channel, 'youtubeRefreshTokenEnv'), false);
  assert.equal(snapshot.channel.project_root, '[로컬 경로 숨김]');
  assert.equal(snapshot.channel.document_output, '[로컬 경로 숨김]');
  assert.match(snapshot.channel.notes, /\[자격 증명 참조 숨김\]/);
  assert.match(snapshot.channel.notes, /\[토큰 숨김\]/);
  assert.match(snapshot.channel.notes, /\[로컬 경로 숨김\]/);
  assert.equal(Object.hasOwn(snapshot.series, 'api_key'), false);
  assert.equal(snapshot.episodes[0].provenance, '[로컬 경로 숨김]');
});

test('embeds a useful offline snapshot with planned and observed episodes', () => {
  const html = renderChannelDocument({
    channel: {
      id: 'today.myo',
      identity: { display_name: '오늘묘', handle: '@today.myo', language: 'ko' },
      pipeline_profile: 'media-render-r11',
      status: 'active',
      formats: ['reel', 'carousel'],
      cadence: { reel: { target_per_week: 3, days: ['Mon', 'Wed', 'Fri'], time: '18:00' } },
    },
    series: {
      id: 'season-1',
      episodes: [
        { id: 'MYO-001', title: '계획 에피소드', format: 'reel' },
        { id: 'MYO-002', title: '다음 에피소드', format: 'carousel' },
      ],
    },
    episodes: [
      { id: 'MYO-001', title: '관측된 제목', current_stage: 'R8', qa: { verdict: 'PASS' }, status: 'in_progress' },
    ],
  });

  const snapshot = readSnapshot(html);
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.offline, true);
  assert.equal(snapshot.channel.name, '오늘묘');
  assert.equal(snapshot.channel.pipeline_profile, 'media-render-r11');
  assert.equal(snapshot.episodes.length, 2);
  assert.equal(snapshot.episodes.find(ep => ep.id === 'MYO-001').title, '관측된 제목');
  assert.equal(snapshot.episodes.find(ep => ep.id === 'MYO-001').lifecycle_stage, 'qa');
  assert.equal(snapshot.episodes.find(ep => ep.id === 'MYO-002').status, 'planned');
  assert.match(html, /오프라인 스냅샷 · 읽기 전용/);
  assert.match(html, /fetch\('\/api\/channels\/'/);
  assert.match(html, /@media\(max-width:650px\)/);
});

test('correlates planned and observed rows by plan id, slug, and series episode keys', () => {
  const html = renderChannelDocument({
    channel: { id: 'today.myo', identity: { display_name: '오늘묘' } },
    series: {
      schema_version: 2,
      channel_id: 'today.myo',
      revision: 1,
      series: [{
        id: 'season-1',
        title: '시즌 1',
        status: 'active',
        episodes: [
          { id: 'plan-01', episode_no: 1, slug: 'first-eye-contact', title: '첫 만남', format: 'reel' },
          { id: 'plan-02', episode_no: 2, slug: 'way-home', title: '집으로', format: 'reel' },
          { id: 'plan-03', episode_no: 3, slug: 'first-night', title: '첫날 밤', format: 'reel' },
          { id: 'plan-04', episode_no: 4, slug: 'first-purr', title: '첫 골골', format: 'reel' },
        ],
      }],
    },
    episodes: [
      { id: 'BT-EP01', plan_id: 'plan-01', title: '관측 1', source_profile: 'media-render-r11' },
      { id: 'BT-EP02', slug: 'way-home', title: '관측 2', source_profile: 'media-render-r11' },
      { id: 'BT-EP03', series_id: 'season-1', episode_no: 3, title: '관측 3', source_profile: 'media-render-r11' },
      { id: 'BT-EP03-RETRY', series_id: 'season-1', episode_no: 3, title: '재시도', source_profile: 'media-render-r11' },
    ],
  });

  const snapshot = readSnapshot(html);
  assert.equal(snapshot.episodes.length, 5, 'one observed row consumes one plan; retries remain visible');
  assert.equal(snapshot.episodes.filter(ep => ep.id === 'BT-EP01').length, 1);
  assert.equal(snapshot.episodes.filter(ep => ep.id === 'BT-EP02').length, 1);
  assert.equal(snapshot.episodes.filter(ep => ep.id === 'BT-EP03').length, 1);
  assert.equal(snapshot.episodes.filter(ep => ep.id === 'plan-01').length, 0);
  assert.equal(snapshot.episodes.find(ep => ep.id === 'BT-EP01').plan_id, 'plan-01');
  assert.equal(snapshot.episodes.find(ep => ep.id === 'BT-EP02').episode_no, 2);
  assert.equal(snapshot.episodes.find(ep => ep.id === 'plan-04').provenance, 'series-index');

  const executableScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(match => !/application\/json/.test(match[1]));
  for (const script of executableScripts) assert.doesNotThrow(() => new Function(script[2]));
  assert.match(html, /state\.episodes = mergeEpisodeRows\(observed, state\.series\)/);
});

test('legacy series uses an unambiguous episode number when ids differ', () => {
  const snapshot = readSnapshot(renderChannelDocument({
    channel: { id: 'today.myo' },
    series: {
      season: 1,
      generation: 1,
      episodes: [
        { episode_no: 1, slug: 'first-eye-contact', title: '첫 만남', format: 'reel', published: true },
        { episode_no: 2, slug: 'way-home', title: '집으로', format: 'reel' },
      ],
    },
    episodes: [{
      id: 'BT-EP01', episode_no: 1, title: '관측된 첫 만남',
      publish: { published: true }, source_profile: 'media-render-r11',
    }],
  }));

  assert.equal(snapshot.episodes.length, 2);
  assert.equal(snapshot.episodes.filter(ep => ep.published).length, 1);
  assert.equal(snapshot.episodes.find(ep => ep.id === 'BT-EP01').slug, 'first-eye-contact');
});

test('live hydration keeps planned rows while applying observed status', async () => {
  const html = renderChannelDocument({
    channel: { id: 'today.myo', identity: { display_name: '오늘묘' } },
    series: {
      season: 1,
      generation: 1,
      episodes: [
        { episode_no: 1, slug: 'first-eye-contact', title: '첫 만남', format: 'reel' },
        { episode_no: 2, slug: 'way-home', title: '집으로', format: 'reel' },
      ],
    },
    episodes: [{ id: 'BT-EP01', episode_no: 1, slug: 'first-eye-contact', title: '관측 1' }],
  });
  const snapshotText = html.match(/<script id="channel-snapshot" type="application\/json">([\s\S]*?)<\/script>/)[1];

  class FakeNode {
    constructor() {
      this.children = [];
      this.className = '';
      this.hidden = false;
      this.textContent = '';
      this.value = '';
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(node) { this.children.push(node); return node; }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
    addEventListener() {}
  }

  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new FakeNode());
    return nodes.get(id);
  };
  node('channel-snapshot').textContent = snapshotText;
  node('episode-status-filter').value = 'all';
  node('episode-format-filter').value = 'all';
  const document = {
    title: '',
    getElementById: node,
    createElement: () => new FakeNode(),
  };
  const fetch = async url => ({
    ok: true,
    status: 200,
    async json() {
      if (url.endsWith('/episodes')) {
        return {
          episodes: [{
            id: 'BT-EP01', episode_no: 1, slug: 'first-eye-contact',
            title: '관측된 첫 만남', source_profile: 'media-render-r11',
          }],
        };
      }
      return {
        manifest: { id: 'today.myo', identity: { display_name: '오늘묘' } },
        channel: { id: 'today.myo' },
        conflicts: [],
        unresolved: 0,
      };
    },
  });

  new Function('document', 'location', 'fetch', 'URLSearchParams', executableScript(html))(
    document,
    { protocol: 'http:', pathname: '/channels/today.myo', search: '' },
    fetch,
    URLSearchParams,
  );
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(node('kpi-total').textContent, 2);
  assert.equal(node('episode-count').textContent, '2개 표시');
  assert.match(node('connection').textContent, /최신 상태/);
});

test('can mark a server-rendered snapshot as live-capable without changing its data contract', () => {
  const snapshot = readSnapshot(renderChannelDocument({
    channel: { id: 'econ-daily', identity: { display_name: '바로경제' } },
    offline: false,
  }));

  assert.equal(snapshot.offline, false);
  assert.deepEqual(snapshot.episodes, []);
  assert.ok(Array.isArray(snapshot.series));
});

test('accepts registry detail and canonical adapter EpisodeView shapes', () => {
  const snapshot = readSnapshot(renderChannelDocument({
    channel: {
      manifest: {
        id: 'takitani.lab',
        revision: 4,
        status: 'active',
        identity: { display_name: '타키타니 연구소', description: '실험 채널' },
        pipeline: { profile: 'media-render-r11' },
        formats: [{ id: 'reel', enabled: true }],
        paths: { project_root: '/Users/beye/private/takitani.lab' },
        credentials: { instagram: 'INSTAGRAM_ACCESS_TOKEN' },
      },
      context: {
        id: 'takitani.lab',
        cadence: { reel: { target_per_week: 2 } },
        unresolved_conflicts: [],
      },
    },
    episodes: [{
      channel_id: 'takitani.lab',
      id: 'BT-EP01',
      title: '첫 실험',
      format: 'reel',
      native_stage: 'R10',
      lifecycle_stage: 'published',
      artifacts: { images: 6, videos: 6, render: true, platforms: { internal: 'not summarized' } },
      qa: { exists: true, passed: true, status: 'pass' },
      publish: { published: true, video_id: 'public-id' },
      source_profile: 'media-render-r11',
      _root: '/Users/beye/private/takitani.lab/barrotube/ep01',
    }],
  }));

  assert.equal(snapshot.channel.name, '타키타니 연구소');
  assert.equal(snapshot.channel.pipeline_profile, 'media-render-r11');
  assert.deepEqual(snapshot.channel.formats, ['reel']);
  assert.equal(snapshot.channel.paths.project_root, '[로컬 경로 숨김]');
  assert.equal(Object.hasOwn(snapshot.channel.manifest, 'credentials'), false);
  assert.equal(snapshot.episodes[0].published, true);
  assert.equal(snapshot.episodes[0].status, 'published');
  assert.equal(snapshot.episodes[0].assets.images, 6);
  assert.equal(snapshot.episodes[0].assets.render, true);
  assert.equal(snapshot.episodes[0].provenance, 'media-render-r11');
});
