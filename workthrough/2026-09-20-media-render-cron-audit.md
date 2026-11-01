**BarroTube 미디어 렌더 스킬·cron 자동화 상세 점검 — 2026-09-20**

점검 기준: 2026-09-20 22:12~22:29 KST. 저장소 HEAD `c4ac510`과 작업 폴더의 기존 미커밋 변경을 포함한 현재 실행 코드 기준이다.

**판정: 전체 무인 운영은 정상으로 볼 수 없다.** 예약 등록, 기본 실행 환경, 테스트, 수집 루프는 동작한다. 그러나 점심 제작이 시작 전에 차단되고, 지연 업로드가 비공개로 남으며, 일일 doctor가 이 장애를 놓친다. 영상의 파일 무결성 검사와 캐릭터 품질 검사 사이에도 공백이 있다.

이번 작업은 점검과 증거 수집이다. 운영 코드·예약 설정·승인 토큰·기존 영상의 공개 범위는 수정하지 않았다. 게시·재게시·알림 발송·신규 이미지/영상 생성은 실행하지 않았다. `BT_NO_NOTIFY=1`로 진단 및 성장 루프를 실행했으며, 성장 루프는 채널 관측·KPI·성장 지시 파일을 갱신했다. 기존 테스트의 임시 파일과 별도 감사 증거 파일도 생성됐다.

**1. 대상과 점검 범위**

| 항목 | 확인 결과 |
|---|---|
| 요청한 스킬명 | `barro-media-render`라는 별도 설치는 없음. 실제 이름은 `barrotube-media-render` |
| 전역 스킬 연결 | `/Users/beye/.agents/skills/barrotube-media-render` → 저장소 `.claude/skills/barrotube-media-render` |
| 소비자 스킬 연결 | `/Users/beye/.agents/skills/barrotube` → 저장소 `.claude/skills/barrotube` |
| 운영 데이터 | 스킬의 `workspace` → `/Users/beye/BarroTubeData/workspace` |
| 운영 로그 | 스킬의 `logs` → `/Users/beye/BarroTubeData/logs` |
| 스케줄러 | 사용자 crontab 없음. `com.barroskills.barrotube.*` LaunchAgent 12개가 실행 |
| 레거시 중복 실행 | `com.barrotube.*`의 이전 제작·수집 작업은 미로드. 별도 Paperclip ingress 서비스는 대상 파이프라인과 분리 |
| 시스템 등록 | `/Library/LaunchAgents`, `/Library/LaunchDaemons`에서 Barro 이름의 추가 plist 없음 |
| 스킬 참조 | SKILL.md에서 추출한 14개 스크립트/레퍼런스 경로는 소유 스킬 기준으로 존재. 이 중 3개는 소비자 `barrotube` 경로 |

두 실행 모드를 구분했다. 독립 릴은 `script.md → Image/video → FFmpeg → CapCut → 배포 패키지 → Instagram 승인` 흐름이다. 현재 EP cron은 `auto-pipeline.sh → produce-episode.js → QA/승인 → YouTube`를 실행하며, 스틸 엔진 설정은 `codex`, 모션 기본값은 `grok`, 폴백은 로컬 HyperFrames다. cron이 항상 ChatGPT 브라우저→Grok→CapCut 수동 절차 전체를 수행하는 것은 아니다.

**2. 우선순위별 발견 사항**

