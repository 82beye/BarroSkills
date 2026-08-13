/**
 * text-engine.js — JSON 을 돌려주는 텍스트 생성 단계의 공용 엔진 체인
 *
 * 2026-08-13 Gemini 선불 크레딧이 마르자 파이프라인이 세 곳에서 멈췄다:
 * S4 대본, S5 팩트체크, S9 메타데이터. 앞의 둘을 각각 고치고 나니 같은 호출 코드가
 * 복제되기 시작했는데, 이 레포는 이미 workflow-engine.js 가 정본과 갈라져
 * 죽은 채 남아 있는 전력이 있다. 갈라지기 전에 한 곳으로 모은다.
 *
 * 여기 있는 건 "프롬프트를 주면 JSON 문자열을 돌려준다" 뿐이다.
 * 프롬프트 조립·검증·저장은 각 단계의 책임으로 남긴다.
 *
 * 팩트체크(run-factcheck.js)는 이 모듈을 쓰지 않는다 — 검색 도구를 열어야 해서
 * --allowed-tools 가 다르고, grounding 증명이라는 별도 계약이 붙기 때문이다.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '../../..');

/** 응답에서 JSON 객체 하나만 잘라낸다. 코드펜스·앞뒤 문장을 견딘다. */
function extractJson(out, who) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  const body = fenced ? fenced[1].trim() : out;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`${who}: JSON 을 찾지 못했다: ${body.slice(0, 200)}`);
  return body.slice(start, end + 1);
}

const OUTPUT_RULES = [
  '출력 규칙: JSON 객체 **하나만** 출력해라.',
  '- 코드펜스(```), 머리말, 설명, 요약을 붙이지 마라.',
  '- 파일을 쓰지 마라.',
];

function buildPrompt(systemPrompt, userPrompt, extra = []) {
  return [systemPrompt, '', '───────────────', '', userPrompt, '', '───────────────', ...OUTPUT_RULES, ...extra].join('\n');
}

/**
 * claude -p 로 JSON 을 받는다.
 *
 * --allowed-tools '' 로 도구를 전부 막는다. 모델이 파일을 직접 쓰면 후속 계약
 * 검증(image_prompt·TTS 정책 등)을 우회하게 된다 — 산출물은 반드시 stdout 으로 받는다.
 */
export function callClaudeCode(systemPrompt, userPrompt, model = 'sonnet', timeoutSec = 600) {
  const prompt = buildPrompt(systemPrompt, userPrompt, ['- 표준출력에 JSON 만 낸다.']);

  const r = spawnSync('claude', [
    '-p', prompt,
    '--model', model,
    '--permission-mode', 'default',
    '--allowed-tools', '',
  ], { cwd: ROOT, encoding: 'utf-8', timeout: timeoutSec * 1000, maxBuffer: 10 * 1024 * 1024, env: process.env });

  if (r.error?.code === 'ENOENT') {
    throw new Error('claude CLI 를 찾을 수 없다. launchd PATH 에 ~/.local/bin 이 있는지 확인하라.');
  }
  if (r.signal === 'SIGTERM') throw new Error(`claude -p 타임아웃 (${timeoutSec}s)`);
  if (r.status !== 0) throw new Error(`claude -p 종료코드 ${r.status}: ${(r.stderr || '').slice(0, 300)}`);

  const out = (r.stdout || '').trim();
  if (!out) throw new Error('claude -p 응답이 비었다');
  return extractJson(out, 'claude -p');
}

/**
 * codex exec 로 JSON 을 받는다.
 *
 * -o(--output-last-message)가 마지막 응답만 파일로 떨궈 준다 — stdout 에는 진행 로그가
 * 섞이므로 이쪽이 안전하다. -s read-only 로 파일 쓰기를 막는 이유는 claude 쪽과 같다.
 * -a never: 비대화형이라 승인을 물어볼 사람이 없다.
 */
export function callCodex(systemPrompt, userPrompt, model = null, timeoutSec = 600) {
  const prompt = buildPrompt(systemPrompt, userPrompt);
  const outFile = join(tmpdir(), `bt-engine-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const args = ['-a', 'never', '-s', 'read-only'];
  if (model) args.push('-m', model);
  args.push('exec', '--ephemeral', '-o', outFile, prompt);

  try {
    const r = spawnSync('codex', args, {
      cwd: ROOT, encoding: 'utf-8', timeout: timeoutSec * 1000, maxBuffer: 10 * 1024 * 1024, env: process.env,
    });
    if (r.error?.code === 'ENOENT') throw new Error('codex CLI 를 찾을 수 없다 (launchd PATH 확인)');
    if (r.signal === 'SIGTERM') throw new Error(`codex 타임아웃 (${timeoutSec}s)`);
    if (r.status !== 0) throw new Error(`codex 종료코드 ${r.status}: ${(r.stderr || '').slice(0, 300)}`);

    const out = existsSync(outFile) ? readFileSync(outFile, 'utf-8').trim() : '';
    if (!out) throw new Error('codex 응답이 비었다');
    return extractJson(out, 'codex');
  } finally {
    try { unlinkSync(outFile); } catch {}
  }
}

/** Gemini 크레딧·쿼터 고갈은 재시도해도 안 풀린다 — 폴백 사유를 로그에서 구분하는 데 쓴다. */
export function isExhausted(err) {
  return /RESOURCE_EXHAUSTED|prepayment credits are depleted|quotaExceeded|\b429\b/i.test(String(err?.message ?? err));
}

/** `BT_*_ENGINE_CHAIN` 을 파싱한다. 미설정이면 구독 CLI 우선 순서를 쓴다. */
export function resolveChain(envValue, fallback = 'claude,codex,gemini') {
  return (envValue || fallback).split(',').map((e) => e.trim()).filter(Boolean);
}

/**
 * 엔진을 순서대로 시도한다.
 *
 * `runners` 는 {엔진이름: async () => ({json, used})} 맵이다. 체인이 한 개짜리면
 * (= 사용자가 --engine 으로 명시) 폴백 없이 그대로 실패한다 — 그 뜻을 존중해야
 * 원인이 드러난다.
 */
export async function runEngineChain(chain, runners, { log = console.log, warn = console.warn, error = console.error } = {}) {
  const failures = [];
  for (const [i, name] of chain.entries()) {
    const runner = runners[name];
    if (!runner) throw new Error(`알 수 없는 엔진: ${name} (가능: ${Object.keys(runners).join(' | ')})`);
    try {
      log(`   Engine: ${name}${i > 0 ? ` (폴백 ${i}/${chain.length - 1})` : ''}`);
      const got = await runner();
      return {
        ...got,
        engineUsed: failures.length ? `${got.used} (fallback from ${failures.map((f) => f.name).join('→')})` : got.used,
        failures,
      };
    } catch (e) {
      failures.push({ name, message: String(e.message).slice(0, 120) });
      if (i === chain.length - 1) {
        error(`❌ 모든 엔진 실패:\n${failures.map((f) => `   - ${f.name}: ${f.message}`).join('\n')}`);
        throw e;
      }
      // 크레딧 고갈은 예상된 폴백 사유고, 나머지는 사람이 봐야 할 결함이다.
      // cron 로그에서 이 둘이 같은 모양이면 아무도 후자를 못 찾는다.
      warn(`   ⚠ ${name} 실패${isExhausted(e) ? ' [크레딧·쿼터 고갈]' : ''}(${failures.at(-1).message}) → 다음 엔진`);
    }
  }
  throw new Error('빈 엔진 체인');
}
