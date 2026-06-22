/**
 * BarroTube — 통합 설정 로더
 *
 * 우선순위: .env 파일 → process.env → macOS Keychain
 *
 * Usage:
 *   import { getSecret, getAllSecrets, loadEnv } from './config-loader.js';
 *   const token = getSecret('TELEGRAM_BOT_TOKEN');
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const ENV_PATH = resolve(PROJECT_ROOT, '.env');

let envLoaded = false;
const envCache = {};

/**
 * .env 파일을 파싱하여 메모리에 로드한다.
 * process.env를 오염시키지 않고 내부 캐시만 사용한다.
 */
export function loadEnv(path = ENV_PATH) {
  if (envLoaded) return envCache;

  if (existsSync(path)) {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // 따옴표 제거
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (value) {
        envCache[key] = value;
      }
    }
    envLoaded = true;
  }

  return envCache;
}

/**
 * macOS Keychain에서 값을 읽는다.
 */
function getFromKeychain(serviceName) {
  try {
    return execSync(
      `security find-generic-password -s "${serviceName}" -w 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * 시크릿 값을 조회한다.
 * 우선순위: .env 파일 → process.env → macOS Keychain
 *
 * @param {string} key - 환경변수/키 이름
 * @returns {string|null}
 */
export function getSecret(key) {
  loadEnv();

  // 1. .env 파일
  if (envCache[key]) return envCache[key];

  // 2. 환경변수
  if (process.env[key]) return process.env[key];

  // 3. macOS Keychain — bare 키, 실패 시 'BarroTube/<key>' 컨벤션 폴백.
  //    (키체인 항목이 `security add-generic-password -s BarroTube/OPENAI_API_KEY` 형태로
  //     저장되어 있어도 찾도록. 이 컨벤션은 prompt-enrich.js 등에 문서화돼 있다.)
  return getFromKeychain(key) || getFromKeychain(`BarroTube/${key}`);
}

/**
 * 시크릿이 존재하는지 확인한다.
 */
export function hasSecret(key) {
  return getSecret(key) !== null;
}

/**
 * 필수 시크릿 목록을 검증한다.
 * @param {string[]} requiredKeys
 * @returns {{ valid: boolean, missing: string[], sources: Record<string, string> }}
 */
export function validateSecrets(requiredKeys) {
  loadEnv();

  const missing = [];
  const sources = {};

  for (const key of requiredKeys) {
    if (envCache[key]) {
      sources[key] = '.env';
    } else if (process.env[key]) {
      sources[key] = 'env';
    } else if (getFromKeychain(key)) {
      sources[key] = 'keychain';
    } else {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    sources,
  };
}

/**
 * 알려진 모든 BarroTube 키의 상태를 반환한다.
 */
export function auditSecrets() {
  const allKeys = [
    // 미디어 생성
    'ELEVENLABS_API_KEY',
    'FAL_API_KEY',
    'REPLICATE_API_KEY',
    // YouTube
    'YOUTUBE_DATA_API_KEY',
    'YOUTUBE_OAUTH_CLIENT_ID',
    'YOUTUBE_OAUTH_CLIENT_SECRET',
    'YOUTUBE_OAUTH_REFRESH_TOKEN',
    // 알림
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    // LLM 폴백 (선택)
    'ANTHROPIC_API_KEY',
    'GOOGLE_AI_API_KEY',
    'OPENAI_API_KEY',
  ];

  return validateSecrets(allKeys);
}

// CLI 직접 호출: node config-loader.js [audit|get <KEY>]
const scriptPath = process.argv[1];
if (import.meta.url === `file://${scriptPath}`) {
  const cmd = process.argv[2];

  if (cmd === 'audit') {
    const result = auditSecrets();
    console.log('\n🔑 BarroTube Secret Audit');
    console.log('═'.repeat(55));

    for (const [key, source] of Object.entries(result.sources)) {
      const icon = { '.env': '📄', env: '🌍', keychain: '🔐' }[source];
      console.log(`  ${icon} ${key.padEnd(35)} [${source}]`);
    }

    if (result.missing.length > 0) {
      console.log('');
      for (const key of result.missing) {
        console.log(`  ❌ ${key.padEnd(35)} [missing]`);
      }
    }

    console.log('═'.repeat(55));
    console.log(`  Found: ${Object.keys(result.sources).length} | Missing: ${result.missing.length}`);
  } else if (cmd === 'get' && process.argv[3]) {
    const val = getSecret(process.argv[3]);
    if (val) {
      // 보안: 앞 4자만 표시
      const masked = val.slice(0, 4) + '•'.repeat(Math.max(0, val.length - 4));
      console.log(`${process.argv[3]}: ${masked}`);
    } else {
      console.log(`${process.argv[3]}: not found`);
    }
  } else {
    console.log('Usage:');
    console.log('  node config-loader.js audit        — 전체 키 상태 확인');
    console.log('  node config-loader.js get <KEY>     — 특정 키 조회 (마스킹)');
  }
}
