#!/usr/bin/env node

/**
 * check-oauth-expiry.js — YouTube OAuth refresh token 만료 임박 감지
 *
 * Google 은 OAuth 동의 화면이 "테스트" 상태인 앱의 refresh token 을 **7일 후 만료**시킨다.
 * 2026-08-13 실제로 이것 때문에 수집이 멈췄다 — .env 는 08-06 에 갱신됐고 정확히 7일이었다.
 * 문제는 만료돼야만 알 수 있었다는 것이다. 그 사이 competitor-scan 은 매일 조용히 실패했다.
 *
 * 두 가지를 본다:
 *   1. 경과일 (예방) — 발급 후 며칠 지났나. WARN_DAYS 넘으면 미리 알린다.
 *   2. 실제 유효성 (확정, --verify) — channels.list 1 unit 으로 진짜 살아있는지 확인.
 *
 * 동의 화면을 "프로덕션"으로 게시했다면 만료가 없다.
 * 그때는 .env 에 YOUTUBE_OAUTH_PUBLISHED=1 을 넣으면 경과일 검사를 끈다.
 *
 * Usage:
 *   node check-oauth-expiry.js            # 경과일만 (무비용, 오프라인)
 *   node check-oauth-expiry.js --verify   # 실제 토큰 검증 (1 unit)
 *   node check-oauth-expiry.js --json
 *   node check-oauth-expiry.js --notify   # WARN 이상이면 텔레그램 발송
 *
 * exit code 는 항상 0 — 이 검사가 파이프라인을 막아서는 안 된다.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { getSecret } from './config-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_PATH = join(ROOT, '.env');

/** Testing 모드 만료는 7일. 하루 여유를 두고 5일부터 알린다. */
export const TESTING_MODE_TTL_DAYS = 7;
export const WARN_DAYS = 5;
export const CRITICAL_DAYS = 6;

/**
 * 발급 후 경과일로 상태를 판정한다.
 *
 * issuedAt 이 없으면 .env mtime 을 폴백으로 쓰되 그 사실을 밝힌다 —
 * .env 는 다른 이유로도 수정되므로 실제 발급보다 최신일 수 있고,
 * 그러면 남은 날을 실제보다 길게 본다(위험한 쪽으로 틀린다).
 */
export function assessExpiry({ issuedAt, envMtime, published = false, now }) {
  if (!(now instanceof Date)) throw new TypeError('now must be a Date');

  if (published) {
    return { level: 'OK', published: true, days_since: null, days_left: null,
             source: null, message: '프로덕션 게시 — refresh token 만료 없음' };
  }

  const basis = issuedAt ?? envMtime ?? null;
  if (!basis) {
    return { level: 'UNKNOWN', published: false, days_since: null, days_left: null,
             source: null, message: '발급 시각을 알 수 없다 — setup-youtube-oauth.js 를 한 번 돌리면 기록된다' };
  }

  const t = basis instanceof Date ? basis : new Date(basis);
  if (Number.isNaN(t.getTime())) {
    return { level: 'UNKNOWN', published: false, days_since: null, days_left: null,
             source: null, message: `발급 시각 파싱 실패: ${basis}` };
  }

  const days = (now.getTime() - t.getTime()) / 86400_000;
  const left = TESTING_MODE_TTL_DAYS - days;
  const source = issuedAt ? 'issued_at' : 'env_mtime';
  const approx = source === 'env_mtime' ? ' (추정 — .env 수정 시각 기준)' : '';

  let level;
  if (days >= TESTING_MODE_TTL_DAYS) level = 'EXPIRED';
  else if (days >= CRITICAL_DAYS) level = 'CRITICAL';
  else if (days >= WARN_DAYS) level = 'WARN';
  else level = 'OK';

  const message = level === 'EXPIRED'
    ? `발급 후 ${days.toFixed(1)}일 — 이미 만료됐을 가능성이 높다${approx}`
    : `발급 후 ${days.toFixed(1)}일, 남은 ${left.toFixed(1)}일${approx}`;

  return { level, published: false, days_since: +days.toFixed(2), days_left: +left.toFixed(2), source, message };
}

