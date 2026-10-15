# 페이퍼클립 관제 — BarroTube 자동화 (2026-10-07~)

> 페이퍼클립 = **관제탑**(언제·누가·얼마나·무엇이 깨졌나), 로컬 파이프라인 = **공장**(실제로 무엇을 하나, 결정론 그대로).
> 정본: `config/paperclip/company.json`(에이전트·목표·루틴) · `actions.json`(실행 허용 목록) · `token-policy.json`(토큰 관제 기준).
> 서버: `http://127.0.0.1:3100` (launchd `com.barroskills.paperclip`, KeepAlive) · 회사 BarroTube `46041d31…`.

## 1. 왜 이렇게 생겼나

4~5월 체제는 에이전트 17명이 생산 단계를 LLM 으로 하고 타이머(5분)로 깨어 **캐시 입력 10억 토큰·16,962회 실행**을 썼고
stranded→blocked 루프로 5월 23일 멈췄다(큐에 실행 19건이 그대로 남아 있었다). 생산은 그 뒤 결정론 파이프라인으로 옮겨 안정됐다.
새 체제는 그 둘을 합친다: **생산은 결정론 그대로, 판단이 필요한 4곳만 LLM**, 그리고 모든 일은 정해진 스케줄 또는 장애로만 시작한다.

## 2. 편성 — 에이전트 7명 (휴면 14명은 기록 보존용으로 pause)

| 에이전트 | 어댑터·모델 (기본 / 절약 / 대체) | 깨는 조건 | 하루 상한 | 하는 일 |
|---|---|---|---|---|
| CEO | Claude Opus 5.5 high / Sonnet 5.5 / Codex gpt-6-astra | 월 09:30 루틴 | $8 | 주간 경영 리뷰·제안 채택(주 1건↓)·목표 오너 |
| CMO | Codex gpt-6.1-sol medium / gpt-6-luna high / Claude Sonnet 5.5 | 월 08:30 루틴 | $5 | 주간 성장 메모(병목·실험 판정·제안) |
| SRE Engineer | Claude Opus 5.5 high / Sonnet 5.5 / Codex gpt-6.1-sol high | 장애 이슈 | $20 | 원인 확인→사본 수정·테스트→리뷰→반영→재개 |
| Code Reviewer | Codex gpt-6.1-sol high / gpt-6.1-sol medium / Claude Sonnet 5.5 | 리뷰 이슈 | $6 | 다른 모델의 눈으로 패치 승인·반려 |
| Producer | process (모델 없음) | 생산 루틴·재개 이슈 | 0 | 발행 슬롯·재개를 dispatch.js 로 |
| Ops Runner | process (모델 없음, 동시 3) | 운영 루틴 | 0 | 수집·KPI·마켓맵·진단·리포트 |
| Token Governor | process (모델 없음) | 15분 타이머 | 0 | 한도 창 → 엔진·모델·루틴 조절, 순회 |

- 역할 배분 원칙(이 저장소 워커 규약): **Claude = 메인 코딩·디버깅·전략**, **Codex = 분석·리뷰·비평**. 수리(Claude)와 리뷰(Codex)는 다른 공급자.
- Codex Pro 배정: 반복되는 분석·리뷰는 6.1 Sol, 노랑 단계의 CMO는 Luna, 드문 CEO 대체 판단만 Astra. Pro의 사용량은 모델·작업 크기에 따라 달라지므로 고정 호출 수 대신 실제 한도 창을 따른다.
- LLM 에이전트는 **로컬 CLI 엔진**(`engine: cli`)으로 돈다 — 페이퍼클립 ACP 경로의 번들 Claude Code(2.1.257)는 Opus 5.5 를 거부했다.
- 하루 상한은 API 환산 USD(구독이라 청구액은 0, 실행별 `usageJson.costUsd` 합). 넘으면 거버너가 다음 날까지 pause.
- 위임은 세 경로뿐: SRE→Reviewer(리뷰), SRE→Producer(`action: resume`), CEO→SRE(`[구현]`, 주 1건). 지침 `scripts/automation/paperclip/instructions/`.

## 3. 루틴 — launchd 크론 13개를 그대로 옮김

