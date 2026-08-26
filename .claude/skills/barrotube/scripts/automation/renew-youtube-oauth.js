#!/usr/bin/env node

/**
 * renew-youtube-oauth.js — refresh token 이 만료되기 전에 **스스로** 다시 받는다.
 *
 * 왜 필요한가. Google 은 동의 화면이 "테스트" 상태인 앱의 refresh token 을 7일 만에
 * 만료시킨다. check-oauth-expiry.js 는 그 사실을 알려 주기만 하고, setup-youtube-oauth.js
 * 는 사람이 브라우저에서 세 번 클릭해야 끝난다. 그래서 지금까지 만료는 "사람이 마침 로그를
 * 봤을 때만" 막혔다 — 2026-08-13 에는 못 봐서 수집이 멈췄고, 2026-08-26 에는 발행 직전
 * 남은 시간이 1.4일이었다.
 *
 * 영구 해결은 동의 화면을 프로덕션으로 게시하는 것이다(그러면 만료가 없다). 하지만 외부 앱
 * 게시에는 홈페이지·개인정보처리방침·서비스약관 URL 과 인증된 도메인이 필요하고, 그건
 * 운영자만 만들 수 있다. 그때까지의 차선이 이 스크립트다.
 *
 * 하는 일: 만료가 가까우면 로컬 콜백 서버를 띄우고, **로그인된 실제 Chrome** 을 AppleScript
 * 로 몰아 동의 3단계를 대신 클릭한다. Playwright 가 아니라 AppleScript 인 이유는
 * grok-motion-applescript.js 와 같다 — 자동화 지문이 없고 launchd(Aqua 세션)에서 그대로 돈다.
 *
 * 실패해도 안전하다. 어느 단계에서 막히든 기존 토큰은 그대로 두고 텔레그램으로 수동 절차를
 * 알린다. 새 토큰을 받은 뒤에도 **채널이 바뀌지 않았는지 확인**하고, 다르면 되돌린다 —
 * 브랜드 계정을 잘못 고르면 다음 발행이 남의 채널로 나간다.
 *
 * Usage:
 *   node renew-youtube-oauth.js                 # 임박했을 때만 갱신 (launchd 용)
 *   node renew-youtube-oauth.js --force         # 남은 일수와 무관하게 지금 갱신
 *   node renew-youtube-oauth.js --threshold 3   # 남은 일수가 이 값 이하일 때 갱신 (기본 3)
 *   node renew-youtube-oauth.js --dry-run       # 판단만 하고 브라우저는 건드리지 않는다
 *
 * 종료코드: 0 = 갱신했거나 갱신할 필요 없음 · 1 = 갱신이 필요한데 실패(사람 필요)
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { getSecret } from './config-loader.js';
import { assessExpiry } from './check-oauth-expiry.js';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_PATH = join(ROOT, '.env');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload';

/** 동의 화면에서 고를 브랜드 계정. 채널 표시명과 같아야 한다. */
const BRAND = process.env.BT_YT_BRAND || '바로경제';
/** 갱신 후 이 채널이 아니면 되돌린다. */
const EXPECTED_CHANNEL_ID = process.env.BT_YT_CHANNEL_ID || 'UCZAXYLHl1-bFqNmnwtgrcXg';
/** 남은 일수가 이 값 이하이면 갱신한다. 7일 TTL 에 4일 여유. */
const DEFAULT_THRESHOLD_DAYS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnv(key) {
  if (!existsSync(ENV_PATH)) return null;
  const m = readFileSync(ENV_PATH, 'utf-8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

function writeEnv(key, value) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, `${key}=${value}`) : `${content}\n${key}=${value}\n`;
  writeFileSync(ENV_PATH, content, 'utf-8');
}

/**
 * Chrome 탭에서 JS 실행. 탭 인덱스를 고정하지 않는다 — 사용자가 평소 쓰는 브라우저라
 * 실행 중에 탭 순서가 바뀐다 (grok-motion-applescript.js 가 같은 이유로 이렇게 한다).
 */
function chromeJS(urlPart, js) {
  const script = `on run argv
  set u to item 1 of argv
  set j to item 2 of argv
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t) contains u then return (execute t javascript j)
      end repeat
    end repeat
    error "TAB_GONE"
  end tell
end run`;
  return execFileSync('osascript', ['-e', script, urlPart, js], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
  }).trim();
}