/** .env 에서 값을 직접 읽는다 (getSecret 이 캐시하는 경우 대비). */
function readEnvValue(key) {
  if (!existsSync(ENV_PATH)) return null;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(ENV_PATH, 'utf-8'));
  return m ? m[1].trim() : null;
}

/** 실제로 토큰이 살아있는지 확인한다. 1 unit. */
async function verifyToken() {
  const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');
  const refreshToken = getSecret('YOUTUBE_OAUTH_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, reason: 'YOUTUBE_OAUTH_* 가 .env 에 없다' };
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        refresh_token: refreshToken, grant_type: 'refresh_token',
      }),
    });
    if (r.ok) return { ok: true, reason: null };
    const text = await r.text();
    const invalidGrant = /invalid_grant/.test(text);
    return {
      ok: false,
      reason: invalidGrant ? 'invalid_grant — 만료 또는 취소됨' : `OAuth ${r.status}`,
      expired: invalidGrant,
    };
  } catch (e) {
    return { ok: false, reason: `네트워크 오류: ${e.message}` };
  }
}

function notifyTelegram(level, message) {
  const payload = {
    role: 'youtube-oauth',
    used: level,
    limit: `${TESTING_MODE_TTL_DAYS}일`,
    pct: level,
    action: `갱신: node scripts/automation/setup-youtube-oauth.js\n영구 해결: 동의 화면을 '프로덕션'으로 게시`,
  };
  const r = spawnSync('node', [
    join(ROOT, 'scripts', 'automation', 'notify.js'), 'budget_alert', JSON.stringify(payload),
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
  return r.status === 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      verify: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      notify: { type: 'boolean', default: false },
    },
  });

  const now = new Date();
  const issuedAt = readEnvValue('YOUTUBE_OAUTH_ISSUED_AT');
  const published = readEnvValue('YOUTUBE_OAUTH_PUBLISHED') === '1';
  const envMtime = existsSync(ENV_PATH) ? new Date(statSync(ENV_PATH).mtimeMs) : null;

  const result = assessExpiry({ issuedAt, envMtime, published, now });

  if (values.verify) {
    const v = await verifyToken();
    result.verified = v.ok;
    result.verify_reason = v.reason;
    // 실검증이 경과일 추정을 이긴다 — 확정 정보이기 때문
    if (!v.ok && v.expired) {
      result.level = 'EXPIRED';
      result.message = `토큰 실검증 실패: ${v.reason}`;
    } else if (v.ok && result.level === 'EXPIRED') {
      result.level = 'OK';
      result.message = `경과일로는 만료 추정이었으나 실검증은 통과 — ${result.message}`;
    }
  }

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const icon = { OK: '✅', WARN: '⚠️ ', CRITICAL: '🟠', EXPIRED: '🔴', UNKNOWN: '❔' }[result.level];
    console.log(`${icon} YouTube OAuth — ${result.level}`);
    console.log(`   ${result.message}`);
    if (result.level !== 'OK' && result.level !== 'UNKNOWN') {
      console.log('   갱신: node scripts/automation/setup-youtube-oauth.js');
      console.log("   영구 해결: 동의 화면을 '프로덕션'으로 게시 후 .env 에 YOUTUBE_OAUTH_PUBLISHED=1");
    }
  }

  if (values.notify && ['WARN', 'CRITICAL', 'EXPIRED'].includes(result.level)) {
    const sent = notifyTelegram(result.level, result.message);
    if (!values.json) console.log(`   텔레그램: ${sent ? '발송' : '실패'}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((e) => console.error(`✗ ${e.message}`))
    .finally(() => { process.exitCode = 0; });
}
