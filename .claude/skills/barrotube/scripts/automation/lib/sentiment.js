/**
 * sentiment.js — 썸네일 팔레트용 감정(상승/하락) 추론 (하이브리드, 2026-06-07)
 *
 * 기존 generate-thumbnail.js의 단순 키워드 .test() 방식은 부정/반전 문맥을
 * 읽지 못해 오판했다:
 *   "폭락 우려 해소"   → 폭락만 보고 bearish (실제 호재)
 *   "하락 멈춤"        → 하락만 보고 bearish (실제 안정/반등)
 *   "상승세 꺾여"      → 상승만 보고 bullish (실제 하락)
 *   "하락하지 않았다"  → 하락만 보고 bearish (실제 방어)
 *
 * 이 모듈은 2단 하이브리드:
 *   1) scoreSentimentRegex() — 부정어·반전어 윈도우 스코어링.
 *      결정적·무료·오프라인. 항상 동작하는 기본/폴백 경로.
 *   2) classifySentimentLLM() — gpt-4o-mini 분류 (chat/completions 재사용).
 *      OPENAI_API_KEY + opt-in 플래그가 있을 때만. 이중 부정 등 진짜 문맥 처리.
 *
 * detectSentimentPalette()가 둘을 조율: LLM 활성+성공 시 LLM, 그 외/실패 시 regex.
 *
 * scene-backgrounds.md §63 자동 매핑("hook + 위기/충격 → bearish") 준수.
 */

// ── 신호어 (polarity 부호: bearish = -1, bullish = +1) ────────────────────────
// 기존 generate-thumbnail.js의 BEARISH/BULLISH_SIGNALS를 그대로 이관.
const BEARISH_SIGNALS = /깨[졌진짐]|무너|붕괴|폭락|급락|하락|추락|패닉|공포|충격|경고|위기|손실|마이너스|적자|쇼크|투매|약세|반토막|곤두박질|아래로|내려[서앉]|crash|plunge|sell-?off|bear|slump|collapse|tumble/gi;
const BULLISH_SIGNALS = /돌파|신고가|최고가|사상\s*최[고대]|급등|폭등|상승|랠리|호재|강세|반등|불장|rally|surge|soar|all-?time\s*high|bull|breakout/gi;

// ── 반전어 (신호의 부호를 뒤집음) ─────────────────────────────────────────────
// "하락 멈춤", "폭락 해소", "상승세 꺾여" 처럼 신호 직후에 와서 의미를 뒤집는 토큰.
// 신호어와 겹치지 않도록 구성 (반등/회복은 그 자체가 bullish 신호이므로 제외).
const REVERSAL = /해소|진정|멈[춰췄춤춘추]|멎|그[쳐치]|방어|벗어\s*나|되돌|저지|막아|축소|둔화|꺾[여이임였]|진화|안정세|상쇄|낙폭\s*축소|반전|되살|회피|면[했하]/;

// ── 부정어 (신호를 한 번 더 뒤집음 — 반전어와 함께면 이중 부정 → 원복) ──────────
// "하락하지 않았다", "폭락 멈추지 않았다"(반전+부정 = 원래 bearish 유지) 처리.
const NEGATION = /않[다은았아]|없[다어었이]|아니[다]|못\s*[해하]|말[자아]|아냐|아닌/;

// 신호 끝부터 살펴볼 문맥 윈도우 길이(문자 수). 한국어 형태소 ~3-4개 커버.
const CTX_WINDOW = 10;

function collectMatches(text, regex, polarity) {
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    out.push({ end: m.index + m[0].length, polarity });
    if (m.index === regex.lastIndex) regex.lastIndex++; // zero-width 방어
  }
  return out;
}

/**
 * 부정/반전 인식 스코어링. 결정적·동기·무료.
 * @returns 'bearish' | 'bullish' | null
 */
export function scoreSentimentRegex(text) {
  if (!text) return null;
  const matches = [
    ...collectMatches(text, BEARISH_SIGNALS, -1),
    ...collectMatches(text, BULLISH_SIGNALS, +1),
  ];
  if (matches.length === 0) return null;

  let score = 0;
  let sawBear = false;
  let sawBull = false;
  for (const { end, polarity } of matches) {
    const window = text.slice(end, end + CTX_WINDOW);
    let sign = polarity;
    if (REVERSAL.test(window)) sign *= -1;   // 반전어 → 부호 반전
    if (NEGATION.test(window)) sign *= -1;    // 부정어 → 부호 반전 (반전+부정이면 원복)
    score += sign;
    if (sign < 0) sawBear = true;
    else if (sign > 0) sawBull = true;
  }

  if (score < 0) return 'bearish';
  if (score > 0) return 'bullish';
  // 정확히 0(혼재) → 속보 위기 톤 우선 (기존 동작 계승). 둘 다 없으면 null.
  return sawBear && sawBull ? 'bearish' : null;
}

/**
 * gpt-4o-mini 문맥 분류. OPENAI_API_KEY 필요. 실패 시 undefined 반환(→ 폴백 신호).
 * @returns Promise<'bearish'|'bullish'|null|undefined>  undefined = "LLM 불가, regex로 폴백하라"
 */
export async function classifySentimentLLM(text, { model = 'gpt-4o-mini', timeoutMs = 8000, costContext = {} } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !text) return undefined;

  const system = `너는 한국 경제 뉴스 헤드라인의 시장 방향성(상승/하락)을 분류한다.
부정어·반전어·이중부정 문맥을 반드시 고려하라.
예) "폭락 우려 해소"→상승, "하락 멈춤"→상승(또는 중립), "상승세 꺾여"→하락,
   "하락하지 않았다"→상승, "하락 멈추지 않아"→하락.
JSON만 출력: {"sentiment":"bearish"|"bullish"|"neutral","confidence":0~1}
- bearish: 시장 하락/위기/충격 톤
- bullish: 시장 상승/호재/강세 톤
- neutral: 방향성 불명확`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 60,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `헤드라인: "${text.replace(/\s+/g, ' ').trim().slice(0, 400)}"` },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return undefined;

    // 비용 기록 (옵셔널)
    try {
      const { recordCost } = await import('./cost-tracker.js');
      const inTok = data?.usage?.prompt_tokens || 0;
      const outTok = data?.usage?.completion_tokens || 0;
      const cost = (inTok * 0.15 + outTok * 0.6) / 1_000_000;
      recordCost('06e-thumbnail', cost, { ...costContext, engine: 'gpt-4o-mini', task: 'sentiment-classify' });
    } catch { /* cost-tracker 없으면 무시 */ }

    let parsed;
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    const s = String(parsed?.sentiment || '').toLowerCase();
    if (s === 'bearish') return 'bearish';
    if (s === 'bullish') return 'bullish';
    if (s === 'neutral') return null;
    return undefined;
  } catch {
    return undefined; // 네트워크/타임아웃/abort → 폴백
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 하이브리드 조율기. LLM 활성+성공 시 LLM, 그 외/실패 시 결정적 regex.
 * @returns Promise<{ palette: 'bearish'|'bullish'|null, source: 'llm'|'regex' }>
 */
export async function detectSentimentPalette(text, { useLLM = false, model, timeoutMs, costContext } = {}) {
  if (useLLM) {
    const llm = await classifySentimentLLM(text, { model, timeoutMs, costContext });
    if (llm !== undefined) return { palette: llm, source: 'llm' };
  }
  return { palette: scoreSentimentRegex(text), source: 'regex' };
}
