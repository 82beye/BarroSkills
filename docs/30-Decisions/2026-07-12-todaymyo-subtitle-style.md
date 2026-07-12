---
date: 2026-07-12
status: accepted
tags:
  - decision
  - todaymyo
  - capcut
---

# ADR: 자막 워크플로 + 게시본 파스텔 필 스타일 표준

## Context
EP02 병합 시 ffmpeg로 자막을 burn-in → 사용자 교정 "자막은 캡컷 렌더 시점에". 이후 인스타 게시본(@todaymyo EP01) 확인 결과 실제 스타일은 로컬 캡컷 4K본(흰 글씨+아웃라인)이 아닌 **파스텔 필 배경** 스타일이었음 (`ep01_STYLE_nanum_pastel.mp4` = 게시 원본, draft 원본 = `BT-EP01-pyCapCut-TEST`).

## Decision
1. **클립·병합본에 자막 burn-in 금지.** 자막은 캡컷(S7) 렌더 시점에 추가. 파이프라인 산출 = 클린 클립 + SRT.
2. 온스크린 자막에 `(2/?)` 같은 연재 표기 금지 — 연재 표기는 인스타 캡션에만.
3. **채널 자막 표준 = 게시본 파스텔 필 스타일:**
   - 진회색 [0.1,0.1,0.1] 볼드 · size 9.0 · text_size 30 · 테두리/그림자 없음 · `check_flag=23`
   - 배경: style 1 · **#E9E596**(연노랑, 홀수컷) / **#EAC9E8**(연분홍, 짝수컷) · alpha 0.92 · radius 0.5
   - 등장 애니메이션 Wiping In 0.5s · 위치 transform (0,0)
4. 새 EP draft는 `BT-EP01-pyCapCut-TEST`의 텍스트 material을 **전체 필드 복사**하고 문구·배경색만 교체.

## Consequences
- `check_flag`는 기능 비트마스크 — 부분 필드만 복사하면 배경이 렌더되지 않음(47→23 필수). 전체 복사가 안전.
- EP02 최종본이 이 표준의 첫 적용 사례. EP03+는 draft 생성 시점부터 적용.
