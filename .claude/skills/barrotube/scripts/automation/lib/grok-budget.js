#!/usr/bin/env node

/**
 * grok-budget.js — Grok 영상 생성 쿼터를 회차마다 나눠 쓴다 (2026-09-28)
 *
 * 왜 필요했나: Grok Imagine 은 계정 단위 **주간 한도**가 있다. 파이프라인은 편당 5컷을
 * 전부 Grok 에 맡겨 주 17편 × 5 = 85컷을 요구했는데, 실측 한도는 30~35컷이다.
 *   - 09-17(목)~09-20(일): 성공 19컷 뒤 막혔고 09-23(수)에야 풀렸다.
 *   - 09-23(수)~09-27(일) 16:50: 성공 29컷(제출 약 40컷) 뒤 막혔다.
 * 막힌 뒤의 회차는 요청이 거절된 채 컷마다 6분씩 기다리다 HyperFrames 로 떨어졌다
 * (회차당 13~15분 손실, 09-28 점심은 Grok 용 브라우저 스틸 31분까지 헛돌았다).
 *
 * 그래서 세 가지를 한다.
 *   1. 편당 상한 — 우선순위(훅 먼저) 순으로 max_clips_per_episode 컷만 Grok 에 맡긴다.
 *      나머지는 **계획된** 로컬 모션이라 폴백 경보 대상이 아니다.
 *   2. 주간 예산 — 최근 window_days 일의 제출 수가 weekly_budget 에 닿으면 Grok 을 쓰지 않는다.
 *   3. 소진 백오프 — 한도 소진이 확인·추정되면 exhausted_backoff_hours 동안 Grok 을 건너뛰고,
 *      그 뒤 첫 회차는 1컷만 찔러 본다. 나오면 표식을 지운다.
 *
 * 원장은 **제출** 단위로 센다. 정체로 포기한 컷도 Grok 은 나중에 렌더를 끝내므로 쿼터를 쓴다.
 *
 * CLI:
 *   node scripts/automation/lib/grok-budget.js --episode <dir> [--platform shorts]  # 이번 편 계획 (허용 0 이면 exit 3)
 *   node scripts/automation/lib/grok-budget.js --status
 *   node scripts/automation/lib/grok-budget.js --mark-exhausted "<사유>"             # 운영자가 한도 소진을 확인했을 때
 *   node scripts/automation/lib/grok-budget.js --clear-exhausted
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CONFIG_PATH = join(ROOT, 'config', 'motion-engines.json');
export const LEDGER_PATH = process.env.BT_GROK_LEDGER || join(ROOT, 'workspace', 'grok-usage.json');
export const PLAN_FILE = '_grok_plan.json';

export const DEFAULTS = {
  max_clips_per_episode: 2,
  weekly_budget: 30,
  window_days: 7,
  exhausted_backoff_hours: 24,
  scene_priority: ['hook', 'driver', 'movers', 'insight', 'cause', 'implication', 'impact', 'context', 'numbers',
    'counterview', 'supply', 'cta', 'closing'],
};

export function loadGrokBudget(configPath = CONFIG_PATH) {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(configPath, 'utf8')).grok_budget || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function readLedger(path = LEDGER_PATH) {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    return {
      version: 1,
      submissions: Array.isArray(d.submissions) ? d.submissions : [],
      exhausted: d.exhausted || null,
    };
  } catch {
    return { version: 1, submissions: [], exhausted: null };
  }
}

function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

export function usedInWindow(ledger, now = new Date(), windowDays = DEFAULTS.window_days) {
  const since = now.getTime() - windowDays * 86_400_000;
  return ledger.submissions.filter((s) => Date.parse(s.at) >= since).length;
}

/** 소진 백오프가 끝나는 시각. 백오프 중이 아니면 null. */
export function exhaustedUntil(ledger, now = new Date(), backoffHours = DEFAULTS.exhausted_backoff_hours) {
  const at = Date.parse(ledger.exhausted?.at || '');
  if (!Number.isFinite(at)) return null;
  const until = at + backoffHours * 3_600_000;
  return now.getTime() < until ? new Date(until) : null;
}

/**
 * 이번 편에서 Grok 에 맡길 씬을 고른다.
 * scenes: [{ id: '001', role: 'hook' }, ...] · have: 이미 클립이 있는 씬 id
 * 반환 grok 은 우선순위 순서다 — 중간에 멈춰도 중요한 컷이 먼저 나온다.
 */
