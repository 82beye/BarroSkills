# BarroSkills — Quickstart (5분 인계 가이드)

> 처음 사용하는 운영자를 위한 5단계 빠른 시작.

## 1단계 (1분) — 환경 변수 셋업

```bash
cd /Users/beye/workspace/BarroSkills/.claude/skills/barrotube
vi .env  # 이미 .env.example을 복사한 상태
```

채워야 할 5개 필수 키:
```bash
ELEVENLABS_API_KEY=sk_...                # TTS
GOOGLE_AI_API_KEY=AIza...                # Gemini (script + image)
YOUTUBE_DATA_API_KEY=AIza...             # YouTube metadata
YOUTUBE_OAUTH_REFRESH_TOKEN=1//0...      # YouTube upload (S11)
PAPERCLIP_DISABLED=1                     # 이미 설정됨, 그대로
```

API 키 발급법: `.claude/skills/barrotube/references/SECRETS.md`

## 2단계 (10초) — 진단

새 Claude Code 세션에서:
```
/barrotube doctor
```

모든 항목 GREEN 확인. RED 있으면 해당 단계 안내 참조.

수동 진단도 가능:
```bash
cd /Users/beye/workspace/BarroSkills/.claude/skills/barrotube
PAPERCLIP_DISABLED=1 bash .claude/skills/barrotube/lib/doctor-cli.sh
```

## 3단계 (1분) — 첫 EP 만들기 (dry-run)

```
/barrotube
```

AskUserQuestion에서:
- Mode A (신규 EP) 선택
- 토픽 예: "S&P500 vs NASDAQ 100"
- Channel: econ-daily
- Format: long-3min

S0 brief까지만 자동 생성 (무비용). S6/S11 비용 발생 단계 진입 전 운영자 명시 확인 받음.

## 4단계 (15~30분) — 실제 EP 발행 (선택, 💰 비용)

```bash
cd /Users/beye/workspace/BarroSkills/.claude/skills/barrotube
PAPERCLIP_DISABLED=1 node scripts/automation/run-episode.js --episode EP-2026-NNNN --execute
```

`--execute` 플래그가 있어야 실제 API 호출. 비용 약 $0.5~$1/편 (S6a TTS + S6c Image + S11 publish).

## 5단계 (선택) — 자율화 (cron 설치)

```bash
# 매일 06:00 EP 큐 점검
bash .claude/skills/barrotube/lib/install-cron.sh install daily-producer "06:00"

# 매주 월요일 09:00 마케팅 분석
bash .claude/skills/barrotube/lib/install-cron.sh install weekly-marketing "Mon 09:00"

# 매일 07:00 자동 진단
bash .claude/skills/barrotube/lib/install-cron.sh install doctor-daily "07:00"

# 현재 설치 목록
bash .claude/skills/barrotube/lib/install-cron.sh list

# 제거
bash .claude/skills/barrotube/lib/install-cron.sh uninstall daily-producer
```

## 자주 쓰는 명령

```
/barrotube                          # 마스터 진입점
/barrotube produce <topic>          # 신규 EP 빠른 부트스트랩
/barrotube ep status <EP-NNNN>      # 단일 EP 진행 상태
/barrotube ep run EP-NNNN --execute # 단일 EP 풀체인 발행
/barrotube doctor                   # 시스템 점검
```

## 문제 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| `secrets: RED` | .env에 키 누락 | `vi .env` 후 채우기 |
| `agents: <17` | ~/.claude/agents/ 불완전 | `cp ~/youtube-co/claude-code/.claude/agents/*.md ~/.claude/agents/` |
| `in_flight_lock: stale` | EP 작업 중 비정상 종료 | `node scripts/automation/in-flight-lock.js force-release` |
| `paperclip_leak: YELLOW` | _legacy_paperclip 격리 미완 | grep으로 위반 파일 찾아 격리 |
| YouTube 401 / invalid_grant | OAuth 만료 (6개월 미사용) | `node scripts/automation/setup-youtube-oauth.js` 재발급 |
| Gemini 403 | API quota 초과 | 콘솔에서 quota 확인, 또는 FAL/Replicate fallback |
| `node not found` 오류 | NVM 환경 변수 누락 (cron에서) | install-cron.sh의 NODE_BIN 명시 확인 |

## 핵심 파일 위치

```
$BARROTUBE_HOME/
├── .env                                  # 운영자가 채움 (절대 commit 금지)
├── .claude/skills/barrotube/SKILL.md     # 마스터 진입점
├── .claude/skills/barrotube/references/  # 4개 상세 가이드
├── scripts/automation/                   # 61 active 스크립트
├── config/                               # 10 거버넌스 JSON
├── workspace/episodes/EP-*/              # 산출물
├── logs/audit/YYYY-MM-DD.jsonl           # 모든 작업 기록
└── logs/budget/usage-YYYY-MM.json        # 비용 추적

~/.claude/agents/                         # 17 글로벌 CLI 에이전트
```

## ~/youtube-co/와의 관계

**완전 독립**. 두 시스템 병행 가능:
- ~/youtube-co/ 의 Paperclip + launchd 자율 회사 → 그대로 운영 가능 (무영향)
- BarroSkills → on-demand 또는 cron 자율, Paperclip 0% 의존

같은 API key를 두 곳에서 사용해도 무방 (quota 통계는 각자 별도).

## 다음 단계

운영자 1명용 1차 완성. 다음 가능한 작업:
1. 실제 EP 1편 발행 검증 (Phase 5b — 운영자 명시 후)
2. Cron 설치 (자율 운영)
3. CLI agent의 prompt 보강 (BarroSkills 컨텍스트 명시)
4. README + PRD 통합 정리
5. (v2) 일반 배포용 init wizard, multi-channel 지원
