---
date: 2026-07-12
topic: today.myo 에피소드를 barrotube-media-render 결정론 파이프라인에 편입 (오토파일럿 + reel-director)
tags:
  - session
  - todaymyo
  - reels
  - automation
  - render-pipeline
---

# 2026-07-12 오늘묘 파이프라인 편입 세션 (오토파일럿 + reel-director)

## 문제 인식

barroSkills 정본 스킬은 이미 결정론 백본(render_reel_job.py 상태머신 · media_render_doctor
· qa_reel_media · render_master_mix, 2026-07-02 구현)을 갖고 있었으나 **takitani.lab
EP03/EP04로만 검증**됐고 today.myo에는 미연결. today.myo는 별도로 bridge.py 보드 +
media-process.sh를 재구현해 **드리프트** 상태였다. → "에피소드 파이프라인으로 자동 완성"의
정답 = today.myo를 정본 상태머신에 붙이고 그 위에 지휘 루프를 얹는 것.

## 산출물

- **`reel_autopilot.py`** (신규, 정본 스킬 scripts/) — director 지휘 루프의 *결정론 안전 절반*.
  render-job.json을 읽어 브라우저·사람·비가역 액션 없이 완주 가능한 단계를 한 번에 몰고,
  브라우저(R2/R4)·GUI(R7)·HITL(R10)·QA fail에서 멈춰 `blocked_kind`+`next_action` 반환.
  게시·삭제·결제·로그인 대행 절대 안 함.
- **`barrotube-reel-director`** (신규, `~/.claude/agents/`) — Layer1 지휘자. "오토파일럿
  먼저 → blocked_kind별 대응(browser=barrotube-media-render, GUI=CapCut, hitl_publish=사람)".
- **today.myo 연동**: `tools/autopilot.sh <day>` 래퍼 + bridge 읽기전용 `/api/reel/state?day=N`
  (render-job.json 상태를 보드에 노출, localStorage 추정 대체).

## 검증 (실물)

- `reel_render_plan.py`가 today.myo script.md를 정상 파싱(EP01·EP02 각 3컷).
- **EP01 = 13/13 DONE**: 게시 완료본(pyCapCut 교체본)을 `56_capcut_export/video.mp4`에
  하드링크 + `80_publish_result.instagram.json`(permalink 미포착→null, 정직) → 오토파일럿
  완주.
- **EP02 = 11/13**: R3/R5/R8 QA 모두 ok(0 error/0 warn) · R6 CapCut-route skip ·
  distribution(BT-EP02.mp4) · 게시메타 script.md에서 자동 추출(캡션+해시태그10) ·
  **R10 게시(HITL)만 잔여**. 계획서가 EP04에서 달성한 종착점과 동일.

## today.myo route 특이점 (반영됨)

- 클립→**CapCut**(합성+자막+1080화)→export 이므로 R6(FFmpeg master)는 CapCut export 존재 시
  **auto-skip**. FFmpeg master 별도 렌더는 하지 않는다.
- CapCut export 정본은 `56_capcut_export/video.mp4` 표준 경로에 하드링크(디스크 중복 0).
- 게시 캡션 어미: 온스크린 "(N/?)" 금지 규칙과 별개로, IG 캡션 어미는 사람이 최종 결정
  (EP01 선례 "(1/?)"→"!"). 오토파일럿은 script.md 초안을 넣고 REVIEW 플래그만.

## Open / Next

- [ ] EP02 R10: 캡션 확정 + Instagram 토큰(.env/Keychain) 확인 후 HITL 게시.
- [ ] Phase 2~4 잔여: `build_capcut_reel_draft.py`, browser workers 코드화, publish
      duplicate-guard.
- [ ] EP03부터는 처음부터 render-job.json 기준으로 제작(오토파일럿 상시 사용).

## Links

- [[20-Operations/barrotube-media-render-automation-plan]]
- [[10-Channels/today-myo/index]]
- [[50-Sessions/2026-07-12-todaymyo-ep02-pipeline]]
