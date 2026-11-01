# Paperclip 회사 공용 주간 한도별 모델 등급 설정

## 결과

활성 회사 3개, AI 에이전트 37개를 역할별 등급으로 설정했다. process 에이전트 5개는 모델이 없어 변경하지 않았다. 프로젝트 리드/팀 관계, 작업공간, 지시문과 기존 권한은 보존했다. 프로젝트/이슈 별 모델 재정의는 발견되지 않았다.

## 한도와 초기화

사용자 입력은 Codex 잔여 77%, Claude 잔여 8%였다. 적용 시점의 최신 관측은 아래와 같다. 날짜를 하드코딩하지 않고 수집기가 확인한 resetsAt으로 매번 다시 계산한다.

| 공급자 | 사용/잔여 | 다음 초기화 (KST) |
|---|---|---|
| claude | 92% / 8% | 2026-10-28 Wednesday 00:00:00 |
| codex | 24% / 76% | 2026-11-02 Monday 14:59:32 |

## 배정 기준

- 반복 메타데이터/게시/자산 정리: Codex Luna low 또는 Claude Haiku low. 글쓰기/조사/마케팅: Codex Luna medium 또는 Claude Sonnet medium.
- 개발·총괄·디자인·독립 검수: Codex Sol medium 또는 Claude Sonnet medium. Astra/Opus와 high 이상을 전역 기본으로 사용하지 않는다.
- 후보별 과거 처리 토큰 P95 기반 운영 예약량을 초기화까지 남은 일수로 나눈 가용 예산과 비교한다. 비용·모델 출시 순서로 고르지 않는다.
- 30% 예비분, 5%p 안전 여유, 15분 이내 실측, 계정 일치 확인, 회사 공용 실행 예약은 그대로 유지한다. 미래 초기화만으로 한도를 복구하지 않는다.
- 독립 QA의 원래 공급자 계열과 수동 정지는 보존한다. 데이터가 없는 모델은 기존 보수적 cold-start 예약을 사용한다. 토큰 수와 구독 차감률의 정확한 환산은 보장하지 않는다.

## 에이전트별 변경 전후

### BarroTube

| 에이전트 | 이전 | 적용 | 상태 |
|---|---|---|---|
| Writer | claude-opus-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| Marketing Analyst | claude-sonnet-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| Metadata Writer | claude-sonnet-4-6 / high | claude-haiku-4-5 / low | manual-pause |
| Strategist | claude-opus-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| CEO | gpt-6-astra / high | gpt-6.1-sol / medium | ready |
| Producer Shorts | claude-opus-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| Asset PM | claude-sonnet-4-6 / high | claude-haiku-4-5 / low | manual-pause |
| Image Generator | claude-haiku-4-5 / high | claude-haiku-4-5 / low | manual-pause |
| Voice Engineer | claude-haiku-4-5 / high | claude-haiku-4-5 / low | manual-pause |
| SRE Engineer | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| Content Manager | claude-sonnet-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| CMO | gpt-6-luna / high | gpt-6-luna / medium | ready |
| QA Reviewer | claude-opus-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| Publisher | claude-haiku-4-5 / high | claude-haiku-4-5 / low | manual-pause |
| CapCut Composer | claude-sonnet-4-6 / high | claude-haiku-4-5 / low | manual-pause |
| Market Researcher | claude-sonnet-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| Fact Checker | claude-sonnet-4-6 / high | claude-sonnet-5-5 / medium | manual-pause |
| Code Reviewer | gpt-6.1-sol / medium | gpt-6.1-sol / medium | ready |
### 바로게임

| 에이전트 | 이전 | 적용 | 상태 |
|---|---|---|---|
| 클라이언트·조작감 엔지니어 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 서버·전투 엔지니어 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 테크니컬 아티스트 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 플레이·회귀 QA (Codex) | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 댕댕 운영 총괄 | gpt-6-astra / high | gpt-6.1-sol / medium | ready |
| UI·콘텐츠 엔지니어 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 게임플레이 엔지니어 | gpt-6.1-sol / medium | gpt-6.1-sol / medium | ready |
| CEO Hideo | gpt-6-astra / high | gpt-6.1-sol / medium | ready |
| 빌드·출시 엔지니어 | gpt-6.1-sol / medium | gpt-6.1-sol / medium | ready |
| QA (Claude) | claude-sonnet-5-5 / high | claude-sonnet-5-5 / medium | quota-wait |
| QA (Codex) | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 원탱크 총괄 | gpt-6-astra / high | gpt-6.1-sol / medium | ready |
| 게임 디자이너 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
### 바로쇼핑

| 에이전트 | 이전 | 적용 | 상태 |
|---|---|---|---|
| 모션/자막 디자이너 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 엔지니어 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 상품기획 MD | gpt-6.1-sol / medium | gpt-6-luna / medium | ready |
| 리뷰어 | gpt-6.1-sol / high | gpt-6.1-sol / medium | ready |
| 쇼핑홀릭 CEO | gpt-6-astra / high | gpt-6.1-sol / medium | ready |
| 프레임 QA 검수자 | claude-opus-5-5 / high | claude-sonnet-5-5 / medium | quota-wait |

## 구현과 검증

- 수정: `.claude/skills/barrotube/scripts/automation/paperclip/quota-switch.js` — 역할 등급, 추론 강도 반영, 기존 baseline 재계산, 초기화 시각별 일 평균 가용량 비교, 수동 정지 모델 설정만 갱신.
- 수정: `.claude/skills/barrotube/tests/quota-switch.test.js` — 역할 등급/이전 flagship 교체/초기화 전후/예비분/독립 검수/권한·정지 보존 회귀.
- 실제 전후 예: `gpt-6-astra / high` → `gpt-6.1-sol / medium`; 반복 정리 역할 `claude-sonnet-4-6 / high` → `claude-haiku-4-5 / low`.
- Node v24 quota-switch/quota-cli/quota-reserve-policy/quota-retry 검사: 58 통과, 0 실패. diff 공백 검사 통과.
- dry-run 후 실제 중앙 전환기 적용 및 재실행 확인: ready 21, manual-pause 14, quota-wait 2. API에서 37개 모델/추론 강도를 모두 다시 읽었다. 수동 정지와 workspace/instructions/reportsTo 보존을 단언으로 확인했다.
- 실행 중 작업을 종료하거나 새 작업을 일괄 실행하지 않았다. 기존 SRE Engineer/바로쇼핑 엔지니어의 error 상태를 모델 설정 완료와 혼동하지 않는다.

## 한계와 복귀

모델별 실제 품질과 절감률은 다음 업무 실행의 기록으로 측정해야 한다. 미측정 모델에 대한 정량 절감률을 주장하지 않는다. 이 변경은 토큰 관제 설정이며 할로윈 출시나 게임명 변경 완료를 뜻하지 않는다.

원본 파일·런타임 baseline/상태 백업: `/tmp/paperclip-model-policy-20261026/`. 회사/에이전트 API 전후 스냅샷은 `/tmp/paperclip-model-inventory-{before,after}.json`. 복귀는 실행 중 작업을 종료하지 않고 원본 코드와 모델/추론 강도만 복구하며, 새로 변한 실행 상태·인증 환경 전체를 과거 스냅샷으로 덮어쓰지 않는다.

공식 근거: https://developers.openai.com/api/docs/guides/reasoning — 낮은 reasoning effort가 추론 토큰과 지연을 줄이는 방향이며 품질·복잡성과 균형을 맞춰야 한다. 로컬 Codex 모델 목록에서 Luna/Sol과 low/medium 지원을 확인했다.
