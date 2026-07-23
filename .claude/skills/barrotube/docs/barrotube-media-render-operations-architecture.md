---
title: BarroTube Media Render 운영 아키텍처 결정
status: accepted
date: 2026-07-23
revision: 2
revised: 2026-07-23
owner: BarroTube
canonical: true
---

# BarroTube Media Render 운영 아키텍처 결정

> 이 문서는 운영 구조를 결정하기 위한 ADR이자 구현 계획이다. 문서 승인만으로 코드 변경,
> Paperclip 재활성화, 브라우저 권한 확대 또는 외부 발행을 승인하지 않는다.

## 개정 이력

- **rev 1** (codex sol, 2026-07-23, proposed): 최초 제안.
- **rev 2** (Claude, 2026-07-23, accepted): rev 1의 주장 39건을 코드·디스크·실시간 실행과
  교차 검증(REFUTED 0, CONFIRMED 36, PARTIAL 3)한 결과와 운영자 확정 결정 4건을 반영.
  주요 변경: ① "기존 Grok CDP 구현 재사용" 전제 삭제(실물 부재 — 유일한 사실 오류)
  ② 결함 3건 추가(라인 인용) ③ 범위에 barrotube EP 경로(S6c/S6d)와 stage 매핑 명시
  ④ worker 오류 분류·실전 제약(EP-2026-0068 실측) 확장 ⑤ 롤백 절 신설 ⑥ 종료 코드
  계약 수치 확정 ⑦ 구현 순서를 3개 스프린트로 분리 ⑧ 플러그인 채택 근거 정정
  (drift 축소 → Codex/Claude 이중 호스트 단일 배포).

## 요약

**기존 `barrotube-media-render`를 로컬 실행 원장으로 유지하면서 Claude/Codex용
풀 플러그인으로 패키징**한다(운영자 결정, rev 2). 플러그인의 1차 목적은 **Codex CLI와
Claude Code 두 호스트에 같은 스킬 정본을 배포**하는 것이다 — 현행 심볼릭 링크 배포는
divergence 0으로 실측되어 "버전 drift 축소"는 채택 근거가 아니다.

Paperclip × Harness는 지금 렌더 실행기에 넣지 않는다. 로컬 파일럿이 안전·복구 게이트를
통과한 뒤 목표, 일정, backlog, 비용, research/script/QA를 담당하는 **비동기 관제층**으로
제한해 연결한다. 로그인된 Chrome, 다운로드 폴더, macOS clipboard/TCC, CapCut과
YouTube/Instagram OAuth는 로컬 실행기 밖으로 내보내지 않는다. 공개 발행은 계속
사람의 명시적 승인(HITL)을 요구한다.

## 결정

1. 로컬 `render-job.json`을 미디어 제작 상태의 단일 진실 원천(SSOT)으로 유지한다.
2. 플러그인은 기존 스킬을 재작성하지 않고 설치, 버전 고정, 호스트별 발견과 실행 진입점만
   제공한다.
3. 플러그인 안에 별도 DB, durable queue, cron, 대시보드를 만들지 않는다.
4. Paperclip 장애가 진행 중인 EP 제작을 멈추지 못하도록 production critical path에서
   분리한다.
5. Paperclip/Harness에는 브라우저 쿠키, OAuth, 운영 홈 mount, 임의 shell 실행 권한을
   제공하지 않는다.
6. 영상과 메타데이터 해시에 결속된 로컬 승인 없이는 발행할 수 없게 한다.

**운영자 확정 결정 (2026-07-23, rev 2 추가):**

7. 플러그인 형태는 **풀 플러그인** — `.claude-plugin/plugin.json`과
   `.codex-plugin/plugin.json`을 한 트리에 동시 탑재하고 각 호스트의 설치 cache로 배포한다.
   설치 시 기존 standalone 스킬(심볼릭 링크)을 제거해 이중 노출을 막는다.
8. 범위는 **두 소비 모드 모두**다: Standalone 릴 파이프라인(R0~R11, 오늘묘·takitani)과
   barrotube EP 모드(econ-daily, S6c/S6d). worker 계약에 stage 매핑을 정의한다.
9. browser worker는 **계약 표준화 먼저** — 조작 주체는 당분간 대화형(Claude-in-Chrome)을
   유지하고, 결과 계약·오류 분류·검증·다운로드 회수만 코드화한다. 무인 worker는 이 계약
   위에서 별도 결정한다.