| 우선순위 | 발견 | 영향 | 판정 근거 |
|---|---|---|---|
| P1 | `omnibus` 슬롯이 실행 입구에서 거부됨 | 금요일을 제외한 점심 회차 제작 불가 | 최근 3회 exit 2, `Invalid slot`; dry-run 재현 |
| P1 | 지연 공개 분기가 `private`를 유지 | 최근 조회 대상 중 5개가 처리 완료 후 비공개 | 메타데이터·승인·YouTube API 일치 |
| P1 | doctor 감시 대상과 판정이 불완전 | 장애가 있어도 exit 0/GREEN | omnibus 미검사, realestate SIGTERM 미탐지 |
| P1 | 캐릭터 품질 검수가 자동 승인과 연결되지 않음 | 형태 변형·화면 이탈 컷이 PASS | EP-0167 3번 컷 프레임 육안 확인 |
| P2 | Grok 사전 점검 성공과 실제 생성 성공이 다름 | 지연·반복 폴백, 제작 품질 저하 | 오늘 생성 360초 timeout, 저녁 5/5 로컬 폴백 |
| P2 | Grok 계정·오디오 검사가 확인 불가 상태를 허용 | 준비 완료 표시의 신뢰도 저하 | 계정 미검출이면 검사 생략, 오디오 버튼 부재도 통과 가능 |
| P2 | 주 21회 예약과 KPI 주 13회 기준이 불일치 | 발행 일관성이 실제 계획 대비 높게 표시됨 | 설치 달력 vs `planned_per_week: 13` |
| P2 | 부동산 작업 중단·미완료 | 금요일 점심 회차 산출 없음 | SIGTERM 15, EP-0163 최종 영상·QA·게시 결과 없음 |
| P2 | 주간 마케팅 0건 수집도 exit 0 | 빈 인텔이 정상처럼 보임 | 9/14 RSS 오류 2건, items 0 |
| P2 | 모션 엔진 기록 누락 | 혼합 산출물 출처 추적 불완전 | EP-0167 클립 5개 중 manifest는 005만 기록 |
| 운영 조건 | 독립 릴 Instagram 토큰 미검출 | 해당 기본 설정으로 R10 게시 준비 미완료 | `.env`·환경·Keychain 존재 검사 |
| 운영 조건 | OAuth 자동 갱신은 사용자 동의에 의존 | 만료 직전 무인 갱신 실패 가능 | 9/17까지 동의 대기 timeout; 현재 토큰 조회는 성공 |

P1은 정상 운영 판정을 막는 항목, P2는 기능·관측·운영 안정성의 결함이다. 운영 조건은 해당 기능을 사용할 때 해결해야 할 전제다.

**3. `omnibus` 실패의 정확한 위치**

`config/routines.json`과 설치 스크립트는 `omnibus`를 지원한다. 하지만 [auto-pipeline.sh:72](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/auto-pipeline.sh:72)의 허용 목록에는 없다.

```bash
case "$SLOT" in ''|us-close|kr-close|realestate) ;; *) echo "Invalid slot" >&2; exit 2 ;; esac
```

등록은 성공해도 제작은 시작할 수 없는 상태다. launchd의 최근 실행 횟수는 3회이며, stderr에 `Invalid slot`이 3회 남아 있다. 실제 생성 없이 다음 명령으로 동일하게 exit 2를 확인했다.

```bash
cd /Users/beye/workspace/BarroSkills/.claude/skills/barrotube
BT_NO_NOTIFY=1 BT_NO_CAFFEINATE=1 DRY_RUN=1 bash lib/auto-pipeline.sh --slot omnibus
```

후속 불일치도 있다. `growth-directives.js:34`와 `competitor-pipeline.sh:63`의 슬롯 목록도 기존 3개뿐이다. 입구 한 줄을 고친 뒤에는 omnibus용 지시 생성과 데이터 소비까지 검증해야 한다. 현재 테스트는 예약 구성의 존재를 검사하지만 실제 omnibus 진입을 잡지 못한다.

**4. 비공개로 남은 영상과 원인**

22:18 KST에 OAuth 채널 일치를 확인한 뒤 `videos.list`로 최근 로컬 게시 기록 16개를 조회했다. 응답은 공개 10개, 비공개 5개, 미반환 1개였다. 미반환 1개는 EP-0159이며 삭제·접근 불가 등 원인은 확정하지 않았다.

아래 5개는 모두 `uploadStatus=processed`, `processingStatus=succeeded`다. 처리 지연 때문에 비공개인 상태가 아니다.

| 에피소드 | 영상 ID | 메타데이터의 지연 시간 | 저장된 의도 | 실제 YouTube 상태 |
|---|---|---:|---|---|
| EP-2026-0157 | `dqOlrm0TcHU` | 2.20시간 | `publish_now` | private |
| EP-2026-0161 | `n3rDwe8P5uE` | 0.28시간 | `publish_now` | private |
| EP-2026-0165 | `_9z2mWpUuBE` | 0.90시간 | `publish_now` | private |
| EP-2026-0166 | `gwnOYGbXggQ` | 1.32시간 | `publish_now` | private |
| EP-2026-0167 | `gGREFMTpDqM` | 1.00시간 | `publish_now` | private |

