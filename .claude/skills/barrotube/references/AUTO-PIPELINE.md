# AUTO-PIPELINE.md — 완전 자율 EP 발행

> **마케팅 → 콘텐츠 → YouTube 업로드까지 호출 한 번에 자동.** 안전 가드 10개로 5/22 같은 silent failure 차단.

## 흐름 (8 Phase)

```
[Phase 0] 환경 가드 검증 (master switch, in-flight, daily quota, budget)
   ↓
[Phase 1] RSS fetch (marketing-fetch-local.js) — 무비용
   ↓
[Phase 1b] 토픽 자동 선정 (ceo-select-topics.js 휴리스틱) — 무비용
   ↓
[Phase 2] S0 brief 생성 (create-episode.js) — 무비용
   ↓
[Phase 3] S4~S9 produce-episode.js --execute — 💰 비용 ~$0.5
            (Script → Factcheck HIGH 회귀 → TTS → Image → Render → QA → Metadata)
   ↓
[Phase 4] QA Gate (score ≥ 60, blocker = 0)
   ↓ FAIL → Telegram 알람 + exit (publish 안 함)
   ↓ PASS
[Phase 5] S10 자율 승인 (approve-episode.js --by auto-pipeline)
   ↓
[Phase 6] Telegram reject window 30분
   ↓ 운영자 /reject EP-XXXX → exit (publish 안 함)
   ↓ 통과
[Phase 7] S11 publish-youtube.js --execute — 💰📺 영상 공개
   ↓
[Phase 8] 완료 알람 (videoId + URL Telegram 전송)
```

## 안전 가드 10개

| # | 가드 | 위치 | 위반 시 |
|---|---|---|---|
| 1 | **Master kill switch** | `config/autonomy-pause.json` status | paused면 Phase 0에서 즉시 exit 0 |
| 2 | **일일 EP 상한** | `guards.max_episodes_per_day` (=1) | 오늘 이미 publish 1편이면 exit 0 |
| 3 | **월 예산 한도** | `guards.budget_block_threshold_pct` (=90) | 한도 90% 도달 시 exit 0 |
| 4 | **In-flight 락** | `workspace/.in-flight.json` | 다른 EP 진행 중이면 exit 0 (stale은 자동 정리) |
| 5 | **Fact-check HIGH 회귀** | `guards.factcheck_max_rewrites` (=2) | produce-episode 내부에서 2회 시도 후 escalation |
| 6 | **QA Gate** | `guards.qa_min_score` (=60) | score < 60 또는 verdict=FAIL 시 publish 차단 |
| 7 | **Telegram reject window** | `guards.publish_reject_window_minutes` (=30) | 운영자가 `/reject EP-XXXX` → exit 0 |
| 8 | **Audit log 단계별 기록** | `logs/audit/YYYY-MM-DD.jsonl` | silent failure 즉시 탐지 |
| 9 | **Telegram 실패 알람** | `notify_telegram()` | 어느 단계든 실패 시 stage·detail 즉시 알림 |
| 10 | **Idempotency / Resume** | `RESUME_EP=EP-XXXX` env | 중단된 EP에서 재개 가능 (수동 호출) |

## 설치

```bash
# 1. .env에 필수 키 채우기 (5종)
vi /Users/beye/workspace/BarroSkills/.claude/skills/barrotube/.env

# 2. autonomy-pause.json 확인 (status=active 기본)
cat /Users/beye/workspace/BarroSkills/.claude/skills/barrotube/config/autonomy-pause.json

# 3. 시스템 진단 (모든 GREEN 확인)
bash /Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/doctor-cli.sh

# 4. DRY_RUN 검증 (실제 비용 0)
DRY_RUN=1 bash /Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/auto-pipeline.sh

# 5. 수동 1회 실제 실행 (💰 비용)
bash /Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/auto-pipeline.sh

# 6. 안정성 확인 후 cron 설치 (매일 06:30 자동)
bash /Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/install-cron.sh install auto-pipeline "06:30"

# 7. Telegram bot도 함께 (reject window, /pause 등)
bash /Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/install-cron.sh install telegram-bot
```

## 환경 변수 옵션

