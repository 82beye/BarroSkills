import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const active = new Set(['running', 'queued', 'scheduled_retry']);
const delays = [60_000, 300_000, 900_000];
const list = (value) => Array.isArray(value) ? value : value?.items || [];
const isList = (value) => Array.isArray(value) || Array.isArray(value?.items);
const at = (run) => Date.parse(run.createdAt || run.startedAt || run.finishedAt || '') || 0;
const guardText = /^PAPERCLIP_RESERVE_GUARD: admission denied; [^\r\n]*\. No provider started\.$/m;
const sameAgent = (run, agent) => run.agentId === agent.id && (!run.companyId || run.companyId === agent.companyId);
const latestFor = (runs, agent) => list(runs).filter((run) => sameAgent(run, agent)).sort((a, b) => at(b) - at(a))[0];
const callable = (agent) => agent && !['paused', 'terminated', 'pending_approval', 'running'].includes(agent.status)
  && agent.runtimeConfig?.heartbeat?.wakeOnDemand !== false;

function guardProof(run, agent) {
  const adapter = run.runnerProfileJson?.adapterDispatch?.adapterType;
  return run.companyId === agent.companyId && run.agentId === agent.id && run.status === 'failed' && run.exitCode === 78
    && ['claude_local', 'codex_local'].includes(adapter)
    && guardText.test(run.stderrExcerpt || '')
    && !(run.stdoutExcerpt || '').trim() && !(run.resultJson?.stdout || '').trim()
    && !['inputTokens', 'outputTokens', 'cachedInputTokens'].some((key) => Number(run.usageJson?.[key] || 0) > 0)
    && !run.resultJson?.workspaceRestoreFailure;
}

function issueHeld(issue, agent, runId) {
  return issue.companyId !== agent.companyId || issue.assigneeAgentId !== agent.id || Boolean(issue.assigneeUserId)
    || !['todo', 'in_progress', 'blocked'].includes(issue.status)
    || Boolean(issue.hiddenAt || issue.pausedAt || issue.pauseReason || issue.activePauseHold || issue.project?.pausedAt)
    || issue.ancestors?.some((ancestor) => ancestor.pausedAt || ancestor.pauseReason)
    || [issue.executionRunId, issue.checkoutRunId].some((id) => id && id !== runId)
    || Boolean(issue.scheduledRetry) || issue.executionState?.status === 'pending';
}

/** Caller has admitted the selected provider/model and restored its owned heartbeat hold.
 * Persist this return value as stateRecord.guardRetry; no arbitrary errors are returned.
 */