10. 집행은 3개 스프린트로 분리한다: Sprint 1 = 실행 코어 안정화 + 발행 HITL(코드는 codex),
    Sprint 2 = worker 계약 표준화, Sprint 3 = 풀 플러그인. 뒤 스프린트는 앞 스프린트의
    산출물 검수 후 착수한다.

## 현재 상태와 근거

### Media Render: 운영자 감독형 베타

[`barrotube-media-render`](../../barrotube-media-render/SKILL.md)는 실제 이미지, 영상,
FFmpeg master, CapCut export와 발행 패키지를 만든 경험이 있는 실행 가능한 스킬이다.
관련 운영 폴더에서 실제 미디어 산출물과 완주한 job이 확인되어 개념 검증 단계는 지났다.

| 영역 | 현재 평가 | 근거 |
| --- | ---: | --- |
| 결정론 렌더 코어 | 7/10 | 상태머신, FFmpeg, 기술 QA가 실제 산출물로 검증됨 |
| 중단 후 재개 | 6/10 | 파일 기반 재개는 되지만 lock과 입력 변경 감지가 부족함 |
| 기술 QA | 7/10 | 해상도, 길이, 코덱, 중복, 오디오 검사 |
| 콘텐츠 QA | 2/10 | 캐릭터, 장면 정합, 자막, 오타, 모션 글리치 자동 검증 부족 |
| 무인 브라우저 | 2/10 | 실제 worker 대신 대화형 Chrome 세션 위임 |
| 다중 채널 | 3/10 | Instagram과 일부 채널 포맷이 하드코딩됨 |
| 종합 | 5/10 | 견실한 SOP와 로컬 백본이지만 완전한 채널 런타임은 아님 |

현재 구현의 강점 (rev 2 검증에서 전부 CONFIRMED):

- [`render_reel_job.py`](../../barrotube-media-render/scripts/render_reel_job.py)는
  R0~R11 상태와 컷별 진행을 `render-job.json`에 저장하고 디스크 산출물을 기준으로
  재개한다. **render-job.json 직접 I/O는 이 파일의 load()(~120행)/save()(~155행) 두
  지점뿐이고 save()는 이미 tmp+replace 원자적** — 마이그레이션·해시·lock·CAS를 이 두
  지점에 넣으면 autopilot 등 전 호출자가 자동 커버된다.
- [`qa_reel_media.py`](../../barrotube-media-render/scripts/qa_reel_media.py)는 PNG,
  portrait, MD5 중복, ffprobe, black/volume/contact sheet를 검사한다.
- [`render_master_mix.py`](../../barrotube-media-render/scripts/render_master_mix.py)는
  clip 순서, 길이, transition, BGM/SFX/ambient와 master manifest를 처리한다.
- [`reel_autopilot.py`](../../barrotube-media-render/scripts/reel_autopilot.py)는
  결정론 단계를 진행하고 브라우저, GUI, 발행 게이트에서 명시적으로 멈춘다.

운영 전 해결할 결함 (rev 2: 검증 라인 인용 추가, 7~9는 신규 발견):

1. doctor가 실패해도 autopilot이 진행하며(reel_autopilot.py:245-254 — 결과를 로그에만
   기록), blocked/fatal도 프로세스 종료 코드 0이 된다(main():441 무조건 return 0,
   docstring "Exit code 0 always"). doctor 자체의 종료 코드 계약(0/1)은 건전하다.
2. `production-timing.md` 존재만으로 R11이 실제 postmortem보다 먼저 완료될 수 있다
   (render_reel_job.py:230-231, sync():265-268). `production_timer.py`는 init 포함 모든
   명령에서 이 파일을 재생성하므로(save():85-89) timer를 켜는 순간 조건이 성립한다.
3. 완료 증거가 파일 존재 중심이라 입력 교체, 손상 산출물, 오래된 QA를 놓칠 수 있다
   (evidence():185-232 — 해시·mtime·입력 대조 없음). 실물 ep01에서 HITL 단계인
   R10(발행)조차 attempts=0, started_at=null로 소급 completed된 사례가 확인됐다.
4. stage 선행조건과 QA/HITL skip이 코드로 강제되지 않는다(cmd_start/cmd_end/cmd_skip
   모두 선행·gate·hitl 미검사, skip은 note 한 줄로 통과).
5. reel 단위 lock과 revision/CAS가 없어 동시 실행 시 상태 덮어쓰기 위험이 있다.
6. 계획된 ChatGPT/Grok browser worker가 아직 없다.
   [자동화 계획](../../../../docs/20-Operations/barrotube-media-render-automation-plan.md)
