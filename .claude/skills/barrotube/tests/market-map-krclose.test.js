import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  KR_CLOSE_WINDOW, krCloseSnapshotWindow, pickKrForEdition,
} from '../scripts/automation/lib/market-map.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (hhmm, day = '2026-09-29') => new Date(`${day}T${hhmm}:00+09:00`);
const today = { date: '2026-09-29', status: 'OPEN', open: false };

test('KRX 종가 스냅샷은 정규장 마감 뒤, 첫 시간외 단일가 체결(16:10) 전에만 뜬다', () => {
  assert.equal(KR_CLOSE_WINDOW.until, 1609);
  assert.equal(krCloseSnapshotWindow(today, at('15:34')).ok, false, '종가 확정 직후는 반영이 늦을 수 있다');
  assert.equal(krCloseSnapshotWindow(today, at('15:35')).ok, true);
  assert.equal(krCloseSnapshotWindow(today, at('16:09')).ok, true);
  const late = krCloseSnapshotWindow(today, at('16:10'));
  assert.equal(late.ok, false);
  assert.match(late.why, /시간외 단일가/);
  assert.match(krCloseSnapshotWindow({ ...today, date: '2026-09-28' }, at('15:45')).why, /휴장/);
  assert.equal(krCloseSnapshotWindow({ ...today, open: true }, at('15:45')).ok, false, '장중 값은 종가가 아니다');
});

test('석간은 같은 세션의 종가 스냅샷을 쓰고, 없으면 경고를 단다', () => {
  const live = { kr: [{ key: 'A', pct: 4.24 }], themes: [{ name: 'live' }], krSession: today };
  const snapshot = { fetchedAt: '2026-09-29T06:45:00Z', kr: [{ key: 'A', pct: 5.40 }], themes: [{ name: 'snap' }], krSession: today };

  const used = pickKrForEdition({ edition: 'evening', live, snapshot, now: at('18:00') });
  assert.equal(used.source, 'krx-close');
  assert.equal(used.kr[0].pct, 5.40, '18시 실시간 값(시간외 단일가 반영)이 아니라 공식 종가');
  assert.equal(used.themes[0].name, 'snap');
  assert.equal(used.warn, null);

  const stale = pickKrForEdition({ edition: 'evening', live, snapshot: { ...snapshot, krSession: { ...today, date: '2026-09-28' } }, now: at('18:00') });
  assert.equal(stale.source, 'live-after-hours', '다른 세션의 스냅샷은 쓰지 않는다');
  assert.match(stale.warn, /시간외 단일가/);

  assert.equal(pickKrForEdition({ edition: 'evening', live, now: at('15:50') }).warn, null, '창 안의 수동 실행은 실시간 값이 곧 종가다');
  assert.equal(pickKrForEdition({ edition: 'morning', live, snapshot, now: at('08:00') }).source, 'live', '조간은 스냅샷을 쓰지 않는다');
});

test('스냅샷이 15:45 평일 예약으로 돌고, 석간이 그것을 읽는다', () => {
  const install = readFileSync(join(ROOT, 'lib', 'install-cron.sh'), 'utf8');
  assert.match(install, /market-map-krclose\)\n[\s\S]*?script_path="\$\{BARROTUBE_HOME\}\/lib\/market-map-krclose\.sh"/);

  const wrapper = readFileSync(join(ROOT, 'lib', 'market-map-krclose.sh'), 'utf8');
  assert.ok(wrapper.indexOf('wait_for_network') < wrapper.indexOf('--kr-close-snapshot'), '잠에서 막 깬 틈에는 네트워크부터 기다린다');

  const map = readFileSync(join(ROOT, 'scripts', 'automation', 'market-map.js'), 'utf8');
  assert.match(map, /pickKrForEdition\(\{ edition, live, snapshot \}\)/, '석간 수집이 스냅샷을 먼저 본다');
  assert.match(map, /krSource: picked\.source/, '어느 값을 실었는지 data.json 에 남긴다');
  const snap = map.slice(map.indexOf("if (values['kr-close-snapshot'])"));
  assert.ok(snap.indexOf('krCloseSnapshotWindow') < snap.indexOf('writeFileSync'), '창 밖이면 저장하지 않는다');
});
