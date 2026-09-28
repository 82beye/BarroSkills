# BarroTube 미디어·자동화·KPI 검증 및 보안 수정

## 판정

2026-09-14 22:34 KST 기준 코드 수정과 로컬 검증은 완료했다. 최종 JavaScript 401개와 기존 Python 40개 테스트가 모두 통과했고, 실제 채널 수집→KPI→성장 지시 생성도 exit 0으로 완료했다. **전체 무인 운영의 정상 판정은 보류**한다. 사용자 Chrome의 자동화 설정은 이미 켜져 있었으며, 앞선 권한 오류는 별도로 열린 자동화용 Chrome에 연결된 결과였다. 연결을 수정해 Grok 한 컷의 첨부·생성·다운로드까지 확인했지만, 결과가 400×736/6.04초로 요구 규격에 미달했다. 720p/10s 선택 시 업그레이드 창이 나타났고, 이후에는 로그아웃과 Google 재로그인 오류가 발생했다. 당일 국내 마감 영상도 YouTube 서버에서 아직 처리 중이다.

사용자가 지칭한 `barro-media-render`의 실제 설치 이름은 `barrotube-media-render`다. `.claude/skills`의 저장소 파일과 전역 `.agents/skills` 연결을 확인했다. 별도의 cron 서비스가 아니라 macOS LaunchAgent 10개가 작업을 실행한다.

기존 미커밋 루틴·제목·실험 관련 변경을 유지하면서 수정했다. 아래 파일 설명은 이번 감사에서 적용한 내용이다. 새 의존성은 추가하지 않았다.

## 실제 운영 점검

### 스케줄 및 마지막 실행

20:37 KST의 `launchctl print` 결과를 저장했다. 오래된 `com.barrotube.*` 제작용 plist는 로드되지 않아 중복 예약 실행 증거가 없었다. 별도 Paperclip ingress 서비스는 이번 대상이 아니다.

| LaunchAgent 이름 뒤쪽 | 예약 시각 KST | 점검 당시 상태 |
|---|---|---|
| competitor-scan | 매일 05:20, 15:20 | 로드됨, 마지막 exit 0 |
| growth | 매일 05:40, 15:40 | 로드됨, 마지막 exit 0; 수정 후 전체 루프 수동 검증 exit 0 |
| us-close | 매일 06:00 | 로드됨, 마지막 exit 0 |
| oauth-renew | 매일 06:40 | 로드됨, 마지막 exit 0; 실제 OAuth 갱신·채널 조회 성공 |
| doctor-daily | 매일 07:10 | 로드됨, 이전 exit 0; 수정된 진단은 미해결 장애를 찾아 exit 1 |
| publish-resume | 매일 07:30, 17:30 | 로드됨, 마지막 exit 0; 남은 업로드 잠금 별도 탐지 |
| weekly-marketing | 월요일 09:00 | 로드됨, 마지막 exit 0 |
| realestate | 금요일 10:00 제작 | 로드됨, 마지막 exit 0; 설정된 공개 시각은 토요일 10:00 |
| kr-close | 월~금 16:00 | **마지막 exit 1 — EP-2026-0155 업로드 응답 실패** |
| telegram-bot | 상시 실행 | 보안 수정 후 재시작, PID 16081, 실행 중; 재시작 이후 오류 0 |

예약 제작·게시 작업은 수동으로 다시 발행시키지 않았다. 기존 실패 이력을 보존했다. 봇은 입력 대기 상태에서 재시작했으며 시작 알림을 보내는 코드가 없다. 재시작 후 실제 curl 자식 프로세스가 `--config -`를 사용하고 토큰이 argv에 없는 것을 확인했다.

근거: [LaunchAgent 상태](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-launchd-before.json), [봇 재시작 검증](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-bot-after.json).

### 미디어 생성 및 업로드

`EP-2026-0155/platforms/shorts`에는 씬 이미지 5개와 모션 5개가 있다. `_engines.json`은 모두 **HyperFrames 폴백**으로 기록되어 있다. Grok 생성 성공으로 계산하지 않았다.