7. **(rev 2 신규)** sync():249-257이 script.md 존재만으로 R0와 **R0.5(팩트체크,
   gate=True)를 자동 completed** 처리한다 — 팩트체크 게이트가 파일 존재로 우회된다.
8. **(rev 2 신규)** sync():279-290이 스틸 전멸+클립 전량 존재 시 R3 이미지 QA gate를
   승인 기록 없이 자동 skipped 처리한다(비용 방어 의도는 유지하되 승인 기록 필요).
9. **(rev 2 신규)** production_timer.py와 reel_autopilot.py do_postmortem이 같은
   `production-timing.md`를 서로 다른 포맷으로 덮어쓸 수 있다 — 파일 분리 필요.
10. 현재 BarroBench 자료는 기능 회귀보다 스킬 호출 trigger 평가에 가깝다.

> **rev 2 정정**: rev 1의 "기존 Grok CDP 구현은 검증된 흐름만 재사용" 전제는 삭제한다.
> 스킬 전체·BarroSkills 저장소·인접 프로젝트(~/BarroTubeData, ~/BarroAiFactory,
> ~/workspace) 전수 검색에서 CDP/Playwright 구현 코드는 0건이다. 존재하는 것은
> references/ 문서의 수동 절차 SOP와 예제 스니펫(사용자 홈 절대경로 하드코딩 포함)뿐이다.
> 무인 worker는 제로베이스 신규 개발로 재산정한다(예상 작업량 절 참조).

읽기 전용 운영 inventory(rev 2 재검증에서 수치 4건 전부 재현)에서는 script가 있는 reel
12개(오늘묘 today.myo 6 + takitani.lab 6) 중 render job 7개, 이미지·영상·최종 QA 세 종류가
모두 있는 reel 5개, timing JSON이 있는 reel 4개가 확인됐다. 일부 EP는 모든 stage를
완료했지만 EP05/EP06처럼 브라우저 생성 단계(R2, 각 7컷)에서 대기 중인 backlog도 있다.

### Paperclip × Hermes: 현재 채널 실행기 NO-GO

2026-07-23 KST에 [Paperclip × Hermes 파일럿](../../../../../paperclip-hermes-pilot/README.md)을
읽기 전용으로 점검한 결과 (rev 2 재검증에서 전부 재현):

- 전체 상태는 `STALE`, current phase는 0이다(자동 점검은 PASS, 수동 승인 증거 3건 만료).
- Paperclip `127.0.0.1:3102` health는 정상(`/api/health`)이지만 Hermes `8642` execution
  plane은 TCP 연결은 수락하되 HTTP 응답이 비어 있다(empty reply).
- Docker runtime, egress proxy, relay 인증과 live Hermes 검사가 완료 상태가 아니다.
- Phase 3 synthetic ticket 실적과 Phase 4 BarroTube handoff 실적이 없다.
- 현재 확인된 자동 heartbeat는 Hermes worker의 미디어 실행이 아니라 제한된
  `codex_local` CEO의 backlog 생성이다.
- Phase 4 계약은 research, script, QA 파일만 허용하고 browser session, OAuth, publish와
  production write를 금지한다.
  [Phase 4 설계](../../../../../paperclip-hermes-pilot/docs/phase4-handoff-design.md)

Paperclip 자체는 heartbeat, goal, routine, cost hard stop, approval, audit에 적합하다.
공식 최신 릴리스는 self-healing runs와 activity-gated routines를 강화했다. 그러나 로컬
파일럿은 별도 버전에 고정되어 있고 runtime 변경 시 안전 증빙을 다시 승인해야 한다.
Chrome 쿠키와 OAuth를 Hermes에 주는 방법은 현재 격리 설계의 핵심을 무효화한다.

## 선택지 비교

아래 점수는 현재 목표인 "한 대의 Mac에서 로컬 브라우저 렌더 + 공개 발행 HITL"에 대한
5점 정성 평가다.

| 선택 | 현재 준비도 | 브라우저 적합성 | 내구성·관제 | 보안 경계 | 유지 용이성 | 종합 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Paperclip/Hermes가 직접 렌더 | 1 | 1 | 5 | 2 | 1 | 2.3 |
| 플러그인이 큐·스케줄러까지 독자 구현 | 3 | 5 | 2 | 4 | 2 | 3.4 |
| 얇은 플러그인 실행기 + 추후 Paperclip 관제 | 4 | 5 | 4 | 5 | 4 | **4.5** |