[generate-metadata.js:431](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/generate-metadata.js:431)은 기본 공개 범위를 private로 정한 뒤, 유예 6시간 이내 분기에서 `publishAt=null`과 `action=publish_now`만 기록한다. `privacyStatus='public'`을 지정하지 않는다. 공통 업로더는 승인된 private 설정을 그대로 준수한다.

EP-0167은 승인 검증도 통과했다. 승인 토큰의 `effective_upload` 자체가 `privacyStatus=private, publishAt=null`이므로, 원인은 승인 이후 변조가 아닌 잘못 만들어진 게시 의도다. 완료 단계는 `publish_left_private` 경고를 남기지만 최종 exit 0을 유지한다. `publish-resume`도 이미 게시 결과가 있는 영상을 복구하지 않는다.

반면 오늘 저녁 EP-0168은 API에서 `public/processed/succeeded`로 확인됐다. 실제 공개 시각은 18:04:39 KST이며 목표 18:00보다 약 4분 39초 늦었다. 로컬 `scheduled/private`는 업로드 요청 당시의 기록이므로 현재 공개 상태를 그대로 나타내지 않는다.

근거: [YouTube 조회 원자료](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/youtube-status.json), [실제 승인 검증](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/approval-verification.json).

수정 시 새 메타데이터 생성 분기에서 공개 범위를 결정하고 승인받아야 한다. 기존 승인된 메타데이터만 바꾸면 해시 검증이 실패하므로, 5개 영상의 후속 처리는 기존 승인·현재 콘텐츠 시의성까지 확인하는 별도 복구 작업이 필요하다. 이번 점검에서는 공개 전환하지 않았다.

**5. LaunchAgent 12개 점검표**

모두 로드돼 있으며, 실제 launchd의 calendar descriptor와 디스크 plist의 예약 값이 일치한다. 관련 plist 12개는 모드 600이다. 모든 시각은 KST다.

| 작업 | 등록된 실행 시각 | 마지막 관측 | 운영 판정 |
|---|---|---|---|
| competitor-scan | 매일 05:20, 15:20 | 9/20 15:20, exit 0 | 수집·분석 산출 확인. 설계상 실패를 exit 0으로 흡수하므로 산출도 확인 필요 |
| growth | 매일 05:40, 15:40 | 9/20 15:40, exit 0 | 실제 재실행도 성공. KPI 계획 기준은 수정 필요 |
| us-close | 매일 06:00 | 9/20 09:30 완료, exit 0 | EP-0167 비공개 잔류 |
| oauth-renew | 매일 06:40 | 9/20 06:40, exit 0 | 현재는 임계 미도달로 갱신 생략. 최근 실제 갱신 성공을 뜻하지 않음 |
| doctor-daily | 매일 07:10 | 9/20 07:24, exit 0 | 현재 장애를 놓침. 수동 재점검도 exit 0 |
| publish-resume | 매일 07:30, 17:30 | 9/20 17:30, exit 0 | 미처리 업로드 잠금 없음. 이미 uploaded/private인 영상은 복구 대상 밖 |
| market-map | 매일 08:00, 20:00 | 9/20 20:00, exit 0 | 같은 9/18 마감 자료 재사용 방지로 스킵. 이 스킵은 정상 동작 |
| weekly-marketing | 월요일 09:00 | 9/14 09:01, exit 0 | RSS 오류 2건·수집 0건 |
| omnibus | 월~목·토·일 10:00 | 9/20 10:00, exit 2 | 3회 연속 시작 전 차단 |
| realestate | 금요일 10:00 | 9/18 11:08까지 로그, SIGTERM 15 | 중단. 종료시킨 주체·이유는 미확정 |
| kr-close | 매일 16:00 | 9/20 18:04 완료, exit 0 | EP-0168 실제 공개, 모션 전부 로컬 폴백 |
| telegram-bot | RunAtLoad, 상시 | PID 16081 실행 중 | 프로세스 생존 확인. 9/20 오전까지 transport 오류 기록; 실제 메시지 왕복은 미시험 |

