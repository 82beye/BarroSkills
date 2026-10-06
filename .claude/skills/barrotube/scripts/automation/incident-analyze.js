#!/usr/bin/env node
/**
 * incident-analyze.js — 멈춘·실패한 회차의 원인 분석과 수정 설계서를 자동으로 만든다.
 *
 * lib/auto-pipeline.sh 의 halt_for_human / fail_with_alert 가 사람을 부르기 직전에 부른다.
 * 로그 꼬리·실패 문구를 내는 코드 발췌·같은 단계 이력(결정론 증거 묶음)을 읽기 전용 LLM
 * (codex → claude)에 주고, 원인·분류·고칠 자리·회귀 테스트·재개 방법을 받는다.
 * 로그인·한도·네트워크 같은 환경 실패는 LLM 없이 '환경' 으로 분류한다.
 *
 * 코드는 바꾸지 않는다 — 분석·설계까지. 구현은 사람이 승인한 세션이 설계서를 보고 한다.
 *
 * 산출: workspace/growth/incidents/<id>.md · workspace/growth/incidents.jsonl
 * stdout 마지막 줄: INCIDENT=<id> / INCIDENT_SUMMARY=<텔레그램 한 줄>
 *
 * Usage:
 *   node scripts/automation/incident-analyze.js --ep EP-2026-0214 --slot us-close --kind halt \
 *     --stage "Phase 6 재작성" --detail "…" [--log logs/cron/us-close] [--engine codex|claude] [--dry-run]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { STAGE_CODE } from './lib/growth-diagnosis.js';
import { loadAudit } from './lib/growth-dossier.js';
import { callClaudeCode, callCodex, resolveChain, runEngineChain } from './lib/text-engine.js';
import {
  alertLine, buildAnalysisPrompt, codeExcerpt, envAnalysis, errorLines, findMessageSources, incidentId,
  incidentMarkdown, matchEnvFailure, needlesOf, NEXT_RUN, parseAnalysis, runSlice, sameStageHistory, shouldSkipStage, stageKey, stopMarkers,
} from './lib/incident-analysis.js';

const ROOT = resolve(import.meta.dirname, '../..');
const GROWTH = join(ROOT, 'workspace', 'growth');

function tail(path, n) {
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf-8').split('\n');
  return lines.slice(-n).join('\n');
}

function codeFiles() {
  const dirs = [['lib', /\.sh$/], ['scripts/automation', /\.js$/], ['scripts/automation/lib', /\.js$/]];
  const out = [];
  for (const [dir, re] of dirs) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      // 분석기 자신은 실패 문구를 예시로 품고 있어 검색을 흐린다.
      if (re.test(name) && !/^incident-analy/.test(name)) out.push({ path: `${dir}/${name}`, text: readFileSync(join(abs, name), 'utf-8') });
    }
  }
  return out;
}

function previousAnalyses(stage) {
  const f = join(GROWTH, 'incidents.jsonl');
  if (!existsSync(f)) return [];
  const key = stageKey(stage);
  const rows = readFileSync(f, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  // 처리 기록을 붙인다 — 「고쳤다던 원인이 또 났다」 는 분석가가 알아야 할 가장 큰 단서다.
  const done = new Map(rows.filter((r) => r.type === 'resolution').map((r) => [r.id, `${r.status}: ${r.note ?? ''}`]));
  return rows
    .filter((r) => r.type !== 'resolution' && key && stageKey(r.stage) === key)
    .slice(-5)
    .map((r) => ({ ...r, resolution: done.get(r.id) ?? null }));
}

/** 분석가가 대조할 원자료 — 에피소드 텍스트 파일과 그날 수집 데이터. 매체 파일은 뺀다. */
function readablePaths(ep, dayHint) {
  const out = [];
  const epDir = ep ? join(ROOT, 'workspace', 'episodes', ep) : null;
  const walk = (dir, rel, depth) => {
    if (!existsSync(dir) || depth > 3) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith('.') && name.name !== '.factcheck-revs') continue;
      if (name.isDirectory()) { if (name.name !== '40_assets' && name.name !== '55_render') walk(join(dir, name.name), `${rel}/${name.name}`, depth + 1); }
      else if (/\.(md|json|ya?ml|txt)$/.test(name.name)) out.push(`${rel}/${name.name}`);
    }
  };
  if (epDir) walk(epDir, `workspace/episodes/${ep}`, 0);
  const script = out.find((p) => p.endsWith('/30_script.md'));
  const date = script && readFileSync(join(ROOT, script), 'utf-8').match(/^summary_date:\s*(\S+)/m)?.[1];
  const day = date || dayHint;
  const news = join(ROOT, 'workspace', 'daily-news', day);
  if (existsSync(news)) for (const n of readdirSync(news)) if (/\.(json|md)$/.test(n)) out.push(`workspace/daily-news/${day}/${n}`);
  return out.slice(0, 60);
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

