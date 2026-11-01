# 페이퍼클립 관제 — BarroTube 자동화 (2026-10-07~)

> 페이퍼클립 = **관제탑**(언제·누가·얼마나·무엇이 깨졌나), 로컬 파이프라인 = **공장**(실제로 무엇을 하나, 결정론 그대로).
> 정본: `config/paperclip/company.json`(에이전트·목표·루틴) · `actions.json`(실행 허용 목록) · `token-policy.json`(토큰 관제 기준).
> 서버: `http://127.0.0.1:3100` (launchd `com.barroskills.paperclip`, KeepAlive) · 회사 BarroTube `46041d31…`.

## 1. 왜 이렇게 생겼나

4~5월 체제는 에이전트 17명이 생산 단계를 LLM 으로 하고 타이머(5분)로 깨어 **캐시 입력 10억 토큰·16,962회 실행**을 썼고
stranded→blocked 루프로 5월 23일 멈췄다(큐에 실행 19건이 그대로 남아 있었다). 생산은 그 뒤 결정론 파이프라인으로 옮겨 안정됐다.
새 체제는 그 둘을 합친다: **생산은 결정론 그대로, 판단이 필요한 4곳만 LLM**, 그리고 모든 일은 정해진 스케줄 또는 장애로만 시작한다.

## 2. 편성 — 에이전트 7명 (휴면 14명은 기록 보존용으로 pause)

조직도: CEO → CMO · Producer · Token Governor · SRE Engineer(→ Ops Runner · Code Reviewer). 그 밖의 [휴면] 14명은 4~5월 단계별 체제의 기록이라 pause 상태다.

| 에이전트 | 어댑터·모델 (기본 / 절약 / 대체) | 깨는 조건 | 하루 상한 | 하는 일 |
|---|---|---|---|---|
| CEO | Claude Opus 5.5 high / Sonnet 5.5 / Codex gpt-6-astra | 월 09:30 루틴 · 막힘 점검 이슈 | $8 | 주간 경영 리뷰·제안 채택(주 1건↓)·목표 오너·막힘 점검(§6-1) |
| CMO | Codex gpt-6.1-sol medium / gpt-6-luna high / Claude Sonnet 5.5 | 월 08:30 루틴 | $5 | 주간 성장 메모(병목·실험 판정·제안) |
| SRE Engineer | Claude Opus 5.5 high / Sonnet 5.5 / Codex gpt-6.1-sol high | 장애 이슈 | $20 | 원인 확인→사본 수정·테스트→리뷰→반영→재개 |
| Code Reviewer | Codex gpt-6.1-sol high / gpt-6.1-sol medium / Claude Sonnet 5.5 | 리뷰 이슈 | $6 | 다른 모델의 눈으로 패치 승인·반려 |
| Producer | process (모델 없음) | 생산 루틴·재개 이슈 | 0 | 발행 슬롯·재개를 dispatch.js 로 |
| Ops Runner | process (모델 없음, 동시 3) | 운영 루틴 | 0 | 수집·KPI·마켓맵·진단·리포트 |
| Token Governor | process (모델 없음) | 60초 타이머 | 0 | 전 회사 구독 한도 → 실행 승인·모델 전환, 순회 |

- 역할 배분 원칙(이 저장소 워커 규약): **Claude = 메인 코딩·디버깅·전략**, **Codex = 분석·리뷰·비평**. 수리(Claude)와 리뷰(Codex)는 다른 공급자.
- Codex Pro 배정: 반복되는 분석·리뷰는 6.1 Sol, 노랑 단계의 CMO는 Luna, 드문 CEO 대체 판단만 Astra. Pro의 사용량은 모델·작업 크기에 따라 달라지므로 고정 호출 수 대신 실제 한도 창을 따른다.
- LLM 에이전트는 **로컬 CLI 엔진**(`engine: cli`)으로 돈다 — 페이퍼클립 ACP 경로의 번들 Claude Code(2.1.257)는 Opus 5.5 를 거부했다.
- 하루 상한은 API 환산 USD(구독이라 청구액은 0, 실행별 `usageJson.costUsd` 합). 넘으면 거버너가 다음 날까지 pause.
- 위임은 네 경로뿐: SRE→Reviewer(리뷰), SRE→Producer(`action: resume`), CEO→SRE(`[구현]`, 주 1건), CEO→SRE·Reviewer·CMO(막힘 점검에서 다시 맡기기, `triage.js` 로만). 지침 `scripts/automation/paperclip/instructions/`.

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

