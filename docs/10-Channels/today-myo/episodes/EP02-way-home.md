---
episode: EP02 집으로 가는 길 (Way Home)
series: S1 아기냥 · Day 2
format: 9:16 릴스 · 3컷 · 30초
status: final-ready
date: 2026-07-12
tags:
  - todaymyo
  - episode
  - reels
---

# EP02 「집으로 가는 길」 제작 기록

> 서사 비트: 낯선 세계 진입 — 첫 이동. 입양 아크 2단계(만남→**집**). 빼꼼-움켜쥠-문앞.
> 최종본: `barrotube/ep02_way-home/ep02_FINAL_1080x1920.mp4` (1080×1920 · 30.1s · H.264+AAC)

## 제작 타임라인 (2026-07-11 ~ 07-12)

### 1) 이미지 3컷 — ChatGPT (Pro)
- 미디어 큐(`tools/media-queue/02-image.json`) 처리. `barrotube-media-render` 스킬 흐름을 현재 세션에서 직접 수행.
- 1차: DNA 텍스트 앵커만으로 생성 → **교정: 캐릭터 시트 PNG를 반드시 첨부** (클립보드 `cmd+V` 우회 — `file_upload` 도구가 로컬 경로 거부).
- 2차: 오늘묘 시트 첨부 재생성 → **교정 2: 가족 캐스트 반영** — 운반자를 여성(긴머리)→**아빠(영포티)**로 교체 재생성.
- 산출: `Image/ep02-cut1~3.png` (941×1672). DNA 검수 3요소 매 컷 통과, md5 중복 없음.

### 2) 가족 캐릭터 시트 3종 — ChatGPT
- DAD/MOM/SON 레퍼런스 시트 (1024×1536, 흰 스튜디오, 포트레이트·표정 그리드·턴어라운드·포즈·팔레트).
- 같은 대화에서 순차 생성해 가족 톤 일치. `character-sheet/family-{dad,mom,son}-sheet-v1.png`.
- `character_dna.md` 조연 섹션에 스펙+시트 경로 기록.

### 3) 영상 3편 — Grok Imagine (image→video)
- 각 스틸 첨부 + 모션 프롬프트 + **`AUDIO:` 절 필수** (사용자 요청 "음성도 포함").
- 컷별 사운드: ①거리 앰비언스+아기냥 mew ②심장박동+옷깃+골골송 ③문소리+아빠 대사 **"다 왔어… 이제 집이야"**+답 mew.
- 산출: `video/ep02-cut1~3.mp4` (720×1264 · 10.04s · AAC 확인). 계정 jamsowens@akugu.com, 결제 모달 없음.

### 4) 병합 & 자막 워크플로 교정
- ffmpeg concat → `video/ep02_final.mp4` (30.1s 클린 병합).
- 1차 실수: Pillow 자막 burn-in → **교정: burn-in 금지, 자막은 캡컷(S7) 렌더 시점** + `(2/?)` 연재표기 온스크린 금지.
- `render/capcut_subtitles.srt` 생성 (컷 타이밍 0-10/10-20/20-30).

### 5) CapCut 자동 렌더 (S7b→내보내기)
- draft `BT-EP02-WayHome` 생성: EP01 draft 복제 후 클립·자막·타이밍 교체, 클립 볼륨 0→1.0.
- 관문 돌파 기록 → [[20-Operations/capcut-draft-automation]] (신형 Timelines 포맷 / 샌드박스 보안 북마크 / 해상도 필드 / Quartz 클릭).
- 내보내기: 1080P/H.264/30fps 자동 실행, 공유(TikTok/YouTube) 다이얼로그는 취소(발행 게이트 유지).

### 6) 인스타 게시본 자막 스타일 매칭
- @todaymyo 게시본(EP01) 확인 → 실제 스타일 = **파스텔 필 배경**(연노랑 #E9E596 / 연분홍 #EAC9E8, radius 0.5, alpha 0.92) + 진회색(0.1) 볼드 + Wiping In.
- 스타일 원본 draft = `BT-EP01-pyCapCut-TEST`. 텍스트 material **전체 필드 복사**(핵심: `check_flag 47→23`, 흰 테두리·그림자 제거).
- 재내보내기 → 최종본 완성. 컷1·3 노랑 / 컷2 분홍 (게시본 교차 패턴).

## 산출물

| 파일 | 내용 |
|---|---|
| `ep02_FINAL_1080x1920.mp4` | ✅ 최종 게시본 (자막+오디오) |
| `Image/ep02-cut1~3.png` | 스틸 3장 (가족 캐스트 v2) |
| `video/ep02-cut1~3.mp4` | Grok 클립 3편 (오디오 포함) |
| `video/ep02_final.mp4` | 클린 병합본 (자막 없음) |
| `render/capcut_subtitles.srt` | 캡컷용 자막 스크립트 |
| CapCut `BT-EP02-WayHome` | 재렌더 가능한 draft |

## 남은 일

- [ ] S10 보드 승인 → S11 인스타 발행 (캡션·해시태그 = script.md 발행 메타 초안)
- [ ] 발행 후 [[10-Channels/today-myo/index|채널 허브]] 상태 갱신, EP03 「첫날밤」 기획

## Links

- [[10-Channels/today-myo/index|오늘묘 채널 허브]]
- [[30-Decisions/2026-07-11-todaymyo-character-sheet-rule]]
- [[30-Decisions/2026-07-12-todaymyo-subtitle-style]]
- [[50-Sessions/2026-07-12-todaymyo-ep02-pipeline]]