| 루틴 | KST | 담당 | 액션 | 등급 |
|---|---|---|---|:-:|
| 생산 · 미국 증시 마감 | 매일 06:00 | Producer | `slot:us-close` | 0 |
| 생산 · 점심 옴니버스 | 월~목 10:00 | Producer | `slot:omnibus` | 0 |
| 생산 · 주간 부동산 | 금 10:00 | Producer | `slot:realestate` | 0 |
| 생산 · 국내 증시 마감 | 월~금 16:00 | Producer | `slot:kr-close` | 0 |
| 생산 · 미게시 회수 | 07:30·17:30 | Producer | `job:publish-resume` | 0 |
| 운영 · 마켓맵 | 08:00·18:00 | Ops | `job:market-map` | 0 |
| 운영 · KRX 종가 스냅샷 | 월~금 15:45 | Ops | `job:market-map-krclose` | 0 |
| 운영 · 경쟁 인텔 | 05:20·15:20 | Ops | `job:competitor-scan` | 1 |
| 운영 · OAuth 점검 | 06:40 | Ops | `job:oauth-renew` | 0 |
| 운영 · 자동 진단 | 07:10 | Ops | `job:doctor` | 0 |
| 성장 · KPI 루프 (+목표 동기화) | 05:40·15:40 | Ops | `job:growth` | 0 |
| 성장 · 주간 마케팅 수집 | 월 09:00 | Ops | `job:weekly-marketing` | 1 |
| 성장 · 성장 매니저 | 19:40 | Ops | `job:growth-manager` | 1 |
| 성장 · CMO 주간 메모 | 월 08:30 | CMO | (LLM) | 2 |
| 성장 · CEO 주간 리뷰 | 월 09:30 | CEO | (LLM) | 2 |
| 관제 · 토큰 일일 리포트 | 21:00 | Ops | `job:token-report` | 0 |

- launchd 에 남는 것: `telegram-bot`(상시 데몬), `deadman-*`(정시+20분 폴백), `rescue-kr-close`(17:20·19:20·21:20 실패 회차 재점검), `com.barroskills.paperclip`(서버).
- 등급: 0 = 늘 돈다 · 1 = 두 공급자 모두 RED 면 보류 · 2 = 담당 기본 공급자 YELLOW↑ 면 보류. **보류는 연기**다 — 풀리면 놓친 회차가 한 번 돈다.
- `tests/paperclip-automation.test.js` 의 이관 대응표가 시각·명령·로그 이름을 고정한다. 편성을 바꾸면 그 표와 company.json 을 같이 고친다.

## 4. 실행 — dispatch.js 와 회차 마커