- launchd 에 남는 것: `telegram-bot`(상시 데몬), `deadman-*`(정시+20분 폴백), `rescue-kr-close`(17:20·19:20·21:20, 자동 재개의 안전망), `com.barroskills.paperclip`(서버).
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

영상을 못 냈는데 exit 0 으로 끝나는 길은 결과를 따로 적는다(`cleanExitStatus`). 주제가 없거나 앞 회차가 잠금을 쥐고 있으면 `idle`, QA 가 게시를 막으면 `halted`. 예전에는 둘 다 `done`·`guarded` 로 남아 장애도 재시도도 없이 그날 편이 사라졌다(10-26 월 us-close, 10-26·10-30 kr-close). 운영자 정지·일일 상한·예산의 🛑 는 의도된 멈춤이라 그대로 `guarded`.

페이퍼클립이 재시작돼도 파이프라인은 계속 돈다. 주인 없이 끝난 마커는 거버너 순회(15분)가 마무리한다.
**데드맨**: 생산 4슬롯·마켓맵은 정시+20분에 launchd 가 `paperclip-deadman.sh` 로 마커를 본다 — 마커도 없고 페이퍼클립 큐에도 없을 때만 텔레그램 경보 후 직접 실행.

**자동 재개 (2026-11-02~, `deadman-recover.js`)**: 데드맨은 회차가 아예 안 떴을 때만 나선다. 뜨고 나서 막힌 회차는 토큰 거버너 순회가 전 슬롯을 보고 공개 유예 안에서 끝날 때까지 다시 돌린다. 모델을 쓰지 않는 결정론 경로다. 계기: 11-01 일요일 06:13 에 멈춘 회차를 SRE·CEO 가 같은 한도에 막힌 채 15회 실행하다 유예가 끝났다. 주말은 슬롯이 하루 하나라 그 하나가 막히면 발행이 없다.
- `failed`·`halted`·`lost` → 같은 EP 를 `resume`. EP 가 없거나(로그의 지난 EP 언급은 제외) `idle` 이면 `rerun`(주제부터). 같은 EP 가 내용 단계(Phase 4·5·6·9)에서 두 번 막히면 `rerun`.
- 시도 사이 15·30·45·60·60·60분, 재개 6회까지. 유예 끝 1시간 전부터 새로 시작하지 않는다(렌더 + 거부창이 유예를 넘기면 비공개로 남는다).
- 한도 거부로 멈췄고 두 공급자 모두 70% 이상이면 시도를 쓰지 않고 기다린다.
- 재개가 또 실패해도 SRE 이슈를 새로 열지 않고 원 장애에 묶는다. 끝나면 `env` 장애는 닫고, `code` 장애는 SRE 몫으로 남긴다. 끝내 못 끝내면 텔레그램 한 번.
- 이중 실행은 회차 마커(O_EXCL)가 막는다. 운영자 패스·`guarded` 는 끝난 회차로 존중한다. 기록은 `runs/<날짜>/rescue-<슬롯>.json`, 로그는 `logs/cron/rescue.log`.
- launchd `rescue-kr-close`(17:20·19:20·21:20)는 페이퍼클립이 멈췄을 때의 안전망으로 남는다. 설치: `bash lib/install-cron.sh install rescue-kr-close "17:20,19:20,21:20"`.
- 지금 판단 보기: `node scripts/automation/paperclip/deadman-recover.js --all --dry-run [--now <ISO>]`.