function openTab(url) {
  const s = `on run argv
  tell application "Google Chrome"
    if (count of windows) = 0 then make new window
    tell front window to make new tab with properties {URL:(item 1 of argv)}
    activate
  end tell
end run`;
  execFileSync('osascript', ['-e', s, url], { encoding: 'utf8', timeout: 30_000 });
}

function closeTab(urlPart) {
  const s = `on run argv
  set u to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t) contains u then close t
      end repeat
    end repeat
  end tell
end run`;
  try { execFileSync('osascript', ['-e', s, urlPart], { encoding: 'utf8', timeout: 15_000 }); } catch { /* 이미 닫혔으면 그만 */ }
}

/** 현재 열려 있는 OAuth 탭의 URL. 없으면 null. */
function currentAuthUrl() {
  const s = `tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t) contains "accounts.google.com" then return (URL of t)
      if (URL of t) contains "127.0.0.1" then return (URL of t)
    end repeat
  end repeat
  return "none"
end tell`;
  try {
    const r = execFileSync('osascript', ['-e', s], { encoding: 'utf8', timeout: 15_000 }).trim();
    return r === 'none' ? null : r;
  } catch { return null; }
}

/**
 * 동의 3단계를 클릭한다. 각 화면은 순서가 보장되지 않아(계정이 하나면 선택 화면이 없고,
 * 이미 신뢰한 앱이면 경고가 없다) **화면을 판별해서** 맞는 버튼을 누른다.
 */
const CLICK_JS = `(function(){
  var brand = ${JSON.stringify(BRAND)};
  function textOf(e){ return (e.innerText||e.textContent||'').trim(); }
  // 1) 브랜드 계정 선택
  var rows = Array.from(document.querySelectorAll('li,[role="link"],[data-identifier],div'));
  var row = rows.find(function(e){
    var t = textOf(e);
    return t.indexOf(brand) === 0 && t.length < 60 && e.offsetParent !== null;
  });
  if (row && /delegation|oauthchooseaccount/.test(location.href)) { row.click(); return 'ACCOUNT'; }
  // 2) 미확인 앱 경고 / 3) 동의 요약 — 둘 다 "계속"
  var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
  var go = btns.find(function(b){ var t=textOf(b); return (t==='계속'||t==='Continue') && b.offsetParent!==null; });
  if (go) { go.click(); return 'CONTINUE'; }
  return 'WAIT';
})()`;

function findFreePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function waitForCode(port, timeoutMs) {
  return new Promise((res, rej) => {
    const server = createServer((req, r) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = u.searchParams.get('code');
      r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      r.end(code ? '<h2>✅ 갱신 완료 — 창을 닫아도 됩니다.</h2>' : '<h2>❌ code 없음</h2>');
      server.close();
      code ? res(code) : rej(new Error('authorization code 를 받지 못했습니다'));
    });
    server.listen(port, '127.0.0.1');
    setTimeout(() => { server.close(); rej(new Error('동의 대기 시간 초과')); }, timeoutMs);
  });
}