최종 영상은 56초, 1080×1920, H.264/AAC 48 kHz stereo, 29,093,383 bytes다. 실제 파일 SHA-256이 PASS QA 보고서에 기록된 해시와 일치한다.

```text
6fe5dfc949c2c1854e51166042c8e03818d2fa7ca3f988137c2b4f631379fc73
```

기존 업로드는 17:35:46 KST에 시작했고, 응답 실패 후 죽은 PID의 결과 잠금이 남았다. 채널 인증 후 읽기 전용 조회로 제목·채널·시작 시각이 일치하는 `pzq5dlDAMd4`를 찾았다. 20:29, 20:43, 21:59 및 최종 22:27 KST의 API 응답은 `uploadStatus=uploaded`, `processingStatus=processing`, `duration=P0D`다. **완료로 기록하거나 다시 업로드하지 않았다.**

이 오래된 잠금에는 재개 세션 URL이 없으므로 PID가 죽었다는 이유만으로 삭제할 수 없다. 운영 인플라이트 잠금은 소유 프로세스 종료를 확인해 기존 공유 해제 함수로 정리했지만, 게시 결과 잠금은 그대로 보존했다.

현재 수정은 새 업로드의 세션 URL·영상 해시·메타데이터 해시를 소유자 전용 잠금 파일에 저장한다. 전송 응답이 유실되면 **동일 세션**의 서버 상태를 조회하고 미수신 바이트만 제한적으로 재전송한다. 프로세스 종료 후 저장된 세션을 자동으로 복구하는 별도 명령까지 구현한 것은 아니다. 모호한 상태에서는 잠금을 유지한다. 이 동작은 [YouTube 재개 업로드 프로토콜](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)에 따른다.

근거: [미디어·KPI 독립 검증](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-kpi-media-verification.json), [원격 업로드 조회](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-upload-reconciliation.json).

### 브라우저 및 독립 릴 모드

- Chrome 직접 경로: 초기 권한 오류의 대상은 점검 도구가 별도로 띄운 Chrome이었다. 사용자 Chrome(PID 52864)의 메뉴에는 허용 표시가 있었고, 해당 PID에 직접 보낸 JavaScript도 실행됐다. 우리 점검 도구가 만든 브라우저만 닫고, 코드가 일반 Chrome의 PID·창·탭 ID를 고정하도록 수정했다.
- 사용자가 권한을 위임한 뒤 기존 Google 계정으로 Grok 로그인에 성공했고 한 컷을 생성했다. 이후 세션이 로그아웃됐으며, 정상 로그인 버튼으로 재시도해도 `Something went wrong. Please try again.`가 두 번 반환됐다. 로그아웃 원인은 확인되지 않았다. 최종 `--check`는 권한 오류가 아닌 **로그아웃 상태로 exit 3**이다.
- 실제 생성 영상은 기존 게시물 ID로 다운로드했다. **400×736, H.264/AAC, 6.041667초, 1,135,456 bytes**다. 720p/10초 선택 시 업그레이드 창이 나타났다. 요구 규격에 미달하므로 감사 폴더에만 보관했고, 완료된 운영 씬으로 기록하지 않았다. 결제나 체험은 시작하지 않았다.
- 전용 프로필 경로 `grok-motion.js --status`: exit 3. 실제 작성기를 확인하지 못했다. 쿠키만 존재하는 상태를 성공으로 처리하던 코드를 수정했고, 검사 종료 시 자신이 만든 브라우저 컨텍스트를 닫는다.
- 독립 릴 예시 `takitani.lab/barrotube/ep02_reel`: ffmpeg/ffprobe, 다운로드 접근, CapCut 2, 템플릿, BGM/SFX, 6컷 스크립트와 폴더가 존재한다. 기존 릴 상태 파일을 덮어쓰지 않고 점검했다.
- 독립 Instagram 게시에 필요한 토큰은 해당 스크립트의 기본 `.env` 경로·프로세스 환경·Keychain에서 확인되지 않았다. 브라우저 로그인과 Instagram 게시 성공은 이 로컬 preflight의 `ok:true`가 보증하지 않는다.