> **rev 2 보완**: 위 표에는 널 옵션 **D. 현상 유지(symlink 배포) + 실행 코어 안정화만**이
> 빠져 있었다. 단일 Mac·단일 운영자 기준으로 D는 C와 대등하거나 우세하다(현행 symlink
> 배포는 repo 정본 직결로 divergence 실측 0, 즉시 반영 유지). 그러나 D는 **Codex CLI
> 배포가 불가능**하다. 운영자가 Codex 동시 지원을 확정(결정 7)함에 따라 C를 풀 플러그인
> 형태로 채택하되, 채택 근거를 "설치·버전 drift 축소"에서 **"Codex/Claude 이중 호스트
> 단일 배포"**로 정정한다. 또한 symlink는 플러그인 cache 복사에서 보안상 skip되므로 두
> 배포 방식은 병행할 수 없다 — 플러그인 전환 시 standalone symlink를 제거한다(Sprint 3).

### A. Paperclip/Hermes 직접 실행

장점은 durable issue, heartbeat, budget, approval과 중앙 감사다. 하지만 현재 로컬
execution plane이 준비되지 않았고 브라우저 세션을 연결하려면 host home, 쿠키, clipboard,
Downloads, OAuth 경계를 새로 열어야 한다. 과거 Paperclip 의존 자동화가 운영에서 분리된
이유도 재도입 비용에 포함해야 한다.

**판정: 현재 도입하지 않는다.**

### B. 독립적인 풀 플러그인 (큐 런타임 포함)

로컬 브라우저와 앱에는 가장 가깝지만 플러그인이 durable queue, lease, scheduler, retry,
dead-letter, audit와 dashboard를 다시 만들면 Paperclip과 중복되는 별도 운영 제품이 된다.
Claude/Codex 플러그인은 skills, commands, hooks, MCP와 assets의 배포 단위이지 그 자체가
24시간 실행되는 queue runtime은 아니다.

**판정: 플러그인을 운영 플랫폼으로 확장하지 않는다.**

### C. 얇은 플러그인 + 비동기 관제

현재의 파일 상태머신과 브라우저 접근을 보존하면서 Codex/Claude 두 호스트에 단일 정본을
배포한다. Paperclip은 검증 완료 후 credential-free handoff와 best-effort status mirror만
담당한다.

**판정: 채택한다 (풀 플러그인 형태, Sprint 3).**

## 목표 아키텍처

```text
┌────────────────────────────────────────────────────────────┐
│ Paperclip × Harness — optional control plane               │
│ goals · schedule · backlog · research/script/QA · budget   │
│ (현재 비활성 — §5 게이트 통과 전까지 존재하지 않는 층)      │
└──────────────────────────┬─────────────────────────────────┘
                           │ credential-free, hash manifest
                           │ no shell / cookie / OAuth
                           ▼
┌────────────────────────────────────────────────────────────┐
│ Claude/Codex full plugin — local execution plane           │
│ barrotube-media-render skill · render-job SSOT · QA        │
├────────────────────────────────────────────────────────────┤
│ Logged-in Chrome · Downloads · FFmpeg · CapCut             │
└──────────────────────────┬─────────────────────────────────┘
                           │ video/meta hashes
                           ▼
                 Human approval (HITL)
                           │
                           ▼
                 YouTube / Instagram publish
```

### 책임과 신뢰 경계

| 구성요소 | 책임 | 금지 |
| --- | --- | --- |
| Paperclip | 목표, backlog, 일정, 비용, research/script/QA, 알림 | Chrome/OAuth 접근, 임의 shell, 직접 발행 |
| Harness agent | 격리된 지식 작업과 정형 handoff | 운영 workspace 직접 변경, browser worker 역할 |
| 로컬 플러그인 | 스킬 배포, job 상태, 렌더 진입, 기술 QA | 자체 queue/DB/scheduler 재구축 |
| 브라우저 worker | 한 컷 생성, 상태 검증, 다운로드, 검증 | 로그인 대행, 결제, captcha 우회 |
| Publisher | 승인된 영상과 메타 발행, 결과 저장 | 해시가 달라진 승인 재사용 |
| 운영자 | 콘텐츠 검수, 계정 복구, 공개 발행 승인 | 승인 파일을 일반 자동화에 위임 |

### 두 파이프라인과 stage 매핑 (rev 2 신설)

이 스킬은 두 소비 모드를 가진다 (media-render SKILL.md "두 소비 모드"와 정합):

1. **Standalone 릴 모드** — R0~R11 상태머신, `render-job.json` SSOT.
   대상: 오늘묘(today.myo)·takitani.lab 릴.