export async function retryGuardRun({ agent, runs, stateRecord = {}, api, now = Date.now() }) {
  const checkedAt = new Date(now).toISOString();
  const previous = stateRecord.guardRetry || {};
  let runId, issueId, attempts = 0;
  const result = (status, reason, extra = {}) => ({ status, reason, ...(runId ? { runId } : {}), ...(issueId ? { issueId } : {}), attempts, checkedAt, ...extra });
  try {
    if (!callable(agent) || stateRecord.action === 'manual-pause' || !stateRecord.selected) return result('skipped', 'agent-not-ready');
    if (![join(here, 'quota-bin/claude'), join(here, 'quota-bin/codex')].includes(agent.adapterConfig?.command)) return result('skipped', 'guard-not-configured');
    const recent = latestFor(runs, agent);
    if (!recent || recent.status !== 'failed' || list(runs).some((run) => sameAgent(run, agent) && active.has(run.status))) return result('skipped', 'no-uncontested-failed-run');
    runId = recent.id;
    if (previous.runId === runId) {
      attempts = previous.attempts || 0;
      if (previous.status === 'accepted') return { ...previous, checkedAt };
      if (attempts >= delays.length) return result('exhausted', 'retry-budget-exhausted');
      if (Date.parse(previous.nextAttemptAt || '') > now) return { ...previous, checkedAt };
    }
    const get = (path) => api('GET', path, undefined, { auth: false });
    const run = await get(`/heartbeat-runs/${runId}`);
    if (!guardProof(run, agent)) return result('skipped', 'not-proven-guard-denial');
    issueId = run.nativeIssueId || run.contextSnapshot?.issueId;
    if (!issueId) return result('skipped', 'no-source-issue');
    const [issue, diagnostics, interactions, approvals, recovery] = await Promise.all([
      get(`/issues/${issueId}`), get(`/issues/${issueId}/diagnostics/blockers`),
      get(`/issues/${issueId}/interactions`), get(`/issues/${issueId}/approvals`), get(`/issues/${issueId}/recovery-actions`),
    ]);
    if (issueHeld(issue, agent, runId)) return result('skipped', 'issue-owner-or-hold-changed');
    if (!diagnostics.readiness || diagnostics.readiness.isDependencyReady !== true
      || diagnostics.readiness.unresolvedBlockerCount !== 0 || diagnostics.readiness.pendingFinalizeBlockerCount !== 0
      || diagnostics.truncated || diagnostics.omittedUnauthorizedBlockerCount) return result('skipped', 'dependency-proof-incomplete');
    if (!isList(interactions) || !isList(approvals)) return result('skipped', 'decision-proof-incomplete');
    if (list(interactions).some((item) => item.status === 'pending')
      || list(approvals).some((item) => ['pending', 'revision_requested'].includes(item.status))) return result('skipped', 'pending-user-decision');
    const action = recovery.active || null;
    if (action) {
      const sourceId = action.evidence?.runId || action.evidence?.latestRunId;
      if (sourceId !== runId || action.sourceIssueId !== issueId || action.companyId !== agent.companyId
        || action.returnOwnerAgentId !== agent.id || action.ownerType !== 'board'
        || !['active', 'escalated'].includes(action.status)
        || !['legacy_execution_requires_reconciliation', 'stranded_assigned_issue'].includes(action.cause)) return result('skipped', 'unrelated-recovery-action');
      if (issue.executionBlocker && issue.executionBlocker.recoveryActionId !== action.id) return result('skipped', 'unrelated-execution-hold');
      if (issue.status === 'blocked') {
        const activity = list(await get(`/issues/${issueId}/activity`));
        const lastStatus = activity.filter((item) => item.details?.status).sort((a, b) => at(b) - at(a))[0];
        if (issue.blockedReason || issue.blockerReason || !lastStatus || lastStatus.actorType !== 'system'
          || lastStatus.details.status !== 'blocked' || lastStatus.details.recoveryActionId !== action.id
          || lastStatus.details.latestRunId !== runId
          || lastStatus.details.source !== 'recovery.reconcile_stranded_assigned_issue') return result('skipped', 'blocked-state-not-owned-by-guard-recovery');
      }
    } else if (issue.status === 'blocked' || issue.executionBlocker) return result('skipped', 'manual-or-unrelated-blocker');
    // Recheck authoritative live rows just before mutation. Native API rechecks
    // ownership, pause, dependencies and execution authority transactionally.
    const [currentAgent, freshRuns, issueRuns] = await Promise.all([
      get(`/agents/${agent.id}`), get(`/companies/${agent.companyId}/heartbeat-runs?agentId=${agent.id}&summary=true`),
      get(`/issues/${issueId}/runs`),
    ]);
    if (!callable(currentAgent) || currentAgent.companyId !== agent.companyId) return result('skipped', 'agent-changed');
    if (!isList(freshRuns) || !isList(issueRuns)) return result('skipped', 'execution-proof-incomplete');
    if (latestFor(freshRuns, agent)?.id !== runId || list(freshRuns).some((item) => sameAgent(item, agent) && (active.has(item.status) || item.retryOfRunId === runId))) return result('skipped', 'newer-or-existing-execution');
    if (list(issueRuns).some((item) => (item.runId || item.id) !== runId && (active.has(item.status) || at(item) >= at(run)))) return result('skipped', 'source-issue-has-newer-execution');
    attempts++;
    let receipt;
    if (action) {
      const body = { actionId: action.id, outcome: 'restored', sourceIssueStatus: 'todo',
        resolutionNote: 'Quota admission recovered. The exact guarded run exited before a provider was spawned.' };
      if (action.cause === 'legacy_execution_requires_reconciliation') body.executionReconciliation = {
        runId, providerStopped: true, actionOutcome: 'not_performed',
        outcomeEvidence: `Verified run ${runId}: installed quota wrapper returned 78 with exact admission-denied marker, empty provider stdout, zero recorded usage, and no workspace restore failure. Current selected quota policy admits retry at ${checkedAt}.`,
      };
      receipt = await api('POST', `/issues/${issueId}/recovery-actions/resolve`, body, { auth: false });
      if (receipt.recoveryAction?.status === 'resolved' || receipt.replayed === true) return result('accepted', 'native-recovery-owns-continuation', { actionId: action.id });
    } else {
      receipt = await api('POST', `/agents/${agent.id}/wakeup`, {
        source: 'on_demand', triggerDetail: 'manual', reason: 'retry_failed_run', failedRunId: runId, idempotencyKey: `quota-resume:${runId}`,
      }, { auth: false });
      const successorRunId = receipt.id || receipt.runId;
      if (successorRunId && receipt.status !== 'skipped') return result('accepted', 'exact-run-retry-accepted', { successorRunId });
    }
    return result('waiting', 'retry-not-admitted', { nextAttemptAt: new Date(now + delays[Math.min(attempts - 1, delays.length - 1)]).toISOString() });
  } catch {
    // Transport loss after POST is retried using the same native idempotency key.
    return result('waiting', 'retry-read-or-admission-failed', { nextAttemptAt: new Date(now + delays[Math.max(0, Math.min(attempts - 1, delays.length - 1))]).toISOString() });
  }
}