```bash
DRY_RUN=1                          # 명령어 echo only, 비용 0
FORCE_TOPIC="미국 금리 인하"       # 토픽 강제 (RSS skip)
RESUME_EP=EP-2026-NNNN             # 특정 EP 재개 (Phase 1·2 skip)
```

## Telegram 제어 명령

| 명령 | 동작 |
|---|---|
| `/pause` | autonomy paused — 모든 cron + auto-pipeline 즉시 중단 |
| `/resume` | autonomy active — 다음 cron부터 복귀 |
| `/reject EP-XXXX` | reject window 30분 내 publish 차단 |
| `/doctor` | 즉시 진단 (모든 가드 상태) |
| `/budget` | 현재 월 예산 사용량 |
| `/status` | 진행 중 EP·큐 분포 |

## 운영 안전 권장

### Week 1 — DRY_RUN 검증
```bash
DRY_RUN=1 bash lib/auto-pipeline.sh   # 매일 수동 실행, 흐름 확인
```

### Week 2 — 수동 실제 실행 (1편씩)
```bash
bash lib/auto-pipeline.sh             # 매일 수동, 모든 stage·QA·비용 모니터링
```

### Week 3+ — Cron 자동 (autonomy 활성)
```bash
bash lib/install-cron.sh install auto-pipeline "06:30"
```

매일 06:30 자동 실행. 운영자는 Telegram으로 `/reject`만 신경 쓰면 됨.

## 5/22 silent failure 회귀 방지

| 옛 BarroTube 사고 | BarroSkills 방어 |
|---|---|
| `lifecycle-bridge.js`의 status 누락 → 23일 마비 | `doctor-daily` cron이 매일 audit log 0건 시 알람 |
| effectiveness=0% 8시간 연속 | `audit_today` 가 매 호출 기록, idle 24h 시 escalation |
| backlog 42건 stranded | auto-pipeline은 backlog 사용 안 함 (직접 monolith) |
| Producer 단일 hub 부하 | monolith가 모든 단계 직접 실행 (Task 위임 없음) |

## 비용 추정 (cron 매일 1편 자동 가정)

| 항목 | 1편 | 월 (30편) |
|---|---|---|
| Gemini script | ~$0.10 | $3 |
| ElevenLabs TTS | ~$0.10 (5씬 shorts) | $3 |
| Gemini image (5장) | ~$0.20 | $6 |
| Gemini metadata | ~$0.05 | $1.5 |
| YouTube API | $0 (quota 내) | $0 |
| **합계** | **~$0.45** | **~$14** |

월 $770 예산의 약 2% 사용.

## 실패 시나리오 대응

| 실패 | auto-pipeline 동작 |
|---|---|
| RSS fetch 0건 | Phase 1에서 idle exit 0 + Telegram 알람 |
| 토픽 선정 결과 없음 | Phase 1b에서 idle exit 0 (정상) |
| create-episode 실패 | Phase 2에서 exit 1 + Telegram 알람 |
| produce-episode 실패 (API quota 등) | Phase 3에서 exit 1 + Telegram 알람 |
| QA FAIL | Phase 4에서 exit 0 + Telegram 수동 검토 안내 |
| 운영자 /reject | Phase 6에서 exit 0 (정상 cancel) |
| publish-youtube 실패 (OAuth 만료) | Phase 7에서 exit 1 + Telegram setup-oauth 안내 |

## 한계 & 미해결

1. **Phase 3 비용 발생을 막을 방법 없음 (의도)** — 자율 운영의 본질. autonomy-pause로 전체 중단만 가능
2. **Task 위임 (Claude agent) 불가** — cron 셸은 monolith script만. Marketing Analyst·CMO·CEO Task agent는 별도로 운영자가 수동 호출 시 사용
3. **YouTube OAuth 6개월 만료** — `setup-youtube-oauth.js` 재실행 필요. doctor-cli.sh가 발급 시점 모니터링 권장 (TODO)
4. **shorts 우선** — long-3min은 S2·S3 (research·strategy) 필요해서 monolith만으론 부족. shorts(skip_stages 적용)가 안정
5. **content drift** — 매일 자동 EP는 토픽·페르소나 다양성 자동 보장 안 함. 운영자가 주간 검토로 채널 방향 보정 권장
