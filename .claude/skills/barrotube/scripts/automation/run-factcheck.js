#!/usr/bin/env node

/**
 * run-factcheck.js — S5 Factcheck Gate (claude WebSearch → Gemini google_search)
 *
 * 설계: docs/design/S5-factcheck-gate.md
 * Agent spec: claude-code/.claude/agents/06-fact-checker.md
 *
 * 입력:  <epDir>/30_script.md (Writer 산출물)
 * 출력:  <epDir>/35_factcheck.md (frontmatter + HIGH/MED/LOW 분류 claims)
 * stdout(JSON): { pass, total_claims, high_risk_count, med_risk_count, low_risk_count, file }
 *
 * 호출자:
 *   node run-factcheck.js --episode EP-2026-0009
 *   node run-factcheck.js --episode EP-2026-0009 --force            # 기존 리포트 덮어쓰기
 *   node run-factcheck.js --episode EP-2026-0009 --engine gemini    # 단일 지정(폴백 없음)
 *   BT_FACTCHECK_ENGINE_CHAIN=gemini,claude node run-factcheck.js -e EP-…
 *
 * 판정 규칙 (agent spec §Behavior):
 *   - HIGH 가 1개라도 있으면 pass=false
 *   - 검증 불가 주장은 HIGH 로 분류 (안전 우선)
 *
 * 증거 검증 (2026-08-13)
 * ────────────────────
 * Gemini 는 groundingMetadata 로 "실제 검색했다"를 API 가 증명해 준다. claude 에는 그
 * 필드가 없어서 증명을 우리가 만든다 — evidence 의 URL 을 직접 때려 실존을 확인하고,
 * 날조된 인용(404·NXDOMAIN)이 붙은 claim 을 HIGH 로 격상한다.
 * 새 정책이 아니라 기존 "검증 불가 = HIGH" 규칙의 적용이다.
 * 이 검증은 엔진과 무관하게 항상 돈다 — Gemini 도 URL 을 지어낼 수 있다.
 * 판정 근거는 lib/evidence-verify.js 헤더 참조.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';
import { resolvePaths } from './paths.js';
import {
  extractEvidenceUrls,
  verifyEvidenceUrls,
  escalateFabricatedEvidence,
} from './lib/evidence-verify.js';

const DEFAULT_MODEL = process.env.GEMINI_FACTCHECK_MODEL || 'gemini-2.5-pro';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * auto 모드의 시도 순서.
 *
 * claude 를 앞에 둔다 — 구독으로 돌고, 2026-08-13 Gemini 선불 크레딧 고갈로
 * Phase 6 이 통째로 멈춘 전력이 있다. Gemini 는 groundingMetadata 라는
 * 더 강한 증거를 주므로 뒤에 남겨 폴백으로 쓴다.
 */
const ENGINE_CHAIN = (process.env.BT_FACTCHECK_ENGINE_CHAIN || 'claude,gemini')
  .split(',').map((e) => e.trim()).filter(Boolean);