설정상 제작/공개 목표는 매일 06→08시, 10→12시, 16→18시다. 금요일 10시는 부동산이 omnibus를 대체한다. 따라서 예정 제작은 주 21회다. 정해진 시작 시각끼리의 충돌은 없지만, 긴 작업이 다음 슬롯까지 이어질 때 공유 in-flight 잠금으로 후속 작업이 밀릴 수 있다.

`pmset -g sched`에는 기상 예약이 없었다. 현재 Amphetamine/caffeinate의 절전 방지 assertion은 존재하지만, 미래 예약 시점의 기상이나 덮개 닫힘 상태에서의 실행까지 보증하지 않는다. `oauth-renew`는 다른 작업의 `run-node.sh` 래퍼와 달리 Node v24.11.1의 절대 경로를 직접 사용한다. 현재 경로는 존재하지만 해당 버전 제거 시 별도 갱신이 필요하다.

근거: [예약·실행 상태](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/launchagents.json), [주요 로그 발췌](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/log-excerpts.json).

**6. doctor가 놓치는 항목**

22:17에 `BT_NO_NOTIFY=1 bash lib/doctor-cli.sh`를 실행했으며 결과는 exit 0이었다.

- [doctor-cli.sh:156](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/lib/doctor-cli.sh:156)은 us-close·kr-close·realestate·growth·competitor-scan·publish-resume 6개만 검사한다. omnibus·market-map·oauth-renew·weekly-marketing·telegram-bot의 실행 실패를 이 목록으로는 감지하지 못한다.
- `last exit code`가 숫자로 있는 경우만 실패로 본다. realestate는 `last terminating signal=Terminated: 15`인데 `last exit=not yet observed`와 GREEN으로 출력한다.
- 프로세스 exit 0 뒤에 남은 private 영상, 수집 0건, 최근 실행/산출의 부재는 정상 판정을 막지 않는다.
- Grok의 실제 생성 성공률, 캐릭터 품질, 개별 슬롯의 누락도 검사하지 않는다.
- `PAPERCLIP_DISABLED`는 현재 doctor 환경에서 미설정이라 YELLOW다. active 스크립트의 직접 Paperclip URL 참조 검사는 0건이었다. 이 경고 자체가 오늘 제작 실패의 원인이라는 증거는 없다.

근거: [doctor 실제 결과](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/doctor.log).

**7. 미디어 파일·Grok·품질 점검**

| 검증 | EP-2026-0167 | EP-2026-0168 |
|---|---|---|
| 씬 PNG | 5개, 전체 디코드 성공, 중복 없음 | 5개, 전체 디코드 성공, 중복 없음 |
| 모션 클립 | 5개, 중복 없음 | 5개, 중복 없음 |
| 움직임 수치 검사 | 5/5 통과 | 5/5 통과 |
| 엔진 증거 | 001~004 기록 없음; 규격은 Grok 기준 통과. 005는 HyperFrames | 001~005 모두 HyperFrames |
| 최종 영상 | 62.40초, 37,584,664 bytes | 59.40초, 27,523,520 bytes |
| 최종 스트림 | 1080×1920, H.264, 30fps, AAC 48kHz stereo | 동일 |
| 최종 영상과 QA 해시 | 일치 | 일치 |
| 실제 승인 검증 | 영상·메타·QA·썸네일·채널·공개 설정 검증 통과 | 동일 |
| 전체 FFmpeg 디코드 | 오류 없음 | 오류 없음 |
| 프레임 육안 검사 | 3번 컷 후반 형태 변형·화면 이탈 확인 | 팬·줌 위주이며 캐릭터 동작 변화가 거의 없음 |

오늘 아침 001~004는 720×1264, 약 10.04초, H.264/AAC이며 공통 Grok 파일 규격 검사에 통과했다. 파일 규격만으로 생성 출처를 확정하지 않았다. 두 Grok 생성 스크립트에는 `_engines.json` 기록이 없고, 로컬 생성기만 기록을 남긴다. SKILL.md의 “실제 엔진을 manifest로 확인” 지침을 완전히 충족하지 못한다.

