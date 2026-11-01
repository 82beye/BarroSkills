# Paperclip 구독 연결과 사용량 갱신

## 개요

2026-10-28 20:05 KST 기준 모든 활성 회사의 Claude/Codex 한도 판단을 갱신했다. 주간 한도는 회복됐지만 오래된 연결 토큰과 사용량 조회 제한 때문에 작업 재개가 막혀 있었다. 기존 잔여 30%와 5%p 안전 여유를 유지하며 인증·조회 경로를 복구했다.

## 변경

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/paperclip/quota-cli-identity.js`: 성공한 실제 계정별 사용량을 최대 5분 공유한다. 파일 잠금으로 같은 계정의 동시 조회를 직렬화하고 원래 관측 시각을 유지한다. 실패·미래·만료·다른 계정 자료를 재사용하지 않으며, 계정 인증은 각 호출 전후에 확인한다.
- 같은 파일: macOS 호스트 Claude는 명시적인 로컬 Keychain 읽기 후 bearer 계정을 원격 검증하고 CLI 계정 해시와 일치할 때만 사용량을 조회한다. 사용자 지정 HOME/CLAUDE_CONFIG_DIR은 호스트 Keychain을 빌리지 않는다.
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/quota-cli-identity.test.js`: 캐시 재사용·관측 시각 보존·만료/미래/계정 불일치·오류 처리·호스트 Keychain 계정 증명 회귀 검증을 추가했다.
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/references/PAPERCLIP.md`: 관측 공유와 계정 검증 동작을 기록했다.
- 공식 Codex device 로그인으로 만료된 호스트 인증을 갱신했다. 계정 해시는 기존과 같았다. 공식 OpenAI Docs의 app-server 인증/한도 조회 경로와 설치된 CLI 프로토콜을 확인했다.
- 3개 활성 회사의 기존 Claude 기본 연결을 Paperclip 공식 `/ai-connections/local` 경로로 재연결했다. 조회 제한 대기 동안 잠시 비활성화한 Token Governor 타이머는 enabled=true, intervalSec=60으로 복구했다.

## 핵심 코드

```js
const measuredAt = reusable ? cached.observedAt : new Date().toISOString();
```

관측 공유가 새 측정처럼 기록되면 진행 중 소비 예약이 일찍 해제될 수 있으므로 원래 시각을 유지한다.

## 검증

- 관련 자동 테스트 67개 통과, 실패 0, 종료 코드 0.
- 실제 호스트 조회 성공: Claude 사용 약 2~3%, Codex 사용 0%. 같은 계정의 공유 관측과 실제 관리형 연결 경로를 확인했다.
- 실행 중 작업을 중단하지 않고 11명에 대해 Claude 전환 설정 및 네이티브 연결 검사를 완료했다. SRE·댕댕 운영 총괄·원탱크 총괄·CEO Hideo를 포함한다.
- 운영 23명 최종 상태: {'manual-pause': 14, 'ready': 20, 'wait-active-run': 3}. 연결 대기/한도 대기 0명. 실행 중인 작업은 전환 경계까지 유지한다.
- 활성 회사 3개 LLM 에이전트 37명 모두 engine=cli 및 quota-bin 보호 경로를 유지한다. 수동 pause 14명 유지.
- 증거와 변경 전 사본: `/tmp/paperclip-quota-refresh-20261028/`.

## 한계

외부 구독 사용과 기존 실행의 추가 소비를 공급자 측에서 제한하지 않는다. 이후 구독 인증이 만료되면 공식 재연결이 필요할 수 있다. 성공 관측 공유의 최대 지연은 5분이며, 진행 중·완료 후 미정산 소비 예약을 계속 합산한다.