**같은 원인 재발은 묶는다 (2026-10-19~)**: dispatch 가 대신 만든 장애(PX-)는 지문으로 가른다.
- doctor 는 RED 항목 묶음이 지문이다. 나머지 잡은 액션 + EP + 마지막 로그 줄이 지문이다. 숫자는 무시하고 EP 번호는 남긴다.
- 같은 지문의 장애 이슈가 열려 있으면 새 SRE 이슈를 열지 않는다. 회차 이슈를 그 이슈에 막힌 것으로 걸고 끝낸다. SRE 를 깨우지 않으며, `paperclip-incidents.json` 에 `duplicateOf`·`recurrences` 를 남긴다.
- 장애 분석기 기록(IR-, 생산 회차)은 회차마다 새 장애다.
- 계기: EP-2026-0219 업로드 락 하나로 doctor 가 10-09~10-19 매일 실패했다. 그때마다 새 SRE 이슈가 열려 Opus 가 같은 진단을 11번 했다(중복 16건은 YOU-322 로 정리).

**막던 장애가 닫히면 회차 이슈도 닫는다**: 실패 회차 이슈는 배정이 풀려 있다. 그래서 막던 이슈가 닫혀도 페이퍼클립이 아무도 깨우지 않고, 이슈는 blocked 로 남는다. 거버너 순회가 루틴 출신·담당 없음·막던 이슈 전부 닫힘인 이슈를 `done` 으로 정리한다(`settleRunIssues`).

## 5. 토큰 관제 — token-governor.js (60초)

`token-policy.json`의 `global_reserve.enabled: true`에서는 `quota-switch.js`가 활성 회사 전체를 관리한다. 기존 개별 pause/resume 정책보다 이 정책이 우선한다.

- Claude와 Codex 각각 주간 잔여 30%를 보호한다. 실제 사용률 + 진행 중 소비 예약 + 다음 모델의 예상 소비가 65% 이하여야 시작한다. 5%p는 추가 안전 여유다. 양쪽 모두 부족하면 신규 LLM 실행을 보류한다.
- 최근 7일 실행의 모델별 입력·캐시·출력 토큰 P95로 실행 예산을 추정한다. 토큰·환산 USD를 실제 구독 주간 %로 간주하지 않으며, 관측된 같은 계정의 사용률 증가가 있으면 보수적으로 반영한다.
- **생산 회차 호출은 등급이 다르다 (2026-11-02~)**. `dispatch.js` 가 `kind: production` 액션에 `BT_QUOTA_CLASS=production` 을 붙이고, `quota-cli.js` 가 에이전트 실행이 아닐 때만 이 등급으로 본다. ① 호출당 0.6% 로 예약한다(호출 P95 55만 토큰을 에이전트 눈금 500만 토큰 = 5% 로 환산. 에이전트 눈금을 그대로 쓰면 호출 몇 건이 몰린 것만으로 예약이 15~25% 쌓여 사용률이 절반을 넘긴 주말에 회차가 스스로 막혔다). ② 에이전트 예약에 막히지 않는다. ③ 70% 까지 간다 — 에이전트는 그대로 65% 에서 멈추므로 30% 보존선은 지켜지고, 65~70% 구간이 발행 몫으로 남는다. ④ 환경의 유료 API 키를 떼고 구독 CLI 를 부른다(`produce-episode.js` 가 이미지 엔진용으로 올린 `OPENAI_API_KEY` 때문에 S9 가 `paid_or_alternate_auth_present` 로 거부됐다. 사람이 고칠 인증 문제가 아니다).
- 15분 이내 주간 관측과 실제 선택된 구독 계정이 필요하다. `quota-bin/claude`, `quota-bin/codex`가 모델 실행 직전 계정과 한도를 다시 확인하고, 계정별 공유 예약을 원자적으로 잡는다. 불명확한 관측·연결은 대기한다.
- 같은 계정의 성공한 관측은 `quota-observations/`에서 최대 5분 공유해 사용량 API의 조회 제한을 줄인다. 매번 계정 인증을 확인하고 원래 관측 시각을 유지하므로, 캐시로 완료 실행의 소비 예약을 조기 해제하지 않는다. macOS 호스트의 Claude Keychain은 실제 bearer 계정이 선택된 CLI 계정과 일치할 때만 사용한다.
- 기본 모델 → 안전한 절약 모델·다른 공급자 순으로 판단하며, 안전한 현재 모델을 유지한다. QA는 원래 공급자 계열을 보존하고 실제 작성 공급자와의 독립 검수 조건을 따른다. 유료 API로 자동 우회하지 않는다.
- 새 실행만 보류한다. 실행 중 작업·체크아웃·수동 pause를 보존하며, 한도가 회복되면 관제가 설정한 heartbeat 보류만 해제한다. 모델이 시작되지 않은 한도 거절 실행만 증거와 중복 방지 키를 확인해 재개한다.
- 기록은 `$BT/workspace/ops/quota-switch-state.json`, `quota-switch-baselines.json`, `quota-admissions.json`에 남는다. 기존 `token-state.json`과 `engine-routing.env`도 호환용으로 갱신한다. 장애·회차 마커 순회는 계속 수행한다.
- 관제 자체는 모델을 호출하지 않는다. 외부 대화나 이미 진행 중인 실행의 소비까지 공급자 측에서 제한하는 기능은 아니므로, 이미 소진된 잔액은 복구하지 못한다.