async function main() {
  const { values } = parseArgs({
    options: {
      ep: { type: 'string', default: '' },
      slot: { type: 'string', default: '' },
      kind: { type: 'string', default: 'halt' },
      stage: { type: 'string' },
      detail: { type: 'string', default: '' },
      log: { type: 'string' },
      engine: { type: 'string' },
      timeout: { type: 'string', default: '240' },
      'scan-lines': { type: 'string', default: '4000' },
      at: { type: 'string' },   // 소급 분석 때 원래 사건 시각
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.stage) {
    console.error('Usage: incident-analyze.js --stage "<Phase N …>" [--ep EP] [--slot slot] [--kind halt|fail] [--detail …] [--log logs/cron/<name>]');
    process.exit(1);
  }
  if (shouldSkipStage(values.stage)) {
    console.log(`⏭  ${values.stage} 는 자동 분석 대상이 아니다 (가드·게시 이후 단계)`);
    return;
  }

  const now = new Date();
  // 같은 분에 두 건(소급 분석 등)이면 설계서가 덮이지 않게 접미사를 붙인다.
  let id = incidentId(now);
  for (let n = 2; existsSync(join(GROWTH, 'incidents', `${id}.md`)); n += 1) id = `${incidentId(now)}-${n}`;
  const incident = {
    id, at: values.at || now.toISOString(), ep: values.ep || null, slot: values.slot || null,
    kind: values.kind, stage: values.stage, detail: values.detail,
  };

  const base = values.log ? resolve(ROOT, values.log) : join(ROOT, 'logs', 'cron', values.slot || 'auto-pipeline');
  // 지난 회차를 소급 분석하면(--scan-lines 크게) 그 회차가 로그 앞쪽에 있다 — 다음 회차 시작 전에서 자른다.
  const scan = Number.parseInt(values['scan-lines'], 10) || 4000;
  const logTail = runSlice(tail(`${base}.log`, scan), values.ep, { fallback: 80, until: NEXT_RUN.log }).split('\n').slice(-120).join('\n');
  const errTail = runSlice(tail(`${base}.err`, scan), values.ep, { lead: 20, fallback: 80, until: NEXT_RUN.err, stopAt: stopMarkers(values.stage) }).split('\n').slice(-200).join('\n');
  // stderr 가 실패 문구를 담는다 — 뒤에 붙여 '가장 최근' 으로 읽히게 한다.
  const errLines = errorLines(`${logTail}\n${errTail}`, 30);

  // 실패 문구 → 그 문구를 내는 코드. 최신 줄이 가장 직접적인 원인 메시지다.
  const needles = [...needlesOf(values.detail), ...errLines.slice().reverse().slice(0, 8).flatMap(needlesOf)];
  const files = codeFiles();
  const excerpts = findMessageSources(needles, files, 4).map((h) => ({
    ...h, excerpt: codeExcerpt(files.find((f) => f.path === h.path).text, h.line, 30),
  }));
  const history = sameStageHistory(loadAudit(ROOT, now, 14), values.stage);
  // 원자료 날짜 = 대본의 summary_date, 없으면 사건 시각의 KST 날짜(소급 분석이면 그날).
  const readable = readablePaths(values.ep, new Date(Date.parse(incident.at) + 9 * 3600e3).toISOString().slice(0, 10));
  const previous = previousAnalyses(values.stage);

  let analysis = null;
  let engine = null;
  const env = matchEnvFailure(`${values.detail}\n${errLines.join('\n')}`);
  if (env) {
    analysis = envAnalysis(env);
  } else if (values['dry-run']) {
    const { system, user } = buildAnalysisPrompt({ incident, errLines, logTail, excerpts, history, previous, readable, stageCode: STAGE_CODE[stageKey(values.stage)] });
    console.log(`[DRY_RUN] system ${system.length}자 · 증거 ${user.length}자 · 코드 발췌 ${excerpts.length}곳`);
    excerpts.forEach((x) => console.log(`   ${x.path}:${x.line} 「${x.needle}」`));
    return;
  } else {
    const { system, user } = buildAnalysisPrompt({ incident, errLines, logTail, excerpts, history, previous, readable, stageCode: STAGE_CODE[stageKey(values.stage)] });
    const timeout = Number.parseInt(values.timeout, 10) || 240;
    const chain = values.engine ? [values.engine] : resolveChain(process.env.BT_INCIDENT_ENGINE_CHAIN, 'codex,claude');
    try {
      const got = await runEngineChain(chain, {
        codex: () => ({ json: callCodex(system, user, null, timeout), used: 'codex' }),
        claude: () => ({ json: callClaudeCode(system, user, 'sonnet', timeout), used: 'claude' }),
      }, { log: () => {}, warn: (m) => console.error(m), error: (m) => console.error(m) });
      analysis = parseAnalysis(got.json);
      engine = got.engineUsed;
    } catch (e) {
      console.error(`⚠ 자동 분석 엔진 실패: ${String(e.message).slice(0, 200)}`);
    }
  }
  if (!analysis) {
    analysis = {
      root_cause: '자동 분석이 결론을 내지 못했다 — 증거 묶음(로그 줄·코드 위치)만 남긴다.',
      class: 'code', status: 'open', confidence: null, evidence: errLines.slice(-5),
      fix: { summary: '', files: excerpts.map((x) => x.path), steps: [], test: '' }, resume: '',
    };
  }

  mkdirSync(join(GROWTH, 'incidents'), { recursive: true });
  writeAtomic(join(GROWTH, 'incidents', `${id}.md`), incidentMarkdown(id, incident, analysis, { excerpts, history, engine }));
  appendFileSync(join(GROWTH, 'incidents.jsonl'), `${JSON.stringify({
    id, at: incident.at, ep: incident.ep, slot: incident.slot, kind: incident.kind, stage: incident.stage,
    class: analysis.class, status: analysis.status, confidence: analysis.confidence, root_cause: analysis.root_cause,
    files: analysis.fix.files, engine,
  })}\n`);

  console.log(`🔎 ${id} [${analysis.class}] ${analysis.root_cause}`);
  console.log(`INCIDENT=${id}`);
  console.log(`INCIDENT_SUMMARY=${alertLine(id, analysis).replace(/\n/g, ' ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`❌ incident-analyze: ${e.message}`);
    process.exit(1);
  });
}