2. **barrotube EP 모드** — econ-daily EP(S0~S12)의 S6c/S6d 단계가 같은 브라우저 절차를
   소비하되 산출 경로는 EP 규약을 따른다. `produce-episode.js`는 media-render 산출물
   부재 시 **exit 3**으로 hard-block하므로, 본 문서의 종료 코드·게이트 변경은 EP
   파이프라인에도 파급된다.

worker 결과 계약의 stage 매핑:

| worker 작업 단위 | 릴 모드 | EP 모드 (산출 경로) |
| --- | --- | --- |
| ChatGPT 이미지 1컷 | R2 | S6c (`40_assets/images/scene_NNN.png`) |
| Grok 영상 1컷 (image→video) | R4 | S6c-모션 (`40_assets/videos/scene_NNN.mp4`) |
| 인트로 카드 | — | S6d (`45_intro.png` — 템플릿 아님, 매 EP 신규) |
| 아웃트로 카드 | — | `48_outro.png` — 고정 템플릿 + **프로그램 합성**(생성 금지) |

EP 모드 특유 제약 (rev 2 명시):

- 이미지 생성 전 **채널 캐릭터 시트를 매번 첨부**한다(클립보드 «class PNGf» 경유 —
  file_upload는 호스트 경로를 거부).
- **텍스트가 실리는 컷(아웃트로 등)은 AI 생성 대신 프로그램 합성**(NotoSansKR 폰트,
  make_outro.py 방식)이 원칙이다 — AI 한글 렌더 오타 실사례(좋아요→좀아요, 메타→머타).
- 캐릭터 품질 판정 기준은 문서 서술이 아니라 **정본 시트 이미지**다.

## 구현 순서 (rev 2: 3개 스프린트로 분리)

각 스프린트는 앞 스프린트 산출물 검수 후 착수한다. Sprint 1의 코드 구현은 codex가
담당한다(별도 구현 지시 프롬프트로 전달, 본 문서가 스펙 정본).

### Sprint 1 — 실행 코어 안정화 + 발행 HITL

**1-1. 종료 코드·출력 계약** (render_reel_job CLI와 reel_autopilot 공통):

- `0` completed / `2` usage·config fatal(승인 없는 gate skip 포함) / `3` blocked
  (브라우저·GUI·HITL 핸드오프 — barrotube produce-episode의 exit 3 관례와 정렬) /
  `4` recoverable failure(lock·CAS 충돌 포함) / `5` fatal(doctor 실패 포함).
- stdout 마지막 줄에 `{"status": ..., "stage": ..., "reason": ...}` JSON을 병행 출력한다.

**1-2. 게이트·상태 강제:**

- doctor 실패 시 상태 전이 0건 + exit 5.
- gate=True·hitl=True stage는 sync 자동 승격 금지(결함 7·8의 자동 경로 포함 제거).
  end/skip에는 `--approve "<by>: <사유>"` 필수 → `approvals[]`에 {by, at, note} 기록.
- R11은 `90_timing/postmortem.md`(신규 별도 파일) + 명시적 end 명령으로만 완료한다.
  production-timing.md는 timer 전용으로 분리(결함 9 해소).
- stage 선행조건을 강제한다(선행 미완료 시 start 거부).

**1-3. 상태 파일 v2 (`barrotube.render_job.v2`):**

- Python 표준 `fcntl.flock`으로 reel 단위 lock(`render-job.json.lock`), 획득 실패 exit 4.
  (rev 1의 "브라우저 계정별 전역 lock"은 worker 부재로 Sprint 2로 이월)
- `revision` 정수 필드로 CAS: load 시 기억, save 시 재확인 후 +1, 불일치면 exit 4.
- stage/cut별 입력 SHA-256과 출력 `{path, sha256, bytes, ffprobe{duration,codec,w,h}}` 기록.
- 입력 해시가 바뀌면 해당 지점 이후 완료와 QA를 무효화(pending 강등 + QA stale 마킹).
  단 **v1 소급 금지** — 기존 릴 6개의 completed 이력은 강등하지 않는다.
- cut별 attempts와 error history를 누적한다.
- v1 job은 읽되 첫 변경 때 원자적으로 v2로 이동하고 `render-job.v1.bak.json` 백업을
  남긴다. 복원 절차는 롤백 절 참조.
- 한 줄/여러 줄 `Grok 모션` 포맷을 parser fixture로 고정한다(reel_render_plan.py:73의
  한 줄 전용 정규식을 라벨 뒤 연속 비어있지 않은 줄 블록까지 확장).

**1-4. 발행 HITL (`publish_gate.py` 신규, 릴 R10과 추후 EP S11 공용):**