근거: [독립 모드 preflight](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-standalone-preflight.json), [Grok 실제 검증 기록](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-grok-smoke/verification.json), [기존 영상 다운로드 로그](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-grok-existing-download.log), [최종 세션 검사](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-grok-current-final.log).

## KPI 수정 및 실제 재계산

기존 수집기는 최신 50개 영상만 갱신해 오래된 영상의 관측치가 동결되어 있었다. 인덱스 14일 관측이 없는 상황에서 다른 모집단의 채널 누적 조회수로 전환하면서 주간 성장률이 12.25배로 표시됐다. 인덱스로 정상 계산된 WoW도 등급이 NA가 되는 별도 오류가 있었다.

수정 후 알려진 영상 전체를 50개씩 조회한다. 20:28 KST 수집 결과 인덱스는 121개이며 120개 응답을 갱신했다. 누락된 영상은 unavailable로 표시하고, 처리 중인 영상은 성과 계산에서 제외한다. Analytics는 28일 범위를 요청했고 25일의 응답이 있었다. 데이터 수집 실패는 exit 1이며, 그 뒤의 KPI/성장 지시 갱신을 중단한다.

| 지표 | 수정 후 값 | 근거 |
|---|---|---|
| 주간 조회 성장 | **1.06737배 / YELLOW** | Analytics의 같은 기준으로 비교 |
| 이전 7일 조회 | 6,249 | 2026-08-29~09-04 |
| 최근 확정 7일 조회 | 6,670 | 2026-09-05~09-11 |
| 평균 시청률 | 64.3953% / YELLOW | 위 최근 7일, 조회수 가중 평균 |
| 발행 일관성 | 85% / RED | 처리 중인 당일 영상 제외 |
| 48h 조회 지수 | 0.43배 / RED | 실제 측정 가능한 관측만 사용 |
| 발행당 조회 | 약 551 / YELLOW | 인덱스 조회 증분 / 발행 편수 |
| 전체 성과 등급 | **RED** | 저조한 성과 판정 |
| 수집·계산 건강 상태 | **GREEN** | 최신 관측과 계산 결과 존재 |

Python으로 API 원자료의 두 7일 합계와 가중 평균을 별도 계산해 저장된 KPI 값과 일치함을 확인했다. Analytics 일별 값은 확정일까지 지연되므로 관측 기준일을 표시한다. 9월 14일 현재까지의 실시간 조회 성장률이라고 표현하지 않는다.

`metrics_version=3`으로 기준 변경을 명시했다. 48시간 지표에 게시 이전·미래·너무 오래된 관측을 사용하지 않고, 관측 누락을 0이나 실패로 바꾸지 않는다. 이전 측정 버전과의 실험 비교는 기존 버전 보호 규칙에 따라 보류될 수 있다.

실제 실행 산출: [KPI](/Users/beye/BarroTubeData/workspace/growth/kpi/2026-09-14.md), [성장 루프 로그](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-growth-live-final.log). 세 슬롯의 성장 지시 파일도 함께 갱신됐다.

## 적용한 코드·보안 변경

