# SECRETS.md — API Key·OAuth 셋업 가이드

> BarroSkills 운영에 필요한 모든 secret의 발급·저장·검증 절차.

## 필수 Secrets (5종)

| Key | 용처 | 발급 위치 | 비용 |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | TTS (S6a) | https://elevenlabs.io/app/settings/api-keys | ~$0.02/씬 ($22/월 starter) |
| `GOOGLE_AI_API_KEY` | Gemini script/image (S4, S6c~e) | https://aistudio.google.com/apikey | ~$0.04/이미지 + 토큰 |
| `YOUTUBE_DATA_API_KEY` | YouTube metadata 조회 | https://console.cloud.google.com/apis/credentials | 무료 (quota 한정) |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | YouTube 업로드 (S11) | `setup-youtube-oauth.js` 실행 | 무료 |
| `PAPERCLIP_DISABLED` | BarroSkills 독립 운영 | (직접 설정 = 1) | 무료 |

## 선택 Secrets

| Key | 용처 |
|---|---|
| `YOUTUBE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` | OAuth flow 재발급 시 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | S10 Telegram /approve 게이트 (미설정 시 AskUserQuestion) |
| `FAL_API_KEY` / `REPLICATE_API_KEY` | 이미지 fallback (Gemini 장애 시) |

## 저장 방식 2종

### 방식 A — `.env` 파일 (간단, 권장)

```bash
cd $BARROTUBE_HOME
cp .env.example .env
vi .env   # 또는 nano

# 필수 5개 입력
ELEVENLABS_API_KEY=sk_...
GOOGLE_AI_API_KEY=AIza...
YOUTUBE_DATA_API_KEY=AIza...
YOUTUBE_OAUTH_REFRESH_TOKEN=1//0...
PAPERCLIP_DISABLED=1
```

`.gitignore`에 `.env` 추가됨 (이미 .env.example만 commit).

### 방식 B — macOS Keychain (보안 강화)

```bash
# 각 키마다 한 번씩
security add-generic-password -a beye -s ELEVENLABS_API_KEY -w "sk_..."
security add-generic-password -a beye -s GOOGLE_AI_API_KEY -w "AIza..."
security add-generic-password -a beye -s YOUTUBE_DATA_API_KEY -w "AIza..."
security add-generic-password -a beye -s YOUTUBE_OAUTH_REFRESH_TOKEN -w "1//0..."

# .env에는 PAPERCLIP_DISABLED만
echo "PAPERCLIP_DISABLED=1" > .env
```

`config-loader.js`의 `getSecret()`이 다음 순서로 검색:
1. `process.env[KEY]`
2. `.env` 파일 (자동 로드)
3. `security find-generic-password -a beye -s <KEY>` (Keychain)

## YouTube OAuth 발급 (Step-by-step)

### 1단계 — Google Cloud Project 생성

1. https://console.cloud.google.com/projectcreate
2. Project name: `barroskills` (또는 임의)
3. Create

### 2단계 — YouTube Data API v3 활성화

1. APIs & Services → Library
2. "YouTube Data API v3" 검색 → Enable

### 3단계 — OAuth 2.0 Client ID 발급

1. APIs & Services → Credentials → Create Credentials → OAuth client ID
2. Application type: **Desktop app**
3. Name: `BarroSkills Desktop`
4. Create → `client_id` + `client_secret` 표시
5. 다운로드 (JSON) → 보관

### 4단계 — Test User 등록 (Pre-publish 필수)

1. APIs & Services → OAuth consent screen
2. App name: `BarroSkills`
3. Test users → 본인 Google 계정 추가
4. Save

### 5단계 — Refresh Token 발급

```bash
cd $BARROTUBE_HOME
node scripts/automation/setup-youtube-oauth.js
```

- 브라우저가 자동 열림 → Google 로그인
- "이 앱은 확인되지 않았습니다" → "Advanced" → "Go to BarroSkills (unsafe)" 클릭
- Scope 2종 승인:
  - `youtube.upload` (영상 업로드)
  - `youtube` (재생목록·썸네일 권한)
- "Continue" → loopback 127.0.0.1:<random>으로 redirect
- 자동으로 refresh_token 추출 후 `.env` 또는 Keychain에 저장

### 6단계 — 검증

```bash
node -e "
import('./scripts/automation/publish-youtube.js').then(m => {
  m.getYouTubeClient().then(c => console.log('OAuth OK'));
});
"
```

## API Key 검증 명령

`.env` 채운 직후:

```bash
cd $BARROTUBE_HOME

# ElevenLabs
curl -s -H "xi-api-key:$(grep ELEVENLABS .env | cut -d= -f2)" https://api.elevenlabs.io/v1/user 2>&1 | head -5

# Google AI (Gemini)
curl -s "https://generativelanguage.googleapis.com/v1/models?key=$(grep GOOGLE_AI .env | cut -d= -f2)" 2>&1 | head -3

# YouTube Data API
curl -s "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&key=$(grep YOUTUBE_DATA .env | cut -d= -f2)" 2>&1 | head -5

# 또는 /barrotube doctor 호출로 일괄 검증
```

## OAuth 토큰 만료 대응

YouTube refresh_token은 6개월 미사용 시 무효화될 수 있음.
- 증상: S11 publish 시 `invalid_grant` 에러
- 복구: `node scripts/automation/setup-youtube-oauth.js` 재실행

## 비용 모니터링

월 한도 (`config/budget-policy.json`):
- ElevenLabs: voice-engineer $120/월
- Gemini: image-generator $150/월 (이미지), writer $120/월 (스크립트)
- YouTube API: 무료 (10,000 unit/일 쿼터, 영상 1편 upload = 1600 unit)

`/barrotube doctor`로 매주 1회 사용량 점검 권장.

## 보안 권장사항

1. **`.env` 절대 git commit 금지** — `.gitignore` 이미 등록
2. API key 회전 (rotation) 3개월에 1회
3. Test user에 본인 계정만 등록 (production 전환 전)
4. YouTube OAuth scope 최소화 — `youtube.readonly`로는 upload 불가, `youtube.upload + youtube` 2종이 BarroSkills에 필요
5. macOS Keychain 사용 시 잠금화면 활성화 (시크릿 보호)
