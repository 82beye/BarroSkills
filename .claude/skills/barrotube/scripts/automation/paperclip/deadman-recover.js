#!/usr/bin/env node
/**
 * deadman-recover.js — 시작했지만 끝내지 못한 생산 회차를 공개 유예가 끝날 때까지 다시 돌린다.
 *
 * 데드맨은 「회차가 아예 안 떴을 때」만 나선다. 뜨고 나서 막힌 회차는 SRE·CEO 에이전트에게 넘어갔는데,
 * 에이전트도 같은 한도에 막혀 유예가 그냥 지나갔다 (2026-11-01 일요일: 06:13 멈춤 → 15회 실행 → 14시 유예 종료,
 * 영상 0편). 주말에는 슬롯이 하루 하나뿐이라 그 하나가 막히면 그날 발행이 없다.
 *
 * 그래서 재개는 모델 없는 결정론 경로로 둔다. 토큰 거버너 순회가 슬롯마다 판단하고(`rescueAll`), launchd 의
 * rescue-kr-close 는 페이퍼클립이 죽어 있을 때의 안전망으로 같은 코드를 부른다.
 *   - failed·halted·lost → 같은 EP 를 resume. EP 가 없거나 내용 단계에서 두 번 막히면 주제부터 rerun.
 *   - idle(exit 0, 영상 없음) → rerun.
 *   - 한도 거부로 멈췄고 한도가 아직 닫혀 있으면 시도를 쓰지 않고 기다린다.
 *   - 이중 실행은 dispatch 의 회차 마커(O_EXCL)가 막는다. 운영자 패스(guarded)·가드는 끝난 회차로 존중한다.
 *   - 끝까지 못 끝내면 텔레그램 한 번. 장애 이슈는 SRE 몫으로 남는다.
 *
 * Usage:
 *   node scripts/automation/paperclip/deadman-recover.js --all
 *   node scripts/automation/paperclip/deadman-recover.js --slot kr-close
 *   node scripts/automation/paperclip/deadman-recover.js --all --dry-run [--now 2026-11-01T07:00:00+09:00]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { marketShockTopic } from '../lib/topic-fallback.js';
import { PIPELINE_CALL_PERCENT } from './quota-reserve-policy.js';
import { GROWTH, OPS, ROOT, allIncidents, api, knownSlots, kstParts, readJson, readMarker, updateMarker } from './lib.js';

// 앞 시도가 끝난 뒤 기다릴 시간(분). 세션 창·예약이 풀릴 틈을 준다. 길이가 곧 재개 상한이다.
const RESCUE_DELAYS_MIN = [15, 30, 45, 60, 60, 60];
// 유예 끝 1시간 전부터는 새로 시작하지 않는다 — 렌더 + 거부창 30분이 유예를 넘기면 공개되지 못하고 비공개로 남는다.
const START_MARGIN_MS = 60 * 60_000;
const RESERVE_LINE_PERCENT = 70;      // 주간 30% 보존선. 생산 호출도 넘지 않는다.
const UNFINISHED = new Set(['failed', 'halted', 'lost', 'idle']);
const CONTENT_STAGE = /Phase [4569]\b/;   // 대본·계약·팩트체크·QA — 다시 돌려도 같은 내용이면 또 막히는 단계
const EP_RE = /^EP-\d{4}-\d{4}$/;

/**
 * 오늘 이 슬롯의 시도들(시작 순) → 다음 행동. 파일·네트워크를 만지지 않는다.
 * action: none | wait | resume | rerun | giveup
 */
export function planRescue({ runs, now, deadline, quotaOpen = true, epUsable = () => true }) {
  const last = runs.at(-1);
  if (!last) return { action: 'none', reason: 'no-run' };
  if (runs.some((r) => r.status === 'running')) return { action: 'none', reason: 'running' };
  if (!UNFINISHED.has(last.status)) return { action: 'none', reason: last.status, rescued: last.status === 'done' && runs.length > 1 };
  const attempts = runs.length - 1;
  if (attempts >= RESCUE_DELAYS_MIN.length) return { action: 'giveup', reason: 'attempts', attempts };
  if (now >= deadline - START_MARGIN_MS) return { action: 'giveup', reason: 'grace', attempts };
  const until = Date.parse(last.finishedAt) + RESCUE_DELAYS_MIN[attempts] * 60_000;
  if (now < until) return { action: 'wait', reason: 'backoff', until, attempts };
  if (last.quotaDenied && !quotaOpen) return { action: 'wait', reason: 'quota', attempts };
  const ep = last.status !== 'idle' && EP_RE.test(last.ep ?? '') && epUsable(last.ep) ? last.ep : null;
  // 같은 대본이 내용 단계에서 두 번 막혔으면 고쳐 쓰기로는 안 풀린다. 한도 거부로 멈춘 시도는 내용 판정이 아니다.
  const stuck = runs.filter((r) => r.ep === ep && !r.quotaDenied && CONTENT_STAGE.test(r.stage ?? '')).length >= 2;
  return ep && !stuck ? { action: 'resume', ep, attempts } : { action: 'rerun', attempts };
}

