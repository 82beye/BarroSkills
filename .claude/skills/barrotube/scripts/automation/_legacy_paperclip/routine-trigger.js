#!/usr/bin/env node
/**
 * routine-trigger.js — BarroTube 자율 시작 트리거
 *
 * launchd StartInterval 기반으로 주기 실행 (시간 고정 없음):
 *   --routine daily-producer     (launchd 1시간 주기, 하루 1회 dedup)
 *   --routine daily-marketing    (launchd 4시간 주기, 하루 1회 dedup)
 *
 * 멱등성:
 *   - 같은 day(=YYYY-MM-DD) + routine 이름으로 이미 발행된 이슈가 있으면 skip
 *   - logs/autonomy/routine-triggers.jsonl에 발행 기록
 *   - --force 플래그로 dedup 우회 (즉시 실행 시 사용)
 *
 * Safety:
 *   - autonomy-pause.json status=paused이면 skip
 *   - guards.max_episodes_per_day / max_new_series_per_day 체크
 *
 * 즉시 실행 (on-demand):
 *   node routine-trigger.js --routine daily-producer --force
 *   node routine-trigger.js --routine daily-marketing --force
 *   또는: bash scripts/automation/trigger-now.sh [producer|marketing|news|all]
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const LOG_DIR = join(ROOT, 'logs', 'autonomy');
const TRIGGER_LOG = join(LOG_DIR, 'routine-triggers.jsonl');
const PAUSE_FILE = join(ROOT, 'paperclip', 'config', 'autonomy-pause.json');
const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';
const API_BASE = 'http://localhost:3100';

function log(msg) {
  const line = `[${new Date().toISOString()}] [routine-trigger] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'routine-trigger.log'), line + '\n', 'utf-8');
  } catch {}
}

function isPaused() {
  try {
    if (!existsSync(PAUSE_FILE)) return false;
    return JSON.parse(readFileSync(PAUSE_FILE, 'utf-8')).status === 'paused';
  } catch { return false; }
}

function isDrainOnly() {
  try {
    if (!existsSync(PAUSE_FILE)) return false;
    const j = JSON.parse(readFileSync(PAUSE_FILE, 'utf-8'));
    return j.mode === 'drain-only' || j?.guards?.accept_new_issues === false;
  } catch { return false; }
}

async function api(path, opts = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`API ${r.status} ${path}: ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function loadAgentByName() {
  const agents = await api(`/api/companies/${COMPANY_ID}/agents`);
  const m = {};
  for (const a of agents) m[a.name] = a.id;
  return m;
}

function todayKey(routine) {
  return `${routine}:${new Date().toISOString().slice(0, 10)}`;
}

function alreadyTriggered(key) {
  if (!existsSync(TRIGGER_LOG)) return false;
  const lines = readFileSync(TRIGGER_LOG, 'utf-8').split('\n').filter(Boolean);
  for (const l of lines) {
    try { const j = JSON.parse(l); if (j.key === key) return true; } catch {}
  }
  return false;
}

function record(key, payload) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(TRIGGER_LOG, JSON.stringify({ key, ...payload, at: new Date().toISOString() }) + '\n', 'utf-8');
}

const ROUTINES = {
  // 하위 호환: 구 키 weekly-marketing → daily-marketing으로 alias
  'weekly-marketing': async (ctx) => ROUTINES['daily-marketing'](ctx),
  'daily-marketing': async ({ agents }) => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      title: `[일일 자율 트리거] 경쟁 채널 트래킹 + 트렌드 키워드 분석 (${today})`,
      description: `자율 회사 인프라가 발행하는 마케팅 분석 트리거 이슈입니다.\n\n## 입력 데이터 (가장 최근 정량 데이터를 반드시 활용)\n- **경쟁 채널 정량 통계**: \`workspace/intel/competitors/\` 의 가장 최근 일자 파일 (구독자/총 조회수/최근 7일 신규 영상 + 영상별 조회수·좋아요)\n- **9개 RSS 시황 뉴스**: \`workspace/daily-news/\` 의 가장 최근 6일치 \`news.json\` (한국 5 + 글로벌 4)\n- **이전 마케팅 리포트**: \`workspace/intel/marketing/*.json\` 최근 N개 (트렌드 변화 비교)\n\n## 작업 요청\n1. **위 정량 데이터 우선 인용** — LLM 추정 금지, 실제 수치만 사용 (모든 통계는 출처 파일 명시)\n2. 경쟁 채널 구독자/조회수 변화 + 신규 업로드 영상의 떠오르는 토픽 식별 (3건 이상)\n3. 9개 RSS의 글로벌 시황 + 한국 시황 교차 분석으로 블루오션 키워드 추출 (CEO의 \`ceo-select-topics.js --marketing-report\`가 +5점 가산점으로 사용)\n4. 핵심 인사이트와 시리즈 아이디어 3건 이상 추천 → \`report\` 키 document로 commit. document body에 \`## 선정 채널\` H2 섹션과 \`### 채널 N: <이름>\` H3 섹션을 포함하면 \`fetch-competitor-stats.js\`가 자동으로 인식 (resolve-competitor-channels.js 정책 v2.0)\n5. 완료 시 lifecycle-bridge가 CMO 경유 CEO에게 자동 핸드오프 (Rule 1)\n\n## 운영 가드\n- 정량 데이터 파일 부재 시 idle 코멘트 후 done\n- 추가 channel-id 매핑이 필요한 경우 \`paperclip/config/competitor-channel-overrides.json\`에 운영자 보강 후 다음 fetch 사이클에서 자동 반영\n\n## 메타\n- source: scheduled-routine, daily-marketing, ${today}\n- 발행자: routine-trigger.js (자율 회사 인프라)`,
      assigneeAgentId: agents['Marketing Analyst'],
      priority: 'medium',
    };
  },
  'daily-producer': async ({ agents }) => {
    return {
      title: `[일일 자율 트리거] 시황 fetch → 토픽 선정 → EP 큐 점검 (${new Date().toISOString().slice(0, 10)})`,
      description: `자율 회사 인프라가 발행하는 일일 EP 큐 관리 트리거 이슈입니다.\n\n## 작업 요청\n0. **시황 데이터 확보**: \`workspace/daily-news/${new Date().toISOString().slice(0, 10)}/news.json\` 존재 확인. 없으면 \`node scripts/automation/fetch-daily-news.js\` 직접 실행.\n1. **토픽 자동 선정**: \`node scripts/automation/ceo-select-topics.js --date ${new Date().toISOString().slice(0, 10)} --count 2 --channel econ-daily\` 실행. 산출 \`workspace/daily-news/${new Date().toISOString().slice(0, 10)}/topics.json\` 의 1순위 객체 (\`selected[0]\`) 사용.\n2. \`workspace/.in-flight.json\` 락 상태 확인. busy면 idle 코멘트 후 done.\n3. \`workspace/episodes/\` 하위 ep 디렉토리 중 status=in_progress (\`.episode_status.json\`) 인 EP 식별.\n4. **신규 EP 부트스트랩** (in_progress 없을 때):\n   - **토픽 입력 형식 (정본)**: 1순위 객체의 \`title\` 필드 그대로 \`--topic\` 인자에 큰따옴표로 감싸 전달. **\`keyword\` 필드 사용 금지** (너무 짧아 EP brief에 부적합).\n   - 명령: \`node scripts/automation/topic-to-episode.js --topic "<topics.json selected[0].title>" --channel econ-daily\`\n   - **\`--auto-run\` 절대 사용 금지** (brief 산출까지만, S4~S9 produce는 비용 발생 단계라 운영자 명시 승인 후).\n5. 진행 중 EP 있으면 다음 단계 부서원에 위임 또는 produce/run-episode 진행.\n6. 신규 EP 부트스트랩은 일일 1편 상한 (\`autonomy-pause.json\` guards.max_episodes_per_day).\n7. 모든 작업 완료 후 status=done.\n\n## 안전선\n- 4번의 \`--auto-run\` 절대 사용 금지 (TTS/이미지 자동 과금 발생 위험).\n- 0번 fetch-daily-news 실패 시 (대다수 RSS fail = 5/10 미만 성공) idle 코멘트 후 done. 일부 5xx/timeout은 fetchSource가 1회 자동 재시도 처리.\n- topics.json이 비어있으면(고스코어 토픽 0건) idle 코멘트 후 done — 다음 사이클 대기.\n\n## 메타\n- source: scheduled-routine, daily-producer, ${new Date().toISOString().slice(0, 10)}\n- 발행자: routine-trigger.js (자율 회사 인프라)`,
      assigneeAgentId: agents['Producer'],
      priority: 'medium',
    };
  },
};

function weekNum() {
  const d = new Date();
  const onejan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
}

async function main() {
  const { values } = parseArgs({
    options: {
      routine: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });

  if (!values.routine) { log('--routine required'); process.exit(2); }
  if (!ROUTINES[values.routine]) { log(`unknown routine: ${values.routine}`); process.exit(2); }

  if (isPaused()) { log('autonomy-pause status=paused — skipping'); return; }
  if (isDrainOnly()) { log('🚧 drain-only mode — skipping all routine triggers (no new issues until drain complete)'); return; }

  const key = todayKey(values.routine);
  if (!values.force && alreadyTriggered(key)) {
    log(`already triggered today: ${key}`);
    return;
  }

  const agents = await loadAgentByName();
  const builder = ROUTINES[values.routine];
  const issuePayload = await builder({ agents });

  log(`routine ${values.routine} → would post: "${issuePayload.title}" → ${Object.entries(agents).find(([k, v]) => v === issuePayload.assigneeAgentId)?.[0]}`);

  if (values['dry-run']) {
    log(`[dry-run] skipping POST`);
    return;
  }

  // FIX 2026-05-23 (Producer normalization):
  //   PaperClip 서버 default status='backlog'이지만 agent inbox-lite는 todo/in_progress/blocked만 노출.
  //   routine 이슈가 backlog로 들어가면 assignee가 영원히 못 봄. 매일 dailies가 stranded → 5/22까지 30건 누적.
  //   명시적으로 status='todo'로 발행하여 assignment-wakeup이 즉시 spawn 트리거하게 함.
  const payloadWithStatus = { ...issuePayload, status: 'todo' };
  const created = await api(`/api/companies/${COMPANY_ID}/issues`, {
    method: 'POST', body: JSON.stringify(payloadWithStatus),
  });
  record(key, { routine: values.routine, identifier: created.identifier, id: created.id });
  log(`created: ${created.identifier} (${created.id})`);
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
