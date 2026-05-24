#!/usr/bin/env node

/**
 * run-factcheck.js — S5 Factcheck Gate (Phase A — Gemini + google_search grounding)
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
 *   node run-factcheck.js --episode EP-2026-0009 --force     # 기존 리포트 덮어쓰기
 *   node run-factcheck.js --episode EP-2026-0009 --model gemini-2.5-pro
 *
 * 판정 규칙 (agent spec §Behavior):
 *   - HIGH 가 1개라도 있으면 pass=false
 *   - 검증 불가 주장은 HIGH 로 분류 (안전 우선)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';
import { resolvePaths } from './paths.js';

const DEFAULT_MODEL = process.env.GEMINI_FACTCHECK_MODEL || 'gemini-2.5-pro';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const SYSTEM_PROMPT = `You are "Fact Checker Agent" of BarroTube, a Korean economy YouTube Shorts channel.

MISSION:
Extract verifiable claims (numbers, years, proper nouns, quotes, statistics) from the provided script and verify each against reliable sources using google_search. Classify risk and suggest revisions.

RULES:
1. Output MUST be a single JSON object. No markdown, no prose, no code fences.
2. Extract every factual claim from every scene. Do not skip any numeric/statistical assertion.
3. For each claim, use google_search to verify against reliable sources (통계청, 한국은행, IMF, World Bank, 연합뉴스, 로이터, AP, BBC, 공식 기업 공시 등).
4. Classify risk:
   - HIGH: 수치 오류, 날짜 오류, 인물/기업 혼동, 법적/규제 위험, 검증 불가 (안전 우선 — unverifiable = HIGH)
   - MED: 맥락 누락, 과장 표현, 불완전한 인용
   - LOW: 사소한 표현 차이, 최신 데이터와 미세 차이
5. For HIGH/MED, always provide "suggested_revision" (corrected Korean sentence, same 스타일/길이).
6. Cite "evidence" with source URL or official document name. Min 2 independent sources for HIGH.
7. If a claim cannot be verified via search, mark HIGH with risk_reason="unverifiable".

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

function readIfExists(p) { return existsSync(p) ? readFileSync(p, 'utf-8') : ''; }

function parseScriptFrontmatter(scriptText) {
  const m = scriptText.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('30_script.md has no YAML frontmatter');
  return parseYAML(m[1]);
}

const FORCE_GROUNDING = (process.env.GEMINI_FACTCHECK_FORCE_GROUNDING || 'true').toLowerCase() !== 'false';

const GROUNDING_REINFORCEMENT = `\n\n[GROUNDING REQUIREMENT — CRITICAL]\nYou MUST call google_search at least once for EVERY claim that contains numbers, dates, proper nouns, or statistical assertions. Do NOT rely on internal knowledge. If you do not call google_search, your response will be rejected and re-issued. For each claim provide a real URL pulled from search results in the "evidence" field.`;

/**
 * 응답 본문에서 http(s) URL을 추출 — fact-check evidence 인용 검증용.
 * Gemini 2.5-pro 응답 구조에서 groundingChunks 메타데이터가 누락되더라도
 * 실제 evidence 필드에 인용 URL이 있으면 grounded:true로 판정 (E-5 개선).
 */
function extractEvidenceUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>)]+/g;
  const urls = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    // 트레일링 punctuation 제거
    const u = String(m[0]).replace(/[.,;:!?\)\]]+$/, '');
    if (u.length > 8) urls.add(u);
  }
  return Array.from(urls);
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
  const groundedByEvidence = webSearchQueries.length > 0 && evidenceUrls.length >= minEvidenceUrls;
  const grounded = groundedByChunks || groundedByEvidence;

  return {
    text,
    groundingMeta,
    webSearchQueries,
    evidenceUrls,
    groundedByChunks,
    groundedByEvidence,
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

function formatMarkdown({ episodeId, channelId, scriptRevision, checkedAt, result, groundingSources, webSearchQueries, evidenceUrls = [], groundedByChunks = false, groundedByEvidence = false }) {
  const counts = classify(result.claims || []);
  const pass = counts.HIGH === 0;
  const total = (result.claims || []).length;
  // E-5 개선: grounded 판정을 (groundingChunks 메타데이터) OR (webSearchQueries + evidence URL 실존)으로 확장.
  const grounded = groundingSources.length > 0 || (webSearchQueries?.length > 0 && evidenceUrls.length > 0);

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
    `backend: gemini-google_search`,
    `grounded: ${grounded}`,
    `grounded_by_chunks: ${groundedByChunks}`,
    `grounded_by_evidence: ${groundedByEvidence}`,
    `evidence_url_count: ${evidenceUrls.length}`,
    `grounding_source_count: ${groundingSources.length}`,
    `search_query_count: ${webSearchQueries?.length || 0}`,
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
    sections.push('> ⚠ **Grounding 미활성**: Gemini 가 google_search tool 을 호출하지 않고 내부 지식만으로 응답했습니다. evidence 필드의 인용은 모델의 학습 데이터 기반이며 실시간 검증이 아닙니다. HIGH 위험 결정 전 수동 재확인 권장.');
    sections.push('');
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
      force: { type: 'boolean', default: false },
      model: { type: 'string', short: 'm' },
      platform: { type: 'string', short: 'p' },
      format: { type: 'string', short: 'f' },
    },
  });
  if (!values.episode) {
    console.error('Usage: run-factcheck.js --episode <EP-YYYY-NNNN> [--platform shorts|long] [--force] [--model gemini-2.5-pro]');
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
  const fm = parseScriptFrontmatter(scriptText);
  const episodeId = fm.episode_id || 'EP-UNKNOWN';
  const channelId = fm.channel_id || 'econ-daily';
  const scriptRevision = fm.revision ?? 1;

  const userPrompt = [
    '[EPISODE SCRIPT TO FACT-CHECK]',
    scriptText,
    '',
    '---',
    'Extract every verifiable claim from every scene narration. Verify each using google_search against reliable sources.',
    'Return the JSON object per the OUTPUT SCHEMA. Do not include the script itself in the output.',
  ].join('\n');

  console.error(`🔍 Factcheck: ${episodeId} (model=${values.model || DEFAULT_MODEL}, force_grounding=${FORCE_GROUNDING})`);

  const factcheckResp = await callGeminiWithGroundingEnforced(userPrompt, values.model || DEFAULT_MODEL);
  const {
    text,
    groundingMeta,
    webSearchQueries,
    grounded,
    usage,
    attempts,
    retried,
    evidenceUrls = [],
    groundedByChunks = false,
    groundedByEvidence = false,
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

  const counts = classify(result.claims);
  const groundingSources = collectGroundingSources(groundingMeta);

  const md = formatMarkdown({
    episodeId,
    channelId,
    scriptRevision,
    checkedAt: new Date().toISOString(),
    result,
    groundingSources,
    webSearchQueries,
    evidenceUrls,
    groundedByChunks,
    groundedByEvidence,
  });
  writeFileSync(outPath, md, 'utf-8');

  // E-5 개선: groundingChunks 메타데이터 비어 있어도 evidence URL이 있으면 grounded로 인정.
  if (groundingSources.length === 0 && evidenceUrls.length === 0) {
    if (FORCE_GROUNDING && retried) {
      console.error(`❌ grounding 강제 재시도 후에도 비활성 — Gemini 가 google_search 호출 거부. evidence 는 모델 지식 기반. 운영자 검토 필요.`);
    } else {
      console.error(`⚠  grounding 비활성 — Gemini 가 google_search 를 호출하지 않음. evidence 는 모델 지식 기반, 실시간 검색 아님.`);
    }
  } else if (groundingSources.length === 0 && evidenceUrls.length > 0 && webSearchQueries.length > 0) {
    console.error(`ℹ️  grounding 메타데이터(groundingChunks) 비어 있으나 evidence 본문에 ${evidenceUrls.length}개 URL + webSearchQueries ${webSearchQueries.length}건 → evidence-based grounded:true 인정 (E-5).`);
  }

  const summary = {
    pass: counts.HIGH === 0,
    total_claims: result.claims.length,
    high_risk_count: counts.HIGH,
    med_risk_count: counts.MED,
    low_risk_count: counts.LOW,
    file: outPath,
    grounded,
    grounded_by_chunks: groundedByChunks,
    grounded_by_evidence: groundedByEvidence,
    evidence_url_count: evidenceUrls.length,
    grounding_sources: groundingSources.length,
    grounding_attempts: attempts,
    grounding_retried: retried,
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
