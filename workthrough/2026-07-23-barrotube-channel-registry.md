# BarroTube 채널 레지스트리·관리 보드·설계문서 구현

## Overview

여러 프로젝트와 파이프라인에 흩어진 채널 데이터를 하나의 정규 채널 레지스트리로 통합했다. 기존 원본 폴더를 이동하지 않고 manifest가 위치를 참조하며, adapter가 서로 다른 산출물 형식을 공통 `EpisodeView`로 변환한다. 이 데이터를 로컬 관리 보드와 독립 실행형 HTML 설계문서가 함께 사용하도록 구현했다.

YouTube 발행 경로도 채널 manifest, OAuth 대상 채널, QA 판정, 승인 시점의 파일 해시를 하나의 승인 묶음으로 고정했다. 마이그레이션된 파일럿 3개 채널은 의도적으로 `needs_review` 상태이며, 남은 충돌을 해소하기 전에는 제작·발행 액션이 차단된다.

## Context

- `econ-daily`, `today.myo`, `takitani.lab`의 계획, 에피소드, 발행 결과가 서로 다른 루트와 스키마에 존재했다.
- `/Users/beye/BarroAiFactory/today.myo/오늘묘-영상제작-설계문서.html` 같은 문서는 수동 관리되어 실제 산출물과 쉽게 불일치할 수 있었다.
- 공용 산출물 루트에 여러 채널이 섞일 가능성이 있어, 채널 소유권이 불명확한 에피소드를 자동 귀속하면 잘못된 발행으로 이어질 수 있었다.
- 기존 발행 승인은 QA 문구와 파일 경로를 확인했지만, 승인 이후 파일 변경이나 다른 OAuth 채널로의 발행을 충분히 묶어 두지 못했다.

## Architecture

```text
channel.yaml + series/index.json
            │
            ▼
  ChannelRegistry (검증·경로·충돌·revision CAS)
            │
            ▼
 profile adapters (S12 / R11 / C4) ──► EpisodeView[]
            │
            ├──► local channel board
            ├──► redacted standalone HTML document
            └──► approval/publish safety gate
```

레지스트리는 메타데이터의 단일 기준점이지만 원본 미디어의 저장 위치를 강제로 바꾸지 않는다. `paths`는 허용된 루트 아래의 기존 폴더를 가리키고, 실제 경로(realpath) 검증으로 심볼릭 링크 이탈을 막는다.

## Changes Made

### 1. 정규 채널·시리즈 스키마와 레지스트리

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/schemas/channel.schema.json`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/schemas/series.schema.json`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/lib/channel-registry.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/templates/channel-config.yaml`

구현 내용:

- canonical `channel.yaml`과 legacy manifest 읽기 호환
- `revision` 기반 optimistic concurrency(CAS), 원자적 생성·갱신, stale lock 회수
- 허용된 변수만 사용하는 경로 템플릿과 realpath containment 검증
- manifest 내부의 평문 secret, 변형된 secret key, 배열 내부 secret 차단
- raw credential 대신 환경변수 이름만 저장
- 지원 profile(`barrotube-s12`, `media-render-r11`, `carousel-c4`) 검증
- series 소유 채널, 문서 출력 경로, migration conflict를 activation gate에 포함
- hard delete 없이 `active`, `needs_review`, `archived` 상태 전이만 제공

### 2. 분산 산출물 통합 adapter

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/lib/channel-adapters.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/paths.js`

S12 YouTube 에피소드, R11 Reel, C4 carousel의 서로 다른 구조를 공통 `EpisodeView`로 변환한다. canonical series의 중첩 에피소드를 평탄화하고 `plan_id`, `slug`, `series_id + episode_no`로 계획과 관측 산출물을 연결한다.

동일 에피소드 ID가 여러 profile에 있으면 `source_profile`을 명시해야 하며, 공용 S12 루트의 미귀속 에피소드는 `pipeline.legacy_default_channel`이 명시된 경우에만 해당 채널에 포함한다. `platforms/reels`와 `platforms/tiktok` 같은 배포 폴더만으로 production layout을 v2로 오판하지 않도록 수정했다.