| 파일 | 이번 변경 |
|---|---|
| [미디어 SKILL.md](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/SKILL.md) | Grok 기본값과 HyperFrames 폴백, 첨부 순서, 오디오 조건, cron/KPI 검증 절차를 실제 코드와 일치시킴. 광범위한 브라우저 종료 지시 제거 |
| [move_media.py](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/scripts/move_media.py) | 경로 이름·형식 검증, 원본 symlink 차단, 손상 파일 거부, 명시적 덮어쓰기, 임시 파일·SHA-256·fsync·원자적 복사 후 원본 삭제 |
| [.gitignore](/Users/beye/workspace/BarroSkills/.gitignore) | 비밀 `.env` 변형과 숫자 접미 백업 파일 제외, 예제 파일 예외 유지 |
| [config-loader.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/config-loader.js) | 비밀 키 이름 검증, shell 보간 제거, Keychain 인자 배열·타임아웃, CLI에서 비밀 일부도 출력하지 않음 |
| [notify.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/notify.js) | 공통 Telegram 요청에서 토큰을 curl argv 대신 stdin으로 전달, API `ok` 검사, 타임아웃, 안전한 macOS 알림 인자 전달, `BT_NO_NOTIFY` |
| [telegram-bot.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/telegram-bot.js) | 동일한 안전한 Telegram 요청 재사용, `/reject` EP ID 검증; 실행 중 봇 재시작까지 적용 |
| [guards.sh](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/guards.sh) | umask 077, `.env` 이름 검증, KST 중복 제거 발행 상한, 예산 숫자 검증, 공유 잠금 해제, QA 정본 검사, 알림 실패 시 게시 차단, 기존 거부 보존 |
| [auto-pipeline.sh](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/auto-pipeline.sh) | 슬롯/EP 입력 검증, 플랫폼 QA 경로 사용, 승인 직전 거부창 표식으로 재개 작업과의 경합 차단 |
| [publish-youtube.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/publish-youtube.js) | 공통 일시정지·거부 게이트, 인증/요청 타임아웃, 업로드 URL 검증, 동일 세션 조회·재시도, 세션 증거 보존 |
| [run-episode.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/run-episode.js) | 같은 게시 게이트와 세션 기록 콜백 사용 |
| [publish-resume.sh](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/publish-resume.sh) | 게시 실패와 결과 파일 누락을 exit 1로 전달, 기존 업로드 잠금 보존·재시도 차단, 공백을 포함한 경로 처리 |
| [in-flight-lock.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/in-flight-lock.js) | 살아 있는 로컬 PID는 시간 경과만으로 stale 처리하지 않음; 소유권 획득을 원자적·배타적으로 처리 |
| [doctor-cli.sh](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/doctor-cli.sh) | `.env` 실행 제거, JSON 안전 출력, 실제 cron 오류·KPI 신선도·남은 게시 잠금·비밀 파일 권한 진단 |
| [install-cron.sh](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/install-cron.sh) | 시간 범위·스크립트 존재 검증, XML escaping, 새 plist Umask 077·모드 600·plutil 검증, 부동산 예약 설명 정정 |
| [grok-motion-applescript.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/grok-motion-applescript.js) | 다른 Chrome 종료 코드 제거, 일반 Chrome PID·창·탭 고정, 권한/로그인/품질 선택 실패 중단, 첨부 게시물과 새 영상 게시물 ID 구분 |
| [grok-motion.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/grok-motion.js) | shell 프로세스 검색 제거, 실제 작성기 검사, 상태 검사 후 컨텍스트 정리, 공통 Grok 원본 검증 사용 |
| [motion-verify.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/lib/motion-verify.js) | 두 Grok 경로의 공통 파일 검사: H.264, 최소 가로 720, 9:16 근접 세로 비율, 9~11초, AAC 오디오. 손상·저품질 원본은 실패 |
| [fetch-channel-stats.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/fetch-channel-stats.js) | 전체 알려진 ID 갱신, 채널 일치 검사, 손상 이력 보존, 원자적 저장, Analytics 28일, 미처리 상태 기록, 실패 exit 1 |
| [KPI 계산 라이브러리](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/lib/growth-kpi.js) | 같은 기준 WoW, 관측 시간 검증, 누락/0 구분, 처리 중 영상 제외, Analytics 가중 평균, 버전 3 |
| [growth-kpi.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/growth-kpi.js) | KST 기본 날짜, 잘못된 과거 재계산 차단, 채널·관측 신선도 검증, 계산 입력 기준 기록 |
| [growth-pipeline.sh](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/growth-pipeline.sh) | 수집 또는 계산 실패를 전파해 오래된 값의 재발행 방지 |
| [growth-directives.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/growth-directives.js) | KST 날짜와 슬롯 검증 |
| [growth-weekly.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/growth-weekly.js) | 요청 날짜 기준 주간 범위, KST 기본값, 실험 판정 사유 기록 |

