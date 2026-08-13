import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractEvidenceUrls,
  isCitable,
  classifyResult,
  verifyEvidenceUrls,
  escalateFabricatedEvidence,
} from '../scripts/automation/lib/evidence-verify.js';

const ROOT = join(import.meta.dirname, '..');

/** 네트워크를 타지 않는다 — URL → 응답 표를 주입한다 (레포 불변식: 테스트 네트워크 0). */
function fakeFetch(table) {
  return async (url) => {
    const hit = table[url];
    if (hit === undefined) throw Object.assign(new Error('unmapped'), { code: 'ENOTFOUND' });
    if (hit instanceof Error) throw hit;
    return { status: hit, body: { cancel: async () => {} } };
  };
}

test('bot blocking is not fabrication — the 2026-08-13 measurement', () => {
  // bls.gov 는 실재하는 문서에도 403 을 준다. 같은 403 이 날조 URL 에도 온다.
  // "200 아니면 가짜" 로 짰으면 1차 출처를 인용할수록 FAIL 나는 뒤집힌 게이트가 됐다.
  assert.equal(classifyResult({ status: 403 }), 'blocked');
  assert.equal(classifyResult({ status: 401 }), 'blocked');
  assert.equal(classifyResult({ status: 429 }), 'blocked');

  // 반면 이 둘은 날조의 직접 증거다
  assert.equal(classifyResult({ status: 404 }), 'fabricated');
  assert.equal(classifyResult({ status: 410 }), 'fabricated');
  assert.equal(classifyResult({ error: 'ENOTFOUND' }), 'fabricated');

  // 판별 불가는 판별 불가로 남긴다 — 날조로 접으면 오탐이 된다
  assert.equal(classifyResult({ error: 'EAI_AGAIN' }), 'unreachable', 'DNS 일시 장애는 NXDOMAIN 이 아니다');
  assert.equal(classifyResult({ error: 'ETIMEDOUT' }), 'unreachable');
  assert.equal(classifyResult({ status: 503 }), 'unreachable');

  assert.equal(classifyResult({ status: 200 }), 'alive');
  assert.equal(classifyResult({ status: 204 }), 'alive');
});

test('a bare domain is not a citation', () => {
  // https://reuters.com/ 도 200 이다. 실존하지만 어떤 주장의 근거도 아니다.
  assert.equal(isCitable('https://www.reuters.com/'), false);
  assert.equal(isCitable('https://www.reuters.com'), false);
  assert.equal(isCitable('https://finance.yahoo.com/news/cpi-report-140522541.html'), true);
  assert.equal(isCitable('ftp://example.com/doc.pdf'), false, 'http(s) 만 검증 대상');
  assert.equal(isCitable('출처: 한국은행 보도자료'), false);
});

test('urls are pulled out of free-form evidence prose', () => {
  const urls = extractEvidenceUrls(
    '연합뉴스(https://yna.co.kr/view/AKR123.) 및 https://www.bok.or.kr/portal/bbs/P0000559/view.do?nttId=10086 참조',
  );
  assert.deepEqual(urls, [
    'https://yna.co.kr/view/AKR123',                                  // 트레일링 마침표 제거
    'https://www.bok.or.kr/portal/bbs/P0000559/view.do?nttId=10086',  // 쿼리스트링 보존
  ]);
});

test('verification counts each verdict and reports whether it could decide', async () => {
  const table = {
    'https://finance.yahoo.com/news/real-article.html': 200,
    'https://www.bls.gov/news.release/cpi.htm': 403,
    'https://finance.yahoo.com/news/made-up-999999.html': 404,
  };
  const v = await verifyEvidenceUrls([
    ...Object.keys(table),
    'https://nonexistent-domain-xyz.example/article/1',   // 표에 없음 → ENOTFOUND
    'https://www.reuters.com/',                            // 루트 → 검사 대상 아님
  ], { fetchImpl: fakeFetch(table), concurrency: 2 });

  assert.equal(v.alive, 1);
  assert.equal(v.blocked, 1);
  assert.equal(v.fabricated, 2, '404 + NXDOMAIN');
  assert.equal(v.not_citable, 1);
  assert.equal(v.checked, 4, '루트 URL 은 때려보지 않는다');
  assert.equal(v.ran, true);
});

test('all-blocked means the check could not decide — never read as a pass', async () => {
  // 사내망·오프라인·전면 봇차단에서 이게 통과로 읽히면 게이트가 무력화된다.
  const v = await verifyEvidenceUrls(
    ['https://a.example/doc/1', 'https://b.example/doc/2'],
    { fetchImpl: fakeFetch({ 'https://a.example/doc/1': 403, 'https://b.example/doc/2': 429 }) },
  );
  assert.equal(v.ran, false);
  assert.equal(v.alive, 0);
  assert.equal(v.fabricated, 0, '차단은 날조가 아니다');
});

