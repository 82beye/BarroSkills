# SECRETS.md — API Key·OAuth 셋업 가이드

> BarroSkills 운영에 필요한 모든 secret의 발급·저장·검증 절차.

## 필수 Secrets (5종)

| Key | 용처 | 발급 위치 | 비용 |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | TTS (S6a) | https://elevenlabs.io/app/settings/api-keys | ~$0.02/씬 ($22/월 starter) |
| `GOOGLE_AI_API_KEY` | Gemini script/image (S4, S6c~e) | https://aistudio.google.com/apikey | ~$0.04/이미지 + 토큰 |
| `YOUTUBE_DATA_API_KEY` | YouTube metadata 조회 | https://console.cloud.google.com/apis/credentials | 무료 (quota 한정) |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | YouTube 업로드 (S11) | `setup-youtube-oauth.js` 실행 | 무료 |
| `YOUTUBE_OAUTH_ISSUED_AT` | 만료 감지 기준 시각 | `setup-youtube-oauth.js` 가 자동 기록 | — |
| `YOUTUBE_OAUTH_PUBLISHED` | 프로덕션 게시 여부(`1`이면 만료 검사 끔) | 동의 화면 게시 후 수동 | — |
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

## YouTube OAuth 만료 — 7일 규칙

Google 은 OAuth **동의 화면이 "테스트" 상태**인 앱의 refresh token 을 **7일 후 만료**시킨다.
2026-08-13 이것 때문에 경쟁 채널 수집이 멈췄다 — `.env` 는 08-06 에 갱신됐고 정확히 7일이었다.
문제는 만료돼야만 알 수 있었다는 점이다. 그 사이 `competitor-scan` 은 매일 조용히 실패했다.

### 감지

```bash
node scripts/automation/check-oauth-expiry.js            # 경과일만 (무비용·오프라인)
node scripts/automation/check-oauth-expiry.js --verify   # 실제 토큰 검증 (1 unit)
```

- 5일 경과 `WARN` · 6일 `CRITICAL` · 7일 이상 `EXPIRED`
- `competitor-pipeline.sh` 가 매일 05:20 수집 **전에** 검사하고 WARN 이상이면 텔레그램 발송
- `doctor-cli.sh` 의 `youtube_oauth` 항목이 EXPIRED 를 RED 로 보고
- 발급 기록(`YOUTUBE_OAUTH_ISSUED_AT`)이 없으면 `.env` mtime 으로 추정하되 "추정"임을 밝힌다

### 자동 갱신 (기본)

```bash
node scripts/automation/renew-youtube-oauth.js            # 임박했을 때만 (launchd 용)
node scripts/automation/renew-youtube-oauth.js --force    # 지금 바로
node scripts/automation/renew-youtube-oauth.js --dry-run  # 판단만
```

남은 기간이 **3일 이하**일 때만 실제로 갱신하고, 그 외에는 즉시 종료한다.
갱신은 로컬 콜백 서버 + **로그인된 실제 Chrome** 을 AppleScript 로 몰아 동의 3단계
(브랜드 계정 선택 → "확인되지 않은 앱" 계속 → 동의 계속)를 대신 클릭한다.
Playwright 가 아니라 AppleScript 인 이유는 `grok-motion-applescript.js` 와 같다 —
자동화 지문이 없고 launchd(Aqua 세션)에서 그대로 돈다.

launchd: `com.barroskills.barrotube.oauth-renew` — 매일 **06:40** (us-close 06:00 이 끝난 뒤,
kr-close 16:00 전. 발행 중에 Chrome 을 빼앗지 않으려고 슬롯 사이에 둔다).
로그는 `logs/cron/oauth-renew.{log,err}`.

안전장치 두 가지:
- **채널 검증** — 새 토큰의 `channels.list(mine=true)` 가 기대 채널(`바로경제`,
  `UCZAXYLHl1-bFqNmnwtgrcXg`)이 아니면 되돌린다. 브랜드 계정을 잘못 고르면 다음 발행이
  남의 채널로 나간다. 다른 채널이면 `BT_YT_BRAND` / `BT_YT_CHANNEL_ID` 로 바꾼다.
- **실패해도 기존 토큰 유지** — 어느 단계에서 막히든 `.env` 를 되돌리고 텔레그램으로
  수동 절차를 알린다. 남은 기간 동안은 계속 돈다.

### 수동 갱신

```bash
node scripts/automation/setup-youtube-oauth.js
```

