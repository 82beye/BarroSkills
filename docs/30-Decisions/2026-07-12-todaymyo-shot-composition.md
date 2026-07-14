---
date: 2026-07-12
tags:
  - decision
  - todaymyo
  - reels
  - shot-composition
status: adopted
---

# 결정: 오늘묘 릴스 씬 구성 시스템 (3컷 → 6~8컷 다양화)

## 문제
EP01·EP02를 "3컷 × 컷당 ~10초 = 30.1초 풀컷"으로 냈더니 **루즈**했다. 코드 진단 결과:
컷 전환이 10초에 1번뿐 + EP01은 3컷 전부 동일 손바닥 클로즈업+push-in(앵글 변화 0) +
클로즈업 일변도(파이프라인 자체 "wide/no close-up" 규칙과도 불일치). 경쟁 채널 takitani =
6컷 + "3~5초마다 예상 밖 액션".

## 결정 (채택)
- **컷 수 6~8(표준 7), 총 16~22s.** 훅 ≤1.5s, 본문 2~3s, 클리프행어로 갈수록 단축(가속).
- **샷 스케일 어휘 강제**: `EW`(릴당 ≥1) · `W` · `M` · `CU` · `ECU 인서트`(릴당 ≥2) + 앵글 변주.
- **강제 규칙**: 인접 컷 샷사이즈 ≥2단계 점프 또는 앵글 변경 · 카메라무브 비중복 · insert ≤2.2s.
- **제작 방식 = 하이브리드**: 히어로 풀 스틸 3 + ECU 디테일 인서트 3~4(눈동자·발볼록·수염 등).
  인서트는 히어로 크롭 + Grok 마이크로무브로 만들어 ChatGPT 일일 한도(~10장)를 아낀다.
- **길이 실현**: Grok은 6s/10s만 → 소스는 그대로 두고 **렌더에서 2~4s 트림**(trim은 클립
  앞부분 → Grok 모션은 "머니 모먼트 첫 N초 front-load").
- **적용**: EP01/EP02는 그대로, **EP03(첫날밤)부터 표준**. EP03 = 첫 신설계 레퍼런스.

## 구현 (동반)
- **CUT 스키마 확장**: `**샷:**`/`**프레이밍:**`/`**길이:**`/`**역할:**` 4필드(optional, 하위호환).
  `reel_render_plan.py`·`dna_apply.py`가 파싱, `render_master_mix.py`가 `길이`를 읽어 컷별
  트림·xfade(`--durations` 불필요).
- **`dna_apply.py` 버그 수정**: `image_prompt`가 `DNA앵커+제목`만 써서 프레이밍·이미지 지시를
  버렸음 → `DNA+프레이밍+이미지지시+제목`으로 교체(샷 설계가 ChatGPT까지 도달).
- **QA**: 콘택트시트 N-aware, Grok 6s 정식 채택(`dur_warn` 하한 8.0→5.5, `dur_min` 3.0 유지).
- **문서**: `barrotube-reels-pipeline.md` Image Prompt Rule을 **샷-role 분기**로 교체(EW/W=와이드
  유지, ECU=매크로 명시 허용). `reel-batch.md`·`barrotube-schema.md` 동반. today.myo 설계문서
  §4/§6 개정 + CUT 템플릿.

## 후속/주의
- **Day3 포맷 = reel로 재지정 확정(2026-07-12).** 레지스트리가 Day3를 `car`(캐러셀)로 뒀던 것을
  `bridge.py` EPISODES + HTML 보드 EPS 양쪽에서 `reel`로 변경(릴스 22→23, 캐러셀 8→7). 보드
  캡션도 릴스용으로 교체. EP03「첫날밤」이 Day3 reel의 정본.
- EP03 이미지·영상 생성은 인터랙티브 `claude --chrome` 세션 필요(오토파일럿은 R2에서 정지).

관련: [[50-Sessions/2026-07-12-todaymyo-autopilot-integration]] ·
[[30-Decisions/2026-07-12-todaymyo-subtitle-style]] · [[10-Channels/today-myo/index]]
