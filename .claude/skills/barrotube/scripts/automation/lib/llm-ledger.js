/**
 * llm-ledger.js — 파이프라인 LLM 호출의 토큰·환산 비용 장부 (workspace/ops/llm-ledger.jsonl)
 *
 * 2026-10-07 운영자: "토큰 소모 체크가 되어야 한다." 페이퍼클립은 에이전트 실행의 토큰만 센다 —
 * 회차 안에서 스크립트가 부르는 claude -p · codex exec 는 구독 한도를 같이 쓰면서도 보이지 않았다.
 * 이 장부를 토큰 거버너 일일 리포트가 읽어 「어느 단계가 얼마나」를 보여 준다.
 *
 * 장부 쓰기가 실패해도 호출 결과는 그대로 돌려준다 — 계측 때문에 회차가 죽으면 안 된다.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const OPS = join(resolve(import.meta.dirname, '../../..'), 'workspace', 'ops');

/**
 * claude -p --output-format json 의 봉투를 푼다. 봉투가 아니면(구버전 CLI 등) 원문을 텍스트로 본다.
 * cached = 캐시 읽기, input = 새 입력 + 캐시 쓰기 (한도 소모 쪽에 가까운 값).
 */
export function parseClaudeEnvelope(stdout = '') {
  const raw = String(stdout).trim();
  try {
    const env = JSON.parse(raw);
    if (env && typeof env === 'object' && 'result' in env) {
      const u = env.usage ?? {};
      return {
        text: String(env.result ?? ''),
        isError: Boolean(env.is_error),
        costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null,
        input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cached: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        model: Object.keys(env.modelUsage ?? {})[0] ?? null,
      };
    }
  } catch {}
  return { text: raw, isError: false, costUsd: null, input: 0, cached: 0, output: 0, model: null };
}

/** codex exec --json 의 JSONL 에서 turn.completed 사용량을 모은다. */
export function codexUsageFromJsonl(stdout = '') {
  const sum = { input: 0, cached: 0, output: 0 };
  for (const line of String(stdout).split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type !== 'turn.completed' || !ev.usage) continue;
      sum.input += Math.max(0, (ev.usage.input_tokens ?? 0) - (ev.usage.cached_input_tokens ?? 0));
      sum.cached += ev.usage.cached_input_tokens ?? 0;
      sum.output += (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0);
    } catch {}
  }
  return sum;
}

export function recordLlmUsage({ engine, model = null, input = 0, cached = 0, output = 0, costUsd = null, ms = null, ok = true, caller } = {}) {
  try {
    mkdirSync(OPS, { recursive: true });
    appendFileSync(join(OPS, 'llm-ledger.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(),
      engine, model, input, cached, output, costUsd, ms, ok,
      caller: caller ?? basename(process.argv[1] ?? '?', '.js'),
      slot: process.env.BT_SLOT || null,
    })}\n`);
  } catch {}
}