/** 어느 공급자든 호출을 받아 줄 수 있는가. 못 읽으면 막지 않는다 — 실제 판정은 호출 때 quota-cli 가 한다. */
export function pipelineQuotaOpen(state = readJson(join(OPS, 'quota-switch-state.json'), {})) {
  const providers = Object.values(state?.providers ?? {});
  if (!providers.length) return true;
  return providers.some((p) => (p.weekUsedPercent ?? 0) + PIPELINE_CALL_PERCENT <= RESERVE_LINE_PERCENT && !(p.sessionUsedPercent >= 100));
}

/** 오늘 이 슬롯의 시도 마커들 — 원 회차·rerun(`slot_x#n`)·resume(`resume-EP#n`). */
export function slotRuns(date, slot) {
  const dir = join(OPS, 'runs', date);
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const key = file.slice(0, -5);
    const own = key === `slot_${slot}` || key.startsWith(`slot_${slot}#`);
    if (!own && !key.startsWith('resume-')) continue;
    const marker = readMarker(date, key);
    if (marker && (own || marker.params?.slot === slot)) runs.push({ ...marker, key });
  }
  return runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

export function slotDeadline(config, slot, date) {
  return Date.parse(`${date}T${config.slots[slot].publish_at}:00+09:00`) + config.guards.publish_late_grace_hours * 3600_000;
}

/**
 * 로그에서 집은 EP 가 정말 이 회차의 것인가. findEp 는 첫 언급을 잡아서, 「Released stale lock (EP-2026-0256)」 같은
 * 줄이 앞서면 어제 EP 가 나온다 (2026-10-26). 그걸 재개하면 어제 영상을 오늘 내보내게 된다.
 */
function epMadeSince(ep, startedAt) {
  const created = readJson(join(ROOT, 'workspace', 'episodes', ep, '.episode_status.json'))?.created_at;
  return Boolean(created) && Date.parse(created) >= Date.parse(startedAt);
}

function briefTopicMatchesShock(brief, shock) {
  if (!shock) return true;
  const selected = /^topic:\s*(.*)$/m.exec(brief)?.[1] ?? '';
  const percent = shock.topic.match(/\d+\.\d+%/)?.[0];
  return Boolean(percent && selected.includes('코스피') && selected.includes(percent));
}