오늘 저녁 AppleScript 경로는 001·002가 각각 360초 안에 준비되지 않아 나머지를 중단했다. 이어서 `produce-episode.js:365`는 전용 Playwright 경로를 재시도했고, 파일 입력 대기 30초 timeout이 반복됐다. 최종적으로 HyperFrames 5컷이 만들어졌다. 파일 생성·게시 성공과 Grok 성공을 구분해야 한다. 서비스측 정체인지 자동화의 완료 판정 문제인지는 로그만으로 확정하지 않았다.

현재 `grok-motion-applescript.js --check`는 exit 0이었다. 다만 계정 이메일은 출력되지 않았다. [signedInAs 검사](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/grok-motion-applescript.js:147)는 이메일을 못 읽으면 null을 돌려주고, `--check`는 이 경우 계정 일치 검사를 생략한다. 오디오 검사 역시 버튼이 존재하면서 OFF일 때만 차단하므로 버튼을 찾지 못한 상태를 확인 완료로 오인할 수 있다. 추가 DOM 상태 조회는 Apple Events timeout으로 완료하지 못했다. 따라서 현재 로그인 계정·오디오 ON·신규 생성 성공을 독립 확인한 것으로 판정하지 않았다.

**품질상 가장 큰 공백은 움직임 확인과 캐릭터 검수 사이에 있다.** [generate-qa-report.js:404](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/scripts/automation/generate-qa-report.js:404)는 스스로 “형태가 뭉개져도 앞뒤가 달라 움직임 검사에 통과한다”고 설명하고, 컨택트 시트를 승인 전에 보도록 한다. 하지만 시트 생성 성공이 곧 QA 체크 성공으로 기록되고, QA PASS는 현재 설정에서 자동 승인으로 이어진다. 실제 시트를 검토했다는 증거를 요구하지 않는다.

EP-0167 컨택트 시트의 세 번째 행 후반에는 캐릭터 머리·몸 주변에 칩 모양의 구조가 생기고, 마지막 프레임에는 캐릭터가 하단 밖으로 사라진다. 이번 육안 검수에서는 재검토가 필요한 컷으로 판정한다. 기존 PASS 보고서를 이번 점검에서 변경하지는 않았다.

근거: [EP-0167 프레임 시트](/Users/beye/BarroTubeData/workspace/episodes/EP-2026-0167/platforms/shorts/60_qa_frames.png), [EP-0168 프레임 시트](/Users/beye/BarroTubeData/workspace/episodes/EP-2026-0168/platforms/shorts/60_qa_frames.png), [미디어 수치 검증](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/media-verification.json), [전체 디코드 검증](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/full-decode.json), [브라우저 검증 범위](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/browser-inspection.json).

**8. 성장 루프·수집·OAuth**

22:21에 알림 없이 실제 채널 수집→KPI→성장 지시 생성을 실행했고 exit 0으로 완료했다. 인덱스 133편 중 132편을 갱신했다. 관측 시각은 `2026-09-20T13:21:52.727Z`, Analytics 최신 날짜는 9/17, `metrics_version=3`이다.

| 최신 재계산 항목 | 값 | 해석 |
|---|---:|---|
| 전체 KPI 등급 | RED | 성과 등급이며 수집 실패를 뜻하지 않음 |
| 발행 일관성 | 62% | 현재 코드의 8/13. 현행 예약 계획과 분모 불일치 |
| 주간 순증 구독 | +6 | 기존 계산기 산출 |
| 주간 조회 성장 | 0.79배 | Analytics 기준 |
| 평균 시청률 | 72.39% | Analytics 기준 |
| 발행당 조회 | +624 | 기존 계산기 산출 |

[growth.json:37](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube/config/growth.json:37)은 주 13편을 기준으로 한다. 현행 주 21회 예약을 같은 주간 분모로 단순 적용하면 8/21=38.1%다. 다만 9/16에 편성 변경이 있었으므로 전환 주간의 정확한 기대 편수는 변경일을 반영해야 한다. 이번 보고서의 38.1%는 새 기준을 전체 7일에 적용한 비교값이며 공식 KPI를 바꾼 값이 아니다.

