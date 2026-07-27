# BarroTube 참조형 에피소드 목록·연결 자산 모달

## Overview

오늘묘 S1 영상 제작·관리 설계문서의 제작 보드를 BarroTube 중앙 채널 보드에 적용했다.
분산된 `series/index.json` 계획과 실제 에피소드 폴더 스캔 결과를 한 목록으로 병합하고,
데스크톱에서는 에피소드당 한 행, 1024px 이하에서는 에피소드당 한 카드로 표시한다.

각 관측 에피소드의 스크립트·이미지·영상·오디오·배포본·문서는 현재 선택한 파이프라인과
플랫폼 범위에 묶인 자산 모달에서 확인한다. 계획만 있고 실제 폴더가 없는 회차는 현황에는
표시하되 검증·실행·자산 버튼을 비활성화하고, 서버도 직접 API 호출을 다시 차단한다.

## Context

- TodayMyo 연재 마스터에는 30개 계획이 있지만 실제 산출물 스캔에는 7개만 있었다.
- 기존 `/episodes` API를 곧바로 병합 목록으로 바꾸면 생성 설계문서와 다른 소비자의
  observed-only 계약이 깨질 수 있었다.
- 실제 adapter와 연재 마스터가 집계하는 컷 수가 다를 수 있다. 대표적으로 TodayMyo Day 4는
  adapter의 이미지 수가 0이지만 연재 마스터에는 제작된 이미지 6/7이 기록돼 있다.
- 데스크톱 테이블과 모바일 카드가 동시에 DOM에 존재하므로 컨트롤 ID를 복제하면 잘못된
  프로필·플랫폼을 액션이나 자산 조회에 전달할 수 있었다.

## Architecture

```text
series/index.json ──┐
                    ├── mergeEpisodeSources ──► board_episodes ──► table / mobile cards
adapter scan ───────┘              │
                                   ├── observed row: actions + asset modal
                                   └── plan-only row: disabled + server deny

legacy consumers ◄──────────────────── episodes (observed-only)
```

## Changes Made

### 1. 계획·실측 병합 계약

- `scripts/automation/lib/channel-document.js`
  - 계획과 실측의 ID, slug, series/episode 번호 상관관계를 `mergeEpisodeSources()`로 공용화했다.
  - 시리즈 시작일과 생성 시각을 계획 레코드에 전달한다.
- `tools/board/server.js`
  - 기존 `episodes`는 실측-only로 유지한다.
  - UI 전용 `board_episodes`와 `observed_count`, `planned_count`, `unobserved_count`를 추가했다.
  - 실측 행에는 계획 제목·폴더·서사 비트·단계·컷 수·사람 QA·발행 정보를 보강한다.
  - 계획-only 행은 `observed:false`, `assets_available:false`, `supported_actions:[]`로 만든다.

파일럿 병합 결과:

| Channel | Observed | Planned | Board rows | Plan-only |
|---|---:|---:|---:|---:|
| today.myo | 7 | 30 | 30 | 23 |
| econ-daily | 63 | 35 | 83 | 20 |
| takitani.lab | 1 | 7 | 7 | 6 |

### 2. 참조 문서형 에피소드 목록

- `tools/board/index.html`
  - `Day / 에피소드`, `에피소드(폴더·서사)`, `포맷`, `대본/이미지/영상/렌더`,
    `영상 확인`, `발행`, `상태`, `관리` 위계를 적용했다.
  - 에피소드 ID 하나를 하나의 `<tr>`로 렌더하고 상세용 추가 행은 만들지 않는다.
  - 컷 수는 `3/3`, 부분 제작은 `6/7`, 캐러셀의 영상·렌더는 `—`로 표시한다.
  - 사람 QA 체크 수와 자동 QA 결과를 분리하고, 발행 > QA 통과 > 생성완료 > 제작중 > 계획
    우선순위로 상태와 진행 막대를 계산한다.
  - 제작완료·QA·발행·발행 대기·실측/전체 요약을 목록 위에 표시한다.
  - 1024px 이하에서는 같은 뷰모델을 별도 모바일 카드로 렌더한다.

TodayMyo 확인값:

- 30/30 행, 실측 7/30
- Day 4: 이미지 6/7, 영상 6/7, 렌더 완료, 전체 상태 제작중
- Day 7 carousel: 이미지 5/5, 영상·렌더 N/A
- Day 8~30 plan-only: 실행·검증·자산 컨트롤 비활성

### 3. 행/카드 공통 액션과 자산 모달

- 이벤트를 `workspaceBody`에서 위임하고 클릭된 `[data-episode-item]` 내부의
  `data-role=action/platform`을 조회한다. 데스크톱과 모바일에 중복 ID가 없다.
- 프로필이나 플랫폼을 바꾸어 다시 렌더한 뒤 같은 화면의 교체 컨트롤로 포커스를 복원한다.
- 자산 모달 탭은 script, images, videos, audio, distribution, documents를 제공한다.
- 텍스트·이미지·영상·오디오를 모달에서 미리 보고 원본을 새 창에서 열 수 있다.
- S12 `long`/`shorts` 선택은 자산 목록과 파일 URL 양쪽에 전달된다.
- 모달을 닫으면 원래 누른 자산 버튼으로 포커스가 돌아가며 media `src`를 제거한다.

### 4. 자산 파일 경계

- 자산 목록에 포함된 정규 파일만 GET/HEAD/Range로 제공한다.
- backup 파일과 파일 symlink를 목록에서 제외하고 profile/platform 경계를 다시 검증한다.
- `O_NOFOLLOW`로 파일을 연 뒤 canonical path와 열린 fd의 `dev/ino`를 재결합해 상위 디렉터리
  swap 및 swap-back TOCTOU를 차단한다. 이후 스트림은 경로를 다시 여는 대신 같은 fd를 쓴다.
- plan-only ID로 assets, asset/file, actions API를 직접 호출해도 관측 에피소드 재스캔에서
  `404 EPISODE_NOT_FOUND`가 나며 실행기는 호출되지 않는다.

### 5. 문서와 회귀 테스트

- `README.md`에 계획/실측 병합, 데스크톱 행, 모바일 카드, 연결 자산 모달 운용법을 추가했다.
- `tests/channel-board.test.js`에 다음 회귀를 추가했다.
  - observed-only `episodes`와 병합 `board_episodes`의 계약
  - 계획-only 행의 비활성 payload와 직접 API 호출 차단
  - 부분 컷, carousel N/A, 1에피소드 1행/1카드 렌더
  - 연결 자산 파일의 HEAD/Range/목록 허용 경계

## Key Decisions

1. 기존 API 호환을 위해 `episodes`를 바꾸지 않고 `board_episodes`를 추가했다.
2. 계획-only 행에 실행 가능한 가짜 BT ID를 만들지 않았다.
3. 관측 자산 수가 양수이면 실제 값을 우선하고 기대 컷 수로 표시를 제한한다. 실제 값이 0이고
   연재 마스터가 명시적으로 미완료인 경우에만 계획 집계를 부분 진척 fallback으로 사용한다.
4. 자동 QA 리포트 통과를 사람 QA 통과로 간주하지 않는다.
5. 참고 문서의 펼침 상세 행 대신 기존 요구사항인 자산 모달을 상세 표면으로 유지했다.

## Verification

- Node.js 22와 24에서 전체 테스트 60개 통과.
- 인라인 보드 JavaScript와 `server.js`, `channel-document.js` syntax check 통과.
- 실제 headless Chrome 검증:
  - TodayMyo 30 table rows / 30 mobile cards, duplicate DOM ID 0개
  - 1600px에서 테이블, 740px에서 카드 표시
  - desktop/mobile S12 플랫폼 변경 후 각각 shorts/long 자산 모달로 전달
  - 자산 모달에서 스크립트·이미지·영상·오디오·배포본·문서 탭 로드
  - 계획행 모든 작업 컨트롤 비활성, 브라우저 예외 0개

## Operational Note

`server.js`는 프로세스 시작 시 로드되므로 이미 열어 둔 보드는 재시작해야 새 병합 API가
반영된다.

```bash
cd /Users/beye/workspace/BarroSkills/.claude/skills/barrotube
npm run board -- --open
```

기본 8933이 사용 중이면 서버가 다음 빈 loopback 포트를 골라 실제 URL을 출력한다.