export function retargetShockDocuments({ brief, research, strategy }, shock) {
  const topic = shock.topic;
  const caution = `\n## 급락 자동 복구 근거\n\n- 당일 종가: ${topic}. 수집 시세를 대본 팩트체크에서 다시 검증한다.\n- 한국거래소 지수 화면: ${shock.source_url}\n- 수집 뉴스와 연결되지 않은 하락 원인을 지어내지 않는다. 실제 수급·종목 원인은 당일 출처로 확인된 것만 말한다.\n`;
  return {
    brief: brief.replace(/^topic:.*$/m, `topic: ${JSON.stringify(topic)}`)
      .replace(/(## 주제\n)[\s\S]*?(\n## 채널)/, `$1${topic}$2`)
      .replace(/(## 운영자 요구사항\n)/, `$1당일 급락을 우선 설명한다. 원인·전망은 출처 없이 단정하지 않는다.\n`),
    research: research.replace(/(## 선정 토픽\n)[\s\S]*?(\n## 시세 스냅샷)/, `$1${topic}$2`) +
      (research.includes('## 급락 자동 복구 근거') ? '' : caution),
    strategy: strategy.replace(/(## 한 문장 앵글\n)[\s\S]*?(\n## 시청자 가치)/,
      `$1당일 코스피 급락을 확인된 수치와 출처 있는 해석으로 설명한다: ${topic}$2`) +
      (strategy.includes('## 급락 자동 복구 근거') ? '' : caution),
  };
}

/**
 * 급락일 국내 마감을 재개해도 되는가. 대본 전이면 주제를 급락 종가로 돌린다.
 * 다른 헤드라인으로 만든 회차를 급락일에 그대로 내보내지 않는다 — 맞출 수 없으면 SRE 에게 남긴다.
 */
function shockResumeAllowed(date, slot, ep) {
  if (slot !== 'kr-close') return true;
  const shock = marketShockTopic(readJson(join(ROOT, 'workspace', 'daily-news', date, `market-${slot}.json`), {}), { slotName: slot, date });
  if (!shock) return true;
  const episodeDir = join(ROOT, 'workspace', 'episodes', ep);
  const briefPath = join(episodeDir, '00_brief.md');
  let brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '';
  const researchPath = join(episodeDir, '10_market_research.md');
  const strategyPath = join(episodeDir, '20_strategy.md');
  if (!existsSync(join(episodeDir, 'platforms', 'shorts', '30_script.md')) && existsSync(researchPath) && existsSync(strategyPath)) {
    const originals = { brief, research: readFileSync(researchPath, 'utf8'), strategy: readFileSync(strategyPath, 'utf8') };
    const selectedResearch = /## 선정 토픽\n([^\n]*)/.exec(originals.research)?.[1] ?? '';
    const selectedStrategy = /## 한 문장 앵글\n([^\n]*)/.exec(originals.strategy)?.[1] ?? '';
    const needsRetarget = !briefTopicMatchesShock(brief, shock) || !selectedResearch.includes(shock.topic) || !selectedStrategy.includes(shock.topic);
    if (needsRetarget && brief.includes('## 주제') && originals.research.includes('## 선정 토픽') && originals.strategy.includes('## 한 문장 앵글')) {
      const updated = retargetShockDocuments(originals, shock);
      for (const [name, file] of [['brief', briefPath], ['research', researchPath], ['strategy', strategyPath]]) {
        // 앞선 점검이 문서 일부만 고치고 종료돼도 다음 점검에서 이어갈 수 있다.
        const backup = `${file}.pre-auto-rescue`;
        if (!existsSync(backup)) writeFileSync(backup, originals[name], { flag: 'wx' });
        writeFileSync(file, updated[name]);
      }
      brief = updated.brief;
      console.log(`📌 ${ep}: 급락 종가로 주제 자동 교정`);
    }
  }
  if (briefTopicMatchesShock(brief, shock)) return true;
  console.error(`⚠ ${ep}: 급락 수치와 주제가 맞지 않아 자동 재개 보류 — SRE 검토 필요`);
  return false;
}

/** 분리된 프로세스로 띄운다 — 순회를 잡지 않고, 슬롯끼리 서로 기다리지 않는다. 중복은 dispatch 마커가 막는다. */
function launchRescue(slot, plan, rescueOf) {
  const dispatch = join(ROOT, 'scripts/automation/paperclip/dispatch.js');
  const args = plan.action === 'resume'
    ? ['--direct', 'resume', '--slot', slot, '--ep', plan.ep]
    : ['--direct', `slot:${slot}`, '--rerun'];
  const log = openSync(join(ROOT, 'logs', 'cron', 'rescue.log'), 'a');
  // launchd 경로의 PATH 에는 quota-bin 이 없다. 재개라고 보존선을 비켜 가면 안 되므로 항상 앞에 둔다.
  const child = spawn(process.execPath, [dispatch, ...args, '--via', 'auto-rescue', '--rescue-of', rescueOf], {
    cwd: ROOT, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, PATH: `${join(ROOT, 'scripts/automation/paperclip/quota-bin')}:${process.env.PATH}` },
  });
  child.unref();
  closeSync(log);
}

async function tell(text) {
  try { const { sendTelegramText } = await import('../notify.js'); await sendTelegramText(text); } catch (e) { console.error(`⚠ 텔레그램 실패: ${e.message}`); }
}

/**
 * 재개로 끝난 회차의 환경 장애를 닫는다 — 안 닫으면 SRE·CEO 가 이미 끝난 일을 계속 점검한다.
 * 코드 결함으로 분류된 장애는 남긴다. 이번에 우연히 통과했을 뿐 다시 날 수 있다.
 */
export async function closeRescued(runs, {
  incidents = allIncidents(),
  record = (row) => appendFileSync(join(GROWTH, 'incidents.jsonl'), `${JSON.stringify(row)}\n`),
  patch = (issueId, body) => api('PATCH', `/issues/${issueId}`, body, { auth: false }),
} = {}) {
  const byId = new Map(incidents.map((inc) => [inc.id, inc]));
  const last = runs.at(-1);
  const note = `자동 재개로 회차 완료 — ${last.ep ?? '?'} (${last.key}, ${runs.length - 1}회 재시도).`;
  const keep = new Set();
  const close = new Map();
  for (const run of runs) {
    for (const opened of run.sreIssues ?? []) {
      if (!opened.issueId) continue;
      if (byId.get(opened.incident)?.class === 'env') close.set(opened.issueId, opened.issue);
      else keep.add(opened.issueId);
    }
    for (const id of run.incidentIds ?? []) {
      const inc = byId.get(id);
      if (inc?.class === 'env' && !inc.resolved) record({ type: 'resolution', id, at: new Date().toISOString(), status: 'resolved', note });
    }
  }
  const closed = [];
  for (const [issueId, identifier] of close) {
    if (keep.has(issueId)) continue;
    try {
      await patch(issueId, { status: 'done', comment: `♻️ ${note} 환경 장애라 코드 변경 없이 닫는다.` });
      closed.push(identifier ?? issueId);
    } catch (e) { console.error(`⚠ 장애 이슈 닫기 실패 (${identifier}): ${e.message}`); }
  }
  return closed;
}

export async function rescueSlot(slot, { now = new Date(), config = readJson(join(ROOT, 'config', 'routines.json')), dryRun = false } = {}) {
  const { date } = kstParts(now);
  const runs = slotRuns(date, slot);
  const plan = planRescue({
    runs, now: now.getTime(), deadline: slotDeadline(config, slot, date), quotaOpen: pipelineQuotaOpen(),
    epUsable: (ep) => epMadeSince(ep, runs[0]?.startedAt),
  });
  if (dryRun) return { slot, ...plan };
  const stateKey = `rescue-${slot}`;
  const state = readMarker(date, stateKey) ?? {};
  const label = config.slots[slot].label;

  if (plan.rescued && !state.closedAt) {
    const closed = await closeRescued(runs);
    updateMarker(date, stateKey, { status: 'closed', closedAt: new Date().toISOString(), closed });
    await tell(`✅ <b>${label}</b> 자동 재개로 완료 — ${runs.at(-1).ep ?? ''} (${runs.length - 1}회 재시도)`);
    return { slot, ...plan, closed };
  }
  if (plan.action === 'giveup' && !state.gaveUpAt) {
    updateMarker(date, stateKey, { status: 'gave-up', gaveUpAt: new Date().toISOString(), reason: plan.reason, attempts: plan.attempts });
    const why = plan.reason === 'grace' ? '공개 유예가 끝나 갑니다' : `재시도 ${plan.attempts}회를 다 썼습니다`;
    await tell(`🛑 <b>${label}</b> 오늘 회차를 끝내지 못했습니다 — ${why}. 마지막 상태: ${runs.at(-1).status}${runs.at(-1).ep ? ` · ${runs.at(-1).ep}` : ''}`);
    return { slot, ...plan };
  }
  if (plan.action !== 'resume' && plan.action !== 'rerun') return { slot, ...plan };
  if (plan.action === 'resume' && !shockResumeAllowed(date, slot, plan.ep)) return { slot, action: 'none', reason: 'shock-topic-mismatch' };

  console.log(`♻️ ${slot}: ${plan.action}${plan.ep ? ` ${plan.ep}` : ''} (재시도 ${plan.attempts + 1}/${RESCUE_DELAYS_MIN.length})`);
  launchRescue(slot, plan, runs.find((r) => r.sreIssues?.length)?.key ?? runs[0].key);
  updateMarker(date, stateKey, { status: 'rescuing', attempts: plan.attempts + 1, lastAction: plan.action, lastAt: new Date().toISOString() });
  if (plan.attempts === 0) await tell(`♻️ <b>${label}</b> 막힌 회차를 자동으로 다시 돌립니다 — ${plan.action === 'resume' ? plan.ep : '주제부터 새로'}`);
  return { slot, ...plan };
}

/** 거버너 순회가 부른다. 한 슬롯의 실패가 다른 슬롯의 재개를 막지 않게 따로 받는다. */
export async function rescueAll(opts = {}) {
  const results = [];
  for (const slot of knownSlots()) {
    try { results.push(await rescueSlot(slot, opts)); } catch (e) { console.error(`⚠ ${slot} 재개 판단 실패: ${e.message}`); }
  }
  return results;
}

async function main() {
  const { values } = parseArgs({ options: {
    slot: { type: 'string' }, all: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, now: { type: 'string' },
  } });
  if (!values.all && !knownSlots().includes(values.slot)) throw new Error(`--all 또는 --slot <${knownSlots().join('|')}>`);
  const opts = { dryRun: values['dry-run'], ...(values.now ? { now: new Date(values.now) } : {}) };
  const results = values.all ? await rescueAll(opts) : [await rescueSlot(values.slot, opts)];
  if (values['dry-run']) for (const r of results) console.log(JSON.stringify(r));
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`자동 재개 오류: ${e.message}`); process.exitCode = 1; });
}