성장 지시는 us-close·kr-close·realestate 3개만 생성됐고 omnibus는 없다. 수집기와 계산기가 실행되는 것은 확인했지만, 현재 편성 전체를 반영한 성장 루프는 아니다.

주간 마케팅의 마지막 월요일 실행은 9/14이며 RSS 2개가 실패하고 `items:0`인데 exit 0이었다. 과거 누적 stderr를 오늘 새 오류로 세지는 않았다. market-map의 오늘 저녁 스킵도 동일한 마감 자료 중복 방지에 따른 정상 스킵으로 분류했다. 이전 9/18 커뮤니티 게시 오류는 오늘의 신규 실패로 분류하지 않았다.

OAuth는 실제 토큰 발급·채널 조회·영상 상태 조회에 성공했다. 로컬 만료 점검은 발급 후 약 3.55일, 남은 약 3.45일로 표시했다. 이는 스크립트의 testing-mode 가정에 따른 계산이다. 9/20 자동 갱신 작업은 남은 기간이 임계보다 길어 갱신을 수행하지 않았다. 과거 동의 화면 대기 timeout이 반복된 이력이 있으므로 현재 exit 0을 자동 재인증의 성공 증거로 사용할 수 없다.

근거: [성장 루프 실행 로그](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/growth-live.log), [점검 시점 KPI 사본](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/kpi-after.json).

**9. 독립 릴 스킬과 문서 정합성**

표본은 `takitani.lab/barrotube/ep02_reel`이다. 기존 릴의 상태 파일을 덮어쓰지 않고 doctor 함수를 호출해 별도 감사 폴더에 결과를 저장했다.

- ffmpeg·ffprobe·Node·Python·jq 존재, Downloads 임시 쓰기/삭제 검사 통과.
- CapCut 2 설치, `draft_info.json`을 가진 템플릿 후보 112개 확인. 앱을 열어 실제 내보내기를 시험한 결과는 아니다.
- BGM/SFX 각 1개, 스크립트 6컷 파싱, Image/video 폴더 확인.
- 기본 `/Users/beye/youtube-co/.env`·프로세스 환경·Keychain에서 Instagram 토큰을 찾지 못함. 모든 채널의 별도 설정을 전수 조사한 결과는 아니다.
- doctor의 `ok:true`는 error 항목이 없다는 뜻이다. Instagram 토큰 경고와 브라우저 수동 확인 항목이 남아 있어도 true가 된다.
- `reel_autopilot.py`는 설계상 브라우저 작업·CapCut 내보내기·Instagram 최종 게시에서 외부 작업/승인을 요구한다. 스킬 설치만으로 독립 릴 전체가 cron에서 무인 완결되는 구조는 아니다.

문서에는 현재 설정과 다른 설명이 남아 있다. SKILL.md 일부는 ChatGPT 브라우저 이미지 5장과 5씬 고정 조건을 설명하지만 현재 스틸 설정은 codex이고 realestate는 7씬이다. `media_assets_ready()`도 001~005만 검사한다. 후속 `produce-episode.js`는 대본의 실제 씬을 사용하므로 최종 7씬 검사가 전부 빠진다고 단정할 수는 없지만, 초기 브라우저 게이트가 6·7번 컷 준비를 대표하지 못한다. 루틴 주석에는 평일 kr-close·토요일 부동산 공개 같은 이전 편성도 남아 있다.

근거: [독립 릴 preflight](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/standalone-preflight.json), [스킬 정본](/Users/beye/workspace/BarroSkills/.claude/skills/barrotube-media-render/SKILL.md).

**10. 실행한 검증과 한계**