루틴이 이슈를 만들고(본문 첫 줄 `action: …`) 담당 process 에이전트를 깨우면 `dispatch.js` 가:
1. 이슈의 액션을 **허용 목록**으로 푼다 (슬롯·EP 형식 검증, 임의 명령 거부, 만든 주체 확인 — SRE 는 재개·재실행만).
2. 회차 마커 `workspace/ops/runs/<KST날짜>/<키>.json` 을 **O_EXCL 로 선점**한다 — daily / twice-daily(오전·오후) / attempt(재개 #n).
   이미 있으면 돌고 있으면 붙고, 끝났으면 「이미 실행됨」 댓글 후 done. 페이퍼클립 catch-up·데드맨·복구 실행이 겹쳐도 한 번만 돈다.
3. 파이프라인을 **분리된 프로세스 그룹**으로 띄워 `logs/cron/<이름>.log/.err`(launchd 시절과 같은 파일)에 쓴다. 1분마다 진행 줄.
4. 끝나면 결과 분류 — `done` · `halted`(exit 0 이어도 실행 중 새 장애 기록) · `failed` · `lost` · `guarded`(🛑 가드).
5. 이슈에 결과 댓글, 성공은 `done`, 실패·멈춤은 **SRE 장애 이슈에 막힌 blocked + 배정 해제**.

페이퍼클립이 재시작돼도 파이프라인은 계속 돈다. 주인 없이 끝난 마커는 거버너 순회(15분)가 마무리한다.
**데드맨**: 생산 4슬롯·마켓맵은 정시+20분에 launchd 가 `paperclip-deadman.sh` 로 마커를 본다 — 마커도 없고 페이퍼클립 큐에도 없을 때만 텔레그램 경보 후 직접 실행.
국내 마감은 시작한 회차가 실패할 수도 있으므로 16:20 데드맨과 별도로 `rescue-kr-close`가 저녁 세 번 재점검한다. 실패 마커가 있고 당일 게시 유예 안이며 아직 재개하지 않은 회차만 한 번 재개한다. 설치: `bash lib/install-cron.sh install rescue-kr-close "17:20,19:20,21:20"`.

## 5. 토큰 관제 — token-governor.js (15분)

| 상태 | 조건 (세션 / 주간 / 주간 속도) | 엔진 순서 | LLM 에이전트 | 루틴 |
|---|---|---|---|---|
| 🟢 GREEN | 세션 < 70% / 주간 < 65% / 속도 정상 | 스크립트 기본 | 기본 모델 | 전부 |
| 🟡 YELLOW | 세션 ≥ 70% / 주간 ≥ 65% / 주간 경과보다 10%p↑(20% 사용 이후) | 다른 쪽이 GREEN 이면 그쪽 앞으로 | 절약 모델 | 2등급 보류 |
| 🔴 RED | 세션 ≥ 90% / 주간 ≥ 85% | RED 쪽을 체인 뒤로 | 다른 공급자로 전환(둘 다 RED 면 pause) | 담당 기본 공급자의 2등급 보류, 둘 다 RED 면 1등급도 |

- 입력: 페이퍼클립 `costs/quota-windows` (Claude 세션·주간, Codex 창 — 이름보다 **리셋까지 남은 시간**으로 세션/주간을 가른다. Pro에 5시간 창이 없으면 Codex 세션은 `-`로 표시한다).
- 회복은 5%p 더 내려가야 한 단계(경계에서 15분마다 모델이 바뀌지 않게). 못 읽으면 직전 상태 유지.
- 엔진 순서는 `workspace/ops/engine-routing.env` → `lib/guards.sh` 가 회차 시작 때 읽는다(명시 환경변수 > 거버너 > .env).
- 구독 한도는 운영자 본인의 대화 세션과 같이 쓴다 — 자동화가 YELLOW 부터 물러나 사람 몫을 남긴다.
- 기록: `token-state.json`(현재 판단) · `token-ledger.jsonl`(15분 스냅샷) · `llm-ledger.jsonl`(파이프라인 LLM 호출별 토큰·환산 비용 — text-engine·desk-briefing) · `token-report/<날짜>.md`(21:00).
- 거버너는 **자기가 멈춘 것만** 되살린다(pausedBy). 사람이 멈춘 에이전트·루틴은 건드리지 않는다.

## 6. 장애 → 수리 → 재개

```
회차 halt/fail ─ incident-analyze.js ─▶ growth/incidents/<IR>.md + incidents.jsonl
      │                                   (원인·분류 code|env·고칠 자리 — 기존 그대로)
      ▼
dispatch(또는 거버너 순회) ─▶ [장애] SRE 이슈 (원 회차 이슈는 그것에 막힘)
      ▼
SRE: env → 풀렸는지 보고 재개/재실행/접기 · code → repair-workspace.js start
      사본에서 최소 수정 + 회귀 테스트 → diff → [리뷰] 이슈 → Code Reviewer
      리뷰어: verdict approve|reject (패치 해시에 묶임) → SRE 이슈에 댓글 → SRE 깸
      SRE: apply (승인·보호 경로·운영 파일 변경 여부·하루 3건·사본 전체 테스트) → 백업·반영
      → Producer 에 action: resume (slot·ep) → incidents.jsonl 처리 기록 + 텔레그램
```

- 보호 경로(자동 반영 금지, 사람에게): `.env*`, OAuth, `publish-youtube.js`·`upload-direct.js`, `config/paperclip/*`, `scripts/automation/paperclip/*`,
  `lib/install-cron.sh`, `config/{budget-policy,notifications,autonomy-pause}.json`.
- 되돌리기: `node scripts/automation/paperclip/repair-workspace.js rollback <id>`. 반영된 수정은 커밋되지 않은 채 운영 트리에 있다 — 사람 세션이 검토·커밋한다.
- 처음 연결 때 기존 장애 6건은 「본 것」으로 기준선 처리했다(사람 세션이 이미 처리함).

## 7. 자동 성장 루프

| 주기 | 누가 | 무엇을 | 산출 |
|---|---|---|---|
| 매일 05:40·15:40 | Ops (결정론) | 수집→KPI→진단→규칙 처방→지시문, 끝나면 목표 제목에 KPI 현재값 | `growth/kpi/`·`remediations.json`·페이퍼클립 목표 |
| 매일 19:40 | Ops → 성장 매니저(LLM 1회, 검증기 통과분만) | 가설·처방(R-AI) 켜기, 판정은 결정론 엔진 | `strategy.json`·`journal/` |
| 월 08:30 | CMO (Codex) | 병목 3·실험 판정·제안 2 | `growth/weekly/<날짜>-cmo.md`·`proposals/` |
| 월 09:30 | CEO (Claude) | 제안 채택(주 1건)·보류·기각·되돌림, 편성 변경은 권고만 | `growth/decisions.jsonl` → `[구현]` SRE 이슈 |
| 채택 시 | SRE + Reviewer | 사본 구현·리뷰·반영, 성공 지표·판정일·되돌림 조건 기록 | 다음 주 CEO 가 판정 |

페이퍼클립 목표: north star「주간 순증 구독 +10」 아래 발행·도달·참여·효율 4개 — 제목에 현재값·등급이 붙는다(`kpi-sync.js`).

## 8. 페이퍼클립 동작 규칙 (2026-10-07 실측 — 모르면 사고 난다)

1. **배정된 이슈가 열려 있으면 실행 취소가 「배정 복구」 실행을 부른다.** 옛 큐를 지울 때는 에이전트 pause → 실행 취소 → 이슈 정리 순서.
2. 배정으로 깬 실행이 **댓글 없이 끝나면** 다시 깨운다(missing_issue_comment). 디스패처·지침 모두 끝에 댓글을 남긴다.
3. `blocked` 는 `blockedByIssueIds` 또는 `unblockDescriptor` 가 있어야 받아들여진다(422).
4. 실행 토큰(에이전트)으로는 paused 에이전트에게 배정 못 하고(409), 남을 unblock owner 로 못 쓴다(403) → 장애 이슈·상태 변경은 board 권한(로컬 신뢰 모드).
5. 실패한 process 실행은 페이퍼클립이 다시 돌리지 않는다(recovery replay not_authorized → blocked). 이슈의 배정을 풀면 실행이 `cancelled(issue_reassigned)` 로 표시된다(결과 댓글은 그 전에 남음).
6. 루틴이 paused 일 때 지난 회차는 다시 active 가 되는 순간 **한 번** 돈다(skip_missed 도 1회는 쏜다). 서버가 잠들었다 깨도 같다.
7. `codex_local` 은 샌드박스 우회가 기본 켜짐 — 리뷰어·CMO·CEO 는 명시적으로 끈다. 새 에이전트는 board 승인 필요(`agent-hires` → `approvals/{id}/approve`).
8. 지침 번들 쓰기는 compare-and-swap(`baseRevisionId`·`baseHash`). 설정 env 값은 REDACTED 로 돌아온다 — 비교는 키만.
9. 공식 `paperclipai service` 는 `~/.local/bin` 관리형 설치를 요구하고 start 때 plist 를 덮어쓴다 → 자체 `com.barroskills.paperclip` 사용.

## 9. 운영 명령

```bash
BT=/Users/beye/workspace/BarroSkills/.claude/skills/barrotube; cd $BT
node scripts/automation/paperclip/setup.js                 # 정본과 차이 (계획만)
node scripts/automation/paperclip/setup.js --apply         # 적용 (새 에이전트·루틴은 정지 상태)
node scripts/automation/paperclip/setup.js --activate      # 가동 (현역 재개 + 루틴 active)
node scripts/automation/paperclip/setup.js --deactivate    # 되돌림 1단계 (루틴·현역 pause)
node scripts/automation/paperclip/token-governor.js --dry-run   # 지금 판단
node scripts/automation/paperclip/token-governor.js --report    # 오늘 리포트
node scripts/automation/paperclip/dispatch.js --direct slot:us-close            # 손으로 한 회차 (마커 공유)
node scripts/automation/paperclip/dispatch.js --direct resume --slot us-close --ep EP-2026-0215
node scripts/automation/paperclip/dispatch.js --finalize 2026-10-08/slot_us-close
node scripts/automation/paperclip/repair-workspace.js show|apply|rollback <id>
launchctl kickstart -k gui/$(id -u)/com.barroskills.paperclip # 서버 재시작 (6초)
```

## 10. 되돌리기 — launchd 로 복귀

```bash
node scripts/automation/paperclip/setup.js --deactivate
for r in deadman-us-close deadman-omnibus deadman-realestate deadman-kr-close deadman-market-map rescue-kr-close; do bash lib/install-cron.sh uninstall $r; done
bash lib/install-cron.sh install us-close "06:00";  bash lib/install-cron.sh install omnibus "Mon-Thu 10:00"
bash lib/install-cron.sh install realestate "Fri 10:00"; bash lib/install-cron.sh install kr-close "Mon-Fri 16:00"
bash lib/install-cron.sh install publish-resume "07:30,17:30"; bash lib/install-cron.sh install market-map "08:00,18:00"
bash lib/install-cron.sh install market-map-krclose "Mon-Fri 15:45"; bash lib/install-cron.sh install competitor-scan "05:20,15:20"
bash lib/install-cron.sh install oauth-renew "06:40"; bash lib/install-cron.sh install doctor-daily "07:10"
bash lib/install-cron.sh install growth "05:40,15:40"; bash lib/install-cron.sh install weekly-marketing "Mon 09:00"
bash lib/install-cron.sh install growth-manager "19:40"
```
`workspace/ops/paperclip-ids.json` 의 `activated` 를 false 로 두면 거버너는 판단·엔진 순서만 하고 에이전트·루틴은 건드리지 않는다.