실제 `.env` 백업·LaunchAgent 파일을 소유자 전용으로 제한했고, 관련 cron/audit/budget/봇 로그 127개도 모드 600으로 맞췄다. 추적 중 텍스트의 일반적인 비밀 토큰 패턴 스캔에서 노출 후보가 없었다. 이 스캔이 모든 형태의 비밀을 탐지한다는 의미는 아니다.

중요한 게시 차단 동작은 다음과 같다.

```bash
if ! notify_telegram "$message" 1; then
  printf '%s\n' 'notification_failed' > "$open_file"
  return 1
fi
```

셸에서 Node 모듈을 import할 때 CLI 실행 조건이 우연히 성립해 알림을 건너뛰던 추가 오류도 수정했다. macOS의 `/var`→`/private/var` 경로 차이로 테스트가 이를 놓치지 않도록 실제 경로를 사용하는 검증을 남겼다.

## 검증 결과 및 재현

| 검증 | 결과 |
|---|---|
| 실제 launchd 계열 Node v24.11.1로 `node --test tests/*.test.js` | **401 passed, 0 failed, 0 skipped**; Node v22.15.0에서도 동일하게 401개 통과 |
| 미디어 스킬 `python3 -m unittest discover -s tests -v` | **40 passed** |
| 수정된 shell 파일 `bash -n` | 통과 |
| `git diff --check` | 통과 |
| 실제 `BT_NO_NOTIFY=1 bash lib/growth-pipeline.sh` | exit 0, 수집·KPI·성장 지시 완료 |
| 실제 `BT_NO_NOTIFY=1 bash lib/doctor-cli.sh` | exit 1, 국내 마감 실패와 보류 업로드를 RED로 탐지 |
| Chrome 직접 `--check` | 실제 Chrome 연결 수정 후 초기 준비 확인 성공; 최종은 exit 3, 재발한 로그아웃을 명시 |
| 실제 Grok 한 컷 생성 및 다운로드 | 다운로드 성공, 400×736/6.04초로 공통 규격 검사에서 거부; 운영 산출물 제외 |
| 실제 봇 재시작 후 프로세스 점검 | 실행 중, 토큰 argv 노출 없음, 관측 구간 오류 0 |
| 게시 재개 보완 후 `automation-security` + `cron-pipeline-contract` | **43 passed, 0 failed, 0 skipped**; 기존 검증 외 추가 회귀 테스트 1개 포함 |
| Chrome 연결·품질 선택·게시물 ID 보완 후 동일 대상 검사 | **44 passed**; 이후 공통 파일 규격 검사까지 추가하고 전체 401개 재검증 |
| 운영 데이터 대상 `DRY_RUN=1 BT_NO_NOTIFY=1 bash lib/publish-resume.sh` | exit 1, EP-2026-0155의 기존 업로드를 재시도하지 않고 잠금 유지 |

새 보안 검증은 [automation-security.test.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/automation-security.test.js)에 있다. 키 주입, 시각 범위, 살아 있는 잠금, 공유 게시 게이트, 알림 실패, KST 상한/예산, Chrome 권한 실패, 수집 실패 후 중단을 확인한다. Telegram 전송 테스트는 가짜 curl만 사용한다.

미디어 보존 검증은 [test_move_media.py](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/tests/test_move_media.py), KPI 경계는 [growth-kpi.test.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/growth-kpi.test.js), 업로드 응답 유실·부분 재개는 [publish-youtube-safety.test.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/publish-youtube-safety.test.js)에 추가했다. [in-flight-lock.test.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/in-flight-lock.test.js)는 운영 잠금에 손대지 않도록 임시 루트로 격리했고, [growth-loop-contract.test.js](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/tests/growth-loop-contract.test.js)는 실패 전파 규약을 반영했다.

상세 로그: [최종 JS 전체 테스트](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-js-node24-post-chrome-final.log), [Python 전체 테스트](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-python-final.log), [실제 Doctor 결과](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-doctor-final.log).

### 20:46 KST 이후 추가 검증