function buildSystemPrompt(searchTool) {
  return `You are "Fact Checker Agent" of BarroTube, a Korean economy YouTube Shorts channel.

MISSION:
Extract verifiable claims (numbers, years, proper nouns, quotes, statistics) from the provided script and verify each against reliable sources using ${searchTool}. Classify risk and suggest revisions.

RULES:
1. Output MUST be a single JSON object. No markdown, no prose, no code fences.
2. Extract every factual claim from every scene. Do not skip any numeric/statistical assertion.
3. For each claim, use ${searchTool} to verify against reliable sources (통계청, 한국은행, IMF, World Bank, 연합뉴스, 로이터, AP, BBC, 공식 기업 공시 등).
4. Classify risk:
   - HIGH: 수치 오류, 날짜 오류, 인물/기업 혼동, 법적/규제 위험, 검증 불가 (안전 우선 — unverifiable = HIGH)
   - MED: 맥락 누락, 과장 표현, 불완전한 인용
   - LOW: 사소한 표현 차이, 최신 데이터와 미세 차이
5. For HIGH/MED, always provide "suggested_revision" (corrected Korean sentence, same 스타일/길이).
6. Cite "evidence" with source URL or official document name. Min 2 independent sources for HIGH.
7. If a claim cannot be verified via search, mark HIGH with risk_reason="unverifiable".
8. Bind every market claim to the exact date and traded_at in the attached pipeline research. Never substitute the previous trading day's close.
9. Treat pipeline snapshots as primary dated evidence, then corroborate them by searching the exact YYYY-MM-DD plus the quoted value. If search results conflict, explain the date mismatch instead of silently choosing another session.
10. EVERY URL you put in "evidence" is fetched and checked by the pipeline after you answer. A URL that returns 404 or whose domain does not resolve is treated as a fabricated citation and escalates that claim to HIGH. Only cite a URL you actually retrieved from search results — never reconstruct or guess one from a pattern. Cite the specific document, not a section or homepage.

OUTPUT SCHEMA:
{
  "summary": "1-sentence Korean summary of overall factual integrity",
  "claims": [
    {
      "scene_id": "001",
      "claim": "원문 그대로 인용",
      "verdict": "사실|부정확|미확인|오류",
      "risk": "HIGH|MED|LOW",
      "evidence": "출처 URL or 문서명 (핵심 1~2줄 발췌)",
      "suggested_revision": "수정된 한국어 문장 (HIGH/MED 만, LOW 는 빈 문자열)",
      "risk_reason": "왜 이 위험도인지 1문장"
    }
  ]
}`;
}

const SYSTEM_PROMPT = buildSystemPrompt('google_search');

function readIfExists(p) { return existsSync(p) ? readFileSync(p, 'utf-8') : ''; }

function parseScriptFrontmatter(scriptText) {
  const m = scriptText.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('30_script.md has no YAML frontmatter');
  return parseYAML(m[1]);
}

const FORCE_GROUNDING = (process.env.GEMINI_FACTCHECK_FORCE_GROUNDING || 'true').toLowerCase() !== 'false';

const GROUNDING_REINFORCEMENT = `\n\n[GROUNDING REQUIREMENT — CRITICAL]\nYou MUST call google_search at least once for EVERY claim that contains numbers, dates, proper nouns, or statistical assertions. Do NOT rely on internal knowledge. If you do not call google_search, your response will be rejected and re-issued. For each claim provide a real URL pulled from search results in the "evidence" field.`;

/**
 * claude -p 로 같은 JSON 을 받는다 (WebSearch 사용).
 *
 * generate-script.js 의 claude 호출과 결정적으로 다른 점: 거기는 --allowed-tools '' 로
 * 도구를 전부 막지만 여기는 검색이 임무 자체라 열어야 한다. 대신 WebSearch·WebFetch 만
 * 연다 — Write·Bash 가 열리면 모델이 35_factcheck.md 를 직접 써서 게이트를 우회할 수 있다.
 *
 * grounded 판정은 여기서 하지 않는다. claude 응답에는 groundingMetadata 가 없으므로
 * 호출자가 evidence URL 실존 검증으로 대신한다.
 */
function callClaudeFactcheck(userPrompt, model = 'sonnet', timeoutSec = 900) {
  const prompt = [
    buildSystemPrompt('WebSearch'),
    '', '───────────────', '',
    userPrompt,
    '', '───────────────',
    '출력 규칙: JSON 객체 **하나만** 출력해라. 코드펜스·머리말·요약을 붙이지 마라.',
    '파일을 쓰지 마라. 표준출력에 JSON 만 낸다.',
  ].join('\n');

  const r = spawnSync('claude', [
    '-p', prompt,
    '--model', model,
    '--permission-mode', 'default',
    '--allowed-tools', 'WebSearch,WebFetch',
  ], {
    cwd: resolve(import.meta.dirname, '../..'),
    encoding: 'utf-8',
    timeout: timeoutSec * 1000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });

  if (r.error?.code === 'ENOENT') throw new Error('claude CLI 를 찾을 수 없다 (launchd PATH 확인)');
  if (r.signal === 'SIGTERM') throw new Error(`claude -p 타임아웃 (${timeoutSec}s)`);
  if (r.status !== 0) throw new Error(`claude -p 종료코드 ${r.status}: ${(r.stderr || '').slice(0, 300)}`);

  const text = (r.stdout || '').trim();
  if (!text) throw new Error('claude -p 응답이 비었다');

  return {
    text,
    backend: 'claude-websearch',
    groundingMeta: null,
    webSearchQueries: [],       // claude 는 던진 검색어를 구조화해 돌려주지 않는다
    evidenceUrls: extractEvidenceUrls(text),
    groundedByChunks: false,
    groundedByQueries: false,   // claude 는 던진 검색어를 구조화해 돌려주지 않는다
    grounded: false,            // URL 실존 검증 후 호출자가 확정한다
    usage: null,
    attempts: 1,
    retried: false,
  };
}

