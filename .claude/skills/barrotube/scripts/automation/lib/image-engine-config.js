/**
 * image-engine-config.js — 이미지 생성 엔진 전역 resolver (SSOT, 2026-06-07)
 *
 * 기존엔 엔진 선택이 단계별로 제각각이었다:
 *   - S6d 인트로 : OPENAI_API_KEY && BT_INTRO_FORCE_GEMINI!=='1'  (opt-out)
 *   - S6e 썸네일 : BT_THUMBNAIL_ENGINE==='openai'                 (opt-in)
 *   - 규칙·env 불일치 + 중앙 설정 부재 → produce-episode가 전역 제어 불가.
 *
 * 이 모듈이 단일 진실 공급원(SSOT). 두 단계(S6d/S6e)가 같은 resolver를 쓰며,
 * env는 자식 프로세스에 상속되므로 produce-episode.js 수정 없이 BT_IMAGE_ENGINE
 * 하나로 전 파이프라인을 토글할 수 있다.
 *
 * 우선순위(높음→낮음):
 *   1) --engine (CLI, cliOverride 인자)
 *   2) 단계별 env: BT_INTRO_ENGINE / BT_THUMBNAIL_ENGINE
 *   3) legacy: BT_INTRO_FORCE_GEMINI=1 (인트로 한정 강제 gemini)
 *   4) 전역 env: BT_IMAGE_ENGINE
 *   5) config/image-engines.json → stages[stage]
 *   6) config/image-engines.json → global
 *   7) auto(현행 호환): 인트로=키 있으면 openai, 그 외=gemini
 *   8) 키 가드: openai인데 OPENAI_API_KEY 없으면 gemini로 강등
 *
 * 값: 'gemini' | 'openai' | 'auto'
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// lib → automation → scripts → barrotube 루트
const ROOT = resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'image-engines.json');

let _cfgCache; // 프로세스 1회 로드 캐시
function loadConfig() {
  if (_cfgCache !== undefined) return _cfgCache;
  try {
    _cfgCache = existsSync(CONFIG_PATH) ? (JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) || {}) : {};
  } catch {
    _cfgCache = {};
  }
  return _cfgCache;
}

// 'media-render': barrotube-media-render 스킬(브라우저 ChatGPT, PD 수행)로 사전 생성.
// API 호출 없음 — 소비 스크립트(generate-intro 등)는 산출물 존재 확인/게이트만 수행.
const VALID = new Set(['gemini', 'openai', 'media-render']);
function norm(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (VALID.has(s)) return s;
  if (s === 'auto') return 'auto';
  return null; // 알 수 없는 값은 무시(다음 우선순위로)
}

// 단계별 명시 env 키
const STAGE_ENV = {
  S6d_intro: 'BT_INTRO_ENGINE',
  S6e_thumbnail: 'BT_THUMBNAIL_ENGINE',
};

// auto(현행 호환) 기본값
function autoDefault(stage, hasKey) {
  if (stage === 'S6d_intro') return hasKey ? 'openai' : 'gemini'; // 인트로: 키 있으면 OpenAI(기존 동작)
  return 'gemini'; // 썸네일·기타: Gemini(기존 동작)
}

/**
 * @param {'S6d_intro'|'S6e_thumbnail'|string} stage
 * @param {{ cliOverride?: string, env?: object, config?: object }} [opts]
 *   config 주입 시 config/image-engines.json 대신 사용(테스트 결정성).
 *   주의: OPENAI_API_KEY 판정은 env(process.env)만 본다. keychain 키는 스크립트
 *   진입부에서 process.env로 hydrate된 뒤 이 함수가 호출되는 것을 전제로 한다.
 * @returns {{ engine: 'gemini'|'openai', downgraded: boolean, source: string, stage: string }}
 *   downgraded=true → openai를 원했으나 키가 없어 gemini로 강등됨.
 */
export function resolveImageEngine(stage, { cliOverride, env = process.env, config } = {}) {
  const hasKey = !!env.OPENAI_API_KEY;
  const cfg = config || loadConfig();

  let pick = null;
  let source = '';
  const pin = (v) => (v && v !== 'auto') ? v : null; // 'auto'는 pin하지 않음(다음 우선순위로)

  // 1) CLI --engine
  pick = pin(norm(cliOverride));
  if (pick) source = 'cli';

  // 2) 단계별 env
  if (!pick && STAGE_ENV[stage]) {
    pick = pin(norm(env[STAGE_ENV[stage]]));
    if (pick) source = STAGE_ENV[stage];
  }
  // 3) legacy BT_INTRO_FORCE_GEMINI (인트로 한정)
  if (!pick && stage === 'S6d_intro' && /^(1|true|yes)$/i.test(env.BT_INTRO_FORCE_GEMINI || '')) {
    pick = 'gemini';
    source = 'BT_INTRO_FORCE_GEMINI(legacy)';
  }
  // 4) 전역 env  ('auto'는 pin하지 않고 다음 우선순위로 흘려보냄)
  if (!pick) {
    const g = norm(env.BT_IMAGE_ENGINE);
    if (g && g !== 'auto') { pick = g; source = 'BT_IMAGE_ENGINE'; }
  }
  // 5) config.stages[stage]
  if (!pick && cfg.stages) {
    const s = norm(cfg.stages[stage]);
    if (s && s !== 'auto') { pick = s; source = 'config.stages'; }
  }
  // 6) config.global
  if (!pick) {
    const g = norm(cfg.global);
    if (g && g !== 'auto') { pick = g; source = 'config.global'; }
  }

  // 7) 미해결 → 현행 호환 기본
  if (!pick) {
    pick = autoDefault(stage, hasKey);
    source = source || 'auto';
  }

  // 8) 키 가드
  let downgraded = false;
  if (pick === 'openai' && !hasKey) {
    pick = 'gemini';
    downgraded = true;
  }

  return { engine: pick, downgraded, source, stage };
}
