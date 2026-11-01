import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createServer } from 'node:http';
import {
  adoptUploadReservation,
  persistPublishResult,
  publishYouTube,
  releasePublishResultReservation,
  reservePublishResult,
  saveUploadSession,
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
        headers: { location: 'https://www.googleapis.com/upload/youtube/session-test' },
      });
    }
    if (url === 'https://www.googleapis.com/upload/youtube/session-test') {
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
      return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/ambiguous' } });
    }
    if (url === 'https://www.googleapis.com/upload/youtube/ambiguous') throw new Error('response lost after PUT started');
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

test('a lost PUT response resumes the same saved session from its confirmed offset', async (t) => {
  const directory = temporaryDirectory(t, 'bt-youtube-resume-');
  const reservation = reservePublishResult(join(directory, 'result.json'));
  setTemporaryEnv(t, { BT_RESUME_CLIENT: 'id', BT_RESUME_SECRET: 'secret', BT_RESUME_TOKEN: 'token' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bytes = Buffer.from('abcdefgh');
  let initCount = 0, putCount = 0, probes = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com')) return new Response('{"access_token":"token"}');
    if (url.includes('/youtube/v3/channels?')) return new Response('{"items":[{"id":"UC_TEST"}]}');
    if (url.includes('/upload/youtube/v3/videos?')) {
      initCount++;
      return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/resume-test' } });
    }
    assert.equal(url, 'https://www.googleapis.com/upload/youtube/resume-test');
    assert.equal(init.headers.Authorization, 'Bearer token');
    assert.equal(init.redirect, 'manual');
    if (init.headers['Content-Range'] === 'bytes */8') {
      probes++;
      return new Response(null, { status: 308, headers: { Range: 'bytes=0-3' } });
    }
    putCount++;
    if (putCount === 1) throw new Error('connection dropped');
    assert.deepEqual(Buffer.from(init.body), Buffer.from('efgh'));
    assert.equal(init.headers['Content-Range'], 'bytes 4-7/8');
    return new Response('{"id":"resumed-video"}', { status: 201 });
  };
  const result = await publishYouTube({
    videoPath: 'fixture.mp4', videoBuffer: bytes,
    meta: { title: 'resume', categoryId: '22', privacyStatus: 'private' },
    expectedChannelId: 'UC_TEST', credentialEnv: { clientIdEnv: 'BT_RESUME_CLIENT', clientSecretEnv: 'BT_RESUME_SECRET', refreshTokenEnv: 'BT_RESUME_TOKEN' },
    onUploadSession: (session) => saveUploadSession(reservation, session),
  });
  assert.deepEqual([initCount, putCount, probes], [1, 2, 1]);
  assert.equal(result.videoId, 'resumed-video');
  const saved = JSON.parse(readFileSync(reservation.lockPath, 'utf8'));
  assert.equal(saved.file_size, bytes.length);
  assert.match(saved.video_sha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.channel_id, 'UC_TEST');
});

// 2026-10-22 EP-2026-0251: 스텁 fetch 는 308 을 그냥 돌려줘서 위 테스트가 통과했지만, 실제 Node fetch 는
// redirect:'error' 에서 308(Resume Incomplete)을 "unexpected redirect" 로 던졌다. 세션 요청만
// 로컬 서버로 보내 진짜 fetch 가 308 을 받게 한다.
function sessionServer(t, handler) {
  const server = createServer(handler);
  t.after(() => server.close());
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}/s`)));
}

function stubGoogle(t, localSession, onInit = () => {}) {
  setTemporaryEnv(t, { BT_R308_CLIENT: 'id', BT_R308_SECRET: 'secret', BT_R308_TOKEN: 'token' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com')) return new Response('{"access_token":"token"}');
    if (url.includes('/youtube/v3/channels?')) return new Response('{"items":[{"id":"UC_TEST"}]}');
    if (url.includes('/upload/youtube/v3/videos?')) {
      onInit();
      return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/r308' } });
    }
    assert.equal(url, 'https://www.googleapis.com/upload/youtube/r308');
    return originalFetch(localSession, init);
  };
}

const R308_CREDS = { clientIdEnv: 'BT_R308_CLIENT', clientSecretEnv: 'BT_R308_SECRET', refreshTokenEnv: 'BT_R308_TOKEN' };
const R308_META = { title: 'r308', categoryId: '22', privacyStatus: 'private' };

function readBody(req) {
  return new Promise((done) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => done(Buffer.concat(parts))); });
}

test('a real fetch survives the 308 Resume Incomplete probe and finishes the same session', async (t) => {
  const seen = [];
  const local = await sessionServer(t, async (req, res) => {
    const range = req.headers['content-range'];
    const body = await readBody(req);
    seen.push(range);
    if (range === 'bytes */8') { res.writeHead(308, { Range: 'bytes=0-3' }); return res.end(); }
    if (range === 'bytes 0-7/8') return req.socket.destroy(); // 전송 중 끊김
    assert.equal(range, 'bytes 4-7/8');
    assert.deepEqual(body, Buffer.from('efgh'));
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"id":"r308-video"}');
  });
  stubGoogle(t, local);
  const result = await publishYouTube({
    videoPath: 'fixture.mp4', videoBuffer: Buffer.from('abcdefgh'), meta: R308_META,
    expectedChannelId: 'UC_TEST', credentialEnv: R308_CREDS,
  });
  assert.equal(result.videoId, 'r308-video');
  assert.deepEqual(seen, ['bytes 0-7/8', 'bytes */8', 'bytes 4-7/8']);
});

test('--resume-upload adopts the saved session, probes first, and never opens a new upload', async (t) => {
  const directory = temporaryDirectory(t, 'bt-youtube-adopt-');
  const out = join(directory, 'result.json');
  const bytes = Buffer.from('abcdefgh');
  // 첫 실행이 세션을 저장하고 죽은 상태를 만든다.
  const first = reservePublishResult(out);
  let initCount = 0;
  const local = await sessionServer(t, async (req, res) => {
    const range = req.headers['content-range'];
    const body = await readBody(req);
    if (range === 'bytes */8') { res.writeHead(308, { Range: 'bytes=0-3' }); return res.end(); }
    assert.equal(range, 'bytes 4-7/8');
    assert.deepEqual(body, Buffer.from('efgh'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"adopted-video"}');
  });
  stubGoogle(t, local, () => { initCount++; });
  await assert.rejects(publishYouTube({
    videoPath: 'fixture.mp4', videoBuffer: bytes, meta: R308_META,
    expectedChannelId: 'UC_TEST', credentialEnv: R308_CREDS,
    onUploadSession: (session) => { saveUploadSession(first, session); throw new Error('process died'); },
  }), /process died/);
  const lock = JSON.parse(readFileSync(first.lockPath, 'utf8'));
  writeFileSync(first.lockPath, JSON.stringify({ ...lock, pid: 2 ** 22 + 12345 }));

  // 메타데이터가 바뀌면 이어 올리지 않는다. 실패해도 저장 세션은 남는다.
  const mismatch = adoptUploadReservation(out);
  await assert.rejects(publishYouTube({
    videoPath: 'fixture.mp4', videoBuffer: bytes, meta: { ...R308_META, title: 'changed' },
    expectedChannelId: 'UC_TEST', credentialEnv: R308_CREDS, resumeSession: mismatch.session,
  }), /does not match/);
  releasePublishResultReservation(mismatch, { uploaded: false, persisted: false });
  assert.equal(existsSync(first.lockPath), true, 'a failed resume keeps the saved session');

  const adopted = adoptUploadReservation(out);
  const result = await publishYouTube({
    videoPath: 'fixture.mp4', videoBuffer: bytes, meta: R308_META,
    expectedChannelId: 'UC_TEST', credentialEnv: R308_CREDS, resumeSession: adopted.session,
  });
  assert.equal(result.videoId, 'adopted-video');
  assert.equal(initCount, 1, 'resume must not initialize a second upload');
  persistPublishResult(adopted, { targets: { youtube: result } });
  releasePublishResultReservation(adopted, { uploaded: true, persisted: true });
  assert.equal(existsSync(first.lockPath), false);
  assert.throws(() => adoptUploadReservation(out), /already published as adopted-video/);
});

test('--resume-upload refuses a lock held by a live process', (t) => {
  const directory = temporaryDirectory(t, 'bt-youtube-adopt-live-');
  const out = join(directory, 'result.json');
  writeFileSync(`${out}.lock`, JSON.stringify({ pid: process.ppid, upload_url: 'https://www.googleapis.com/upload/youtube/x',
    file_size: 8, video_sha256: 'a', metadata_sha256: 'b', channel_id: 'UC_TEST' }));
  assert.throws(() => adoptUploadReservation(out), /live pid/);
});

test('--resume-upload lets only one of two concurrent processes adopt a dead owner session', async (t) => {
  const { spawn, spawnSync } = await import('node:child_process');
  const directory = temporaryDirectory(t, 'bt-youtube-adopt-race-');
  const out = join(directory, 'result.json');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(`${out}.lock`, JSON.stringify({ pid: deadPid, upload_url: 'https://www.googleapis.com/upload/youtube/x',
    file_size: 8, video_sha256: 'a', metadata_sha256: 'b', channel_id: 'UC_TEST' }));
  const moduleUrl = new URL('../scripts/automation/publish-youtube.js', import.meta.url).href;
  // 인계에 성공한 쪽은 부모가 stdin 을 닫을 때까지 살아 있는다(첫 재개가 아직 업로드 중인 상황).
  const script = `import(${JSON.stringify(moduleUrl)}).then((m) => {
    try { m.adoptUploadReservation(${JSON.stringify(out)}); console.log('ok'); }
    catch (error) { console.log('refused ' + error.message); }
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
  });`;
  const run = () => new Promise((resolveLine) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) resolveLine({ child, line: buffer.trim() });
    });
  });
  const results = await Promise.all([run(), run()]);
  for (const { child } of results) child.stdin.end();
  const lines = results.map((r) => r.line);
  assert.equal(lines.filter((line) => line === 'ok').length, 1, lines.join(' | '));
  assert.match(lines.find((line) => line !== 'ok'), /^refused .*(live pid|already being resumed|changed owner)/);
  const lock = JSON.parse(readFileSync(`${out}.lock`, 'utf8'));
  assert.ok(results.some((r) => r.child.pid === lock.pid), 'the lock names the winning process');
  assert.equal(lock.adopted_from_pid, deadPid);
});
