/**
 * BarroTube Episode Workflow Engine
 *
 * PRD §5.1 표준 흐름(S0~S11) 구현
 * 에피소드의 전체 라이프사이클을 관리하며,
 * 체크포인트 기반 재시작(FR-S-003)을 지원한다.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const WORKSPACE = resolve(import.meta.dirname, '../../workspace');
const SCHEMAS = resolve(import.meta.dirname, '../../schemas');
const AGENTS = resolve(import.meta.dirname, '../../claude-code/.claude/agents');
const LOGS = resolve(import.meta.dirname, '../../logs');

/** 에피소드 단계 정의 (PRD §5.1) */
const STAGES = [
  { id: 'S0', name: 'brief',            file: '00_brief.md',           agent: 'board',            gate: 'board' },
  { id: 'S1', name: 'ticket_created',   file: null,                    agent: 'ceo',              gate: 'auto' },
  { id: 'S2', name: 'market_research',  file: '10_market_research.md', agent: 'market-researcher', gate: 'producer' },
  { id: 'S3', name: 'strategy',         file: '20_strategy.md',        agent: 'strategist',       gate: 'producer' },
  { id: 'S4', name: 'script',           file: '30_script.md',          agent: 'writer',           gate: 'producer' },
  { id: 'S5', name: 'factcheck',        file: '35_factcheck.md',       agent: 'fact-checker',     gate: 'producer' },
  { id: 'S6', name: 'assets',           file: '40_assets',             agent: 'asset-pm',         gate: 'asset-pm' },
  { id: 'S7', name: 'capcut_draft',     file: '50_capcut_draft.json',  agent: 'capcut-composer',  gate: 'producer' },
  { id: 'S8', name: 'qa_review',        file: '60_qa_report.md',       agent: 'qa-reviewer',      gate: 'producer' },
  { id: 'S9', name: 'metadata',         file: '70_publish_meta.json',  agent: 'metadata-writer',  gate: 'producer' },
  { id: 'S10', name: 'board_approval',  file: null,                    agent: 'ceo',              gate: 'board' },
  { id: 'S11', name: 'publish',         file: null,                    agent: 'publisher',        gate: 'auto' },
];

/**
 * 에피소드 상태를 판별한다 (체크포인트 기반)
 * FR-S-003: 산출물 존재 여부로 어디서 끊겼는지 판정
 */
export function detectCurrentStage(episodeDir) {
  for (let i = STAGES.length - 1; i >= 0; i--) {
    const stage = STAGES[i];
    if (!stage.file) continue;

    const filePath = join(episodeDir, stage.file);
    if (existsSync(filePath)) {
      // 이 단계까지 완료됨 → 다음 단계부터 시작
      const nextIndex = Math.min(i + 1, STAGES.length - 1);
      return {
        completed_stage: stage,
        next_stage: STAGES[nextIndex],
        completed_index: i,
        next_index: nextIndex,
      };
    }
  }
  return {
    completed_stage: null,
    next_stage: STAGES[0],
    completed_index: -1,
    next_index: 0,
  };
}

/**
 * 새 에피소드 디렉터리를 생성한다
 */
export function createEpisodeDirectory(episodeId) {
  const episodeDir = join(WORKSPACE, 'episodes', episodeId);
  const assetsDir = join(episodeDir, '40_assets');

  mkdirSync(join(assetsDir, 'images'), { recursive: true });
  mkdirSync(join(assetsDir, 'tts'), { recursive: true });

  return episodeDir;
}

/**
 * 에피소드 ID를 생성한다 (EP-YYYY-NNNN)
 */
export function generateEpisodeId() {
  const year = new Date().getFullYear();
  const episodesDir = join(WORKSPACE, 'episodes');

  if (!existsSync(episodesDir)) {
    mkdirSync(episodesDir, { recursive: true });
  }

  const existing = existsSync(episodesDir)
    ? readdirSyncSafe(episodesDir)
        .filter(d => d.startsWith(`EP-${year}-`))
        .sort()
    : [];

  const lastNum = existing.length > 0
    ? parseInt(existing[existing.length - 1].split('-')[2], 10)
    : 0;

  const nextNum = String(lastNum + 1).padStart(4, '0');
  return `EP-${year}-${nextNum}`;
}

