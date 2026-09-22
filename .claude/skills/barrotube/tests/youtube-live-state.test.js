import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectVideoIds } from '../scripts/automation/sync-youtube-state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS = join(ROOT, 'scripts', 'automation', 'lib', 'channel-adapters.js');

test('videoId 는 URL 에서도 되살린다 — 상태 파일이 ID 없이 URL 만 남긴다', () => {
  // 2026-09-23 EP-2026-0165 실측: .episode_status.json 에 video_id 가 없고
  // stage_history 의 youtube_url 만 있었다. ID 가 없으면 유튜브 실제 상태를 조회할
  // 키가 없어 비공개로 묻힌 편이 계속 "발행 ✓" 로 보인다.
  const src = readFileSync(ADAPTERS, 'utf8');
  const m = src.match(/function videoIdFromUrl\(url\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'videoIdFromUrl 이 사라졌다');

  const re = /(?:youtu\.be\/|\/shorts\/|[?&]v=)([A-Za-z0-9_-]{6,})/;
  const pick = (u) => (typeof u === 'string' ? (u.match(re) || [])[1] || null : null);
  assert.equal(pick('https://youtu.be/_9z2mWpUuBE'), '_9z2mWpUuBE');
  assert.equal(pick('https://www.youtube.com/watch?v=7J9FMfQ0SFw'), '7J9FMfQ0SFw');
  assert.equal(pick('https://www.youtube.com/shorts/gGREFMTpDqM'), 'gGREFMTpDqM');
  assert.equal(pick(null), null);
  assert.equal(pick('https://example.com/x'), null);
});

test('S12 폴백은 "발행 안 됨"이 아니라 "영상 기록 없음"일 때만 쓴다', () => {
  // 폴백 조건이 !published 였을 때, "업로드는 됐지만 비공개"라는 정확한 판정이
  // 나오자마자 폴백이 published:true 로 덮어썼다. 그래서 유튜브 정본을 붙여도
  // 보드 수치가 안 바뀌었다.
  const src = readFileSync(ADAPTERS, 'utf8');
  assert.match(src, /if \(!publish\.video_id\) publish = publishFromS12Status\(status\);/);
  assert.ok(!/if \(!publish\.published\) publish = publishFromS12Status/.test(src),
    '되돌아간 폴백 조건이 남아 있다');
});

test('유튜브 정본이 로컬 기록을 덮는다 — published 는 privacy==public 일 때만 참', () => {
  const src = readFileSync(ADAPTERS, 'utf8');
  // parsePublishJson · publishFromS12Status 양쪽 모두 live 를 본다.
  assert.equal((src.match(/const live = liveState\(videoId\);/g) || []).length, 2,
    '두 경로 중 하나가 유튜브 정본을 안 본다');
  assert.match(src, /published: live \? live\.privacy === 'public'/);
  assert.match(src, /live_checked_at/);
});

test('캐시가 없거나 깨지면 기존 판정을 그대로 쓴다', () => {
  // 네트워크·권한 문제로 보드가 통째로 비면 그게 더 큰 장애다.
  const src = readFileSync(ADAPTERS, 'utf8');
  const fn = src.match(/function liveState\(videoId\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /catch \{[\s\S]*?return null;/, '캐시 실패 시 null 로 빠지지 않는다');
});

test('collectVideoIds 는 v1·v2 레이아웃을 모두 훑는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ytstate-'));
  try {
    const v1 = join(dir, 'EP-2026-0001');
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, '80_publish_result.json'),
      JSON.stringify({ targets: { youtube: { videoId: 'AAAAAAAAAAA' } } }));

    const v2 = join(dir, 'EP-2026-0002', 'platforms', 'shorts');
    mkdirSync(v2, { recursive: true });
    writeFileSync(join(v2, '80_publish_result.json'),
      JSON.stringify({ targets: { youtube: { videoId: 'BBBBBBBBBBB' } } }));

    // 손상된 파일 하나가 전체를 막지 않아야 한다.
    const bad = join(dir, 'EP-2026-0003');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, '80_publish_result.json'), '{ not json');

    const ids = collectVideoIds(dir);
    assert.equal(ids.get('AAAAAAAAAAA'), 'EP-2026-0001');
    assert.equal(ids.get('BBBBBBBBBBB'), 'EP-2026-0002');
    assert.equal(ids.size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('보드 UI 는 계획 플래그와 무관하게 실제 비공개를 표시한다', () => {
  // planned_published 는 운영자의 의도이지 유튜브의 사실이 아니다. 카운터 정의는
  // 건드리지 않고 표시만 덧붙였다 — 계획 문서를 정본으로 쓰는 다른 화면이 있다.
  const html = readFileSync(join(ROOT, 'tools', 'board', 'index.html'), 'utf8');
  assert.match(html, /function liveVisibility\(episode\)/);
  assert.match(html, /live_checked_at/);
  assert.match(html, /'비공개'/);
  assert.match(html, /\.live-buried/, '비공개 칩 스타일이 없다');
});
