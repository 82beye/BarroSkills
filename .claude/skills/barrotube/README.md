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

4. **채널 레지스트리 마이그레이션·검토**:
   ```bash
   npm run channel:migrate                 # 기본 dry-run: 쓰기 없이 후보·충돌 확인
   npm run channel:migrate -- --write      # 검토용 manifest·report 생성
   npm run board -- --open                 # 중앙 채널 보드 (기본 8933, 사용 중이면 다음 포트)
   ```
   첫 마이그레이션 대상은 `econ-daily`, `today.myo`, `takitani.lab`이다. 모든 채널은
   `needs_review`로 등록되며, 충돌을 해소하고 활성화하기 전에는 제작·발행 액션을 실행할 수 없다.

5. **Cron 자동화 (선택)**:
   ```
   /barrotube install-cron daily-producer "06:00"
   /barrotube install-cron weekly-marketing "Mon 09:00"
   /barrotube install-cron doctor-daily "07:00"
   ```

## 채널 레지스트리와 설계문서

채널별 정본은 `$BARROTUBE_DATA/workspace/channels/<channel-id>/channel.yaml`이다. manifest는
채널 정체성·플랫폼·파이프라인 프로필·원본 자산 경로·시리즈 인덱스·credential 환경변수
이름을 한곳에 연결한다. 원본 영상·이미지·문서는 이동하거나 복제하지 않고 기존 프로젝트
경로에 둔다.

- **편집 정본**: `npm run board`로 여는 중앙 채널 보드. manifest의 `revision`을 확인해
  동시 수정을 보호하고, 마이그레이션 충돌을 여기서 검토한다.
- **보드 탐색**: 상단 드롭다운에서 채널을 바꾸며, 채널 등록과 설정은 버튼으로 여는
  모달에서만 처리한다. 보드는 `series/index.json`의 연재 계획과 실제 폴더 스캔 결과를
  한 목록으로 병합하므로 아직 제작하지 않은 회차까지 빠짐없이 보인다. 데스크톱에서는
  `Day · 제목/폴더 · 포맷 · 대본/이미지/영상/렌더 · QA · 발행 · 상태 · 관리`를 ID당 한 행으로,
  1024px 이하에서는 같은 정보를 회차당 한 카드로 표시한다. 같은 ID의 여러 파이프라인은
  행/카드 안의 프로필 선택기로 전환한다. 계획만 있는 회차의 실행·자산 컨트롤은 비활성화된다.
- **자산 연결 보기**: 각 회차의 `자산` 버튼은 현재 프로필과 플랫폼에 연결된 스크립트·이미지·
  영상·오디오·배포본·문서를 모달에서 직접 읽거나 재생한다. S12 멀티 플랫폼 회차는 선택한
  `long`/`shorts` 범위만 표시하며, 모달을 닫으면 원래 누른 버튼으로 포커스가 돌아간다.
- **포트 충돌 처리**: 기본 실행은 8933이 사용 중이면 다음 빈 포트를 자동 선택해 실제 URL을
  출력한다. 고정 포트가 필요하면 `npm run board -- --port 8934 --open`처럼 명시한다.
- **읽기 전용 산출물**: `npm run channel:document -- --channel <channel-id>`가 각 프로젝트
  루트에 `<채널>-영상제작-설계문서.html` 스냅샷을 생성한다. HTML을 직접 수정하지 말고
  보드/manifest를 수정한 뒤 다시 생성한다.
- **활성화·발행 게이트**: unresolved conflict가 하나라도 있거나 상태가 `active`가 아니면
  publish를 차단한다. `75_board_approval.json`은 승인 당시 영상·metadata·QA·선택 썸네일,
  manifest revision, YouTube 목적지, 최종 privacy/category/publishAt을 함께 결속한다.
  승인 후 산출물이나 채널 발행 설정이 바뀌면 새 승인이 필요하다.
- **시크릿 분리**: `channel.yaml`에는 OAuth/API 값 자체가 아니라 환경변수 이름만 저장한다.

승인 JSON은 로컬 운영 절차와 변경 탐지를 위한 체크포인트다. 동일 사용자 권한으로 저장소와
실행 코드를 수정할 수 있는 공격자를 막는 암호학적 서명 경계는 아니다. 중앙 보드는 loopback,
세션 토큰, 활성 채널 조건으로 운영자 동작을 제한하며 OS 계정·파일 권한은 별도로 보호해야 한다.
YouTube PUT 결과가 네트워크 오류로 불명확하면 `80_publish_result.json.lock`을 남겨 자동 재시도를
막으므로, YouTube Studio에서 실제 업로드 여부를 확인한 뒤 수동으로 조정한다.

파일 배치는 연합(federated) 구조다. 레지스트리는 `$BARROTUBE_DATA`에 있고, 예를 들어
`today.myo`와 `takitani.lab`의 제작 자산은 `$BARRO_AI_FACTORY` 아래 기존 위치를 계속
사용한다.

## 핵심 문서

| 문서 | 내용 |
|---|---|
| [SKILL.md](./SKILL.md) | 마스터 진입점 — 5개 모드 |
| [references/PIPELINE.md](./references/PIPELINE.md) | S0~S12 단계별 상세 |
| [references/MARKETING.md](./references/MARKETING.md) | 마케팅 → 시리즈 부트스트랩 |
| [references/SECRETS.md](./references/SECRETS.md) | API key·OAuth 셋업 |
| [references/ARCHITECTURE.md](./references/ARCHITECTURE.md) | 에이전트 조직도 + 위임 라인 |

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
- 에이전트 공유 (`~/.claude/agents/` user-scope) — 파이프라인 필수 16 + 선택(reel-director 등)

기존 ~/youtube-co/를 무수정 보존. 두 시스템 병행 가능.

## 라이선스·기여

본인 1명용 (1차, 2026-05-24). 일반 배포 v2 검토 예정.