function readdirSyncSafe(dir) {
  try {
    const { readdirSync } = await import('node:fs');
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 00_brief.md를 생성한다
 */
export function createBrief(episodeDir, { episodeId, channelId, topic, targetLength, notes }) {
  const brief = `---
episode_id: ${episodeId}
channel_id: ${channelId}
created_at: ${new Date().toISOString()}
topic: "${topic}"
target_length_seconds: ${targetLength || 480}
---

# Episode Brief

## 주제
${topic}

## 채널
${channelId}

## 목표 길이
${targetLength || 480}초

## 운영자 요구사항
${notes || '없음'}
`;

  writeFileSync(join(episodeDir, '00_brief.md'), brief, 'utf-8');
}

/**
 * 에피소드 상태 파일을 업데이트한다
 */
export function updateEpisodeStatus(episodeDir, episodeId, stageId, status, details = {}) {
  const statusFile = join(episodeDir, '.episode_status.json');
  let statusData = {};

  if (existsSync(statusFile)) {
    statusData = JSON.parse(readFileSync(statusFile, 'utf-8'));
  }

  statusData.episode_id = episodeId;
  statusData.last_updated = new Date().toISOString();
  statusData.current_stage = stageId;
  statusData.status = status; // 'in_progress' | 'completed' | 'failed' | 'awaiting_approval'

  if (!statusData.stage_history) {
    statusData.stage_history = [];
  }

  statusData.stage_history.push({
    stage: stageId,
    status,
    timestamp: new Date().toISOString(),
    ...details,
  });

  writeFileSync(statusFile, JSON.stringify(statusData, null, 2), 'utf-8');
  return statusData;
}

/**
 * 감사 로그를 기록한다 (FR-O-003)
 */
export function auditLog(episodeId, action, details) {
  const logDir = join(LOGS, 'audit');
  mkdirSync(logDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(logDir, `${date}.jsonl`);

  const entry = {
    timestamp: new Date().toISOString(),
    episode_id: episodeId,
    action,
    ...details,
  };

  const { appendFileSync } = await import('node:fs');
  appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * 팩트체크 결과를 분석하여 재집필 필요 여부를 판단한다
 */
export function analyzeFactcheckResult(factcheckPath) {
  if (!existsSync(factcheckPath)) {
    return { needsRewrite: false, error: 'Factcheck file not found' };
  }

  const content = readFileSync(factcheckPath, 'utf-8');

  // frontmatter에서 high_risk_count 추출
  const highRiskMatch = content.match(/high_risk_count:\s*(\d+)/);
  const passMatch = content.match(/pass:\s*(true|false)/);

  const highRiskCount = highRiskMatch ? parseInt(highRiskMatch[1], 10) : 0;
  const pass = passMatch ? passMatch[1] === 'true' : true;

  return {
    needsRewrite: !pass && highRiskCount > 0,
    highRiskCount,
    pass,
  };
}

/**
 * TTS 길이 합계를 검증한다 (±15% 허용)
 */
export function validateTTSLength(manifestPath, targetSeconds) {
  if (!existsSync(manifestPath)) {
    return { valid: false, error: 'Manifest not found' };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const actualSeconds = manifest.actual_total_seconds;
  const variancePct = ((actualSeconds - targetSeconds) / targetSeconds) * 100;

  return {
    valid: Math.abs(variancePct) <= 15,
    actualSeconds,
    targetSeconds,
    variancePct: variancePct.toFixed(1),
  };
}

/** 워크플로우 단계 정보 내보내기 */
export { STAGES, WORKSPACE, SCHEMAS, AGENTS, LOGS };