설치된 Paperclip의 연결 설정 비교 오류는 `scripts/automation/paperclip/patch-binding-order.js`로 최소 수정했다. Paperclip 업그레이드 시 패치 필요 여부와 launchd의 `quota-bin` PATH 우선순위를 다시 확인한다. 이 패치는 모델을 실행하는 연결 검사를 생략하지 않으며, 동일한 연결 객체의 키 순서 차이만 제거한다.

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

- 사람이 할 일(Studio 확인·OAuth 동의·크레딧 충전·보호 경로 검토)로 막힐 때 `unblockDescriptor.owner` 는 항상 `"board"` 로 둔다. SRE 자기 agentId 로 걸면 운영자 대기 목록에 뜨지 않는다.
  2026-10-19 기준 YOU-322·297·315·406 이 그렇게 열흘 넘게 방치됐다. 담당은 SRE 로 남겨 두므로, 운영자가 댓글을 달면 SRE 가 깨어 마무리한다.
- 리뷰는 샌드박스 안에서 돈다. 권한 오류(EPERM·bind)로 난 실패는 판정 사유로 삼지 않는다. `apply` 가 샌드박스 밖에서 전체 테스트를 다시 돌린다(YOU-458 은 이것만으로 두 번 반려됐다).
- 보호 경로(자동 반영 금지, 사람에게): `.env*`, OAuth, `publish-youtube.js`·`upload-direct.js`, `config/paperclip/*`, `scripts/automation/paperclip/*`,
  `lib/install-cron.sh`, `config/{budget-policy,notifications,autonomy-pause}.json`.
- 되돌리기: `node scripts/automation/paperclip/repair-workspace.js rollback <id>`. 반영된 수정은 커밋되지 않은 채 운영 트리에 있다 — 사람 세션이 검토·커밋한다.
- 처음 연결 때 기존 장애 6건은 「본 것」으로 기준선 처리했다(사람 세션이 이미 처리함).

## 6-1. 막힘 점검 — CEO 가 멈춘 이슈를 서브에이전트에게 다시 맡긴다 (2026-10-25~)

