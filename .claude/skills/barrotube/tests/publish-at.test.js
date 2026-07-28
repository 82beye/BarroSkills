import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePublishAt } from '../scripts/automation/generate-metadata.js';

// 이 로직이 틀리면 영상이 조용히 사라진다: publishAt 이 과거면 YouTube 가 거부하고,
// privacyStatus 는 publish-approval.js 가 이미 private 로 강제한 뒤라 영영 안 열린다.
// 그래서 "예약을 못 걸 바엔 걸지 않는다"가 정답이고, 아래가 그 계약이다.

/** 2026-07-29 05:00 KST = 2026-07-28T20:00Z — us-close 루틴이 06:00 에 도는 상황 */
const AT_0500_KST = new Date('2026-07-28T20:00:00Z');

test('HH:MM 은 KST 오늘 날짜로 확장된다', () => {
  assert.equal(resolvePublishAt('08:00', AT_0500_KST), '2026-07-29T08:00:00+09:00');
  assert.equal(resolvePublishAt('18:00', AT_0500_KST), '2026-07-29T18:00:00+09:00');
});

test('한 자리 시각도 0 을 채운다', () => {
  assert.equal(resolvePublishAt('8:00', AT_0500_KST), '2026-07-29T08:00:00+09:00');
});

test('이미 지난 시각은 예약하지 않는다 (null)', () => {
  // 05:00 KST 에 04:00 예약은 과거
  assert.equal(resolvePublishAt('04:00', AT_0500_KST), null);
});

test('5분 이내도 예약하지 않는다 — 업로드가 끝나기 전에 시각이 지나면 거부된다', () => {
  assert.equal(resolvePublishAt('05:03', AT_0500_KST), null);
  assert.ok(resolvePublishAt('05:10', AT_0500_KST));
});

test('KST 달력일은 머신 TZ 가 아니라 Asia/Seoul 기준이다', () => {
  // UTC 로는 2026-07-28 22:00 이지만 KST 로는 이미 2026-07-29 07:00 이다.
  // 여기서 UTC 날짜를 쓰면 하루 전으로 예약돼 전부 과거가 된다.
  const utcStillYesterday = new Date('2026-07-28T22:00:00Z');
  assert.equal(resolvePublishAt('18:00', utcStillYesterday), '2026-07-29T18:00:00+09:00');
});

test('완전한 ISO8601 은 그대로 통과한다', () => {
  const iso = '2026-08-01T08:00:00+09:00';
  assert.equal(resolvePublishAt(iso, AT_0500_KST), iso);
});

test('해석 불가·범위 밖은 null', () => {
  for (const bad of ['', null, undefined, 'tomorrow', '25:00', '08:60', '0800']) {
    assert.equal(resolvePublishAt(bad, AT_0500_KST), null, `${bad} 는 null 이어야 한다`);
  }
});

test('두 슬롯의 실제 값이 모두 유효하다', () => {
  // routines.json 의 publish_at 이 바뀌어도 이 테스트가 계약을 지킨다
  const at0600 = new Date('2026-07-28T21:00:00Z');  // 07-29 06:00 KST
  const at1600 = new Date('2026-07-29T07:00:00Z');  // 07-29 16:00 KST
  assert.equal(resolvePublishAt('08:00', at0600), '2026-07-29T08:00:00+09:00');
  assert.equal(resolvePublishAt('18:00', at1600), '2026-07-29T18:00:00+09:00');
});
