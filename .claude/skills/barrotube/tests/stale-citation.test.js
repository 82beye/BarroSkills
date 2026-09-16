import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { findStaleCitations, articleDate } from '../scripts/automation/lib/evidence-verify.js';

/**
 * 인용이 **살아 있다**는 것과 **오늘 기사다**는 것은 다르다.
 *
 * 2026-09-16 EP-2026-0157: 리서처가 「LIG넥스원 +28.88%(오늘)」의 근거로
 * biz.heraldcorp.com/article/10685491 을 인용했다. 그 URL 은 지금도 200 을 주지만
 * 2026-03-03 자 「이란 사태에 방산주 불기둥…한화에어로 20%·LIG넥스원 30%」 —
 * 반년 전, 정반대 사건(확전), 다른 수치였다. 실존 검증은 alive 로 통과시킨다.
 *
 * 그 결과 팩트체커가 대본 단계에서 잡았고, 재작성 3회가 내용을 통째로 지워
 * 「정확한 상승 배경은 후속 보도로 다시 확인이 필요합니다」만 남았다.
 * 리서치 단계에서 막으면 대본에 토큰을 쓰기 전에 끝난다.
 */
test('날짜를 못 읽으면 판단하지 않는다 — 없는 근거로 막지 않는다', async () => {
  const r = await findStaleCitations(['https://example.invalid/none'], '2026-09-16', { timeoutMs: 2000 });
  assert.deepEqual(r, [], '읽을 수 없으면 조용히 넘어간다');
});

test('리서치가 인용 날짜를 검사하고 초과 시 멈춘다', () => {
  const src = readFileSync(new URL('../scripts/automation/research-brief.js', import.meta.url), 'utf8');
  assert.match(src, /findStaleCitations/, '날짜 검사를 호출해야 한다');
  assert.match(src, /STALE_CITATION_DAYS/, '허용 나이가 상수로 있어야 한다');
  // 막지 않고 경고만 하면 EP-0157 이 그대로 재발한다.
  const block = src.slice(src.indexOf('findStaleCitations('), src.indexOf('let topic;'));
  assert.match(block, /process\.exit\(4\)/, '오래된 인용이면 대본을 쓰기 전에 멈춰야 한다');
});

test('실존 검증만으로는 이 사고를 못 잡는다 — 날짜 검사가 따로 필요한 이유', () => {
  // verifyEvidenceUrls 는 200 이면 alive 다. 그것만으로 통과시키면 197일 전 기사가 그대로 들어온다.
  const src = readFileSync(new URL('../scripts/automation/lib/evidence-verify.js', import.meta.url), 'utf8');
  assert.match(src, /articleDate/, '기사 날짜 추출기가 있어야 한다');
  assert.match(src, /article:published_time/, 'meta 태그에서 날짜를 읽는다');
  assert.match(src, /datePublished/, 'JSON-LD 도 본다 (사이트마다 다르다)');
});

/**
 * 마케팅 수집 0건은 성공이 아니다.
 * 2026-09-07·09-14 두 주 연속 `items: 0` 짜리 빈 파일을 쓰고 exit 0 으로 지나갔다 —
 * 인텔이 비어 있어도 아무도 몰랐고, 그 위에서 도는 마케팅 처방은 근거가 없었다.
 */
test('수집 0건이면 크론이 실패로 끝난다', () => {
  const src = readFileSync(new URL('../scripts/automation/marketing-fetch-local.js', import.meta.url), 'utf8');
  assert.match(src, /fetched_count === 0/, '0건을 따로 봐야 한다');
  assert.match(src, /process\.exitCode = 5/, '0건이면 종료코드로 드러나야 한다');
});

test('RSS 피드 목록이 설정에 있고 실측 확인된 것만 들어 있다', () => {
  const wl = JSON.parse(readFileSync(new URL('../config/domain-whitelist.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(wl.rss_feeds) && wl.rss_feeds.length >= 3,
    'rss_feeds 가 없으면 fallback 2개로 떨어지고 그중 하나는 영구 403 이다');
  // 영구 403 인 피드가 다시 들어오지 않게 못 박는다.
  assert.equal(wl.rss_feeds.some((u) => u.includes('mk.co.kr')), false,
    'mk.co.kr RSS 는 403 이다 (2026-09-16 실측)');
});

/**
 * 토픽에 실린 인용도 검증한다 — 토픽은 00_brief.md 에 통째로 들어가고
 * 팩트체커는 나레이션뿐 아니라 그 배경 문서까지 채점하기 때문이다.
 *
 * 2026-09-16 두 건이 같은 구조였다:
 *   EP-0157 — 데스크 브리핑이 197일 전 기사(확전)를 오늘 것(휴전)으로 인용
 *   EP-0158 — FORCE_TOPIC 의 수치가 틀려, 나레이션을 고쳐도 배경 문서가 계속 채점돼 HIGH 가 안 내려갔다
 */
test('Phase 3 이 토픽 인용을 검증하고 오래되면 멈춘다', () => {
  const src = readFileSync(new URL('../lib/auto-pipeline.sh', import.meta.url), 'utf8');
  const phase3 = src.slice(src.indexOf('Phase 3 — S0 Brief'), src.indexOf('Stage A — Phase 4'));
  assert.match(phase3, /findStaleCitations/, '토픽의 인용 날짜를 봐야 한다');
  assert.match(phase3, /halt_for_human "Phase 3 brief"/, '오래되면 대본 전에 멈춰야 한다');
  assert.match(phase3, /BT_SKIP_TOPIC_CITATION_CHECK/, '끄는 스위치도 있어야 한다');
});

test('URL 이 없는 토픽은 통과시킨다 — 인용이 없으면 검사할 것도 없다', async () => {
  const { extractEvidenceUrls } = await import('../scripts/automation/lib/evidence-verify.js');
  assert.equal(extractEvidenceUrls('오늘 코스피가 올랐다').length, 0);
});