- `approve`: interactive TTY 필수(비TTY exit 2). 최종 영상 SHA-256, 메타 SHA-256, 채널,
  승인자, 승인·만료 시각(`--ttl` 기본 24h)을 `30_approval.json`에 기록.
- `verify`: 발행 직전 같은 해시를 재계산해 재검증. 승인 뒤 영상·메타가 바뀌면 승인 폐기.
  판정은 항상 해시 재계산으로만 한다 — approval 파일 내 self-claim을 신뢰하지 않는다
  (agent가 작성 가능한 일반 파일만으로 publish 권한이 생기지 않게).
- 동일 (채널, 영상 해시, caption 해시) 조합의 중복 발행을 `90_publish_ledger.json`으로
  차단한다.
- render_reel_job의 R10 end는 유효한 approval 없이는 거부된다.
- OAuth는 로컬 publisher 프로세스에만 주입한다.

### Sprint 2 — foreground browser worker: 계약 표준화

조작 주체는 당분간 **대화형(Claude-in-Chrome) 유지**(결정 9). 이 스프린트의 코드화
범위는 결과 계약·오류 분류·검증·회수다. 무인 worker(Playwright)는 이 계약 위에서 별도
결정하며, 재사용할 기존 CDP 구현은 없으므로(rev 2 정정) 신규 개발 기준으로 재산정한다.

- ChatGPT 이미지와 Grok 영상을 각각 한 번에 한 컷만 처리한다.
- 로그인, captcha, multi-download block은 `blocked`로 반환한다.
- quota/paywall은 `quota_or_paywall`로 반환하고 구매를 시도하지 않는다.
- **오류 분류 확장 (rev 2, EP-2026-0068 실측 반영):** `connection_lost`(브라우저 확장
  단절 — 실측 세션당 수 회, 재시도 가능), `tls_block`(네트워크 레벨 차단 — 실측 1회,
  네트워크 교체 필요), `tcc_denied`(macOS TCC 권한 거부), `option_drift`, `timeout`.
- 720p/10s/9:16 상태를 읽어 필요한 값만 변경하고 다시 확인한다(EP-0068에서 검증된 방식).
- **다운로드 회수 경로 표준화 (rev 2):** macOS TCC가 ~/Downloads readdir을 차단하는
  환경을 기본 가정한다 — Chrome History(`target_path`) 조회 + osascript 복제 경로를
  표준 회수 절차로 코드화한다.
- **컷-파일 결속 검증 (rev 2):** 대화 내 이미지가 전부 동일 크기(941×1672)라 정렬·크기
  기반 식별은 금지한다(EP-0068 오배치 실사례). 다운로드 직후 md5를 계산해 기존 산출물과
  대조하고, artifacts에 결속 증거(요청↔다운로드 연결 기록)를 남긴다.
- **클립보드 전역 lock (rev 2):** 클립보드 첨부(«class PNGf»)는 머신 전역 공유 자원이다
  — 첨부 구간에 계정 lock과 별개의 전역 lock을 둔다.
- 생성 전후 asset identity와 SHA-256으로 이전 결과 중복 다운로드를 막는다.
- PNG signature 또는 ffprobe 통과 후에만 stage를 완료한다.
- references/ 스니펫의 사용자 홈 절대경로는 제거한다(플러그인 상대경로 요구).
- CapCut은 foreground GUI 단계로 유지한다. FFmpeg 결과가 충분한 형식에서는 CapCut을
  필수 단계로 강제하지 않는다.

worker 결과 계약:

```json
{
  "job_id": "channel/episode 또는 econ-daily/EP-YYYY-NNNN",
  "stage": "R2 | R4 | S6c | S6c-motion | S6d",
  "cut": 1,
  "status": "completed|blocked|failed",
  "error_type": null,
  "recoverable": false,
  "artifacts": [
    {
      "path": "Image/ep-cut1.png",
      "sha256": "...",
      "binding": "요청↔다운로드 연결 증거 (메시지 식별자 또는 다운로드 직후 md5 대조 기록)"
    }
  ],
  "next_action": null
}
```

### Sprint 3 — 풀 Claude/Codex 플러그인

```text
barrotube-media-render-plugin/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── skills/barrotube-media-render/
│   ├── SKILL.md
│   ├── scripts/
│   ├── references/
│   └── tools/
└── assets/
```

v1 포함:

- 기존 스킬, scripts, references와 tools의 단일 정본
- Claude/Codex manifest와 설치 메타데이터
- 설치 cache에서도 동작하는 plugin-root 상대경로
- doctor, status, 안전한 run-until-gate
- 신규 세션 discovery, 설치 버전 표시, update smoke test