| 검증 | 결과 |
|---|---|
| launchd용 Node v24.11.1로 `node --test tests/*.test.js` | 460 passed, 0 failed, 0 skipped |
| Python 3.14.6 `python3 -m unittest discover -s tests -v` | 40 passed |
| `lib/*.sh` 10개 `bash -n` | 전부 통과 |
| `git diff --check` | 통과 |
| `npm ls --depth=0` | 선언 의존성 설치 확인. `@emnapi/runtime` extraneous 1개, 현재 장애 원인 증거 없음 |
| Grok `--check` | exit 0; 계정 미확인·생성 미시험 조건 포함 |
| 로컬 HyperFrames `--doctor` | exit 0, HyperFrames·GSAP·FFmpeg·Chrome 확인 |
| 실제 doctor | exit 0; 운영 장애 미탐지 재현 |
| omnibus dry-run | exit 2, Invalid slot 재현 |
| 실제 성장 루프 | exit 0, 수집→KPI→3개 지시 갱신 |
| YouTube 읽기 전용 조회 | 채널 일치 확인, 게시 기록 16개 대조 |
| 최근 영상 2편 | 파일 해시·승인 검증·디코드·클립 움직임 검사 완료 |
| 비밀 파일 권한 | 스킬 `.env` 및 백업 3개, 관련 plist 12개 모드 600 |
| 미처리 게시 잠금 | `80_publish_result.json.lock` 미관측, in-flight 잠금 없음 |

첫 Node 테스트 실행에는 외부 알림 억제를 위해 `BT_NO_NOTIFY=1`을 추가했는데, Telegram 거부 응답을 검증하는 mock 테스트 하나의 전제까지 비활성화해 1건 실패했다. 표준 환경으로 다시 실행한 460개는 모두 통과했다. 두 로그를 보존했으며, 이 최초 실패를 제품 회귀로 세지 않았다.

현재 터미널의 일부 작업 디렉터리는 Node v22.15.0을 선택하지만, 설치된 LaunchAgent PATH는 v24.11.1을 가리킨다. 전체 Node 테스트는 v24.11.1 절대 경로로 실행했다. 두 버전 모두 package.json의 Node ≥20 조건을 충족한다.

실제 게시/공개 전환, 새 Grok 생성, Instagram 게시, CapCut 내보내기, Telegram 왕복 명령은 이번 점검에서 실행하지 않았다. 따라서 해당 외부 동작 전체의 end-to-end 성공을 선언하지 않는다. 현재 프레임 품질 판정은 두 편의 컨택트 시트와 파일 검사 범위이며 전체 과거 영상의 품질 보증은 아니다.

테스트가 모두 통과해도 이번에 발견한 실제 슬롯 실행·공개 의도·캐릭터 품질·관측 누락은 남아 있다.

**11. 수정 시 권장 순서와 완료 조건**

1. **omnibus 실행 입구와 슬롯 목록을 정합화.** 모든 설정 슬롯이 dry-run에서 입구를 통과하고, 해당 슬롯의 수집/성장 지시를 받을 수 있어야 한다.
2. **지연 공개 의도를 메타데이터 생성 단계에서 정확히 설정.** 유예 이내 public, 유예 초과 private, 미래 시각 private+publishAt을 승인 전 검증한다. 기존 5개 영상은 시의성과 승인 범위를 확인해 별도로 복구한다.
3. **doctor에 실제 결과 검사를 연결.** 등록된 작업 누락, SIGTERM, 실행/산출 신선도, 비공개 잔류, 필수 수집 0건을 구분하고 실패를 종료 코드로 전달한다.
4. **Grok 품질 수락 증거를 자동 승인 앞에 연결.** 계정·오디오·첨부·다운로드·컷별 엔진 기록을 확인하고, 프레임 시트 생성과 캐릭터 검수 완료를 구분한다. EP-0167 3번 컷은 우선 재검토 대상이다.
5. **편성·KPI·문서를 한 기준으로 맞춤.** 주 21회 편성과 변경일을 반영하고, 7씬/omnibus 경로·원래의 독립 릴 승인 경계를 명확히 한다.
6. **부동산·RSS·갱신 경로 재검증.** EP-0163의 중단 원인과 오래된 근거를 정리하고, 다음 예약 실행의 최종 산출 및 OAuth 실제 갱신 결과를 확인한다.

정상 판정의 완료 기준은 테스트 통과에 더해 실제 예약 3개 슬롯의 실행·품질 검수·최종 공개 상태가 일치하고, 의도적 스킵과 장애가 doctor에서 구분되는 것이다.

전체 증거 폴더: [2026-09-20-media-cron](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron). 테스트 원문: [Node](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/node-tests-standard.log), [Python](/Users/beye/BarroTubeData/workspace/growth/audit/2026-09-20-media-cron/python-tests.log).
