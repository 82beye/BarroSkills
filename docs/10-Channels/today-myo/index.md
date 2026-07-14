---
channel: 오늘묘 (today.myo)
handle: "@todaymyo"
platform: Instagram Reels
status: active
tags:
  - channel
  - todaymyo
  - status/active
---

# 오늘묘 (today.myo)

AI 실사 새끼고양이 **오늘(Oneul)**의 일생을 압축 시즌제로 연재하는 인스타 릴스 채널.
서사의 척추는 '만남(입양)→일생→작별→새 입양'의 인연 모티프. 각 에피소드 = 표층 밈 × 심층 서사 이중 레이어.

- 프로젝트 루트: `/Users/beye/BarroAiFactory/today.myo`
- 캐릭터 진실원천: `character_dna.md` (LOCK) + `character-sheet/oneul-character-sheet-v1.png`
- 게시 계정: [instagram.com/todaymyo](https://www.instagram.com/todaymyo/) (게시물 1 — EP01)

## 캐스트

| 캐릭터 | 스펙 | 시트 |
|---|---|---|
| 오늘(Oneul) | 실버 태비 8주령, 검수 3요소: 줄무늬+M/회청색 눈/크림 언더파츠 | `character-sheet/oneul-character-sheet-v1.png` |
| 아빠(주인공) | 40대 중반 영포티, 투블럭, 베이지 재킷 | `character-sheet/family-dad-sheet-v1.png` |
| 엄마 | 40대 중반 영포티, 웨이브 다크브라운, 크림 니트 | `character-sheet/family-mom-sheet-v1.png` |
| 아들 | 12살 초5, 베이지 후디 | `character-sheet/family-son-sheet-v1.png` |

## 에피소드

- EP01 「첫 눈맞춤」 — ✅ 게시 완료 (2026-07-11, 자막 = 파스텔 필 스타일). 구설계 3컷×10s.
- [[10-Channels/today-myo/episodes/EP02-way-home|EP02 「집으로 가는 길」]] — ✅ 최종본 완성, 게시 대기(R10). 구설계 3컷×10s.
- EP03 「첫날밤」 — 🎬 **신설계 첫 적용**(7컷 하이브리드, ~15.2s). 대본·plan·상태머신 완비, **이미지 생성 대기(R2)**. *(Day3 포맷 car→reel 재지정 2026-07-12)*
- EP04 「마음의 빗장 풀림」(first-purr) — 🎬 신설계 7컷(첫 골골·꾹꾹이), 대본·plan·상태머신 완비, **R2 대기**.
- EP05 「이름을 지어줘」(name-vote) — 🎬 신설계 7컷(명명 이벤트·댓글 CTA), 대본·plan·상태머신 완비, **R2 대기**.

## 파이프라인 상태 (2026-07-12 barrotube-media-render 편입)

에피소드는 이제 정본 스킬의 **결정론 상태머신(render-job.json, R0~R11)**으로 추적된다.
상태 진실원천은 각 `barrotube/epNN_slug/render-job.json`.

| EP | 상태 | 잔여 |
|---|---|---|
| EP01 | **13/13 DONE** (게시 완료본 편입) | — |
| EP02 | **11/13** (QA 3게이트 통과·distribution·게시메타 자동) | **R10 게시(HITL)** + R11 |
| EP03 | **3/13** (대본·plan·상태머신 편입, 신설계 7컷) | **R2 이미지 생성**(브라우저) 이후 전 단계 |
| EP04 | **3/13** (신설계 7컷 선제작) | **R2 이미지 생성**(브라우저) 이후 전 단계 |
| EP05 | **3/13** (신설계 7컷 선제작, 명명 CTA) | **R2 이미지 생성**(브라우저) 이후 전 단계 |

- **자동 완주**: `bash tools/autopilot.sh <day>` — `reel_autopilot.py`가 결정론 단계
  (QA·distribution·게시메타·회고)를 끝까지 몰고 브라우저(R2/R4)·CapCut(R7)·게시(R10,HITL)
  에서 멈춰 '다음 액션'을 보고. **게시·삭제·결제·로그인 대행은 절대 안 함.**
- **완전 자율(브라우저 포함)**: 인터랙티브 `claude --chrome`에서
  [[barrotube-reel-director]] 에이전트 호출 → 오토파일럿 + barrotube-media-render 위임.
- **보드 연동**: bridge `/api/reel/state?day=N`가 render-job.json 상태를 보드에 노출.
- today.myo route: 클립→CapCut(합성+자막+1080화)→export → **R6(FFmpeg master) auto-skip**,
  CapCut export는 `56_capcut_export/video.mp4` 표준 경로(하드링크).
- 관련: [[20-Operations/barrotube-media-render-automation-plan|자동 운영 갭 분석·구현 계획]]

## 제작 규칙 (결정 로그)

- [[30-Decisions/2026-07-11-todaymyo-character-sheet-rule|캐릭터 시트 첨부 규칙 + 가족 캐스트]]
- [[30-Decisions/2026-07-12-todaymyo-subtitle-style|자막 규칙: 캡컷 단계 + 파스텔 필 스타일]]
- [[30-Decisions/2026-07-12-todaymyo-shot-composition|씬 구성 시스템: 3컷→6~8컷 다양화(EP03부터)]]

## 운영 노하우

- [[20-Operations/capcut-draft-automation|CapCut Draft 자동화 (신형 포맷·샌드박스·내보내기)]]