v1 제외:

- 별도 agent 조직
- SessionStart 자동 hook
- 신규 MCP 서버와 custom UI
- 자체 queue, DB, cron
- 자동 발행

**rev 2 추가 요구 (검증 발견):**

- 설치 시 기존 standalone 스킬(symlink)을 제거한다 — 플러그인 스킬은
  `/plugin-name:skill-name` 네임스페이스로 노출되며, 기존 스킬을 남기면 이중 노출로
  트리거가 경합한다.
- 플러그인 트리 안에 symlink를 두지 않는다 — cache 복사 시 보안상 skip된다.
- 상태·산출물·lock은 플러그인 트리 밖(데이터 디렉토리)에 둔다 — plugin root 경로는
  업데이트마다 바뀐다.
- 이 머신의 `~/.claude/skills`는 TCC 보호 경로(Desktop)로의 symlink다 — 설치·검증
  스크립트가 이 경로에서 실패할 수 있으므로 설치 smoke test에 포함한다.
- 롤백: 플러그인 제거 + symlink 복원 절차를 문서화하고 스크립트로 제공한다.

### Paperclip의 제한적 재도입 (스프린트 아님 — 조건부 미래 결정)

[`PAPERCLIP_DISABLED=1`](../SKILL.md)은 아래 게이트가 모두 통과할 때까지 유지한다.

- Phase 0~2가 현재 runtime 기준 `COMPLETE`
- Phase 3 synthetic ticket 10건과 recovery 검증 통과
- Phase 4 research/script/QA handoff 3회 통과
- Hermes health, Docker, egress와 relay 검사가 연속 정상 — **rev 2 기준 확정:**
  pilotctl 증거 유효기간 체계에 따라 **STALE 없이 연속 168h(7일) PASS**
- company/agent 비용 hard stop과 concurrency 1 검증 — **rev 2 기준 확정:** Paperclip
  budget 한도 초과 시 실행 중단이 Phase 3 synthetic ticket에서 실증될 것
- browser cookie, OAuth, 운영 홈 mount 0건

재도입 후에도 Paperclip 입력은 EP ID와 고정 action enum만 허용한다. arbitrary command,
임의 경로와 browser/publish/OAuth action은 거부한다. 상태 회신은 best-effort mirror로
처리하여 Paperclip 장애가 로컬 job을 막지 않게 한다.

**rev 2 재차단 트리거:** 재도입 후 다음 중 1건이라도 발생하면 즉시 `PAPERCLIP_DISABLED=1`
재설정 — 허용 외 action 시도, 비용 한도 초과, 상태 미러 오류 반복. 재도입은 게이트
재통과를 요구한다.

## 테스트 계획

### 자동 테스트

- doctor 실패 시 state 불변과 비정상 종료(exit 5)
- 종료 코드 5종(0/2/3/4/5) 각각의 재현
- 선행 stage 완료 전 다음 stage 시작 거부
- R10 전 R11 완료 거부, production-timing.md 존재만으로 R11 완료 불가
- 승인 없는 QA/HITL skip 거부 (rev 2: R0.5 자동 승격 금지, R3 자동 skip 승인 필요 포함)
- timer/postmortem 파일 분리 (rev 2)
- 입력 변경 시 downstream과 QA 무효화 + v1 이력 소급 강등 금지 (rev 2)
- 동일 reel의 동시 lock 획득 거부, revision CAS 충돌 (rev 2)
- v1→v2 마이그레이션: 백업 생성·필드 보존·롤백, 조회 명령의 원본 무변경 (rev 2)
- cut별 retry/error history 보존
- 한 줄/여러 줄 script parser fixture
- 손상 PNG, 짧은 MP4와 중복 SHA-256 거부
- logout, paywall, option drift, timeout + connection_lost, tls_block, tcc_denied의
  표준 오류 분류 (rev 2 확장, Sprint 2)
- 컷-파일 결속: 동일 크기 이미지 오배치 시나리오 검출 (rev 2, Sprint 2)
- Claude/Codex 신규 세션에서 플러그인 discovery (Sprint 3)
- plugin tree에 사용자 홈/npx cache 절대경로와 symlink가 없는지 검사 (rev 2 확장, Sprint 3)
- standalone 스킬 제거 후 이중 노출 부재 확인 (rev 2, Sprint 3)
- Paperclip handoff의 임의 action/path/shell 입력 거부
- 승인 뒤 video/meta 변경 시 publish 차단, 승인 TTL 만료·비TTY approve 거부 (rev 2 확장)

### 실제 canary 수용 기준