async function callGeminiWithSearch(userPrompt, model, opts = {}) {
  const key = getSecret('GOOGLE_AI_API_KEY');
  if (!key) throw new Error('GOOGLE_AI_API_KEY not set');

  const url = `${API_BASE}/models/${model}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: 8000,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
  if (!text) throw new Error(`No content: ${JSON.stringify(data).slice(0, 300)}`);

  const groundingMeta = data.candidates?.[0]?.groundingMetadata || null;
  const webSearchQueries = groundingMeta?.webSearchQueries || groundingMeta?.web_search_queries || [];
  const groundingChunks = groundingMeta?.groundingChunks || groundingMeta?.grounding_chunks || [];

  // E-5 (2026-04-26 개선): grounded 판정 로직 확장 — Gemini 2.5-pro가 groundingChunks
  // 메타데이터를 누락하는 응답 구조 특성에 대응.
  //   레거시: groundingChunks.length > 0 → grounded:true
  //   확장:  (groundingChunks.length > 0)
  //          OR (webSearchQueries.length > 0 AND evidence 본문에 ≥ N URL 실존)
  // EVIDENCE_MIN_URLS는 환경변수 GEMINI_FACTCHECK_EVIDENCE_MIN (기본 1).
  const evidenceUrls = extractEvidenceUrls(text);
  const minEvidenceUrls = parseInt(process.env.GEMINI_FACTCHECK_EVIDENCE_MIN || '1', 10);
  const groundedByChunks = groundingChunks.length > 0;
  const groundedByQueries = webSearchQueries.length > 0 && evidenceUrls.length >= minEvidenceUrls;
  const grounded = groundedByChunks || groundedByQueries;

  return {
    text,
    backend: 'gemini-google_search',
    groundingMeta,
    webSearchQueries,
    evidenceUrls,
    groundedByChunks,
    groundedByQueries,
    grounded,
    usage: data.usageMetadata || null,
  };
}

/**
 * grounding-enforced wrapper — grounded:false 응답 시 1회 강화 prompt로 재시도.
 * GEMINI_FACTCHECK_FORCE_GROUNDING=false 설정 시 단일 호출로 fallback.
 *
 * E-5 (2026-04-26): grounded 판정이 (groundingChunks) OR (webSearchQueries + evidence URL)
 * 으로 확장되었으므로, 이 wrapper는 첫 호출에서 둘 중 어느 신호든 잡으면 재시도하지 않는다.
 * Cycle 3 중단 사유였던 "groundingChunks 누락 → grounded:false → 무한 재시도" 패턴 해소.
 */
async function callGeminiWithGroundingEnforced(userPrompt, model) {
  const first = await callGeminiWithSearch(userPrompt, model);
  if (first.grounded || !FORCE_GROUNDING) {
    return { ...first, attempts: 1, retried: false };
  }

  console.error('⚠  1차 호출 grounded:false (chunks=0, evidence_urls=0) — 강화 prompt 로 1회 재시도 (GEMINI_FACTCHECK_FORCE_GROUNDING=true)');
  const reinforced = userPrompt + GROUNDING_REINFORCEMENT;
  const second = await callGeminiWithSearch(reinforced, model, { temperature: 0.1 });
  return { ...second, attempts: 2, retried: true, retried_grounded: second.grounded };
}

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : text).trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`Unable to locate JSON object in model output:\n${text.slice(0, 500)}`);
  }
  return JSON.parse(candidate.slice(first, last + 1));
}

function classify(claims) {
  const counts = { HIGH: 0, MED: 0, LOW: 0 };
  for (const c of claims) {
    const k = (c.risk || '').toUpperCase();
    if (k in counts) counts[k]++;
  }
  return counts;
}

function formatMarkdown({ episodeId, channelId, scriptRevision, checkedAt, result, backend = 'gemini-google_search', groundingSources, webSearchQueries, evidenceUrls = [], groundedByChunks = false, groundedByQueries = false, groundedByEvidence = false, verification = null, escalated = 0, flagged = 0 }) {
  const counts = classify(result.claims || []);
  const pass = counts.HIGH === 0;
  const total = (result.claims || []).length;
  // API 가 증명(chunks·queries) OR 우리가 증명(실존 확인된 evidence URL).
  const grounded = groundedByChunks || groundedByQueries || groundedByEvidence;

  const fm = [
    '---',
    `episode_id: ${episodeId}`,
    `channel_id: ${channelId}`,
    `script_revision: ${scriptRevision}`,
    `checked_at: ${checkedAt}`,
    `total_claims: ${total}`,
    `high_risk_count: ${counts.HIGH}`,
    `med_risk_count: ${counts.MED}`,
    `low_risk_count: ${counts.LOW}`,
    `pass: ${pass}`,
    `backend: ${backend}`,
    `grounded: ${grounded}`,
    `grounded_by_chunks: ${groundedByChunks}`,
    `grounded_by_queries: ${groundedByQueries}`,
    `grounded_by_evidence: ${groundedByEvidence}`,
    `evidence_url_count: ${evidenceUrls.length}`,
    `grounding_source_count: ${groundingSources.length}`,
    `search_query_count: ${webSearchQueries?.length || 0}`,
    // URL 실존 검증 — 사후에 "이 리포트가 뭘로 뒷받침됐나"를 답할 수 있어야 한다
    `evidence_checked: ${verification?.checked ?? 0}`,
    `evidence_alive: ${verification?.alive ?? 0}`,
    `evidence_fabricated: ${verification?.fabricated ?? 0}`,
    `evidence_blocked: ${verification?.blocked ?? 0}`,
    `evidence_unreachable: ${verification?.unreachable ?? 0}`,
    `evidence_verification_ran: ${verification?.ran ?? false}`,
    `claims_escalated_by_evidence: ${escalated}`,
    `claims_flagged_by_evidence: ${flagged}`,
    '---',
    '',
  ].join('\n');

  const groupsOrder = ['HIGH', 'MED', 'LOW'];
  const groups = { HIGH: [], MED: [], LOW: [] };
  for (const c of result.claims || []) {
    const key = (c.risk || '').toUpperCase();
    if (groups[key]) groups[key].push(c);
  }

  const sections = ['# Fact Check Report', ''];
  sections.push('## Summary');
  sections.push(`- 총 검증 항목: ${total}개`);
  sections.push(`- HIGH: ${counts.HIGH} | MED: ${counts.MED} | LOW: ${counts.LOW}`);
  sections.push(`- **판정**: ${pass ? 'PASS' : 'FAIL'}`);
  if (result.summary) sections.push(`- 요약: ${result.summary}`);
  sections.push('');

  sections.push('## Detailed Findings');
  sections.push('');

  for (const g of groupsOrder) {
    for (const c of groups[g]) {
      sections.push(`### [${g}] Scene ${c.scene_id || '?'}: "${(c.claim || '').slice(0, 120)}"`);
      sections.push(`- **주장**: ${c.claim || ''}`);
      sections.push(`- **검증 결과**: ${c.verdict || '미기재'}`);
      sections.push(`- **근거**: ${c.evidence || '미기재'}`);
      if (g !== 'LOW' && c.suggested_revision) {
        sections.push(`- **수정 제안**: "${c.suggested_revision}"`);
      }
      if (c.risk_reason) sections.push(`- **위험 사유**: ${c.risk_reason}`);
      sections.push('');
    }
  }

  if (!grounded) {
    sections.push('> ⚠ **Grounding 미활성**: 모델이 검색 도구를 호출하지 않고 내부 지식만으로 응답했거나, 인용 URL 이 하나도 실존 확인되지 않았습니다. evidence 는 모델의 학습 데이터 기반이며 실시간 검증이 아닙니다. HIGH 위험 결정 전 수동 재확인 권장.');
    sections.push('');
  }

  if (verification && verification.checked > 0) {
    sections.push('## Evidence URL Verification');
    sections.push('');
    sections.push(`- 검사: ${verification.checked}건 (인용 형식 미달 ${verification.not_citable}건 제외)`);
    sections.push(`- **실존 확인 ${verification.alive}** / **날조 ${verification.fabricated}** / 봇차단 ${verification.blocked} / 도달불가 ${verification.unreachable}`);
    if (escalated > 0) {
      sections.push(`- ⛔ 살아있는 근거가 없어 **claim ${escalated}개를 HIGH 로 자동 격상**했습니다 (검증 불가 = HIGH).`);
    }
    if (flagged > 0) {
      sections.push(`- ⚠ claim ${flagged}개는 인용 일부가 죽었으나 실존 확인된 근거가 남아 **MED 로 표시**했습니다 (주장 유지).`);
    }
    if (!verification.ran) {
      sections.push('- ⚠ 검사한 URL 이 전부 봇차단·도달불가라 **검증이 판정을 내지 못했습니다**. 이 리포트를 "URL 검증 통과" 로 읽지 마십시오.');
    }
    sections.push('');
    sections.push('> 봇차단(401·403·429)은 날조가 아닙니다 — bls.gov 는 실재하는 문서에도 403 을 줍니다. 실존 증명이 안 될 뿐입니다.');
    sections.push('');
    const bad = verification.results.filter((r) => r.verdict === 'fabricated');
    if (bad.length > 0) {
      sections.push('### 날조된 인용');
      for (const r of bad) sections.push(`- \`${r.url}\` — ${r.status ? `HTTP ${r.status}` : r.error}`);
      sections.push('');
    }
  }

  if (webSearchQueries && webSearchQueries.length > 0) {
    sections.push('## Search Queries Used');
    for (const q of webSearchQueries) sections.push(`- \`${q}\``);
    sections.push('');
  }

  if (groundingSources && groundingSources.length > 0) {
    sections.push('## Grounding Sources (Google Search)');
    for (const s of groundingSources) {
      sections.push(`- ${s}`);
    }
    sections.push('');
  }

  return fm + sections.join('\n');
}