### 3. 마이그레이션과 시리즈 인덱스

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/channel-migrate.js`

기본 실행은 읽기 전용 dry-run이다. `--write`로 manifest와 migration report를 만들고, `--refresh-series`로 기존 brief에서 canonical series index를 재구축한다. 기존 파일은 timestamp backup을 남기며, 변경이 없으면 다시 쓰지 않는다.

파일럿 결과:

- `/Users/beye/BarroTubeData/workspace/channels/econ-daily/channel.yaml` — revision 2
- `/Users/beye/BarroTubeData/workspace/channels/today.myo/channel.yaml` — revision 2
- `/Users/beye/BarroTubeData/workspace/channels/takitani.lab/channel.yaml` — revision 1
- `/Users/beye/BarroTubeData/workspace/channels/migration-report.json`
- econ series backup: `/Users/beye/BarroTubeData/workspace/channels/econ-daily/series/index.json.bak.2026-07-23T14-13-44-451Z`

### 4. 자동 생성 채널 설계문서

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/lib/channel-document.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/render-channel-document.js`

HTML은 서버 없이 열 수 있는 snapshot이며 다음 정보를 포함한다.

- 채널 identity, profile, format, cadence
- series 계획과 실제 episode 진행 단계
- QA·승인·발행 상태
- unresolved conflict와 활성화 가능 여부
- registry API가 열려 있을 때의 live refresh

출력 전 credential 관련 필드와 절대 경로를 제거하고 HTML/script context escaping을 적용한다. 출력 대상은 `.html`이어야 하며 채널 project 또는 registry 디렉터리 안에 있어야 한다. manifest, series, source tree와 충돌하는 경로는 거부한다.

생성된 문서:

- `/Users/beye/BarroTubeData/workspace/channels/econ-daily/econ-daily-영상제작-설계문서.html`
- `/Users/beye/BarroAiFactory/today.myo/오늘묘-영상제작-설계문서.html`
- `/Users/beye/BarroAiFactory/takitani.lab/takitani.lab-영상제작-설계문서.html`

기존 문서에는 timestamp backup을 남겼고 원본 미디어는 이동하거나 수정하지 않았다.

### 5. 로컬 채널 관리 보드

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tools/board/index.html`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tools/board/server.js`

보드에서 채널 목록, manifest 상세, 에피소드, 자산, 충돌을 조회하고 revision을 포함한 안전한 manifest 갱신을 할 수 있다. 실행 액션은 profile별 allowlist만 허용하며 raw command API는 제거했다.

보안 경계:

- loopback bind, Host·Origin 검증, 세션 mutation token
- request body, command output, 실행 시간 제한
- timeout 시 POSIX process group의 하위 프로세스까지 종료
- profile과 플랫폼 경계를 지키는 asset path 검증
- `needs_review` 채널의 production action 차단

### 6. 승인·YouTube 발행 안전성

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/lib/publish-approval.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/approve-episode.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/publish-youtube.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/run-episode.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/create-playlist.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/generate-qa-report.js`

승인은 다음 항목에 묶인다.

- channel ID, episode ID, platform/layout, manifest revision
- 실제 OAuth YouTube channel ID
- effective privacy, category, publishAt
- video, metadata, QA report, thumbnail SHA-256

발행은 승인 당시 읽은 immutable buffer를 사용한다. 결과 파일은 exclusive reservation 후 원자적으로 기록하며, resumable upload PUT 결과가 불명확하면 lock을 남겨 수동 reconciliation 전 중복 업로드를 막는다. 전역 credential fallback은 제거했고 채널 manifest가 지정한 환경변수와 확인된 OAuth 대상만 사용한다.

> 승인 JSON은 실수·경합·승인 후 파일 변경을 막기 위한 로컬 운영 무결성 장치다. 동일 OS 사용자 권한으로 저장소와 승인 파일을 함께 변경할 수 있는 공격자에 대한 암호학적 신뢰 경계는 아니다.

### 7. 설정·문서·테스트

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/.env.example`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/README.md`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/SKILL.md`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/package.json`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/channel-adapters.test.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/channel-board.test.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/channel-document.test.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/channel-migrate.test.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/channel-registry.test.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/paths.test.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/publish-approval.test.js`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/publish-youtube-safety.test.js`

운영 명령, 파일럿 검토 순서, 활성화 gate, ambiguous upload 복구 절차를 README와 skill 문서에 추가했다.

## Code Examples

### Canonical channel manifest

```yaml
schema_version: 1
id: today.myo
revision: 2
status: needs_review
identity:
  display_name: 오늘묘
pipeline:
  profile: media-render-r11
  additional_profiles:
    - carousel-c4
