# BarroTube — Independent Skill

> Claude Code Skill로 패키징된 BarroTube YouTube 자동화 회사. Paperclip 0% 의존, 호출 한 번으로 마케팅 분석 → EP 산출 → YouTube 업로드까지 완주.

## 5초 요약

```
/barrotube              # 마스터 진입점 (5개 모드 AskUserQuestion)
/barrotube ep <args>    # 단일 EP 라이프사이클 단축
/barrotube doctor       # 시스템 진단
```

## 위치

```
$BARROTUBE_HOME = /Users/beye/workspace/BarroSkills/.claude/skills/barrotube  (코드 영역)
$BARROTUBE_DATA = ~/BarroTubeData                                              (데이터 영역, 별도)

# 코드 영역 (스킬 자체 — commit 대상)
SKILL.md                          본 스킬 진입점 (/barrotube + args 서브커맨드)
references/                       PIPELINE, MARKETING, SECRETS, ARCHITECTURE, DOCTOR, EP, AUTO-PIPELINE
templates/                        brief, series-curriculum, channel-config
lib/                              install-cron.sh, doctor-cli.sh, guards.sh, auto-pipeline.sh
scripts/automation/               60+ active automation 스크립트
scripts/automation/_legacy_paperclip/  10개 격리된 Paperclip 의존 스크립트
config/                          거버넌스 JSON (정책 — personas, formats, budget, autonomy-pause 등)
.env.example                     셋업 가이드 (실 파일, commit 대상)

# 데이터 영역 (symlink로 연결 — gitignore, 환경마다 다름)
workspace/  →  $BARROTUBE_DATA/workspace/   (episodes/, channels/, intel/, daily-news/)
logs/       →  $BARROTUBE_DATA/logs/        (audit/, budget/, cron/)
.env        →  $BARROTUBE_DATA/.env         (운영자 secrets)
logs/                            audit/budget/cron 로그
~/.claude/agents/                17개 CLI agent (전역 user-scope)
```

## 빠른 시작

1. **`.env` 셋업**:
   ```bash
   cd $BARROTUBE_HOME
   cp .env.example .env
   vi .env   # ELEVENLABS_API_KEY, GOOGLE_AI_API_KEY, YOUTUBE_OAUTH_REFRESH_TOKEN, PAPERCLIP_DISABLED=1
   ```
   상세: `.claude/skills/barrotube/references/SECRETS.md`

2. **시스템 진단**:
   ```
   /barrotube doctor
   ```
   모든 키 GREEN 확인.

3. **신규 EP 만들기**:
   ```
   /barrotube
   → 모드 A (신규 EP)
   → 토픽 입력
   → S0~S11 자동 진행 (S10 Board 승인 + S11 publish는 운영자 명시)
   ```

4. **Cron 자동화 (선택)**:
   ```
   /barrotube install-cron daily-producer "06:00"
   /barrotube install-cron weekly-marketing "Mon 09:00"
   /barrotube install-cron doctor-daily "07:00"
   ```

## 핵심 문서

| 문서 | 내용 |
|---|---|
| [SKILL.md](./SKILL.md) | 마스터 진입점 — 5개 모드 |
| [references/PIPELINE.md](./references/PIPELINE.md) | S0~S12 단계별 상세 |
| [references/MARKETING.md](./references/MARKETING.md) | 마케팅 → 시리즈 부트스트랩 |
| [references/SECRETS.md](./references/SECRETS.md) | API key·OAuth 셋업 |
| [references/ARCHITECTURE.md](./references/ARCHITECTURE.md) | 17 에이전트 + 위임 라인 |

## 의존성

- **OS**: macOS 14+ (launchd cron, Keychain 시크릿)
- **Node**: v20+ (package.json `engines` 명시)
- **외부 API**: ElevenLabs, Google AI/Gemini, YouTube Data API
- **로컬 도구**: FFmpeg (render-direct.js), Python 3.10+ (sharp 의존성)

## ~/youtube-co/와의 관계

BarroSkills는 ~/youtube-co/의 70%를 재사용하지만 **완전 독립**:
- 워크스페이스 분리 (`/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/workspace/` ≠ `~/youtube-co/workspace/`)
- 시크릿 분리 (BarroSkills `.env`)
- Paperclip API 호출 0% (`_legacy_paperclip/` 격리)
- launchd 데몬 분리 (`com.barroskills.*` ≠ `com.barrotube.*`)
- 17 에이전트 공유 (`~/.claude/agents/` user-scope)

기존 ~/youtube-co/를 무수정 보존. 두 시스템 병행 가능.

## 라이선스·기여

본인 1명용 (1차, 2026-05-24). 일반 배포 v2 검토 예정.
