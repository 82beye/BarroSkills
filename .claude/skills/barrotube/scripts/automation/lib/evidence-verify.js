/**
 * evidence-verify.js — 팩트체크 evidence URL 의 실존 검증
 *
 * 왜 필요한가
 * ──────────
 * S5 게이트는 모델이 "검증했다"고 말한 것을 그대로 믿으면 성립하지 않는다.
 * Gemini 경로는 API 가 groundingMetadata(실제 던진 검색어·읽은 페이지)를 돌려줘서
 * 코드가 그걸 확인할 수 있었지만, claude·codex 에는 대응하는 필드가 없다.
 * 그래서 증명을 우리가 직접 만든다 — evidence 에 적힌 URL 을 실제로 때려본다.
 *
 * 이 검사가 증명하는 것과 못 하는 것
 * ──────────────────────────────
 * 못 한다: "모델이 그 페이지를 읽고 주장을 대조했다". https://reuters.com/ 도 200 이다.
 * 한다:   "그 URL 은 날조다". 404·NXDOMAIN 은 인용이 지어내졌다는 직접 증거다.
 *
 * 안전 게이트에서 중요한 건 후자다 — 환각 인용을 잡는 게 목적이지
 * 모델의 성실성을 증명하는 게 목적이 아니다.
 *
 * 2026-08-13 실측이 판정표를 정했다:
 *   https://www.bls.gov/news.release/archives/cpi_08122026.htm       → 403 (실재하는데 봇 차단)
 *   https://www.bls.gov/news.release/archives/cpi_99999999.htm       → 403 (날조인데 같은 403)
 *   https://finance.yahoo.com/news/this-article-does-not-exist-…html → 404 (날조 적발)
 *   https://www.yonhapnews-totally-fake-domain-xyz.com/article/123    → ENOTFOUND (날조 적발)
 *
 * bls.gov 가 진짜 URL 에도 403 을 준다는 게 핵심이다. "200 아니면 가짜" 로 짰으면
 * 통계청·BLS 같은 1차 출처를 인용할수록 FAIL 나는 뒤집힌 게이트가 됐을 것이다.
 */

/** 응답 본문에서 http(s) URL 을 뽑는다. evidence 필드는 자유 서술이라 정규식이 유일한 경로다. */
export function extractEvidenceUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>)]+/g;
  const urls = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = String(m[0]).replace(/[.,;:!?)\]]+$/, '');   // 트레일링 문장부호 제거
    if (u.length > 8) urls.add(u);
  }
  return Array.from(urls);
}

/**
 * 인용으로 성립하는 URL 인가.
 *
 * 도메인 루트(https://reuters.com/)는 실존하지만 어떤 주장의 근거도 아니다.
 * 경로가 있어야 특정 문서를 가리킨다 — 이걸 통과 못 하면 때려볼 필요도 없다.
 */
export function isCitable(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.pathname.replace(/\/+$/, '').length > 0;
}

/**
 * HTTP 상태·네트워크 오류를 네 갈래로 나눈다.
 *
 * alive / fabricated 만 판정이고 blocked / unreachable 은 "모른다" 다.
 * 이 둘을 fabricated 로 접으면 봇 차단하는 1차 출처가 전부 날조로 몰린다.
 */
export function classifyResult({ status = null, error = null }) {
  if (error) {
    const e = String(error);
    // ENOTFOUND = NXDOMAIN. 도메인 자체가 없다 — 지어낸 출처다.
    // EAI_AGAIN 은 DNS 서버 일시 장애라서 같은 취급하면 안 된다.
    if (/ENOTFOUND|Could not resolve host/i.test(e)) return 'fabricated';
    return 'unreachable';
  }
  if (status >= 200 && status < 300) return 'alive';
  if (status === 404 || status === 410) return 'fabricated';
  if (status >= 500) return 'unreachable';
  return 'blocked';   // 401·403·429 등 — 서버가 봇을 막은 것이지 URL 이 없는 게 아니다
}

/** 브라우저 UA. 기본 UA 로는 멀쩡한 언론사도 403 을 준다 — 오탐을 줄인다. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function probe(url, fetchImpl, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    // 헤더만 필요하다 — 본문을 끝까지 읽으면 느리고 메모리만 쓴다
    try { await res.body?.cancel(); } catch {}
    return { status: res.status, error: null };
  } catch (e) {
    return { status: null, error: e?.cause?.code || e?.code || e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * URL 목록의 실존을 확인한다.
 *
 * fetchImpl 을 주입받는다 — 테스트가 네트워크를 타면 안 되기 때문이다(레포 불변식).
 */