paths:
  project_root: ${BARRO_AI_FACTORY}/today.myo
  series_index: ${CHANNEL_ROOT}/series/index.json
document:
  output_path: ${BARRO_AI_FACTORY}/today.myo/오늘묘-영상제작-설계문서.html
```

### 운영 명령

```bash
cd /Users/beye/workspace/BarroSkills/.claude/skills/barrotube

npm run channel:migrate                       # 후보와 충돌만 확인
npm run channel:migrate -- --write            # 검토용 manifest/report 생성
npm run channel:migrate -- --write --refresh-series
npm run channel:document -- --channel today.myo
npm run board
```

## Verification Results

### Automated tests

```text
npm test
56 tests, 56 passed, 0 failed

python3 -m unittest discover -s ../barrotube-media-render/tests -p 'test_*.py'
Ran 35 tests in 26.706s — OK
```

이번 작업에서 추가·수정한 JavaScript 13개 파일은 각각 `node --check`를 통과했다. 보드 테스트에는 세션 보안, raw command 제거, revision CAS, multi-profile 라우팅, 발행 인자 결합, timeout 시 descendant 종료가 포함된다.

### Pilot registry state

| Channel | Revision | State | Observed | Published | Unresolved |
|---|---:|---|---:|---:|---:|
| econ-daily | 2 | needs_review | 63 | 39 | 5 |
| today.myo | 2 | needs_review | 7 | 1 | 4 |
| takitani.lab | 1 | needs_review | 1 | 1 | 3 |

세 채널 모두 `document_output_safe: true`다. 로컬 보드 API smoke test에서 채널 목록·상세·에피소드 응답을 확인한 뒤 서버를 종료했다.

### Document reproducibility and redaction

```text
node scripts/automation/render-channel-document.js --all --dry-run
econ-daily   changed: false, episode_count: 63
today.myo    changed: false, episode_count: 7
takitani.lab changed: false, episode_count: 1
```

생성된 세 HTML에서 `/Users/beye` 절대 경로와 `client_secret`, `refresh_token`, `access_token`, `api_key` 패턴이 없음을 확인했다.

## Follow-up Debugging: Board Port Collision

### Reproduction and root cause

기본 명령 `npm run board`가 아래 오류로 종료됐다.

```text
Error: listen EADDRINUSE: address already in use 127.0.0.1:8933
```

`lsof`와 `ps`로 확인한 결과 8933은 BarroTube가 아니라 2026-07-11부터 실행 중인
`Python -m http.server 8933 --bind 127.0.0.1 -d /Users/beye/BarroAiFactory/today.myo/tools/_share`
프로세스가 점유하고 있었다. 사용자 소유 프로세스이므로 종료하지 않았다.

### Fix

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tools/board/server.js`
  - 기본 8933이 점유되면 최대 20개 후보에서 다음 빈 loopback 포트를 자동 선택한다.
  - 실제 bound port를 Origin 검사와 출력 URL에 사용한다.
  - `--port` 또는 `BARROTUBE_BOARD_PORT`로 고정한 포트가 점유되면 unhandled stack 대신
    실행 가능한 대체 명령을 출력한다.
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/channel-board.test.js`
  - 기본 포트 fallback과 명시 포트 fail-clean 동작을 회귀 테스트로 추가했다.
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/README.md`
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/SKILL.md`
  - 자동 포트 선택과 고정 포트 사용법을 문서화했다.

전체 테스트를 병렬 실행하며 기존 file-lock 구현의 간헐적 livelock도 발견했다. 정상 lock의
모든 contender가 stale-recovery mutex를 만들면서 현재 소유자가 반복적으로 양보하는 구조였다.
`/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/lib/channel-registry.js`에서
lock의 mtime을 먼저 확인하고 실제 stale lock일 때만 recovery mutex를 획득하도록 변경했다.

### Follow-up verification

```text
npm run board
포트 8933 사용 중 → 8934 자동 선택
BarroTube 채널 보드: http://127.0.0.1:8934

GET http://127.0.0.1:8934/api/channels
200 OK — econ-daily, takitani.lab, today.myo

