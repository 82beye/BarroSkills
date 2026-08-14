# 자막 — HyperFrames 카라오케 자막 (파일럿)

기존 자막은 파이썬(PIL)이 구운 **정지 PNG** 를 시간창마다 갈아 끼운다. 이 ffmpeg 빌드에
libass/drawtext 가 없어서 나온 우회로이고, 그래서 할 수 있는 연출이 "색이 바뀐다" 하나뿐이었다.

```bash
node scripts/automation/render-with-captions.js --episode workspace/episodes/EP-YYYY-NNNN \
  --platform shorts --keep-base
```

## 두 단계

| 단계 | 하는 일 |
|---|---|
| 1 | `render-direct.js` 를 **자막 없이**(`BT_SUBTITLE_MODE=none`) 돌려 완성본을 만든다. 인트로 카드·아웃트로 패드·엔드카드·BGM 더킹이 전부 들어간 실제 발행 화면이다. |
| 2 | 그 영상을 HyperFrames 컴포지션의 **배경 `<video>`** 로 깔고 자막을 그려 한 번에 MP4 로 뽑는다. |

씬 클립에만 얹으면 인트로·아웃트로·BGM 이 빠진 반쪽짜리가 나온다. 그래서 완성본 위에 올린다.

초기 구현은 자막만 알파 WebM 으로 뽑아 ffmpeg 로 덮었는데, **VP9 알파 인코딩이 이 파이프라인에서
제일 느린 구간**이었다. HyperFrames 가 `<video>` 를 클립으로 받으므로 한 번에 합쳤다.
원본 오디오도 그대로 실린다(실측 `hasAudio=true`, 출력에 AAC).

`BT_SUBTITLE_MODE=none` 은 이 비교를 위해 `render-direct.js` 에 추가했다 — 없으면 자막이 두 겹이 된다.

## 스타일 — 어디서 왔나

youtube `ddFFtFylJZE` 프레임 실측 (1920x1080).

| 요소 | 실측값 |
|---|---|
| 알약 배경 | RGB(41,44,41), 거의 불투명 |
| 모서리 | 스타디움 — radius = 높이/2 |
| 폭 | **텍스트 폭만큼만** 늘어남 (풀와이드 바 아님) |
| 미발화 | RGB(252,252,247) `#FCFCF7` |
| **활성(발화 통과)** | RGB(148,197,222) `#94C5DE` — **노랑이 아니라 하늘색** |
| 고정 키워드 | RGB(233,221,158) `#FAE477` |
| 외곽선 | 없음 — 대비는 알약이 만든다 |
| 글자 | cap 39px → font-size 약 62px, 두꺼운 고딕 |
| 하단 여백 | 프레임 높이의 7~9% |

## 카라오케 스윕

처음엔 "문구가 통째로 나타난다"고 잘못 읽었다. 연속 프레임을 0.25초 간격으로 겹쳐 보니
발화가 지나간 단어까지 **좌→우로 누적** 활성화되고 있었다.

```
조금                     ← 활성
조금 더                  ← 활성
조금 더 저렴하니까         ← 활성
조금 더 저렴하니까 여기서   ← 활성
```

그리고 `16기가` 같은 키워드는 **스윕과 무관하게 처음부터 끝까지 노랑**이다. 두 계층이다.

> 배경 위에서는 색 판정이 안 된다. 배경의 주황·흰 픽셀이 자막 색으로 잡혀 스윕이 안 도는 것처럼
> 보였다. `hyperframes snapshot` 으로 **자막만 단독 렌더**해서 확인할 것.

## 세로(1080x1920)로 옮기며 바꾼 것

- 폭이 절반이라 글자수에 따라 72/64/58/52px 중 고르고, 안 들어가면 두 줄로 쌓는다.
  **한 씬 안에서는 크기를 하나로 통일** — 레퍼런스가 일정하기 때문.
- 하단 여백은 480px. Shorts 는 하단을 YouTube UI 가 덮는다.
- 활성 시 크기도 함께 키운다(운영자 요청). 레퍼런스는 색만 바뀐다.

## 하드하게 배운 것

- **확대가 옆 단어를 덮는다.** `transform-origin: 50%` 로 1.08배 하면 단어 폭의 4% 씩 양옆으로
  번진다. 11자 단어면 한쪽에 0.44em — 공백 한 칸(0.16em)을 삼켜 `삼성전자·SK하이닉스강세` 로
  붙는다. 공백 문자를 없애고 글자수에 비례한 margin `(scale-1)/2 × n em` 으로 상쇄한다.
- **강조 판정은 문구 단위로.** 줄마다 판정하면 키워드가 없는 줄에서 리드 폴백이 또 발동해
  한 문구에 노란 덩어리가 두 개 생긴다.