운영자: 「블럭이 너무 많이 발생한다 — CEO 가 그 이슈도 체크해서 서브에이전트들이 처리하게」. 그날 blocked 는 23건이었다.
그중 11건은 장애를 따라 막힌 회차 이슈였고(장애가 닫히면 거버너가 정리), 1건은 운영자 몫이었다. 나머지 9건은 **아무도 다시 깨우지 않아서** 멈춰 있었다.
- 담당이 일시정지일 때 들어온 일: 페이퍼클립이 「담당 호출 불가」로 자동 복구를 멈추고 board 판단을 기다린다(YOU-567·573). 담당이 돌아와도 그대로다.
- 실행이 취소·실패한 뒤: 페이퍼클립이 재실행을 허락하지 않고(`replay not_authorized`) blocked 로 둔다. YOU-553·555·557 은 첫 실행이 취소된 뒤 결과 없이 멈췄다.
- 사람을 기다리면서 `unblockDescriptor.owner` 를 자기 agentId 로 걸었다: 운영자 대기 목록에 뜨지 않는다(YOU-558).

```
토큰 거버너 순회(15분) ─ triage.js maybeOpenTriage
   blocked · 진행 중(도는 실행 없음, LLM 담당) · 검토 중(board 응답 대기)을 목록 응답만으로 가른다
   따라감 · 정리 대기 · 정상 대기 → 손대지 않음
   판단 필요 = 복구 대기·막힘·멈춤 1시간↑(담당이 멈춰 있으면 돌아온 뒤) · 기다림 48시간↑ · 운영자 몫 72시간↑
      ▼ 하루 2회·4시간 간격·지난 점검 뒤 바뀐 항목이 있을 때만
   [막힘 점검] 이슈 → CEO (본문 = 판단 필요 표 + 마지막 댓글·실행·사람 응답 대기, 전체 표 growth/triage/<날짜-시각>.md)
      ▼ CEO(절약 모델 — 기본 Opus 일 때만 이슈 단위로 Sonnet)
   항목마다: 재개 rewake · 위임 assign(SRE·Reviewer·CMO) · 사람에게 escalate · 정리 close · 둔다
      → 이슈마다 한 줄 댓글, done, 사람 몫이 있으면 텔레그램 한 번
```

- 처리는 `triage.js` 허용 동작으로만 한다. 도구는 board 권한으로 처리하고 `workspace/growth/triage/actions.jsonl` 에 남긴다. CEO 의 run 토큰으로는 board 대기 복구를 풀 수 없었다(10-22 YOU-576 「Board access required」).
  - `rewake`: 담당에게 다시 맡긴다. board 대기 복구가 있으면 「원 담당에게 돌려주기」(`recovery-actions/resolve restored→todo`)로 푼다. 끊긴 실행의 결과 확인이 필요한 복구는 `--evidence` 로 끊긴 실행이 한 일·안 한 일을 적어야 풀린다. 담당이 `paused` 거나 열린 막는 이슈가 있으면 거부한다.
  - `assign`: 다른 서브에이전트에게 넘긴다(`assign_to`). process 담당(Producer·Ops)은 받을 수 없다. 이슈 본문이 파이프라인 명령이 되기 때문이다.
  - `escalate`: blocked 면 `unblockDescriptor.owner="board"` 로 바꾼다. 댓글은 달지 않는다(열린 이슈에 board 댓글을 달면 담당이 깨어 「아직 사람 대기」 실행만 하나 더 생긴다). 진행·검토 중은 상태를 두고 기록만 한다.
  - `close`: 닫는다. 닫히는 이슈의 댓글은 아무도 깨우지 않는다. board 대기 복구가 있으면 그것부터 접는다. 장애를 닫으면 따라 막힌 회차 이슈는 거버너가 정리한다.
