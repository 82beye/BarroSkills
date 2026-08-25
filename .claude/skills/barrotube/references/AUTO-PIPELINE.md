# AUTO-PIPELINE.md — 완전 자율 EP 발행

> **마케팅 → 콘텐츠 → YouTube 업로드까지 호출 한 번에 자동.** 안전 가드 10개로 5/22 같은 silent failure 차단.

## 흐름 (Phase 0~12)

> 2026-08-25 갱신: 문서가 `lib/auto-pipeline.sh` 의 실제 단계와 갈라져 있었다(문서 8단계 vs 코드 13단계).
> 아래는 스크립트의 `log_stage` 를 그대로 옮긴 것이다.

```
[Phase 0]  환경 가드 검증 (master switch, in-flight, daily quota, budget)
   ↓
[Phase 1]  데이터 수집 — 무비용
             fetch-market-snapshot.js  시세 18종 (지수·국채·원자재·코인·환율)
             fetch-daily-news.js       RSS 헤드라인
             fetch/analyze-competitors 경쟁 채널 (슬롯의 competitor_scan=true 일 때)
   ↓
[Phase 2a] 전문 기자단 데스크 브리핑 (desk-briefing.js) — 아래 별도 절
   ↓
[Phase 2]  시장 리서치 + 콘텐츠 전략 + 토픽 선정 (research-brief.js)
             ※ RESUME_EP / FORCE_TOPIC 이면 이 단계 전체를 건너뛴다
   ↓
[Phase 3]  S0 brief 생성 (create-episode.js) + 분석 산출물 설치
             research-<slot>.md → 10_market_research.md
             strategy-<slot>.md → 20_strategy.md
             desk-briefing.md   → 05_desk_briefing.md   (있을 때만)
   ↓
[Phase 4]  S4 대본 생성
   ↓
[Phase 5]  image_prompt 계약 검사 (무비용 게이트 — 이미지 굽기 전에 막는다)
   ↓
[Phase 6]  S5 팩트체크 (인용 URL 실존 검증) → HIGH 위험이면 대본 회귀
   ↓
[Phase 7]  이미지·모션 (브라우저 ChatGPT / 로컬 HyperFrames)
   ↓
[Phase 8]  S6~S9 자산·렌더·QA·메타 — 💰 TTS 비용
   ↓
[Phase 9]  QA Gate (score ≥ 60, blocker = 0)
   ↓ FAIL → Telegram 알람 + exit (publish 안 함)
[Phase 10] S10 승인
   ↓
[Phase 11] Telegram reject window 30분
   ↓ 운영자 /reject EP-XXXX → exit
[Phase 12] S11 YouTube 업로드 (private + publishAt)
```

## Phase 2a — 전문 기자단 데스크 브리핑

리서처 한 명이 지수·환율만 보고 토픽을 정하던 구조를 데스크로 쪼갠 것이다. 자산군별로
따로 조사시키고, 에디터가 그 위에서 **오늘 하나**를 고른다.

```bash
node scripts/automation/desk-briefing.js --slot us-close [--date YYYY-MM-DD]
                                         [--desks equities,rates] [--timeout 420] [--dry-run]
```

| 데스크 | 담당 | 시세 |
|---|---|---|
| `equities` | 다우·나스닥·S&P500·코스피·코스닥 | 5종 |
| `rates` | 미국·한국·일본 10년물, 연준·한은 | 3종 (값은 **가격이 아니라 금리 %**) |
| `commodities` | WTI·브렌트·천연가스·금·은·구리 | 6종 |
| `crypto` | 비트코인·이더리움, ETF 자금흐름·규제 | 2종 (**24시간 기준** — 주식의 전일 대비와 다르다) |
| `geopolitics` | 전쟁·분쟁·제재·선거·무역갈등이 자산에 미치는 경로 | 없음 (뉴스·검색만) |
| `fx` | 원/달러, 달러인덱스 | 2종 |

- **산출물** — `workspace/daily-news/<date>/` 에 `desk-<id>.md` (frontmatter 에 `heat` 1~10),
  에디터가 종합한 `desk-briefing.md`, 그리고 `desk-topic.json` (topic·angle·evidence[]).
- **에디터는 heat 순위를 참고값으로만 쓴다.** 여러 데스크가 같은 원인을 가리키면 그게 오늘의
  이야기다 — 자산 나열이 아니라 **인과 하나**를 고르는 게 선정 기준이다.
- **실패해도 파이프라인을 세우지 않는다.** 일부 데스크가 죽어도 남은 것으로 에디터가 돌고,
  전부 죽으면 exit 4 로 빠져 `research-brief.js` 가 그대로 이어받는다. 끄려면 `BT_DESK_BRIEFING=0`.
- **비용·시간** — 데스크당 `claude -p`(기본 sonnet) 1회. 2026-08-25 실측 데스크 ~56초,
  에디터 ~58초 → 6데스크 약 7분.

### 설정이 두 곳으로 갈라지지 않게

데스크가 담당한다고 선언한 심볼(`config/desk-reporters.json`)은 슬롯이 실제로 수집해야
한다(`config/routines.json` 의 `market.symbols`). 갈라지면 그 데스크는 매일 조용히
"스냅샷에 값이 없어 판단하지 못했다"를 쓴다 — 2026-08-25 원자재 데스크가 구리·천연가스에서
실제로 그랬다. `tests/desk-briefing.test.js` 가 이 계약을 강제한다.

### 소셜 검색은 붙는 채널만 준다

`desk-briefing.js` 가 실행 시 `agent-reach doctor --json` 을 **한 번** 돌려 살아 있는 채널만
프롬프트에 넣고, 미인증 채널은 "시도하지 마라"로 못박는다. 예전에는 `twitter search` 가
프롬프트에 박혀 있었는데 twitter-cli 가 미인증이라 6개 데스크가 저마다 실패하는 데 턴을 썼다.
2026-08-25 이 머신 기준 살아 있는 채널: github·youtube·reddit·bilibili·linkedin·v2ex·rss·exa_search·web.

## 안전 가드 10개

| # | 가드 | 위치 | 위반 시 |
|---|---|---|---|
| 1 | **Master kill switch** | `config/autonomy-pause.json` status | paused면 Phase 0에서 즉시 exit 0 |
| 2 | **일일 EP 상한** | `guards.max_episodes_per_day` (=1) | 오늘 이미 publish 1편이면 exit 0 |
| 3 | **월 예산 한도** | `guards.budget_block_threshold_pct` (=90) | 한도 90% 도달 시 exit 0 |
| 4 | **In-flight 락** | `workspace/.in-flight.json` | 다른 EP 진행 중이면 exit 0 (stale은 자동 정리) |
| 5 | **Fact-check 자동 회귀** | `guards.factcheck_max_rewrites` (=3) | Phase 6 이 `revise-script-factcheck.js` 로 지적 문장만 고쳐 재검증, 상한 소진 시 escalation |
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