- **`·` 로 문구를 쪼개지 않는다.** 레퍼런스도 `기본 칩 · 메모리 32GB` 처럼 한 문구 안에서 쓴다.
  여기서 자르면 `삼성전자·` 같은 조각이 알약 하나를 차지한다.
- **`--resolution` 은 알파 출력과 함께 못 쓴다** (`outputResolution cannot be combined with
  alpha output`). 배경 `<video>` 방식은 알파가 아니므로 `--resolution portrait` 를 쓴다.

## 알려진 한계

단어 타이밍이 **글자수 비례 근사**다. 기존 카라오케 모드와 같은 정밀도이고, TTS 타임스탬프
사이드카가 생기면 `splitPhrases`/단어 배분만 갈아 끼우면 정확해진다.

## 파이프라인에서의 자리

`produce-episode` 의 **S7 이 기본으로 이 경로를 쓴다** (`BT_CAPTION_ENGINE=hyperframes`).
산출물이 `55_render/video.mp4` 로 같으므로 QA·승인·게시 단계는 바뀌지 않는다.
기존 파이썬 PNG 자막으로 되돌리려면 `BT_CAPTION_ENGINE=pil`.

모션은 **Grok 이 정본**이다 — 피사체가 실제로 움직여야 화면이 산다. 로컬 HyperFrames 모션
(`generate-motion.js`)은 브라우저가 막혔을 때의 폴백이고, 이 자막 층과는 별개다
(`references/MOTION.md`).

---

# 인트로·아웃트로 카드 (`generate-cards.js`)

같은 원리를 카드에도 쓴다 — **배경 그림만 모델이 그리고 글자는 HyperFrames 가 얹는다.**

```bash
node scripts/automation/generate-cards.js --episode <dir> --platform shorts [--force]
```

`produce-episode` 의 S6d 가 기본으로 이걸 부른다(`BT_CARD_ENGINE=hyperframes`).
`none` 이면 예전 경로(`generate-intro.js` / 브라우저)로 돌아간다.

## 문안 규칙 (운영자 확정 2026-08-14)

| 카드 | 성격 | 예 |
|---|---|---|
| 인트로·썸네일 | **자극적인 타이틀** — 대비·반전에 수치를 박는다 | 「사상 최고치인데 AMD는 왜 **8% 빠졌나**」 |
| 아웃트로 | **정의** — 그 회차가 무엇이었는지 한 줄로 규정 | 「이젠 얼마 버나가 아니라 **얼마 쓰나**를 본다」 |

아웃트로는 CTA(구독·좋아요·알림)와 면책 문구를 함께 얹는다.

문안은 `brief.thumbnail.intro_headline_text` / `outro_definition` 이 최우선이고, 없으면
텍스트 엔진 체인(claude→codex)이 대본에서 카드용으로 다시 쓴다. 엔진이 다 죽으면
대본 문장을 잘라 쓰는 폴백으로 간다 — `subtitle_text` 는 자막용 산문이라 잘라 쓰면
「AMD는 정규장에서 7% 올랐습니다. 그런데 실적을」 처럼 문장 중간이 잘린다. 그래서 폴백이다.

## 타이포 — `config/cards.json` 이 정본

```json
{ "fontFamily": "BM DoHyeon OTF", "treatment": { "stroke": 14, "shadow": "hard" } }
```

폰트 후보 10종을 비교해 운영자가 1번(도현 · 외곽선 14)을 채택했다.
폰트를 바꾸려면 이 파일만 고친다 — 스크립트마다 박아 두면 인트로와 아웃트로가 갈라진다.

**볼드는 외곽선으로 낸다.** 배달의민족 폰트는 단일 굵기라 `font-weight` 가 안 먹는다.
`-webkit-text-stroke` + `paint-order: stroke fill` 로 글자를 실제로 두껍게 만든다.

**폰트 라이선스**: 도현체는 사용은 자유지만 **폰트 파일 재배포가 금지**다. git 에 커밋하지
않고 시스템 설치본을 참조한다. 없는 머신에서는 번들 `NotoSansKR-Black` 으로 자동 폴백한다.

## 함정

- **`.tline` 은 `display: block` 이어야 한다.** inline-block 으로 두면 줄들이 나란히 붙어
  「사상 최고치인데AMD는 왜」 처럼 줄바꿈이 사라진다. 폰트 폭이 좁을수록 잘 터진다.
  회전은 block 에도 적용되므로 inline-block 으로 바꿀 이유가 없다.
- **그라데이션과 외곽선은 함께 못 쓴다.** `-webkit-text-fill-color: transparent` 가
  외곽선까지 지운다 — 배경에 묻혀 가독성이 떨어진다.
- **칩에는 세로 여백을 준다.** 안 그러면 강조어의 위아래가 잘린다.
