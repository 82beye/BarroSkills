// 마켓맵 장애 수리 (YOU-556 · S-6/C-7) 회귀 테스트.
//   S-6: 커뮤니티 게시 실패가 `|| echo` 에 묻혀 마커가 done 이었다 → 「◐ PARTIAL」 줄로 드러낸다.
//   C-7: 페이퍼클립 실행이 끝나며 지운 TMPDIR 에서 Chrome 이 죽었다 → 크론이 TMPDIR 을 바꾸고, launch 는 1회 재시도.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchChrome, krFallback, backoffMs } from '../scripts/automation/lib/market-map.js';

const ROOT = resolve(import.meta.dirname, '..');

test('launchChrome — 첫 launch 가 실패하면 한 번 더 띄운다', async () => {
  let calls = 0;
  const fake = { launch: async () => { calls += 1; if (calls === 1) throw new Error('browserType.launch: Timeout 180000ms exceeded.\nCall log: …'); return 'browser'; } };
  const logs = [];
  const b = await launchChrome(fake, { sleep: async () => {}, log: (m) => logs.push(m) });
  assert.equal(b, 'browser');
  assert.equal(calls, 2);
  assert.match(logs[0], /Chrome 실행 실패 \(1\/2\) — browserType\.launch: Timeout/);
});

test('launchChrome — 두 번 다 실패하면 원래 오류로 죽는다 (무한 재시도 없음)', async () => {
  let calls = 0;
  const fake = { launch: async () => { calls += 1; throw new Error(`ENOENT ${calls}`); } };
  await assert.rejects(launchChrome(fake, { sleep: async () => {}, log: () => {} }), /ENOENT 2/);
  assert.equal(calls, 2);
});

test('krFallback — 오늘 KRX 종가 스냅샷이 있으면 그것, 조간은 직전 스냅샷, 석간은 직전 값으로 대신하지 않는다', () => {
  const snapshot = { kr: [{ n: 1, pct: 1 }], themes: [{ name: 't' }], krSession: { date: '2026-10-22', open: false } };
  const priorKr = { kr: [{ n: 2, pct: -1 }], session: { date: '2026-10-21', open: false } };
  const priorThemes = { themes: [{ name: 'p', pct: 2 }], date: '2026-10-21' };

  const s = krFallback({ edition: 'evening', snapshot, priorKr, priorThemes });
  assert.equal(s.krSession.date, '2026-10-22');
  assert.equal(s.kr, snapshot.kr);

  const m = krFallback({ edition: 'morning', priorKr, priorThemes });
  assert.equal(m.krSession.date, '2026-10-21');
  assert.equal(m.krSession.carried, true);
  assert.equal(m.themesDate, '2026-10-21');

  assert.equal(krFallback({ edition: 'evening', priorKr, priorThemes }), null);
  assert.equal(krFallback({ edition: 'morning' }), null);
});

test('backoffMs — 1.5·3·6초로 늘렸다', () => {
  assert.deepEqual([0, 1, 2].map(backoffMs), [1500, 3000, 6000]);
});

/** 크론 스크립트를 가짜 홈에서 돌린다 — 수집·조판·Pages·게시 단계는 종료코드만 흉내 낸다. */
function runCron({ pagesRc = 0, postRc = 0, tmp }) {
  const home = mkdtempSync(join(tmpdir(), 'mm-cron-'));
  mkdirSync(join(home, 'lib'));
  mkdirSync(join(home, 'scripts/automation'), { recursive: true });
  copyFileSync(join(ROOT, 'lib/market-map-cron.sh'), join(home, 'lib/market-map-cron.sh'));
  writeFileSync(join(home, 'lib/guards.sh'), 'wait_for_network() { return 0; }\n');
  writeFileSync(join(home, 'lib/market-map-pages.sh'), `exit ${pagesRc}\n`);
  const seen = join(home, 'tmpdir-seen');
  writeFileSync(join(home, 'scripts/automation/market-map.js'), `require('fs').writeFileSync(${JSON.stringify(seen)}, process.env.TMPDIR || '');\n`);
  writeFileSync(join(home, 'scripts/automation/market-magazine.js'), '');
  writeFileSync(join(home, 'scripts/automation/community-post.js'), `console.error('❌ 커뮤니티 컴포저를 찾지 못했습니다'); process.exit(${postRc});\n`);
  const r = spawnSync('bash', [join(home, 'lib/market-map-cron.sh'), 'morning'], {
    encoding: 'utf-8', env: { ...process.env, TMPDIR: tmp ?? process.env.TMPDIR },
  });
  return { ...r, tmpSeen: readFileSync(seen, 'utf-8') };
}

test('크론 — 커뮤니티 게시가 실패하면 판은 끝까지 가되 ◐ PARTIAL 을 남긴다 (예전엔 done 으로 묻힘)', () => {
  const r = runCron({ postRc: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^◐ PARTIAL 커뮤니티 게시 실패/m);
});

test('크론 — Pages 가 실패해도 ◐ PARTIAL, 게시가 성공하면 PARTIAL 없음', () => {
  const p = runCron({ pagesRc: 1 });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^◐ PARTIAL Pages 갱신 실패/m);
  const ok = runCron({});
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout, /PARTIAL/);
});

test('크론 — 페이퍼클립 실행 임시 폴더(지워질 수 있음)를 TMPDIR 로 물려주지 않는다', () => {
  const gone = join(tmpdir(), 'paperclip-run-you-562-f3fe7b98-gone');
  const r = runCron({ tmp: gone });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.tmpSeen, /paperclip-run-/);
  assert.ok(r.tmpSeen.length > 0);
});