기존 `publish-resume.sh`가 자식 게시 작업 실패를 기록한 뒤에도 항상 exit 0으로 종료하는 문제를 보완했다. 이제 성공 종료와 결과 파일이 모두 있어야 게시 완료로 처리한다. 이미 업로드 잠금이 있으면 S11을 다시 호출하지 않고 보류 상태를 알린다. 예약 재개 실행 실패, 결과가 없는 거짓 성공, 정상 결과 기록, 잠금 보존을 공백이 포함된 임시 작업 경로에서 검사했다.

기존 전체 테스트 결과는 보존하고, 이 변경에 영향을 받는 43개 테스트와 shell 구문·diff 검사를 다시 통과시켰다. [추가 회귀 검증 로그](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-resume-check.log), [운영 대상 무발행 검사](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-logs/barrotube-resume-live-dry.log).

20:46 KST에 같은 YouTube 영상 ID를 다시 조회했으며 여전히 `processing`, `P0D`였다. 당시 Chrome 직접 경로도 exit 3으로 권한 비활성을 보고했다. 이후 사용자 Chrome이 아닌 별도 브라우저에 연결된 것을 발견했으므로, 이 권한 원인 진단은 정정한다.

## 남은 운영 조건

1. Grok Google 로그인 오류가 해소되고 720p/10s 선택이 유지되는 세션에서 규격에 맞는 한 컷의 생성을 확인해야 한다. Chrome 설정에 대한 사용자 확인은 더 이상 필요하지 않다. 결제 권한까지 위임받은 것으로 해석하지 않는다.
2. 기존 YouTube 영상 `pzq5dlDAMd4`의 처리가 끝났는지 **같은 ID**로 확인한다. 완료·실패의 확정 증거에 따라 로컬 게시 기록을 조정해야 하며, 그 전에는 잠금을 삭제하거나 새 업로드 세션을 만들지 않는다.
3. 독립 Instagram 자동 게시까지 사용할 경우 해당 모드의 자격 증명이 필요하다. 현재 감사는 이를 성공으로 인증하지 않는다.

코드·설정·테스트는 저장소에 반영되어 있고, 전역 스킬 연결을 통해 다음 예약 실행에도 같은 파일이 사용된다. 커밋이나 외부 콘텐츠 게시를 수행하지 않았다.

## 이전 대기 판단 — 20:50 KST (권한 원인 진단 정정)

당시 세 차례 작업 회차에서 권한 비활성 exit 3과 YouTube `processing`/`P0D`를 확인해 목표를 `blocked`로 기록했다. 권한 오류를 사용자 Chrome의 설정 문제로 해석한 부분은 잘못된 연결 대상 때문이었다. 사용자의 위임 후 이 연결 오류를 수정했다.

## 권한 위임 후 추가 결과 — 22:34 KST

Grok은 이미지 첨부만으로도 게시물 경로를 만든다. 기존 제출 함수가 이 경로를 새 영상으로 오인해, 실제 영상 `da4022a5-35b4-4496-8149-19483a260f4b`가 생성됐는데도 이전 스틸 게시물 `5e18b3f8-4217-4169-9baf-41d216f7775f`을 360초 동안 기다렸다. 제출 직전과 다른 게시물 경로를 기다리도록 수정하고 회귀 테스트를 남겼다.

실제 영상은 **추가 생성 없이** 기존 `waitForOwnVideo`와 `fetchVideoToFile` 함수로 다운로드했다. 선택 상태만 믿던 검사도 보완했다. 두 경로 모두 실제 파일의 규격을 검사하며, 이번 400×736/6.04초 파일은 실패로 확인됐다. [진단용 원본](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-14-grok-smoke/generated-6s-not-production.mp4)은 운영 에피소드 폴더 밖에 보관한다.

설정·연결 복구와 파일 검사 보완은 끝났다. 규격에 맞는 Grok 생성은 현재 로그인 오류 및 선택 제한 때문에 확인하지 못했고, YouTube 기존 업로드도 처리 중이다. 전체 목표를 완료로 기록하지 않는다. 예약 작업과 기존 HyperFrames 폴백, 게시 잠금 보호는 유지된다.