- 서로 다른 2개 채널에서 총 3개 reel 완주
- 각 reel을 중간에 한 번 중단한 뒤 정확한 컷부터 재개
- 완료된 유료 이미지/영상 재생성 0건
- 브라우저 계정별 동시 생성 1개
- 기술 QA 100% 통과
- 콘텐츠, 캐릭터와 자막 검수 기록 존재 — **rev 2 판정 기준:** 캐릭터는 정본 시트
  이미지와의 대조(문서 서술 아님), 타이포는 저장 전 확대 검수 체크 기록
- 사용자 승인 없는 외부 발행 0건
- 동일 산출물 중복 발행 0건
- Paperclip을 꺼도 진행 중인 로컬 EP 완주

## 롤백 (rev 2 신설)

| 계층 | 절차 |
| --- | --- |
| v2 마이그레이션 | `render-job.v1.bak.json` 복원 + 이전 버전 스크립트 체크아웃. 마이그레이션 코드는 v1 읽기를 계속 지원한다 |
| 발행 | 오발행 시 takedown 런북: 플랫폼에서 비공개 전환 → `90_publish_ledger.json`에 revoked 기록 → postmortem 작성 |
| 플러그인 | 플러그인 제거 + standalone symlink 복원 스크립트 (Sprint 3 산출물) |
| Paperclip | 재차단 트리거 발동 시 `PAPERCLIP_DISABLED=1` 즉시 재설정, 재도입은 게이트 재통과 |

## 운영 가정과 재평가 조건

현재 결정은 한 대의 Mac, 단일 운영자, 소수 채널과 EP 직렬 처리를 전제로 한다.

다음 중 하나가 발생하면 Paperclip 관제층 우선도를 다시 평가한다.

- 운영자 2명 이상
- 제작 장비 2대 이상
- 상시 backlog 10건 이상
- 중앙 비용 집계와 SLA가 실제 운영 요구가 됨
- 여러 클라이언트가 같은 job 상태를 구조적으로 조회해야 함

완전 무인 발행, 결제 자동화, captcha 우회, 로그인 대행은 범위 밖이다. 풀 dashboard와
MCP façade는 위 재평가 조건이 생길 때만 추가한다.

## 예상 작업량 (rev 2 재산정)

| 작업 | 추정 |
| --- | ---: |
| Sprint 1: 실행 코어 안정화 + 발행 HITL | 2~3 집중 작업일 |
| Sprint 2: worker 계약 표준화 (계약·검증·회수만) | 1~2 집중 작업일 |
| 무인 browser worker (Playwright, 별도 결정) | **신규 개발 기준 1~2주 + 실계정 canary** (rev 1의 3~5일은 존재하지 않는 CDP 재사용 전제 — 폐기) |
| Sprint 3: 풀 플러그인 (+이중 노출 제거·경로 마이그레이션) | 1~3 집중 작업일 |
| Paperclip 파일럿 복구·제한 handoff | 별도 3~6 집중 작업일 |
| Paperclip에서 browser/publish 직접 실행 | 2~4주 이상, 권장하지 않음 |

## 참고 자료

로컬:

- [BarroTube 스킬](../SKILL.md)
- [BarroTube 에이전트 아키텍처](../references/ARCHITECTURE.md)
- [Media Render 스킬](../../barrotube-media-render/SKILL.md)
- [Media Render 자동화 계획](../../../../docs/20-Operations/barrotube-media-render-automation-plan.md)
- [Paperclip × Hermes 파일럿](../../../../../paperclip-hermes-pilot/README.md)
- [Paperclip 주간 파일럿](../../../../../paperclip-hermes-pilot/reports/WEEKLY-PILOT.md)
- [Paperclip Phase 4 handoff](../../../../../paperclip-hermes-pilot/docs/phase4-handoff-design.md)

공식:

- [Paperclip repository](https://github.com/paperclipai/paperclip)
- [Paperclip v2026.720.0](https://github.com/paperclipai/paperclip/releases/tag/v2026.720.0)
- [Paperclip plugin specification](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Build Codex plugins](https://developers.openai.com/codex/build-plugins)
- [Codex scheduled tasks](https://developers.openai.com/codex/automations)

> rev 2 검증 방법: Claude 8-에이전트 워크플로우(사실 검증 6 + 적대적 비평 2)로 rev 1의
> 주장 39건을 코드 라인·디스크 실물·실시간 실행(pilotctl, curl)과 대조. 본문 라인 인용이
> 그 근거다. rev 1 원문 백업: 운영자 잡 디렉토리 `adr-rev1-codex-original.md`.