async function exchange(code, clientId, clientSecret, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!res.ok) throw new Error(`토큰 교환 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** 새 토큰이 가리키는 채널. 잘못된 브랜드 계정을 고른 걸 여기서 잡는다. */
async function channelOf(refreshToken, clientId, clientSecret) {
  const t = await (await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  })).json();
  if (!t.access_token) throw new Error(`access_token 발급 실패: ${t.error || 'unknown'}`);
  const r = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  })).json();
  const it = r.items?.[0];
  if (!it) throw new Error('채널 조회 실패');
  return { id: it.id, title: it.snippet.title };
}

function notify(text) {
  try {
    const botToken = getSecret('TELEGRAM_BOT_TOKEN');
    const chatId = getSecret('TELEGRAM_CHAT_ID');
    if (!botToken || !chatId) return;
    execFileSync('curl', ['-s', '-X', 'POST',
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      '-d', `chat_id=${chatId}`, '-d', 'parse_mode=HTML', '--data-urlencode', `text=${text}`,
    ], { encoding: 'utf8', timeout: 20_000 });
  } catch { /* 알림 실패가 갱신을 막지는 않는다 */ }
}

async function main() {
  const { values } = parseArgs({ options: {
    force: { type: 'boolean', default: false },
    threshold: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  } });

  const threshold = Number(values.threshold || DEFAULT_THRESHOLD_DAYS);
  const state = assessExpiry({
    issuedAt: readEnv('YOUTUBE_OAUTH_ISSUED_AT'),
    published: /^(1|true|yes)$/i.test(readEnv('YOUTUBE_OAUTH_PUBLISHED') || ''),
    now: new Date(),
  });

  console.log(`🔐 YouTube OAuth 갱신 점검 — ${state.message} (level=${state.level})`);

  if (state.published) { console.log('   동의 화면이 프로덕션이라 만료가 없다 — 갱신 불필요'); process.exit(0); }
  if (!values.force && state.days_left > threshold) {
    console.log(`   남은 ${state.days_left}일 > 임계 ${threshold}일 — 아직 갱신하지 않는다`);
    process.exit(0);
  }
  if (values['dry-run']) { console.log('   [DRY RUN] 여기서 갱신을 시작했을 것이다'); process.exit(0); }

  const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) { console.error('❌ CLIENT_ID/SECRET 이 없다'); process.exit(1); }

  const prevToken = readEnv('YOUTUBE_OAUTH_REFRESH_TOKEN');
  const port = await findFreePort();
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = new URL(AUTH_URL);
  for (const [k, v] of Object.entries({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
  })) authUrl.searchParams.set(k, v);

  console.log(`   콜백: ${redirectUri}`);
  const codePromise = waitForCode(port, 180_000);

  try {
    openTab(authUrl.toString());
    // 동의 화면은 단계마다 로딩이 있다. 화면을 판별해 누르고, 리디렉트될 때까지 반복한다.
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const url = currentAuthUrl();
      if (url && url.includes('127.0.0.1')) break;          // 리디렉트 완료
      if (!url) continue;
      try {
        const r = chromeJS('accounts.google.com', CLICK_JS);
        if (r !== 'WAIT') console.log(`   ▶ ${r}`);
      } catch { /* 탭이 아직 없거나 전환 중 */ }
    }

    const code = await codePromise;
    console.log('   ✅ authorization code 수신');
    const tokens = await exchange(code, clientId, clientSecret, redirectUri);
    if (!tokens.refresh_token) throw new Error('refresh_token 이 응답에 없다 (이미 승인된 앱이면 생략된다 — myaccount.google.com/permissions 에서 접근 삭제 후 재시도)');

    // 채널이 바뀌면 되돌린다. 잘못된 브랜드 계정은 다음 발행을 남의 채널로 보낸다.
    const ch = await channelOf(tokens.refresh_token, clientId, clientSecret);
    if (ch.id !== EXPECTED_CHANNEL_ID) {
      throw new Error(`채널이 다르다: ${ch.title} (${ch.id}) ≠ 기대 ${EXPECTED_CHANNEL_ID} — 브랜드 계정 "${BRAND}" 선택 실패. 기존 토큰을 유지한다`);
    }

    writeEnv('YOUTUBE_OAUTH_REFRESH_TOKEN', tokens.refresh_token);
    writeEnv('YOUTUBE_OAUTH_ISSUED_AT', new Date().toISOString());
    closeTab('127.0.0.1');
    console.log(`   ✅ 갱신 완료 — 채널 ${ch.title} (${ch.id}), 다시 7일`);
    notify(`🔐 <b>YouTube OAuth 자동 갱신</b>\n채널: ${ch.title}\n남은 기간이 ${state.days_left}일이라 갱신했습니다. 다시 7일.`);
    process.exit(0);
  } catch (e) {
    // 기존 토큰은 건드리지 않았다 — 실패해도 남은 시간 동안은 계속 돈다.
    if (prevToken && readEnv('YOUTUBE_OAUTH_REFRESH_TOKEN') !== prevToken) writeEnv('YOUTUBE_OAUTH_REFRESH_TOKEN', prevToken);
    closeTab('127.0.0.1');
    console.error(`   ❌ 자동 갱신 실패: ${e.message}`);
    notify(`⚠️ <b>YouTube OAuth 자동 갱신 실패</b>\n${e.message}\n남은 기간: ${state.days_left}일\n\n수동:\n<code>node scripts/automation/setup-youtube-oauth.js</code>`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
