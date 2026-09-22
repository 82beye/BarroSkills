import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

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

test('예약이 안 걸려 private 로 남은 업로드를 완료로 위장하지 않는다', () => {
  // publish-youtube 는 publishedAt 을 `publishAt || now` 로 채운다. 예약이 없어도
  // 완료 보고에 "공개: <지금>" 이 찍혀 게시된 것처럼 보인다 — 2026-08-26 EP-0116·0117 이
  // 연속으로 그렇게 묻혔고 둘 다 "✅ 완료" 였다. privacy 를 따로 보고 경고해야 한다.
  const src = readFileSync(join(ROOT, 'lib/auto-pipeline.sh'), 'utf8');
  assert.match(src, /PUB_PRIVACY=/, '완료 보고가 privacyStatus 를 읽어야 한다');
  assert.match(src, /publish_left_private/, 'RED 감사 이벤트로 남겨야 한다');
  assert.match(src, /비공개로 남았습니다/, '텔레그램이 "완료" 가 아니라 경고여야 한다');
  assert.match(src, /set-video-privacy\.js --video/, '무엇을 실행하면 되는지 알려 줘야 한다');

  // 안내한 도구가 실제로 있어야 한다 — 없는 명령을 알려 주면 운영자가 두 번 헤맨다.
  assert.ok(existsSync(join(ROOT, 'scripts/automation/set-video-privacy.js')),
    'set-video-privacy.js 가 있어야 한다');
});

/**
 * "+Nd HH:MM" — 만드는 날과 공개하는 날을 뗀다.
 *
 * 2026-09-14 실측: 금요일만 us-close·realestate·kr-close 가 겹쳐 3편이고 토·일은 1편씩인데,
 * 3편일의 채널 총 조회(1239)가 2편일(1249)과 같다 — 셋째 편이 도달을 넓히지 않는다.
 * realestate 는 한국부동산원 목요일 발표 때문에 금요일 생성이 가장 신선하므로,
 * 생성은 금요일에 두고 공개만 토요일로 민다.
 */
test('+Nd 는 KST 달력일에 일수를 더한다', () => {
  const friday1000KST = new Date('2026-09-11T01:00:00Z');
  assert.equal(resolvePublishAt('+1d 10:00', friday1000KST), '2026-09-12T10:00:00+09:00');
  assert.equal(resolvePublishAt('+2d 12:00', friday1000KST), '2026-09-13T12:00:00+09:00');
  assert.equal(resolvePublishAt('+0d 23:00', friday1000KST), '2026-09-11T23:00:00+09:00');
});

test('+Nd 는 월말·연말을 넘어간다', () => {
  assert.equal(resolvePublishAt('+1d 09:00', new Date('2026-09-30T01:00:00Z')), '2026-10-01T09:00:00+09:00');
  assert.equal(resolvePublishAt('+1d 09:00', new Date('2026-12-31T01:00:00Z')), '2027-01-01T09:00:00+09:00');
});

test('+Nd 도 시각 범위와 형식을 그대로 검사한다', () => {
  const now = new Date('2026-09-11T01:00:00Z');
  assert.equal(resolvePublishAt('+1d 25:00', now), null, '시가 범위를 넘으면 거부');
  assert.equal(resolvePublishAt('+1d 10:60', now), null, '분이 범위를 넘으면 거부');
  assert.equal(resolvePublishAt('+1 10:00', now), null, 'd 가 빠지면 거부');
  assert.equal(resolvePublishAt('-1d 10:00', now), null, '과거로는 못 민다');
});

test('오늘 형식은 하나도 안 바뀐다 — 기존 슬롯 회귀 방지', () => {
  const at0500 = new Date('2026-07-29T20:00:00Z');
  assert.equal(resolvePublishAt('08:00', at0500), '2026-07-30T08:00:00+09:00');
  assert.equal(resolvePublishAt('18:00', at0500), '2026-07-30T18:00:00+09:00');
});

/**
 * revision 은 '주장이 바뀐 횟수'다 — TTS 길이 동기화는 여기 손대면 안 된다.
 *
 * 2026-09-15 EP-2026-0155: 팩트체크가 revision 3 에서 정상 통과했는데 Phase 8 의
 * sync-durations 가 4 로 올려놔서, 35_factcheck.md(script_revision 3)와 어긋났다.
 * Phase 6 의 판본 불일치 가드가 이걸 "고친 대본을 옛 리포트로 심사하려 한다"로 읽어
 * RESUME 재개가 통째로 막힌다. narration 을 한 글자도 안 바꾸는 단계는 판본을 올리지 않는다.
 */