브라우저가 열리고 승인하면 `refresh_token` 과 `ISSUED_AT` 이 `.env` 에 저장된다.
"확인되지 않은 앱" 경고는 `계속`으로 넘어간다. 자동 갱신이 DOM 변경 등으로 깨졌을 때 쓴다.

### 영구 해결 — 지금은 막혀 있다

[동의 화면](https://console.cloud.google.com/auth/audience?project=barrotube)을 **프로덕션**으로
게시하면 만료가 사라지고 위 갱신이 통째로 불필요해진다. 게시 후 `.env` 에
`YOUTUBE_OAUTH_PUBLISHED=1` 을 넣으면 경과일 검사가 꺼진다.

**2026-08-26 실측: "앱 게시" 버튼이 비활성이다.** 경고는
*"앱의 OAuth 구성이 완료되지 않았습니다"* 이고, 원인은 브랜딩 페이지의
**애플리케이션 홈페이지 · 개인정보처리방침 링크 · 서비스 약관 링크**가 비어 있는 것이다
(외부 앱 게시의 필수 항목). 필수 표시(*)가 붙은 앱 이름·지원 이메일·개발자 연락처는
이미 채워져 있다. 즉 남은 것은 **운영자가 소유·인증한 도메인에 그 세 페이지를 올리는 일**이고,
그때까지는 위 자동 갱신이 차선이다.


## 다른 머신으로 이식

경로는 전부 환경변수 → `$HOME` 순으로 풀린다. 개인 절대경로는 코드에 없다
(`tests/portability.test.js` 가 이를 고정한다).

### 1. 레포와 데이터

```bash
git clone https://github.com/82beye/BarroSkills.git ~/workspace/BarroSkills
# 데이터는 git 밖이다 — 별도로 옮긴다
rsync -a old-host:~/BarroTubeData/ ~/BarroTubeData/
```

기본 위치가 아니면 환경변수로 지정한다.

| 변수 | 기본값 | 용도 |
|---|---|---|
| `BARROTUBE_DATA` | `~/BarroTubeData` | workspace·에피소드·인텔 |
| `BARRO_AI_FACTORY` | `~/BarroAiFactory` | today.myo 등 외부 채널 |
| `BARROTUBE_HOME` | 스크립트 위치에서 자동 감지 | 스킬 루트 |
| `BARROTUBE_CHARACTER_SHEET` | `$BARROTUBE_DATA/workspace/docs/바로경제_캐릭터시트.png` | 캐릭터 시트 |

### 2. workspace 심볼릭

`.claude/skills/barrotube/workspace` 는 gitignore 대상이다. 새 머신에서 만든다.

```bash
ln -s "${BARROTUBE_DATA:-$HOME/BarroTubeData}/workspace" \
      ~/workspace/BarroSkills/.claude/skills/barrotube/workspace
```

### 3. 시크릿

`.env` 는 추적되지 않는다. 옮기거나 새로 만든다 — 항목은 이 문서 위쪽 표 참조.
YouTube OAuth 는 머신이 바뀌어도 refresh token 을 그대로 쓸 수 있다.

### 4. 스케줄 설치

```bash
cd ~/workspace/BarroSkills/.claude/skills/barrotube
npm install
bash lib/install-cron.sh install competitor-scan "05:20,15:20"
bash lib/install-cron.sh install us-close  "06:00"
bash lib/install-cron.sh install kr-close  "Mon-Fri 16:00"
bash lib/install-cron.sh install weekly-marketing "Mon 09:00"
bash lib/doctor-cli.sh
```

`install-cron.sh` 가 설치 시점에 경로·node 를 새로 감지하므로 plist 를 복사하면 안 된다.
node 는 실행 시점에도 `guards.sh` 의 `ensure_node_on_path` 가 다시 찾으므로
nvm 버전이 올라가도 재설치 없이 계속 돈다.

### 5. macOS 밖에서

`install-cron.sh` 는 launchd 전용이다. Linux 라면 같은 스크립트를 crontab 에 건다.

```cron
20 5,15 * * *  /bin/bash ~/workspace/BarroSkills/.claude/skills/barrotube/lib/competitor-pipeline.sh
0  6   * * *   /bin/bash ~/.../lib/auto-pipeline.sh --slot us-close
0  16  * * 1-5 /bin/bash ~/.../lib/auto-pipeline.sh --slot kr-close
```

파이프라인 스크립트 자체는 bash 3.2 호환이고 PATH 를 스스로 보정하므로 그대로 돈다.