test('a claim whose evidence is entirely fabricated goes HIGH', () => {
  const claims = [
    { scene_id: '001', claim: 'CPI 는 3.4% 였다', risk: 'LOW', evidence: '출처 https://fake.example/a', risk_reason: '일치' },
    { scene_id: '002', claim: '나스닥 0.54% 상승', risk: 'LOW', evidence: '출처 https://real.example/b', risk_reason: '일치' },
  ];
  const verification = {
    results: [
      { url: 'https://fake.example/a', verdict: 'fabricated', status: 404 },
      { url: 'https://real.example/b', verdict: 'alive', status: 200 },
    ],
  };
  const { claims: out, escalated, flagged } = escalateFabricatedEvidence(claims, verification);

  assert.equal(escalated, 1);
  assert.equal(flagged, 0);
  assert.equal(out[0].risk, 'HIGH', '근거가 없으면 검증 불가 = HIGH (agent spec)');
  assert.equal(out[0].verdict, '미확인');
  assert.match(out[0].risk_reason, /자동 검증/);
  assert.equal(out[1].risk, 'LOW', '멀쩡한 claim 은 건드리지 않는다');
});

test('a surviving live source keeps the claim standing — MED, not HIGH', () => {
  // EP-2026-0091 실측: 나스닥 종가 주장이 Yahoo(404, 패턴에서 재구성)와
  // Motley Fool(200) 을 함께 인용했다. 수치는 살아있는 쪽으로 뒷받침되므로
  // 재집필을 돌릴 이유가 없다 — 늑대소년이 된 게이트는 꺼진다.
  const claims = [{
    scene_id: '001', claim: '나스닥 26,588 마감', risk: 'LOW',
    evidence: 'Yahoo https://fake.example/a ; Fool https://real.example/b', risk_reason: '복수 출처 일치',
  }];
  const verification = {
    results: [
      { url: 'https://fake.example/a', verdict: 'fabricated', status: 404 },
      { url: 'https://real.example/b', verdict: 'alive', status: 200 },
    ],
  };
  const { claims: out, escalated, flagged } = escalateFabricatedEvidence(claims, verification);

  assert.equal(escalated, 0, '재집필을 유발하지 않는다');
  assert.equal(flagged, 1);
  assert.equal(out[0].risk, 'MED');
  assert.equal(out[0].verdict, undefined, '주장 자체의 판정은 건드리지 않는다');
  assert.match(out[0].risk_reason, /실재하지 않음/, '죽은 인용은 반드시 표면화된다');
  assert.match(out[0].risk_reason, /주장은 유지/);
});

test('an already-HIGH claim is never downgraded by the evidence pass', () => {
  const claims = [{
    scene_id: '001', claim: 'x', risk: 'HIGH',
    evidence: 'https://fake.example/a ; https://real.example/b', risk_reason: '수치 오류',
  }];
  const verification = {
    results: [
      { url: 'https://fake.example/a', verdict: 'fabricated', status: 404 },
      { url: 'https://real.example/b', verdict: 'alive', status: 200 },
    ],
  };
  const { claims: out } = escalateFabricatedEvidence(claims, verification);
  assert.equal(out[0].risk, 'HIGH');
});

test('blocked or unreachable evidence never escalates a claim', () => {
  // 우리 쪽 네트워크 문제로 대본이 반려되면 파이프라인이 무작위로 멈춘다.
  const claims = [{ scene_id: '001', claim: 'x', risk: 'LOW', evidence: 'https://bls.gov/doc/1' }];
  const verification = { results: [{ url: 'https://bls.gov/doc/1', verdict: 'blocked', status: 403 }] };
  const { escalated, flagged } = escalateFabricatedEvidence(claims, verification);
  assert.equal(escalated, 0);
  assert.equal(flagged, 0);
});

test('the factcheck gate is not bound to a single provider', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'run-factcheck.js'), 'utf-8');
  assert.match(src, /callClaudeFactcheck/, 'claude must be an available engine');
  assert.match(src, /BT_FACTCHECK_ENGINE_CHAIN \|\| 'claude,gemini'/, 'claude first — Gemini 크레딧 고갈 전력');
  assert.match(src, /requested === 'auto' \? ENGINE_CHAIN : \[requested\]/,
    'an explicit --engine must yield a one-element chain (no silent fallback)');

  // 검색이 임무라 도구를 열어야 하지만, 파일을 쓸 수 있으면 게이트를 우회한다
  assert.match(src, /'--allowed-tools',\s*'WebSearch,WebFetch'/, 'search only — no Write, no Bash');

  // URL 검증은 엔진과 무관하게 돌아야 한다 — Gemini 도 URL 을 지어낼 수 있다
  assert.match(src, /await verifyEvidenceUrls\(claimUrls\)/, 'verification is engine-independent');
  assert.match(src, /escalateFabricatedEvidence\(result\.claims, verification\)/);
  assert.match(src, /backend: \$\{backend\}/, 'the report must name the engine that produced it');
});