test('sync-durations 는 revision 을 올리지 않는다', () => {
  const src = readFileSync(
    new URL('../scripts/automation/sync-durations.js', import.meta.url), 'utf8');
  assert.ok(/fm\.synced_at\s*=/.test(src), 'synced_at 기록은 남아 있어야 한다');
  assert.equal(/fm\.revision\s*=/.test(src), false,
    'revision 을 올리면 팩트체크 리포트와 어긋나 Phase 6 이 헛halt한다');
});

/**
 * 전체 ISO 타임스탬프도 과거 검사를 받아야 한다.
 *
 * 2026-09-16 EP-2026-0156: 07:18 에 시작하며 `BT_PUBLISH_AT=2026-09-16T10:00:00+09:00`
 * 를 넘겼는데 Grok 실패·HyperFrames 폴백·렌더로 13:09 에야 업로드됐다. publishAt 이
 * 3시간 전이라 유튜브가 **즉시 공개**해 버렸고(의도한 10:00 이 아닌 13:10),
 * 파이프라인은 그것을 `status: scheduled` 로 보고했다.
 * HH:MM 경로에는 5분 가드가 있었는데 ISO 경로가 그걸 통째로 건너뛰고 있었다.
 */
test('과거·임박 ISO 는 예약하지 않는다 — 즉시 공개 사고 방지', () => {
  const at1309KST = new Date('2026-09-16T04:09:00Z');
  assert.equal(resolvePublishAt('2026-09-16T10:00:00+09:00', at1309KST), null, '3시간 전 → 예약 금지');
  assert.equal(resolvePublishAt('2026-09-16T13:12:00+09:00', at1309KST), null, '3분 뒤 → 너무 임박');
  assert.equal(resolvePublishAt('2026-09-16T14:00:00+09:00', at1309KST), '2026-09-16T14:00:00+09:00');
});

test('ISO 와 HH:MM 이 같은 기준으로 판정된다', () => {
  const now = new Date('2026-09-16T04:09:00Z'); // 13:09 KST
  // 같은 시각을 두 형식으로 물으면 같은 결론이어야 한다.
  assert.equal(resolvePublishAt('10:00', now), null);
  assert.equal(resolvePublishAt('2026-09-16T10:00:00+09:00', now), null);
  assert.ok(resolvePublishAt('22:00', now));
  assert.ok(resolvePublishAt('2026-09-16T22:00:00+09:00', now));
});

/**
 * 늦은 게시 유예 — 노트북 환경의 구조적 복원력.
 *
 * 운영자 환경: 08~18시 일과 중 손을 못 댄다. 기계가 늦게 깨면 목표 공개 시각이
 * 이미 지나 있다. private 로 남기면 텔레그램도 죽어 있어 아무도 모르는 채 묻힌다
 * (2026-09-16 EP-2026-0155: 14시간 processing 에 갇힘). 뉴스 채널이므로
 * 조금 늦은 건 내보내고, 반나절 넘으면 내용이 죽었으니 잡아 둔다.
 */
test('유예 시간이 config 에 있고 기본이 6시간이다', () => {
  const r = JSON.parse(readFileSync(
    new URL('../config/routines.json', import.meta.url), 'utf8'));
  assert.equal(r.guards.publish_late_grace_hours, 6);
});

test('늦은-게시 분기가 metadata 작성기에 구현돼 있다', () => {
  const src = readFileSync(
    new URL('../scripts/automation/generate-metadata.js', import.meta.url), 'utf8');
  assert.match(src, /publish_now/, '유예 이내면 즉시 공개');
  assert.match(src, /hold_private/, '유예 초과면 private 유지');
  assert.match(src, /publish_late/, '어느 쪽이든 메타에 기록을 남긴다');
});

test('세 슬롯이 하루 3편 구조로 정렬돼 있다', () => {
  const r = JSON.parse(readFileSync(
    new URL('../config/routines.json', import.meta.url), 'utf8'));
  const s = r.slots;
  // 운영자 환경: 08시·12시·18시 공개. 생성은 각각 06·10·16시.
  assert.equal(s['us-close'].publish_at, '08:00');
  assert.equal(s.omnibus.publish_at, '12:00');
  assert.equal(s['kr-close'].publish_at, '18:00');
  assert.match(s.omnibus.cron, /Mon-Thu,Sat,Sun 10:00/, '금요일은 realestate 가 그 자리를 쓴다');
  assert.equal(s['kr-close'].cron, '16:00', '주말에도 18시 회차가 나가야 하루 3편이 된다');
  // 금요일 점심은 부동산 편이 같은 자리를 쓴다.
  assert.equal(s.realestate.publish_at, '12:00');
  assert.match(s.realestate.cron, /Fri/);
});