export function planGrokScenes({ scenes, have = new Set(), episode, ledger, budget = DEFAULTS, now = new Date() }) {
  const order = budget.scene_priority || [];
  const rank = (role) => { const i = order.indexOf(role); return i < 0 ? order.length : i; };
  const candidates = scenes
    .map((s, idx) => ({ ...s, idx }))
    .filter((s) => !have.has(s.id))
    .sort((a, b) => rank(a.role) - rank(b.role) || a.idx - b.idx);
  // 데이터 카드 씬(「미국 증시 요약」 씬 1 지수 카드)은 Grok 에 보내지 않는다 — 글자 카드를
  // 영상 모델에 넣으면 숫자가 일그러진다. 로컬 모션으로 간다.
  const eligible = candidates.filter((s) => !s.card);

  const used = usedInWindow(ledger, now, budget.window_days);
  const episodeUsed = ledger.submissions.filter((s) => s.episode === episode).length;
  const until = exhaustedUntil(ledger, now, budget.exhausted_backoff_hours);
  let allowed = Math.max(0, Math.min(budget.max_clips_per_episode - episodeUsed, budget.weekly_budget - used));
  let reason = `편당 ${budget.max_clips_per_episode}컷 · 주간 ${used}/${budget.weekly_budget}`;
  const probe = Boolean(ledger.exhausted) && !until;

  if (!candidates.length) {
    allowed = 0;
    reason = '모든 씬에 이미 클립이 있다';
  } else if (until) {
    allowed = 0;
    reason = `한도 소진 백오프 (${ledger.exhausted.reason || '사유 미기록'}) — ${until.toISOString()} 까지`;
  } else if (allowed > 0 && probe) {
    allowed = 1;
    reason += ' · 소진 뒤 첫 확인이라 1컷만';
  } else if (allowed === 0 && used >= budget.weekly_budget) {
    reason = `주간 예산 소진 ${used}/${budget.weekly_budget}`;
  } else if (allowed === 0) {
    reason = `이 편은 이미 ${episodeUsed}컷을 제출했다 (상한 ${budget.max_clips_per_episode})`;
  }

  const n = Math.min(allowed, eligible.length);
  const grok = eligible.slice(0, n).map((s) => s.id);
  return {
    allowed: n,
    grok,
    local: candidates.filter((s) => !grok.includes(s.id)).map((s) => s.id).sort(),
    used,
    episodeUsed,
    probe,
    reason,
  };
}

export function recordSubmission(path, { episode, scene, post = null, at = new Date().toISOString() }) {
  const l = readLedger(path);
  l.submissions.push({ at, episode, scene, post });
  // 원장이 끝없이 자라지 않게 30일 넘은 기록은 버린다 (예산 창은 그보다 짧다).
  const keepSince = Date.parse(at) - 30 * 86_400_000;
  l.submissions = l.submissions.filter((s) => Date.parse(s.at) >= keepSince);
  writeLedger(path, l);
}

export function markExhausted(path, reason, at = new Date().toISOString()) {
  const l = readLedger(path);
  l.exhausted = { at, reason };
  writeLedger(path, l);
}

export function clearExhausted(path) {
  const l = readLedger(path);
  if (!l.exhausted) return false;
  l.exhausted = null;
  writeLedger(path, l);
  return true;
}

export function writePlan(videosDir, plan) {
  writeFileSync(join(videosDir, PLAN_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...plan }, null, 2)}\n`);
}

export function readPlan(videosDir) {
  try { return JSON.parse(readFileSync(join(videosDir, PLAN_FILE), 'utf8')); } catch { return null; }
}

/** 30_script.md 에서 씬 id·역할만 읽는다. */
export function loadSceneRoles(baseDir) {
  const txt = readFileSync(join(baseDir, '30_script.md'), 'utf8');
  const out = [];
  for (const blk of txt.split(/\n  - scene_id: /).slice(1)) {
    const id = (blk.match(/^"?(\d+)"?/) || [])[1];
    const role = (blk.match(/role: (\w+)/) || [])[1] || '';
    if (id) out.push({ id: id.padStart(3, '0'), role, card: /\n {4}card:/.test(blk) });
  }
  return out;
}

export function episodeIdOf(path) {
  return (String(path).match(/EP-\d{4}-\d{4}/) || [])[0] || String(path);
}

function mediaBase(episode, platform) {
  const ep = resolve(episode);
  return existsSync(join(ep, 'platforms', platform, '30_script.md')) ? join(ep, 'platforms', platform) : ep;
}

function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string' },
    platform: { type: 'string', default: 'shorts' },
    status: { type: 'boolean' },
    'mark-exhausted': { type: 'string' },
    'clear-exhausted': { type: 'boolean' },
  } });
  const budget = loadGrokBudget();

  if (values['mark-exhausted'] !== undefined) {
    markExhausted(LEDGER_PATH, values['mark-exhausted'] || '운영자 확인');
    const until = exhaustedUntil(readLedger(), new Date(), budget.exhausted_backoff_hours);
    console.log(`⏸  Grok 한도 소진 표시 — ${until ? until.toISOString() : '-'} 까지 건너뛰고, 그 뒤 첫 회차가 1컷으로 확인한다`);
    return;
  }
  if (values['clear-exhausted']) {
    console.log(clearExhausted(LEDGER_PATH) ? '▶  Grok 소진 표시를 지웠다' : '소진 표시가 없다');
    return;
  }

  const ledger = readLedger();
  if (values.status || !values.episode) {
    const until = exhaustedUntil(ledger, new Date(), budget.exhausted_backoff_hours);
    console.log(`Grok 예산: 최근 ${budget.window_days}일 제출 ${usedInWindow(ledger, new Date(), budget.window_days)}/${budget.weekly_budget} · 편당 ${budget.max_clips_per_episode}컷`);
    if (ledger.exhausted) console.log(`소진 표시: ${ledger.exhausted.at} (${ledger.exhausted.reason}) — ${until ? `${until.toISOString()} 까지 건너뜀` : '백오프 끝남, 다음 회차가 1컷으로 확인'}`);
    return;
  }

  const base = mediaBase(values.episode, values.platform);
  const videosDir = join(base, '40_assets', 'videos');
  const scenes = loadSceneRoles(base);
  const have = new Set(scenes.map((s) => s.id).filter((id) => existsSync(join(videosDir, `scene_${id}.mp4`))));
  const plan = planGrokScenes({ scenes, have, episode: episodeIdOf(values.episode), ledger, budget });
  console.log(`Grok 예산 ${plan.allowed}컷${plan.grok.length ? ` (씬 ${plan.grok.join('·')})` : ''} — ${plan.reason}`);
  process.exitCode = plan.allowed > 0 ? 0 : 3;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
