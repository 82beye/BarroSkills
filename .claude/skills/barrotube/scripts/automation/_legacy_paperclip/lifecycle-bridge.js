#!/usr/bin/env node
/**
 * lifecycle-bridge.js — BarroTube 이슈 라이프사이클 핸드오프 브리지
 *
 * 5분 주기로 회사 이슈를 폴링하며 done 상태 트리거 패턴을 감지해
 * 다음 단계 핸드오프 이슈를 자동 발행한다.
 *
 * 멱등성: handoff 발행 결과는 logs/autonomy/lifecycle-handoffs.jsonl에 키로 저장.
 *         같은 키가 이미 있으면 skip.
 *
 * 핸드오프 규칙 (현재 활성):
 *   - Marketing Analyst done + key=report     → CEO에 "마케팅 리포트 분석" 이슈 발행
 *   - CEO done + key=series-plan              → Producer에 "시리즈 부트스트랩" 이슈 발행 (운영자 검토 필요 라벨)
 *   - QA Reviewer done + verdict=PASS         → Metadata Writer에 "메타데이터 작성" 이슈 발행
 *   - Metadata Writer done + EP S10 board-approved 라벨 → Publisher에 "S11 publish" 이슈 발행
 *
 * Safety:
 *   - autonomy-pause.json status=paused이면 모든 동작 skip
 *   - 일일 신규 이슈 발행 상한 (handoff:CEO-marketing-analysis는 max 1/day, handoff:Producer-series는 max 1/day)
 *   - Publish 자동화는 board-approved 라벨 + 운영자 명시 위임이 모두 있어야 발행
 *
 * Usage:
 *   node lifecycle-bridge.js                # 1회 실행
 *   node lifecycle-bridge.js --dry-run      # 발행 직전까지만, 실제 POST 안 함
 *   node lifecycle-bridge.js --since 30     # 최근 30분 내 done만 검사 (기본 60)
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const LOG_DIR = join(ROOT, 'logs', 'autonomy');
const HANDOFF_LOG = join(LOG_DIR, 'lifecycle-handoffs.jsonl');
const PAUSE_FILE = join(ROOT, 'paperclip', 'config', 'autonomy-pause.json');
const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';
const API_BASE = 'http://localhost:3100';

// 알려진 에이전트 ids (캐시 — agents/ list 조회 후 fill)
const AGENT_BY_NAME = {};

function log(msg) {
  const line = `[${new Date().toISOString()}] [lifecycle-bridge] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'lifecycle-bridge.log'), line + '\n', 'utf-8');
  } catch {}
}

function isPaused() {
  try {
    if (!existsSync(PAUSE_FILE)) return false;
    const j = JSON.parse(readFileSync(PAUSE_FILE, 'utf-8'));
    return j.status === 'paused';
  } catch (e) {
    log(`autonomy-pause read error: ${e.message}`);
    return false;
  }
}

function isDrainOnly() {
  try {
    if (!existsSync(PAUSE_FILE)) return false;
    const j = JSON.parse(readFileSync(PAUSE_FILE, 'utf-8'));
    return j.mode === 'drain-only' || j?.guards?.accept_new_issues === false;
  } catch { return false; }
}

// Producer 페르소나 라우팅 (2026-04-29): format/persona/title 신호로 적합한 Producer 선택
function pickProducerByPersona(sourceIssue) {
  const text = `${sourceIssue?.title || ''}\n${sourceIssue?.description || ''}`;
  const isShorts = /\b(shorts?|barro.?alert|60.?초)\b/i.test(text) || /format\s*[:=]\s*shorts/i.test(text);
  const shortsAgent = AGENT_BY_NAME['Producer Shorts'];
  // Producer Shorts가 아직 생성 안 됐으면 기존 Producer로 fallback
  if (isShorts && shortsAgent) return { id: shortsAgent, name: 'Producer Shorts' };
  return { id: AGENT_BY_NAME['Producer'], name: 'Producer' };
}

async function api(path, opts = {}) {
  const url = `${API_BASE}${path}`;
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) {
    const err = new Error(`API ${r.status} ${path}: ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function loadAgents() {
  const agents = await api(`/api/companies/${COMPANY_ID}/agents`);
  for (const a of agents) AGENT_BY_NAME[a.name] = a.id;
  return agents;
}

async function listIssues({ status, sinceMs }) {
  // status filter: server may not support; we filter client-side too
  const url = `/api/companies/${COMPANY_ID}/issues?limit=200`;
  const list = await api(url);
  const items = Array.isArray(list) ? list : (list.items || list.issues || []);
  const since = sinceMs ? Date.now() - sinceMs : null;
  return items.filter((i) => {
    if (status && i.status !== status) return false;
    if (since && i.completedAt && new Date(i.completedAt).getTime() < since) return false;
    return true;
  });
}

function loadHandoffLog() {
  if (!existsSync(HANDOFF_LOG)) return new Set();
  const lines = readFileSync(HANDOFF_LOG, 'utf-8').split('\n').filter(Boolean);
  const keys = new Set();
  for (const l of lines) {
    try { const j = JSON.parse(l); if (j.key) keys.add(j.key); } catch {}
  }
  return keys;
}

function recordHandoff(key, payload) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(HANDOFF_LOG, JSON.stringify({ key, ...payload, at: new Date().toISOString() }) + '\n', 'utf-8');
}

function todayCountInLog(prefix) {
  if (!existsSync(HANDOFF_LOG)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(HANDOFF_LOG, 'utf-8').split('\n').filter(Boolean);
  let count = 0;
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if ((j.key || '').startsWith(prefix) && (j.at || '').startsWith(today)) count++;
    } catch {}
  }
  return count;
}

async function createHandoffIssue({ title, description, assigneeAgentId, parentId, labels = [], priority = 'medium' }) {
  // FIX 2026-05-23 (Producer normalization):
  //   PaperClip 서버 default status='backlog'이지만 agent inbox-lite는 todo/in_progress/blocked만 노출.
  //   handoff 이슈가 backlog로 들어가면 assignee가 영원히 못 봄 (5/22까지 42건 stranded 누적).
  //   명시적으로 status='todo'로 발행하여 assignment-wakeup이 즉시 spawn 트리거하게 함.
  const body = { title, description, assigneeAgentId, parentId, priority, status: 'todo' };
  // labels are added separately if labelIds are needed; for now description annotation
  const created = await api(`/api/companies/${COMPANY_ID}/issues`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return created;
}

async function fetchIssueDocuments(issueId) {
  // Try issue documents endpoint; on 404 return []
  try {
    return await api(`/api/issues/${issueId}/documents`);
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      since: { type: 'string', default: '60' }, // minutes
    },
  });
  const dry = values['dry-run'];
  const sinceMs = parseInt(values.since) * 60 * 1000;

  if (isPaused()) {
    log('autonomy-pause status=paused — skipping all handoffs');
    return;
  }
  if (isDrainOnly()) {
    log('🚧 drain-only mode — skipping ALL new handoff issuance (Rule 0 deadline-unblock + Rule 1~5 모두 skip)');
    return;
  }

  await loadAgents();
  log(`agents loaded: ${Object.keys(AGENT_BY_NAME).length}`);

  const handoffKeys = loadHandoffLog();
  const doneIssues = await listIssues({ status: 'done', sinceMs });
  log(`scanning ${doneIssues.length} done issues (last ${values.since}min)`);

  let createdCount = 0;

  // Rule 0 (pre-scan): blocked 이슈에서 deadline-trigger 패턴 감지 → 도래 시 unblock
  // 패턴: description에 "착수 조건: YOU-XXX 배포 완료 이후" 또는 "deadline-trigger: YYYY-MM-DD HH:MM"
  try {
    const blockedIssues = await listIssues({ status: 'blocked', sinceMs: 365 * 24 * 60 * 60 * 1000 });
    log(`scanning ${blockedIssues.length} blocked issues for deadline triggers`);
    for (const issue of blockedIssues) {
      const desc = `${issue.title || ''}\n${issue.description || ''}`;
      const dlMatch = desc.match(/deadline-trigger:\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)/i);
      const samsungEarnings = /삼성.{0,4}실적.{0,40}배포\s*완료\s*이후|samsung.*earnings.*after\s*release/i.test(desc);
      let shouldUnblock = false;
      let reason = '';
      const now = new Date();
      if (dlMatch) {
        const dt = new Date(dlMatch[1].replace(' ', 'T') + (dlMatch[1].length === 10 ? 'T09:00:00+09:00' : '+09:00'));
        if (now >= dt) { shouldUnblock = true; reason = `deadline-trigger ${dlMatch[1]} 도래`; }
      }
      // 삼성 실적 발표일(2026-04-30) 트리거 — Samsung Q1 2026
      const samsungTriggerAt = new Date('2026-04-30T09:00:00+09:00');
      if (samsungEarnings && now >= samsungTriggerAt) { shouldUnblock = true; reason = '2026-04-30 삼성 실적 발표일 도래'; }

      const key = `deadline-unblock:${issue.id}`;
      if (shouldUnblock && !handoffKeys.has(key)) {
        if (dry) {
          log(`  [dry] would unblock: ${issue.identifier} — ${reason}`);
          continue;
        }
        try {
          await api(`/api/issues/${issue.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ blockedByIssueIds: [], status: 'todo' }),
          });
          await api(`/api/issues/${issue.id}/comments`, {
            method: 'POST',
            body: JSON.stringify({ body: `## 🔓 자동 Unblock — lifecycle-bridge\n\n사유: ${reason}\nat: ${now.toISOString()}\n\nstatus: blocked → todo. 담당자 자율 행동 루프에서 처리 시작 가능.` }),
          });
          recordHandoff(key, { sourceIssue: issue.identifier, target: 'self', action: 'deadline-unblock', reason });
          log(`  ✅ deadline-unblock: ${issue.identifier} — ${reason}`);
          createdCount++;
        } catch (e) {
          log(`  deadline-unblock error for ${issue.identifier}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    log(`  rule0 (deadline) prescan error: ${e.message}`);
  }

  for (const issue of doneIssues) {
    const assignee = issue.assigneeAgentId;
    const docs = await fetchIssueDocuments(issue.id).catch(() => []);
    const docKeys = (docs || []).map((d) => d.key || d.documentKey || '').filter(Boolean);

    // Rule 1: Marketing Analyst done + key=report → CMO 검토 (조직 라인 우회 금지)
    //         CMO 부재 시 CEO로 fallback (자율 시스템 연속성 보장)
    if (assignee === AGENT_BY_NAME['Marketing Analyst'] && (docKeys.includes('report') || /report/i.test(issue.title))) {
      const key = `marketing-analyzed:${issue.id}`;
      if (handoffKeys.has(key)) continue;
      if (todayCountInLog('marketing-analyzed:') >= 1) {
        log(`  rule1 skip (daily limit 1 reached): ${issue.identifier}`);
        continue;
      }
      const cmoAgent = AGENT_BY_NAME['CMO'];
      const ceoAgent = AGENT_BY_NAME['CEO'];
      const target = cmoAgent ? 'CMO' : 'CEO';
      const targetAgent = cmoAgent || ceoAgent;
      const nextStep = cmoAgent
        ? `1. 리포트의 정량 데이터 검증 (workspace/intel/competitors/, daily-news/ 출처 파일 일치 여부)\n2. 부서장 시각으로 핵심 인사이트 우선순위 재정렬\n3. CEO에 시리즈 기획·예산 검토 요청 이슈 발행 (key=marketing-summary로 done 처리)\n4. lifecycle-bridge가 다시 자동으로 CEO에게 핸드오프합니다.`
        : `\`scripts/automation/ceo-analyze-marketing.js\` 실행으로 시드 brief / 시리즈 plan 작성 (CMO 미정의로 fallback)`;
      const payload = {
        title: `[자동 핸드오프] 마케팅 리포트 ${target} 검토 — ${issue.identifier}`,
        description: `Marketing Analyst의 리포트(${issue.identifier} "${issue.title}")가 done 상태입니다.\n\n## 자율 핸드오프 컨텍스트\n- source issue: ${issue.identifier} (${issue.id})\n- target: ${target}\n- 다음 단계:\n${nextStep}\n- 자율 회사 인프라가 발행한 자동 이슈입니다 (lifecycle-bridge Rule 1).`,
        assigneeAgentId: targetAgent,
        parentId: issue.id,
        priority: issue.priority || 'medium',
      };
      if (dry) {
        log(`  [dry] would create: ${payload.title}`);
      } else {
        try {
          const c = await createHandoffIssue(payload);
          recordHandoff(key, { sourceIssue: issue.identifier, target, createdIdentifier: c.identifier });
          log(`  created handoff: ${c.identifier} (${target} ← Marketing ${issue.identifier})`);
          createdCount++;
        } catch (e) {
          log(`  rule1 error: ${e.message}`);
        }
      }
    }

    // Rule 1b: CMO done + key=marketing-summary → CEO 시리즈 기획 검토 (Rule 1의 2-hop)
    if (AGENT_BY_NAME['CMO'] && assignee === AGENT_BY_NAME['CMO'] && (docKeys.includes('marketing-summary') || /marketing[-\s]?summary|마케팅\s*요약/i.test(issue.title))) {
      const key = `cmo-summary:${issue.id}`;
      if (handoffKeys.has(key)) continue;
      if (todayCountInLog('cmo-summary:') >= 1) {
        log(`  rule1b skip (daily limit 1 reached): ${issue.identifier}`);
        continue;
      }
      const payload = {
        title: `[자동 핸드오프] CMO 마케팅 요약 → CEO 시리즈 기획 — ${issue.identifier}`,
        description: `CMO의 marketing-summary(${issue.identifier} "${issue.title}")가 done 상태입니다.\n\n## 자율 핸드오프 컨텍스트\n- source issue: ${issue.identifier} (${issue.id})\n- target: CEO\n- 다음 단계: \`scripts/automation/ceo-analyze-marketing.js --report <CMO summary path>\` 실행으로 시리즈 plan 작성. 산출물 key=series-plan으로 done 처리하면 Rule 2가 다시 Producer로 핸드오프.\n- 자율 회사 인프라가 발행한 자동 이슈입니다 (lifecycle-bridge Rule 1b).`,
        assigneeAgentId: AGENT_BY_NAME['CEO'],
        parentId: issue.id,
        priority: issue.priority || 'medium',
      };
      if (dry) {
        log(`  [dry] would create: ${payload.title}`);
      } else {
        try {
          const c = await createHandoffIssue(payload);
          recordHandoff(key, { sourceIssue: issue.identifier, target: 'CEO', createdIdentifier: c.identifier });
          log(`  created handoff: ${c.identifier} (CEO ← CMO ${issue.identifier})`);
          createdCount++;
        } catch (e) {
          log(`  rule1b error: ${e.message}`);
        }
      }
    }

    // Rule 2: CEO done + key=series-plan → Producer 시리즈 부트스트랩 (운영자 검토 라벨)
    if (assignee === AGENT_BY_NAME['CEO'] && (docKeys.includes('series-plan') || /시리즈\s*plan|series-plan/i.test(issue.title))) {
      const key = `ceo-series-plan:${issue.id}`;
      if (handoffKeys.has(key)) continue;
      if (todayCountInLog('ceo-series-plan:') >= 1) {
        log(`  rule2 skip (daily limit 1 reached): ${issue.identifier}`);
        continue;
      }
      const payload = {
        title: `[자동 핸드오프] 시리즈 부트스트랩 검토 — ${issue.identifier}`,
        description: `CEO가 시리즈 plan을 작성했습니다 (${issue.identifier}).\n\n## 자율 핸드오프 컨텍스트\n- source issue: ${issue.identifier} (${issue.id})\n- assignee: Producer\n- 다음 단계: 신규 시리즈는 \`status: planned\`로 등록되어 있습니다. Producer는 \`producer-trigger-series.js --series <id>\` 무과금 부트스트랩만 수행하고, 첫 EP \`--produce-first --execute\`는 운영자 명시 승인을 기다립니다.\n- 자율 회사 인프라가 발행한 자동 이슈입니다 (lifecycle-bridge).`,
        assigneeAgentId: pickProducerByPersona(issue).id,
        parentId: issue.id,
        priority: issue.priority || 'medium',
      };
      const targetName = pickProducerByPersona(issue).name;
      if (dry) {
        log(`  [dry] would create: ${payload.title} → ${targetName}`);
      } else {
        try {
          const c = await createHandoffIssue(payload);
          recordHandoff(key, { sourceIssue: issue.identifier, target: targetName, createdIdentifier: c.identifier });
          log(`  created handoff: ${c.identifier} (${targetName} ← CEO ${issue.identifier})`);
          createdCount++;
        } catch (e) {
          log(`  rule2 error: ${e.message}`);
        }
      }
    }

    // Rule 3: QA Reviewer done + verdict=PASS → Metadata Writer
    if (assignee === AGENT_BY_NAME['QA Reviewer'] && /PASS|verdict.?pass/i.test((issue.title || '') + ' ' + (issue.description || ''))) {
      const key = `qa-pass:${issue.id}`;
      if (handoffKeys.has(key)) continue;
      const payload = {
        title: `[자동 핸드오프] 메타데이터 작성 — ${issue.identifier}`,
        description: `QA Reviewer가 PASS 판정했습니다 (${issue.identifier}).\n\n## 자율 핸드오프 컨텍스트\n- source issue: ${issue.identifier} (${issue.id})\n- assignee: Metadata Writer\n- 다음 단계: \`70_publish_meta.json\` 작성. 완료 후 lifecycle-bridge가 Publisher 핸드오프를 발행합니다 (단, board-approved 라벨 필수).`,
        assigneeAgentId: AGENT_BY_NAME['Metadata Writer'],
        parentId: issue.id,
        priority: issue.priority || 'medium',
      };
      if (dry) {
        log(`  [dry] would create: ${payload.title}`);
      } else {
        try {
          const c = await createHandoffIssue(payload);
          recordHandoff(key, { sourceIssue: issue.identifier, target: 'Metadata Writer', createdIdentifier: c.identifier });
          log(`  created handoff: ${c.identifier} (Metadata ← QA ${issue.identifier})`);
          createdCount++;
        } catch (e) {
          log(`  rule3 error: ${e.message}`);
        }
      }
    }

    // Rule 4 (2026-04-29 변경): Metadata Writer done → CEO에 publish-decision 이슈
    // Publisher 직접 핸드오프가 아니라 CEO가 자율 결정하도록 한 단계 게이트 추가
    if (assignee === AGENT_BY_NAME['Metadata Writer'] && /metadata|메타데이터/i.test(issue.title)) {
      const key = `meta-to-ceo-publish-decision:${issue.id}`;
      if (!handoffKeys.has(key)) {
        // EP-XXXX 추출
        const epMatch = (issue.title || '').match(/EP-\d{4}-\d{4}/);
        const epId = epMatch ? epMatch[0] : '';
        const payload = {
          title: `[자동 핸드오프] Publish 결정 — ${epId || issue.identifier}`,
          description: `Metadata 작성 완료 (${issue.identifier}). CEO 자율 publish 결정 요청.\n\n## CEO 결정 가이드\n- 메타: \`workspace/episodes/${epId}/70_publish_meta.json\`\n- QA: \`60_qa_report.md\` (verdict/risk 확인)\n- 시리즈 정합성: \`paperclip/config/series.json\`\n\n## 결정 발행\n- **승인**: 이슈에 \`approved-by-ceo\` 라벨 추가 + 사유 코멘트 → status=done. lifecycle-bridge가 다음 사이클에 Publisher 핸드오프 자동 발행.\n- **반려**: status=cancelled + 사유 코멘트.\n- **보류**: in_review + 보완 sub-issue.\n\n## 가드\n- 일일 publish 상한: \`paperclip/config/autonomy-pause.json\` \`guards.max_publish_per_day\` (현재 3편)\n- \`publish_remains_human_only=true\`로 운영자가 되돌리면 즉시 보류\n- QA verdict ≠ PASS이면 자동 반려 권장\n\n자율 회사 인프라가 발행한 자동 이슈입니다 (lifecycle-bridge Rule 4 v2).`,
          assigneeAgentId: AGENT_BY_NAME['CEO'],
          parentId: issue.id,
          priority: issue.priority || 'medium',
        };
        if (dry) {
          log(`  [dry] would create: ${payload.title}`);
        } else {
          try {
            const c = await createHandoffIssue(payload);
            recordHandoff(key, { sourceIssue: issue.identifier, target: 'CEO', createdIdentifier: c.identifier, gate: 'ceo-decision', episode: epId });
            log(`  created handoff: ${c.identifier} (CEO ← Metadata ${issue.identifier}) — gate: ceo-decision`);
            createdCount++;
          } catch (e) {
            log(`  rule4 error: ${e.message}`);
          }
        }
      }
    }

    // Rule 5 (2026-04-29 신규): CEO publish-decision done + approved-by-ceo 라벨 → Publisher 핸드오프
    if (assignee === AGENT_BY_NAME['CEO'] && /Publish 결정|publish-decision/i.test(issue.title)) {
      const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : (l.name || l.key || '')));
      const approvedByCEO = labels.some((l) => /approved.?by.?ceo|ceo.?approved/i.test(l)) ||
                            /\bapproved-by-ceo\b/i.test((issue.description || '') + ' ' + (issue.title || ''));
      const key = `ceo-approved-publish:${issue.id}`;
      if (approvedByCEO && !handoffKeys.has(key)) {
        // 일일 publish 상한 가드
        const todayPublishCount = todayCountInLog('ceo-approved-publish:');
        let maxPerDay = 3;
        try {
          const pause = JSON.parse(readFileSync(PAUSE_FILE, 'utf-8'));
          maxPerDay = pause?.guards?.max_publish_per_day || 3;
          if (pause?.guards?.publish_remains_human_only === true) {
            log(`  rule5 skip — publish_remains_human_only=true (operator reverted gate)`);
            continue;
          }
        } catch {}
        if (todayPublishCount >= maxPerDay) {
          log(`  rule5 skip — daily publish limit ${maxPerDay} reached`);
          continue;
        }
        const epMatch = (issue.title || '').match(/EP-\d{4}-\d{4}/);
        const epId = epMatch ? epMatch[0] : '';
        const payload = {
          title: `[자동 핸드오프] S11 publish — ${epId || issue.identifier}`,
          description: `CEO publish 승인 확인 (${issue.identifier} approved-by-ceo).\n\n## Publisher 처리 절차\n1. **Telegram notifyPublishDecision** 호출 (30분 reject window 시작)\n2. \`logs/autonomy/publish-rejects.jsonl\`에 \`${epId}\` 키 들어오면 즉시 중단\n3. 무응답 + autonomy-pause active + 일일 한도 미초과 시 \`run-episode.js --episode ${epId} --from S11\` 실행\n4. 완료 후 Telegram 결과 알림 + 이슈 done\n\n자율 회사 인프라가 발행한 자동 이슈입니다 (lifecycle-bridge Rule 5).`,
          assigneeAgentId: AGENT_BY_NAME['Publisher'],
          parentId: issue.id,
          priority: issue.priority || 'high',
        };
        if (dry) {
          log(`  [dry] would create: ${payload.title}`);
        } else {
          try {
            const c = await createHandoffIssue(payload);
            recordHandoff(key, { sourceIssue: issue.identifier, target: 'Publisher', createdIdentifier: c.identifier, gate: 'telegram-30min-reject-window', episode: epId });
            log(`  created handoff: ${c.identifier} (Publisher ← CEO ${issue.identifier}) — gate: telegram-30min-reject-window`);
            createdCount++;
          } catch (e) {
            log(`  rule5 error: ${e.message}`);
          }
        }
      }
    }

    // Rule 6 (FIX-4): Publisher done + 시리즈 마지막 EP publish → Content Manager 회고·SEO 모니터링
    //                 Content Manager 역할 정의: 시리즈 사후 분석 + Daily Obsidian 노트 갱신 + SEO 키워드 추적
    if (AGENT_BY_NAME['Content Manager'] && assignee === AGENT_BY_NAME['Publisher'] && /EP-\d{4}-\d{4}/.test(issue.title || '')) {
      const epMatch = (issue.title || '').match(/EP-\d{4}-\d{4}/);
      const epId = epMatch ? epMatch[0] : null;
      // 시리즈 마지막 EP인지 확인 (publish 결과 메타에서)
      let isLastOfSeries = false;
      let seriesId = null;
      if (epId) {
        try {
          const linkPath = `${ROOT}/workspace/episodes/${epId}/series_link.json`;
          if (existsSync(linkPath)) {
            const link = JSON.parse(readFileSync(linkPath, 'utf-8'));
            isLastOfSeries = link?.series_episode === link?.series_total;
            seriesId = link?.series_id;
          }
        } catch {}
      }
      if (isLastOfSeries && seriesId) {
        const key = `series-retro:${issue.id}`;
        if (!handoffKeys.has(key) && todayCountInLog('series-retro:') < 1) {
          const payload = {
            title: `[자동 핸드오프] 시리즈 ${seriesId} 회고·SEO 모니터링 — ${epId} publish 완료`,
            description: `Publisher가 시리즈 ${seriesId}의 마지막 EP(${epId})를 publish 완료했습니다.\n\n## Content Manager 작업 요청\n1. **시리즈 KPI 집계**: 5개 EP의 조회수·평균 시청 시간·구독 전환율을 \`workspace/intel/series-kpi/${seriesId}.json\`으로 정리\n2. **SEO 키워드 추적**: 각 EP의 70_publish_meta.json tags + youtube-data 통계 cross 분석으로 hit/miss 키워드 식별\n3. **Obsidian 데일리 노트 갱신**: \`obsidian-vault/BarroTube/Daily/YYYY-MM-DD.md\`에 시리즈 완성 이벤트 기록\n4. **다음 시즌 추천**: 데이터 기반으로 후속 시즌 후보 3건 추천 → \`series-retro\` key document로 commit\n5. 완료 시 status=done.\n\n## 메타\n- source issue: ${issue.identifier}\n- series: ${seriesId}\n- last episode: ${epId}\n- 자율 회사 인프라가 발행한 자동 이슈입니다 (lifecycle-bridge Rule 6).`,
            assigneeAgentId: AGENT_BY_NAME['Content Manager'],
            parentId: issue.id,
            priority: 'medium',
          };
          if (dry) {
            log(`  [dry] would create: ${payload.title}`);
          } else {
            try {
              const c = await createHandoffIssue(payload);
              recordHandoff(key, { sourceIssue: issue.identifier, target: 'Content Manager', createdIdentifier: c.identifier, series_id: seriesId, episode: epId });
              log(`  created handoff: ${c.identifier} (Content Manager ← Publisher ${issue.identifier}) — series retro for ${seriesId}`);
              createdCount++;
            } catch (e) {
              log(`  rule6 error: ${e.message}`);
            }
          }
        }
      }
    }
  }

  log(`done — ${createdCount} handoff(s) created${dry ? ' (dry-run)' : ''}`);
}

main().catch((e) => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