function collectGroundingSources(meta) {
  if (!meta) return [];
  const chunks = meta.groundingChunks || meta.grounding_chunks || [];
  const sources = [];
  for (const ch of chunks) {
    const web = ch.web || ch.Web;
    if (web?.uri) sources.push(`${web.title || ''} — ${web.uri}`.trim());
  }
  return Array.from(new Set(sources)).slice(0, 20);
}

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      engine: { type: 'string' },              // claude | gemini | auto(기본)
      force: { type: 'boolean', default: false },
      model: { type: 'string', short: 'm' },
      platform: { type: 'string', short: 'p' },
      format: { type: 'string', short: 'f' },
    },
  });
  if (!values.episode) {
    console.error('Usage: run-factcheck.js --episode <EP-YYYY-NNNN> [--platform shorts|long] [--engine claude|gemini] [--force] [--model <model>]');
    process.exit(1);
  }

  let epDir = values.episode;
  if (!epDir.startsWith('/') && !epDir.startsWith('workspace/')) {
    epDir = join('workspace/episodes', values.episode);
  }
  const absEp = resolve(epDir);

  // v2 layout (platforms/) 자동 감지 + v1 fallback
  const fmtArg = values.format || values.platform || 'long-3min';
  const p = resolvePaths(absEp, fmtArg);
  const scriptPath = p.script;
  const outPath = p.factcheck;

  if (!existsSync(scriptPath)) {
    console.error(`❌ ${scriptPath} 없음 — S4 Script 먼저 실행`);
    process.exit(1);
  }

  if (existsSync(outPath) && !values.force) {
    const existing = readIfExists(outPath);
    const passMatch = existing.match(/^pass:\s*(true|false)/m);
    const highMatch = existing.match(/^high_risk_count:\s*(\d+)/m);
    const totalMatch = existing.match(/^total_claims:\s*(\d+)/m);
    if (passMatch) {
      const result = {
        pass: passMatch[1] === 'true',
        total_claims: totalMatch ? parseInt(totalMatch[1], 10) : 0,
        high_risk_count: highMatch ? parseInt(highMatch[1], 10) : 0,
        med_risk_count: 0,
        low_risk_count: 0,
        file: outPath,
        cached: true,
      };
      console.log(JSON.stringify(result));
      process.exit(0);
    }
  }

  const scriptText = readFileSync(scriptPath, 'utf-8');
  const researchText = readIfExists(join(absEp, '10_market_research.md'));
  const strategyText = readIfExists(join(absEp, '20_strategy.md'));
  const fm = parseScriptFrontmatter(scriptText);
  const episodeId = fm.episode_id || 'EP-UNKNOWN';
  const channelId = fm.channel_id || 'econ-daily';
  const scriptRevision = fm.revision ?? 1;

  const userPrompt = [
    '[AUTHORITATIVE PIPELINE MARKET RESEARCH]',
    researchText || '(not available)',
    '',
    '[CONTENT STRATEGY AND FACT BOUNDARIES]',
    strategyText || '(not available)',
    '',
    '[EPISODE SCRIPT TO FACT-CHECK]',
    scriptText,
    '',
    '---',
    'Extract every verifiable claim from every scene narration. Verify each using google_search against reliable sources for the exact date/traded_at in the pipeline research.',
    'Return the JSON object per the OUTPUT SCHEMA. Do not include the script itself in the output.',
  ].join('\n');

  const requested = values.engine || process.env.BT_FACTCHECK_ENGINE || 'auto';
  const chain = requested === 'auto' ? ENGINE_CHAIN : [requested];

  const runEngine = async (name) => {
    switch (name) {
      case 'claude':
        return callClaudeFactcheck(userPrompt, values.model || 'sonnet');
      case 'gemini':
        return callGeminiWithGroundingEnforced(userPrompt, values.model || DEFAULT_MODEL);
      default:
        throw new Error(`알 수 없는 엔진: ${name} (가능: claude | gemini)`);
    }
  };

  let factcheckResp;
  const failures = [];
  for (const [i, name] of chain.entries()) {
    try {
      console.error(`🔍 Factcheck: ${episodeId} (engine=${name}${i > 0 ? `, 폴백 ${i}/${chain.length - 1}` : ''}, force_grounding=${FORCE_GROUNDING})`);
      factcheckResp = await runEngine(name);
      break;
    } catch (e) {
      failures.push(`${name}: ${String(e.message).slice(0, 120)}`);
      if (i === chain.length - 1) {
        console.error(`❌ 모든 엔진 실패:\n${failures.map((f) => `   - ${f}`).join('\n')}`);
        throw e;
      }
      console.error(`   ⚠ ${failures.at(-1)} → 다음 엔진`);
    }
  }

  const {
    text,
    backend,
    groundingMeta,
    webSearchQueries,
    usage,
    attempts,
    retried,
    evidenceUrls = [],
    groundedByChunks = false,
    groundedByQueries = false,
  } = factcheckResp;

  let result;
  try { result = extractJSON(text); }
  catch (e) {
    console.error(`❌ JSON parse failed: ${e.message}`);
    console.error('--- raw output ---');
    console.error(text.slice(0, 1000));
    process.exit(2);
  }

  if (!Array.isArray(result.claims)) {
    console.error(`❌ result.claims is not an array`);
    process.exit(2);
  }

  // ── evidence URL 실존 검증 (엔진 무관) ──────────────────────────
  // claude 경로에는 groundingMetadata 가 없어 이게 유일한 증명이고,
  // Gemini 경로도 URL 을 지어낼 수 있으므로 똑같이 건다.
  const claimUrls = Array.from(new Set(
    result.claims.flatMap((c) => extractEvidenceUrls(c.evidence || '')),
  ));
  const verification = await verifyEvidenceUrls(claimUrls);
  const { claims: verifiedClaims, escalated, flagged } = escalateFabricatedEvidence(result.claims, verification);
  result.claims = verifiedClaims;

  if (escalated > 0) {
    console.error(`❌ 근거 URL 날조 ${verification.fabricated}건 → claim ${escalated}개를 HIGH 로 격상 (살아있는 근거 없음 = 검증 불가)`);
  }
  if (flagged > 0) {
    console.error(`⚠  claim ${flagged}개의 인용 일부가 죽었다 → MED 로 표시 (살아있는 근거가 남아 주장은 유지)`);
  }
  if (claimUrls.length > 0 && !verification.ran) {
    console.error(`⚠  URL 검증이 판정을 내지 못했다 (checked=${verification.checked}, blocked=${verification.blocked}, unreachable=${verification.unreachable}) — 통과로 읽지 말 것`);
  }

  // grounded 확정 — 세 신호는 서로 독립이고 하나라도 서면 인정한다.
  //   chunks   : Gemini API 가 "읽은 페이지" 를 증명 (가장 강함, Gemini 전용)
  //   queries  : Gemini API 가 "던진 검색어" 를 보고 (Gemini 전용, E-5 레거시)
  //   evidence : 우리가 인용 URL 의 실존을 확인 (엔진 무관, 2026-08-13 신설)
  //
  // evidence 를 queries 자리에 덮어쓰지 않는 이유: 봇차단이 심한 날 Gemini 경로가
  // 갑자기 grounded=false 로 떨어지고, auto-pipeline.sh 의 "MED>0 && !grounded" 게이트가
  // 전에는 통과하던 EP 를 사람 대기로 세운다. 새 신호는 더하기만 한다.
  const groundedByEvidence = verification.alive > 0;
  const grounded = groundedByChunks || groundedByQueries || groundedByEvidence;

  const counts = classify(result.claims);
  const groundingSources = collectGroundingSources(groundingMeta);

  const md = formatMarkdown({
    episodeId,
    channelId,
    scriptRevision,
    checkedAt: new Date().toISOString(),
    result,
    backend,
    groundingSources,
    webSearchQueries,
    evidenceUrls,
    groundedByChunks,
    groundedByQueries,
    groundedByEvidence,
    verification,
    escalated,
    flagged,
  });
  writeFileSync(outPath, md, 'utf-8');

  if (!grounded) {
    // 인용 URL 자체가 없거나, 있어도 하나도 실존 확인되지 않았다 = 근거가 모델 기억뿐이다.
    if (FORCE_GROUNDING && retried) {
      console.error(`❌ grounding 강제 재시도 후에도 비활성 — 검색 호출 거부. evidence 는 모델 지식 기반. 운영자 검토 필요.`);
    } else {
      console.error(`⚠  grounding 비활성 (backend=${backend}, chunks=${groundingSources.length}, 실존확인 URL=${verification.alive}) — evidence 는 모델 지식 기반, 실시간 검색 아님.`);
    }
  } else if (groundedByEvidence && !groundedByChunks) {
    console.error(`ℹ️  URL 실존 검증으로 grounded 인정 — ${verification.alive}/${verification.checked}건 확인 (backend=${backend}).`);
  }

  const summary = {
    pass: counts.HIGH === 0,
    total_claims: result.claims.length,
    high_risk_count: counts.HIGH,
    med_risk_count: counts.MED,
    low_risk_count: counts.LOW,
    file: outPath,
    backend,
    grounded,
    grounded_by_chunks: groundedByChunks,
    grounded_by_queries: groundedByQueries,
    grounded_by_evidence: groundedByEvidence,
    evidence_url_count: evidenceUrls.length,
    evidence_checked: verification.checked,
    evidence_alive: verification.alive,
    evidence_fabricated: verification.fabricated,
    evidence_blocked: verification.blocked,
    evidence_unreachable: verification.unreachable,
    evidence_verification_ran: verification.ran,
    claims_escalated_by_evidence: escalated,
    claims_flagged_by_evidence: flagged,
    grounding_sources: groundingSources.length,
    grounding_attempts: attempts ?? 1,
    grounding_retried: retried ?? false,
    force_grounding: FORCE_GROUNDING,
    usage: usage ? { prompt: usage.promptTokenCount, completion: usage.candidatesTokenCount } : null,
  };
  console.log(JSON.stringify(summary));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}

export { parseScriptFrontmatter, classify, formatMarkdown, extractJSON };
