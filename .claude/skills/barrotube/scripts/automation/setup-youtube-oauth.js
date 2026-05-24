#!/usr/bin/env node

/**
 * setup-youtube-oauth.js — YouTube OAuth refresh_token 자동 발급 마법사
 *
 * OAuth 2.0 Loopback Flow 사용 (Desktop app 타입 권장).
 * 로컬 웹서버(127.0.0.1:random)를 띄우고 브라우저로 Google 인증 페이지 자동 열기.
 * 사용자가 승인하면 authorization_code를 받아 refresh_token으로 교환.
 *
 * 사전 준비:
 *  1. Google Cloud Console → 새 프로젝트 or 기존 프로젝트 선택
 *  2. "APIs & Services" → "Enable APIs" → "YouTube Data API v3" 활성화
 *  3. "APIs & Services" → "Credentials" → "Create Credentials" → "OAuth client ID"
 *     - Application type: **Desktop app**
 *     - Name: "BarroTube Uploader"
 *  4. 발급된 Client ID / Client Secret을 .env에 저장:
 *     YOUTUBE_OAUTH_CLIENT_ID=...
 *     YOUTUBE_OAUTH_CLIENT_SECRET=...
 *  5. OAuth consent screen → Scopes에 `youtube.upload` 추가
 *     → Test users에 업로드할 YouTube 계정의 Google 이메일 추가
 *  6. 이 스크립트 실행:
 *     node setup-youtube-oauth.js
 *
 * 결과: .env의 YOUTUBE_OAUTH_REFRESH_TOKEN 값 자동 업데이트
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSecret } from './config-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// 'youtube' = 채널 전체 read/write (업로드 + 썸네일 + 재생목록 + 댓글 등)
// 'youtube.upload' 단독으로는 playlists.insert 불가 → 'youtube' 확장 필요
const SCOPE = 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload';

function findFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForAuthCode(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>❌ OAuth 실패: ${error}</h1><p>터미널로 돌아가세요.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>BarroTube</title></head>
<body style="font-family:system-ui;text-align:center;padding:40px">
  <h1>✅ YouTube 인증 완료!</h1>
  <p>터미널로 돌아가 refresh_token이 .env에 저장되었는지 확인하세요.</p>
  <p>이 창은 닫으셔도 됩니다.</p>
</body></html>`);
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(404);
      res.end();
    });
    server.listen(port, '127.0.0.1');
  });
}

async function exchangeCodeForToken(code, clientId, clientSecret, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function updateEnvFile(key, value) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content, 'utf-8');
}

async function main() {
  console.log('🔐 BarroTube YouTube OAuth Setup');
  console.log('═══════════════════════════════════════');

  const clientId = getSecret('YOUTUBE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('YOUTUBE_OAUTH_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    console.error('\n❌ YOUTUBE_OAUTH_CLIENT_ID / YOUTUBE_OAUTH_CLIENT_SECRET이 .env에 없습니다.');
    console.error('\n사전 준비 방법:');
    console.error('  1. https://console.cloud.google.com/apis/credentials');
    console.error('  2. "OAuth 2.0 Client IDs" → "Create Credentials" → Desktop app');
    console.error('  3. Client ID / Client Secret을 .env에 저장 후 재실행');
    process.exit(1);
  }

  const port = await findFreePort();
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log(`\n🌐 로컬 서버: ${redirectUri}`);
  console.log('🚀 브라우저에서 Google 인증 페이지를 엽니다...\n');

  // macOS 브라우저 자동 오픈
  try {
    execSync(`open "${authUrl.toString()}"`);
  } catch {
    console.log(`수동으로 아래 URL을 열어주세요:\n${authUrl.toString()}\n`);
  }

  console.log('⏳ 브라우저에서 권한 승인을 기다리는 중...');
  const code = await waitForAuthCode(port);
  console.log('✅ Authorization code 수신');

  console.log('🔄 refresh_token 교환 중...');
  const tokens = await exchangeCodeForToken(code, clientId, clientSecret, redirectUri);

  if (!tokens.refresh_token) {
    console.error('\n❌ refresh_token을 받지 못했습니다.');
    console.error('   이전에 이미 이 Client ID로 승인한 적이 있으면 Google이 refresh_token을 생략합니다.');
    console.error('   해결: https://myaccount.google.com/permissions 에서 해당 앱 접근 삭제 후 재시도');
    process.exit(1);
  }

  updateEnvFile('YOUTUBE_OAUTH_REFRESH_TOKEN', tokens.refresh_token);

  console.log('\n✅ 저장 완료!');
  console.log(`   .env의 YOUTUBE_OAUTH_REFRESH_TOKEN 업데이트됨`);
  console.log(`   만료: ${tokens.expires_in ? `${tokens.expires_in}초 후 (access_token)` : 'N/A'}`);
  console.log(`   Scope: ${tokens.scope}`);
  console.log('\n다음 단계: node scripts/automation/publish-youtube.js --video ... --meta ... 로 실 업로드 테스트');
}

main().catch((e) => {
  console.error(`\n❌ Setup failed: ${e.message}`);
  process.exit(1);
});