- 상한: 같은 이슈 다시 맡기기(rewake·assign)는 24시간에 2번까지, 처리 전체는 30건까지. CEO 지침상 같은 담당에게는 한 번에 2~3건만 맡긴다(SRE·리뷰어 동시 1). 10-21 [수리] 6건을 한꺼번에 받은 SRE 는 그중 셋이 줄을 서다 취소돼 결과 없이 멈췄다.
- CEO 가 멈춰 있으면(상한·두 공급자 RED) 점검을 맡기지 않고 하루 한 번 텔레그램으로 「맡기지 못함 + 판단 필요 목록」을 보낸다. 12시간 넘게 안 끝난 점검 이슈는 접고 다음 점검이 이어 받는다.
- 정책: `config/paperclip/company.json` `triage`. `enabled:false` 로 끄면 거버너는 점검을 열지 않는다(도구는 그대로 쓸 수 있다).

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
10. **프로젝트에 묶인 이슈는 에이전트 설정의 cwd 가 아니라 프로젝트 작업 폴더에서 깨운다.** 폴더를 지정하지 않으면 빈 관리 폴더 `~/.paperclip/…/projects/<회사>/<프로젝트>/_default` 를 쓴다.
    2026-10-19 실측: CMO 메모 2편(10-12·10-19)이 `_default/workspace/growth/weekly/` 에 갇혔고, CEO 는 메모가 없다고 보고 리뷰했다.
    **프로젝트 작업 폴더를 지정하면 안 된다.** 지정하면 claude_local·codex_local 은 그 폴더가 git 체크아웃이어야 실행된다(`missing_git_metadata`). growth·ops/repairs 는 git 밖이라, 10-19 에 지정했다가 CMO 실행이 바로 거부돼 되돌렸다.
    그래서 실행 폴더는 `_default` 그대로 두고, 대신 두 가지로 막는다. ① 지침의 경로는 모두 `$BT/…` 절대 경로로 쓴다. ② Codex 에는 자기 cwd 를 `writable_roots` 로 준다.
11. **Codex 셸은 운영자 `~/.codex/config.toml` 의 `shell_environment_policy` 를 따른다.** 지금 값은 `inherit = "core"` 이고, 이러면 페이퍼클립이 넣은 `PAPERCLIP_API_*` 가 셸에서 사라진다.
    그래서 CMO·리뷰어가 댓글·상태를 남기지 못하고 같은 일로 다시 깨어났고, 결국 Board 가 두 에이전트를 멈췄다(10-16).
    지금은 adapterFor 가 Codex 에이전트에 `-c shell_environment_policy.inherit="all"` 과 `-c sandbox_workspace_write.writable_roots=["<자기 cwd>"]` 를 붙인다. 운영자 전역 설정은 건드리지 않는다.
12. 닫히는 이슈(`done`·`cancelled`)에 댓글을 같은 PATCH(`{status, comment}`)로 달면 담당을 깨우지 않는다. 열린 이슈에 단 board 댓글은 담당을 깨운다.
    pause hold(트리 정지)가 걸린 이슈는 댓글이 409 로 거부된다. 풀 때는 `POST /issues/:id/tree-holds/:holdId/release {"metadata":{"wakeAgents":false}}` 로 깨우지 않게 하고, 곧바로 닫는다.

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
# 회차 주제 지정 (2026-10-15~): 그날 그 슬롯의 데스크·에디터·리서처가 따르고 최근 중복 검사를 건너뛴다.
#   dispatch 가 회차 시작 때 회차 이슈에 지시를 댓글로 남긴다. FORCE_TOPIC 은 리서치를 건너뛰므로 쓰지 않는다.
$EDITOR workspace/ops/directives/$(TZ=Asia/Seoul date +%F)-kr-close.md
# 도는 회차 패스: 회차 이슈 댓글 → 마커 status=guarded → 이슈 done → kill -KILL -<마커 pid> (순서를 바꾸면 SRE 이슈가 열린다)
node scripts/automation/paperclip/dispatch.js --finalize 2026-10-08/slot_us-close
node scripts/automation/paperclip/repair-workspace.js show|apply|rollback <id>
node scripts/automation/paperclip/triage.js scan                 # 막힘 점검 — 지금 멈춘 이슈 분류 (읽기만)
node scripts/automation/paperclip/triage.js open --dry-run       # 지금 CEO 에게 점검을 열지·본문 미리 보기 (--force: 횟수·간격 무시)
node scripts/automation/paperclip/triage.js rewake|assign|escalate|close <YOU-n> …   # CEO 처리 동작 (손으로도 같다)
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
