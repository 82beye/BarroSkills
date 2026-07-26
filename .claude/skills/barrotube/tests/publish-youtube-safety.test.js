import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  persistPublishResult,
  publishYouTube,
  releasePublishResultReservation,
  reservePublishResult,
} from '../scripts/automation/publish-youtube.js';

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function setTemporaryEnv(t, entries) {
  const previous = new Map();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('publishYouTube uploads the approved buffer when the source changes during OAuth', async (t) => {
  const directory = temporaryDirectory(t, 'bt-youtube-buffer-');
  const videoPath = join(directory, 'video.mp4');
  const approvedBytes = Buffer.alloc(32, 0x41);
  const expectedUploadedBytes = Buffer.from(approvedBytes);
  const replacementBytes = Buffer.alloc(32, 0x42);
  writeFileSync(videoPath, approvedBytes);

  const credentialEnv = {
    clientIdEnv: 'BT_TEST_YOUTUBE_CLIENT_ID',
    clientSecretEnv: 'BT_TEST_YOUTUBE_CLIENT_SECRET',
    refreshTokenEnv: 'BT_TEST_YOUTUBE_REFRESH_TOKEN',
  };
  setTemporaryEnv(t, {
    BT_TEST_YOUTUBE_CLIENT_ID: 'client-id',
    BT_TEST_YOUTUBE_CLIENT_SECRET: 'client-secret',
    BT_TEST_YOUTUBE_REFRESH_TOKEN: 'refresh-token',
  });

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let uploadedBytes = null;
  let initializedBody = null;
  const meta = { title: 'approved title', shortsTag: false };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      // This is the first awaited operation. Neither filesystem nor caller-owned
      // object changes after this point may alter what gets uploaded.
      writeFileSync(videoPath, replacementBytes);
      approvedBytes.fill(0x43);
      meta.title = 'mutated after approval';
      return new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://www.googleapis.com/youtube/v3/channels?')) {
      return new Response(JSON.stringify({ items: [{ id: 'UC_TEST' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?')) {
      initializedBody = JSON.parse(String(init.body));
      return new Response(null, {
        status: 200,
        headers: { location: 'https://upload.invalid/session' },
      });
    }
    if (url === 'https://upload.invalid/session') {
      uploadedBytes = Buffer.from(init.body);
      return new Response(JSON.stringify({ id: 'uploaded-video-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected network request: ${url}`);
  };

  const result = await publishYouTube({
    videoPath,
    videoBuffer: approvedBytes,
    meta,
    credentialEnv,
    expectedChannelId: 'UC_TEST',
    channelDefaults: { categoryId: '22', privacyStatus: 'private' },
  });

  assert.equal(result.videoId, 'uploaded-video-id');
  assert.deepEqual(uploadedBytes, expectedUploadedBytes);
  assert.notDeepEqual(uploadedBytes, approvedBytes);
  assert.notDeepEqual(uploadedBytes, readFileSync(videoPath));
  assert.equal(initializedBody.snippet.title, 'approved title');
});

test('publish metadata uses channel privacy defaults and fails closed', async () => {
  const base = {
    videoPath: 'fixture.mp4',
    videoBuffer: Buffer.from('approved video'),
    meta: { title: 'metadata defaults', shortsTag: false },
    dryRun: true,
  };

  for (const privacyStatus of ['private', 'unlisted']) {
    const result = await publishYouTube({
      ...base,
      channelDefaults: { categoryId: '22', privacyStatus },
    });
    assert.equal(result.videoBody.status.privacyStatus, privacyStatus);
    assert.equal(result.videoBody.snippet.categoryId, '22');
  }

  const failClosed = await publishYouTube({
    ...base,
    channelDefaults: { categoryId: '24' },
  });
  assert.equal(failClosed.videoBody.status.privacyStatus, 'private');
  assert.equal(failClosed.videoBody.snippet.categoryId, '24');

  await assert.rejects(
    publishYouTube({ ...base, channelDefaults: { privacyStatus: 'private' } }),
    /categoryId is required/,
  );
});

test('publish result reservation is exclusive, rejects published episodes, and cleans up after persistence', async (t) => {
  const directory = temporaryDirectory(t, 'bt-youtube-result-');
  const concurrentPath = join(directory, 'concurrent-result.json');

  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => reservePublishResult(concurrentPath)),
    Promise.resolve().then(() => reservePublishResult(concurrentPath)),
  ]);
  const reservations = attempts.filter(item => item.status === 'fulfilled');
  const rejected = attempts.filter(item => item.status === 'rejected');
  assert.equal(reservations.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already reserved|manual reconciliation/);
  releasePublishResultReservation(reservations[0].value);
  assert.equal(existsSync(`${concurrentPath}.lock`), false);

  const resultPath = join(directory, '80_publish_result.json');
  const reservation = reservePublishResult(resultPath);
  const result = {
    episode_id: 'EP-2026-0001',
    channel_id: 'demo',
    targets: { youtube: { videoId: 'persisted-video-id' } },
  };
  persistPublishResult(reservation, result);
  releasePublishResultReservation(reservation, { uploaded: true, persisted: true });

  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), result);
  assert.equal(existsSync(reservation.lockPath), false);
  assert.throws(
    () => reservePublishResult(resultPath),
    /already published as persisted-video-id/,
  );
});

test('an ambiguous resumable PUT keeps the reconciliation lock', async (t) => {
  const directory = temporaryDirectory(t, 'bt-youtube-ambiguous-');
  const resultPath = join(directory, '80_publish_result.json');
  const reservation = reservePublishResult(resultPath);
  setTemporaryEnv(t, {
    BT_AMBIG_CLIENT_ID: 'client-id',
    BT_AMBIG_CLIENT_SECRET: 'client-secret',
    BT_AMBIG_REFRESH_TOKEN: 'refresh-token',
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
    }
    if (url.includes('/youtube/v3/channels?')) {
      return new Response(JSON.stringify({ items: [{ id: 'UC_TEST' }] }), { status: 200 });
    }
    if (url.includes('/upload/youtube/v3/videos?')) {
      return new Response(null, { status: 200, headers: { location: 'https://upload.invalid/ambiguous' } });
    }
    if (url === 'https://upload.invalid/ambiguous') throw new Error('response lost after PUT started');
    throw new Error(`Unexpected network request: ${url}`);
  };

  let attempted = false;
  await assert.rejects(
    publishYouTube({
      videoPath: join(directory, 'video.mp4'),
      videoBuffer: Buffer.from('approved video'),
      meta: { title: 'ambiguous upload', categoryId: '22', privacyStatus: 'private', shortsTag: false },
      credentialEnv: {
        clientIdEnv: 'BT_AMBIG_CLIENT_ID',
        clientSecretEnv: 'BT_AMBIG_CLIENT_SECRET',
        refreshTokenEnv: 'BT_AMBIG_REFRESH_TOKEN',
      },
      expectedChannelId: 'UC_TEST',
      onUploadAttempt: () => { attempted = true; },
    }),
    /response lost/,
  );
  releasePublishResultReservation(reservation, { uploaded: attempted, persisted: false });
  assert.equal(attempted, true);
  assert.equal(existsSync(reservation.lockPath), true, 'ambiguous upload requires manual reconciliation');
});
