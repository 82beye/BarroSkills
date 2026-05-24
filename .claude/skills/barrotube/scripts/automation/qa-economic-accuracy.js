#!/usr/bin/env node
/**
 * qa-economic-accuracy.js — 경제 정확성 사전 자동 검사 (QA Reviewer 보조)
 *
 * 입력: workspace/episodes/EP-XXXX/30_script.md (또는 platforms/long/30_script.md)
 * 출력: stdout JSON (findings) + (--write 옵션 시) 60_qa_report.md `## 📐 경제 정확성 검사` 섹션 append
 *
 * 검사 항목:
 *   1. 한글 숫자 emphasis token (HIGH)
 *   2. 콤마 누락 큰 수 (MEDIUM)
 *   3. % vs %p 혼용 의심 (MEDIUM)
 *   4. 헷지/펀더멘탈 등 비표준 표기 (LOW)
 *   5. 비율 합계 산술 모순 후보 (MEDIUM)
 *
 * Usage:
 *   node qa-economic-accuracy.js --episode EP-2026-0028
 *   node qa-economic-accuracy.js --episode EP-2026-0028 --write
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');

// Match hangul numerals followed by currency/unit — requires at least one
// "counting" hangul digit (영-구,십,백,천) before the unit (만/억/조/경/원/달러/etc.)
// to avoid false positives on "57.2조 원" (arabic+unit combos are fine).
const HANGUL_NUM_RE = /(?<=[영일이삼사오육칠팔구십백천만억조경])(만|억|조|경)\s?(퍼센트|프로|원|달러)/g;
const COMMA_MISSING_RE = /\b(?<!,)(\d{4,})\s?(원|달러|명|억|조)\b/g;
const PCT_VS_PP = /(전\S{0,4}대비|YoY|MoM|QoQ).{0,15}[+\-]?\d+\.?\d*%(?!p|포인트)/g;
const NONSTD_TERMS = [
  { bad: '헷지', good: '헤지' },
  { bad: '헷징', good: '헤지' },
  { bad: '펀더멘탈', good: '펀더멘털' },
  { bad: '듀레이숀', good: '듀레이션' },
  { bad: '이티에프', good: 'ETF' },
  { bad: '페드', good: '연준' },
];

function findScript(episodeId) {
  const candidates = [
    join(ROOT, 'workspace/episodes', episodeId, 'platforms/long/30_script.md'),
    join(ROOT, 'workspace/episodes', episodeId, 'platforms/shorts/30_script.md'),
    join(ROOT, 'workspace/episodes', episodeId, '30_script.md'),
  ];
  return candidates.find(existsSync);
}

function findQAReport(episodeId) {
  const candidates = [
    join(ROOT, 'workspace/episodes', episodeId, 'platforms/long/60_qa_report.md'),
    join(ROOT, 'workspace/episodes', episodeId, 'platforms/shorts/60_qa_report.md'),
    join(ROOT, 'workspace/episodes', episodeId, '60_qa_report.md'),
  ];
  return candidates.find(existsSync);
}

function check(text) {
  const findings = { hangul_number: [], comma_missing: [], pct_vs_pp: [], nonstd_term: [], arithmetic_suspect: [] };
  let m;
  while ((m = HANGUL_NUM_RE.exec(text))) findings.hangul_number.push({ match: m[0], at: m.index });
  HANGUL_NUM_RE.lastIndex = 0;
  while ((m = COMMA_MISSING_RE.exec(text))) findings.comma_missing.push({ match: m[0], at: m.index });
  COMMA_MISSING_RE.lastIndex = 0;
  while ((m = PCT_VS_PP.exec(text))) findings.pct_vs_pp.push({ match: m[0], at: m.index });
  PCT_VS_PP.lastIndex = 0;
  for (const { bad, good } of NONSTD_TERMS) {
    const re = new RegExp(bad, 'g');
    while ((m = re.exec(text))) findings.nonstd_term.push({ bad, good, at: m.index });
  }
  // 산술 의심: "X% + Y% + Z%" 패턴 — 합이 100%가 아니면 표기
  const ratioRe = /(\d+\.?\d*)\s*%[\s,·+]+(\d+\.?\d*)\s*%[\s,·+]+(\d+\.?\d*)\s*%/g;
  while ((m = ratioRe.exec(text))) {
    const sum = parseFloat(m[1]) + parseFloat(m[2]) + parseFloat(m[3]);
    if (Math.abs(sum - 100) > 0.5) {
      findings.arithmetic_suspect.push({ match: m[0], sum, expected: 100 });
    }
  }
  return findings;
}

function severity(findings) {
  if (findings.hangul_number.length > 0) return 'HIGH';
  if (findings.arithmetic_suspect.length > 0) return 'HIGH';
  const total = findings.comma_missing.length + findings.pct_vs_pp.length + findings.nonstd_term.length;
  if (total >= 5) return 'MEDIUM';
  return 'LOW';
}

function renderReport(findings, sev) {
  let out = '\n## 📐 경제 정확성 검사 (qa-economic-accuracy.js v1)\n\n';
  out += `**risk: ${sev}** | scanned at ${new Date().toISOString()}\n\n`;
  if (findings.hangul_number.length) {
    out += '### ❌ 한글 숫자 emphasis token (HIGH 자동 승격)\n';
    findings.hangul_number.forEach(f => out += `- \`${f.match}\` @ ${f.at}\n`);
    out += '\n';
  }
  if (findings.comma_missing.length) {
    out += '### ⚠ 콤마 누락 큰 수 (MEDIUM)\n';
    findings.comma_missing.forEach(f => out += `- \`${f.match}\` @ ${f.at}\n`);
    out += '\n';
  }
  if (findings.pct_vs_pp.length) {
    out += '### ⚠ %/%p 혼용 의심 (MEDIUM)\n';
    findings.pct_vs_pp.forEach(f => out += `- \`${f.match}\` @ ${f.at}\n`);
    out += '\n';
  }
  if (findings.nonstd_term.length) {
    out += '### ℹ 비표준 표기 (LOW)\n';
    findings.nonstd_term.forEach(f => out += `- \`${f.bad}\` → \`${f.good}\` @ ${f.at}\n`);
    out += '\n';
  }
  if (findings.arithmetic_suspect.length) {
    out += '### ❌ 산술 합계 모순 (HIGH)\n';
    findings.arithmetic_suspect.forEach(f => out += `- \`${f.match}\` 합=${f.sum} (기대 ${f.expected})\n`);
    out += '\n';
  }
  if (Object.values(findings).every(v => v.length === 0)) {
    out += '✅ 모든 검사 통과\n';
  }
  out += '\n_Writer 재집필 트리거: HIGH 발견 시 Producer에 escalation. 최대 2회._\n';
  return out;
}

async function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string', short: 'e' },
    write: { type: 'boolean', default: false },
  }});
  if (!values.episode) {
    console.error('Usage: --episode EP-2026-0028 [--write]');
    process.exit(1);
  }
  const scriptPath = findScript(values.episode);
  if (!scriptPath) { console.error(`script not found for ${values.episode}`); process.exit(2); }
  const rawText = readFileSync(scriptPath, 'utf-8');
  // Strip YAML frontmatter (between --- delimiters) to avoid false positives
  // from TTS narration fields where hangul numbers are intentional.
  const fmMatch = rawText.match(/^---\n[\s\S]*?\n---\n?/);
  const text = fmMatch ? rawText.slice(fmMatch[0].length) : rawText;
  const findings = check(text);
  const sev = severity(findings);
  const report = renderReport(findings, sev);
  console.log(JSON.stringify({ episode: values.episode, severity: sev, findings, scriptPath }, null, 2));
  if (values.write) {
    const reportPath = findQAReport(values.episode);
    if (reportPath) {
      appendFileSync(reportPath, report, 'utf-8');
      console.error(`appended to ${reportPath}`);
    } else {
      console.error('no 60_qa_report.md found — skipping write');
    }
  }
  if (sev === 'HIGH') process.exit(10);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