channel-board tests: 12/12 passed
registry concurrency stress: 10/10 passed
full Node suite: 53/53 passed (Node v22.15.0, 사용자 셸 Node v24.11.1)
```

검증용 BarroTube 서버만 종료했고 기존 8933 Python 서버는 그대로 유지했다.

## Follow-up UI Redesign: Compact Channel Board

### Context

초기 보드는 채널 카드와 KPI가 화면의 절반 이상을 차지했고 채널 설정도 상시 노출됐다.
에피소드 한 건은 메타데이터 grid와 `ep-tools` grid가 두 줄로 배치되어, 실제 데이터는 한 건인데
시각적으로 두 행처럼 보였다.

### Changes

- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tools/board/index.html`
  - 큰 채널 카드·2열 레이아웃을 제거하고 상단 `channelSelect` 드롭다운으로 교체했다.
  - 선택 채널의 상태, revision, 에피소드·발행·미해결 수만 compact chip으로 표시한다.
  - 채널 등록과 채널 설정 폼을 각각 native `dialog` 모달로 이동했다.
  - 본문 전체 폭을 에피소드 semantic table에 할당하고 검색·단계 필터를 추가했다.
  - API 응답을 채널 내 episode ID로 묶어 에피소드 하나당 정확히 하나의 `<tr>`만 만든다.
  - 같은 ID가 R11/C4처럼 여러 `source_profile`에 있으면 한 행의 profile dropdown으로 전환한다.
  - 동일 `(episode ID, source_profile)`이 중복되면 조용히 하나를 선택하지 않고 경고 후 실행을 차단한다.
  - 채널 전환 request sequence를 적용해 느린 이전 응답이 새 선택 화면을 덮지 못하게 했다.
  - manifest 충돌만 원본 인덱스로 편집하고 runtime 진단 충돌은 읽기 전용으로 분리했다.
  - profile dropdown 전환 후 교체된 control로 키보드 초점을 복구한다.
  - 모바일에서는 채널 제어 버튼을 별도 줄에 배치하고, 표는 행을 쪼개지 않은 채 수평 스크롤한다.
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/channel-board.test.js`
  - compact selector, 등록·설정 modal, table DOM 구조를 검증한다.
  - 동일 ID의 multi-profile grouping, profile 전환, composite 중복 실행 차단을 검증한다.
- `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/README.md`
  - 새 채널 선택·모달·행 단위 탐색 방식을 운영 문서에 반영했다.

### Key rendering rule

```javascript
// tools/board/index.html
function groupEpisodes(items) {
  // 채널 안의 동일 episode id는 한 group으로 묶는다.
  // source_profile은 variants에 보존하고 같은 profile 중복은 실행을 차단한다.
}

function episodeRowHtml(group, groupIndex) {
  // group당 하나의 <tr>만 반환한다.
}
```

### UI verification

```text
Desktop 1440×1000: compact channel selector + full-width episode table 확인
Mobile 390×844: 등록/새로고침 버튼 노출, table horizontal scroll 확인
Live DOM / econ-daily: 63 API episodes → 63 <tr> rows
Board UI tests: 15/15 passed
Full Node suite: 56/56 passed
User shell Node v24.11.1: 56/56 passed
JavaScript syntax check: passed
git diff --check: passed
```

실행 중인 8934 보드는 `index.html`을 요청마다 읽으므로 서버 재시작 없이 브라우저 새로고침만으로
새 레이아웃이 반영된다.

## Known Existing Issue

이번 변경 대상이 아닌 `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/workflow-engine.js:103`은 기존 코드의 non-async 함수 안에 `await import`가 있어 저장소 전체 `node --check`에는 실패한다. 새 채널 레지스트리·보드·문서 경로는 이 파일을 사용하지 않으며 관련 테스트는 모두 통과했다. 별도 정리 작업에서 수정해야 한다.

기존에 작업 중이던 `/Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/`의 수정 파일 3개는 변경하거나 되돌리지 않았다.

## Next Steps

1. 보드에서 파일럿별 unresolved conflict를 확인하고 실제 계정·정책 값을 검증한다.
2. `econ-daily`의 YouTube channel ID, credential env 이름, privacy/category 기본값을 확인한다.
3. `today.myo`의 bridge token을 교체하고 Instagram 대상 계정과 character DNA 참조를 확정한다.
4. `takitani.lab`의 Instagram 대상 계정과 character/style 참조를 확정한다.
5. 충돌이 0인 채널만 revision을 확인해 `active`로 전환한다.
6. 첫 실제 발행은 private dry-run과 OAuth channel identity 확인 후 진행한다.
7. ambiguous upload lock이 생기면 YouTube Studio에서 업로드 여부를 먼저 대조한 뒤 수동으로 reconciliation한다.