export async function verifyEvidenceUrls(urls, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 12000,
    concurrency = 4,
    maxUrls = 40,           // 한 EP 가 수백 URL 을 뱉어도 게이트가 몇 분씩 걸리면 안 된다
  } = opts;

  const citable = [];
  const results = [];
  for (const u of urls) {
    if (isCitable(u)) citable.push(u);
    else results.push({ url: u, status: null, verdict: 'not_citable' });
  }

  const targets = citable.slice(0, maxUrls);
  const skipped = citable.length - targets.length;

  // 소규모 워커 풀. 동시에 다 던지면 같은 호스트에 몰린다.
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const url = targets[cursor++];
      const r = await probe(url, fetchImpl, timeoutMs);
      results.push({ url, status: r.status, error: r.error, verdict: classifyResult(r) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  const count = (v) => results.filter((r) => r.verdict === v).length;
  const checked = targets.length;
  const unresolved = count('blocked') + count('unreachable');

  return {
    checked,
    skipped,
    alive: count('alive'),
    fabricated: count('fabricated'),
    blocked: count('blocked'),
    unreachable: count('unreachable'),
    not_citable: count('not_citable'),
    // 던져봤는데 전부 판별 불가 = 검증이 돌지 못한 것이다. 통과로 읽으면 안 된다.
    ran: checked > 0 && unresolved < checked,
    results,
  };
}

/**
 * 근거 URL 이 날조된 claim 의 위험도를 올린다.
 *
 * 두 갈래로 나눈다. 날조 URL 하나만 보고 전부 HIGH 로 올리면 게이트가 늑대소년이 되고,
 * 늑대소년이 된 게이트는 꺼진다 — 2026-08-13 EP-2026-0091 실측에서 바로 이 상황이 나왔다.
 * 나스닥 종가 주장이 Yahoo(404·패턴에서 재구성됨)와 Motley Fool(200) 두 곳을 인용했는데,
 * 수치 자체는 살아있는 쪽으로 뒷받침된다. 이걸 HIGH 로 올려 재집필을 돌릴 이유가 없다.
 *
 *   살아있는 근거가 하나도 없다 → HIGH. 근거 없는 주장이고, agent spec 의
 *     "검증 불가 주장은 HIGH(안전 우선)" 가 그대로 적용된다.
 *   살아있는 근거가 남아 있다   → 최소 MED. 주장은 서 있지만 인용 하나가 죽었다.
 *     사람이 리포트의 링크를 눌러 404 를 만나면 리포트 전체의 신뢰를 잃는다.
 *
 * blocked·unreachable 로는 어느 쪽도 올리지 않는다. 그건 URL 의 문제가 아니라 우리 쪽
 * 네트워크 문제고, 그걸로 대본을 반려하면 파이프라인이 무작위로 멈춘다.
 */
export function escalateFabricatedEvidence(claims, verification) {
  const verdictOf = new Map(verification.results.map((r) => [r.url, r.verdict]));
  const hasFabricated = verification.results.some((r) => r.verdict === 'fabricated');
  if (!hasFabricated) return { claims, escalated: 0, flagged: 0 };

  let escalated = 0;   // → HIGH (근거 전멸)
  let flagged = 0;     // → MED  (근거 일부 생존)

  const out = claims.map((c) => {
    const urls = extractEvidenceUrls(c.evidence || '');
    const dead = urls.filter((u) => verdictOf.get(u) === 'fabricated');
    if (dead.length === 0) return c;

    const alive = urls.filter((u) => verdictOf.get(u) === 'alive');
    const note = `[자동 검증] 근거 URL 이 실재하지 않음(${dead.join(', ')})`;

    if (alive.length === 0) {
      escalated++;
      return {
        ...c,
        risk: 'HIGH',
        verdict: '미확인',
        risk_reason: `${c.risk_reason || ''} ${note} — 살아있는 근거가 없어 검증 불가 처리`.trim(),
      };
    }

    flagged++;
    return {
      ...c,
      risk: c.risk === 'HIGH' ? 'HIGH' : 'MED',   // 이미 HIGH 인 건 내리지 않는다
      risk_reason: `${c.risk_reason || ''} ${note} — 다만 실존 확인된 근거 ${alive.length}건이 남아 주장은 유지`.trim(),
    };
  });

  return { claims: out, escalated, flagged };
}
