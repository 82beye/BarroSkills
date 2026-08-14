# image_prompt 계약

> **정본은 이 문서가 아니라 코드다** — `scripts/automation/lib/image-prompt-contract.js`.
> 템플릿·수치는 전부 거기 상수로 있고, 생성기·검증기·QA 리포트가 그것을 import 한다.
> 이 문서는 *왜* 그런지를 설명할 뿐이다. 숫자를 여기 옮겨 적지 말 것 — 그렇게 갈라졌었다.

## 왜 계약이 필요했나

규격이 4곳에 흩어져 서로 모순이었다.

| 출처 | 길이 규정 | 캐릭터 |
|---|---|---|
| `generate-script.js` RULE 3 (구) | ≤25 words | "cartoon stick figure" |
| `~/.claude/agents/barrotube-writer.md:188` | 영문 100~200자 | — |
| 〃 `:64` 예시 | — | 마스코트 없음 |
| **EP-2026-0069 (발행본 실측)** | **695자** | 마시 v11, 씬 문장의 주어 |

작가 모델은 캐릭터 DNA를 받은 적이 없었다. `character-dna.md` 주입은 이미지 생성
단계(`generate-image-gemini.js`)에만 있었고 대본 단계에는 없었다. 그래서 모델이
"stick figure"를 쓰고, 렌더할 때 사람이 즉흥으로 메웠다. **EP마다 프롬프트가
갈라진 근본 원인이다.**

## 무엇을 기준으로 정했나 — EP-0069 vs EP-0070

같은 채널·같은 포맷·3일 차이. 결과는 정반대였다.

| | EP-0069 | EP-0070 |
|---|---|---|
| 평균 길이 | 695자 | 1,024자 |
| 마스코트가 주어인 문장 비율 | **58%** | 26% |
| 금지어(꼬리 제외) | 0.2개 | 5개 |
| 프레임 비율(%) 지정 | 0/6 | 5/5 |
| **실제 렌더** | 마스코트 크고 중앙 | **5컷 전부 구석 스티커** |

0070은 문서상 훨씬 정교했다 — 프레임 비율, 카메라 화각, 의상, 자막 안전영역까지
명시했고 media-render 규약("첨부 시트 참조, 캐릭터 재기술 금지")도 정확히 따랐다.
그런데 **금지한 것이 전부 그대로 나왔다.**

| 프롬프트 문구 | 결과 |
|---|---|
| `not a corner accent or watermark` | 우하단 워터마크 크기 |
| `never render Masi as a small corner sticker` | 좌하단 코너 스티커 |
| `no tiny corner mascot` (3컷) | 전부 코너 |
| `about 42-46% of frame height` | 실측 약 12% |
| `deliberately no suit and no jacket` | 정장 착용 |

## 규칙

### 1. 마스코트를 씬 동작의 **주어**로 쓴다 — 가장 중요

```
✅  마시 the 바로경제 mascot (…생김새…), worried, standing before a giant balance scale where …
    └─ 주어 ────────────────────┘ └감정┘ └── 마스코트가 하는 일 = 씬 그 자체 ──┘

❌  Use the attached character sheet as reference for Masi.
    Create a … illustration.               ← 씬 문장에 마스코트가 없다
    Masi is the protagonist, 42-46% …      ← 마스코트에 '대한' 서술
    Two market lines crash toward a clock. ← 실제 씬에도 없다
```

모델은 "무엇을 그릴지"를 씬 문장에서 가져간다. 마스코트가 거기 없으면 배치 대상이
아니라 나중에 얹는 장식이 된다. **크기는 숫자가 아니라 문법적 지위가 정한다.**

### 2. 씬 오브젝트는 하나

마스코트와의 관계로 서술한다 — `standing before / between / beside / under`.
0069는 전 컷 1개, 0070은 3~6개였다. 소품이 늘수록 마스코트의 주의 예산이 줄어든다.

### 3. 금지문을 쓰지 않는다

고정 꼬리를 빼고 최대 1개. 이미지 모델은 이름 붙인 것을 그린다.
`no tiny corner mascot` 대신 `standing in the centre, face readable at thumbnail size`.

### 4. 프레임 비율·카메라 스펙을 쓰지 않는다

`42-46% of frame height`, `24mm`, `wide-angle` — 전부 무시된다. 규칙 1로 대체한다.

### 5. 의상은 캐릭터 시트에 있는 것만

econ-daily DNA 허용은 **두 가지뿐** — 기본(무착장) 또는 네이비 `#081320` 정장+타이.
0070은 조끼·집업 재킷·크로스백을 창작했고(시트에 없음), 정작 렌더는 정장으로 나왔다.
한 EP에서 의상 지정은 **최대 1컷** — 60초 안에 갈아입으면 연속성이 깨진다.

### 6. 길이와 고정 꼬리

`BOUNDS.minChars`~`BOUNDS.maxChars`. 짧으면 모델이 캐릭터를 추론하고, 길면 씬 묘사가
마스코트를 밀어낸다. 모든 프롬프트는 `CANONICAL_TAIL` 로 끝난다 — 스타일·비율·텍스트
금지를 한 문장으로 고정한다.

## 실행

```bash
# 이미지 굽기 전 게이트 (BLOCK 있으면 종료코드 1)
node scripts/automation/validate-image-prompts.js --episode <epdir> --platform shorts

# 기계 판독용
node scripts/automation/validate-image-prompts.js --episode <epdir> --json
```

S8 QA 리포트에도 같은 결과가 `## 📐 image_prompt 계약` 섹션으로 실린다.

**누가 대본을 썼든 같은 판정을 받는다** — Claude·Codex·Gemini·사람 모두. 모델 출력은
신뢰할 수 없고 게이트는 신뢰할 수 있다. `generate-script.js` 는 이 계약을 시스템
프롬프트(RULE 3-CONTRACT)로 모델에게 넘기고, 결과를 같은 모듈로 검사한다.

## 알려진 한계

- **`[palette:*]` 태그는 media-render 경로에서 동작하지 않는다.** 토큰을 처리하는 코드는
  `generate-image-gemini.js` 뿐인데 `image-engines.json` 의 `S6c_scene` 기본값은
  `media-render`(브라우저 ChatGPT)다. 검증기는 태그 오타만 잡고 주입은 하지 않는다.
  또 `scene-backgrounds.md` 의 `bearish`(차콜/오프화이트 분할)·`explainer`(밝은 크림)·
  `cta`(밝은 회색) 정의는 실제 채널 톤(딥 네이비)과 어긋나 있다 — API 엔진으로 재실행하면
  배경 지시가 정면충돌한다. 별건 결정 사항.
- **`~/.claude/agents/barrotube-writer.md` 는 레포 밖(전역)이라 이 커밋에 포함되지 않는다.**
  `:64` 예시와 `:188` 100~200자 규정이 아직 옛 규격이다. 다만 보드의 "대본" 버튼이 실행하는
  런타임 경로는 `generate-script.js` 이므로 실제 산출물은 이 계약을 따른다.

## 실측 기준선 — 무엇이 "제대로 된 마시"인가 (2026-08-14)

눈대중 대신 발행본에서 뽑은 수치로 판정한다. EP-2026-0091(발행) 5컷 실측:

| 지표 | 발행본 실측 | 수락 범위 |
|---|---|---|
| 마시 세로 비중 | 26~42% | 25~55% |
| **몸통/머리 폭비** | **0.57~0.68** | **≤ 0.72** |

폭비가 0.85~1.0 이면 "뚱뚱한 마시"다. 측정 방법은 크림-화이트(#FFF2E6 근방) 픽셀의
바운딩 박스에서 상단 45% 구간 최대 폭(머리)과 하단 50~100% 구간 최대 폭(몸통)의 비.
**밝은 색 대형 오브젝트(대리석 기둥 등)가 있는 씬에서는 오탐하므로 육안 병행.**

### 마시가 뚱뚱해지는 진짜 원인 두 가지

1. **캐릭터시트 미첨부.** 텍스트 설명만으로는 비율이 안 잡힌다. 시트를 붙이면 폭비가
   0.44~0.68 로 즉시 정상화된다(실측). `slim capsule body` 같은 문구를 아무리 다듬어도
   시트 없이는 안 된다 — 프롬프트를 고치기 전에 **첨부부터 확인하라.**
2. **`pear-shaped body` 표현.** 배 모양은 아래가 불룩한 형태라 모델이 뚱뚱하게 그린다.
   정본 시트(§1·§2)의 몸통은 좁은 캡슐이고 팔다리는 막대처럼 가늘다.
   `MASCOT_CLAUSE` 는 `slim capsule body with thin stick limbs` 를 쓴다.

### 스테이징 문구는 장식이 아니다

발행본 EP-0091 은 5컷 전부가 아래 문구를 갖고 있었고, 하나도 없던 EP-0092 는 마시가
정장을 입고 화면 30% 로 줄고 배경이 회화풍으로 채워졌다.

- `a single <형용사> <오브젝트> in the centre` — 오브젝트를 하나로 못박아 배경 클러터 방지
- `face readable` — 없으면 썸네일에서 안 보일 크기로 줄어든다
- `<발 동작> while one white mitten hand <조작>` — **마스코트에 신체 동작을 주지 않으면
  모델이 그를 배치 대상이 아니라 나중에 얹는 장식으로 처리한다**
- `the unified <오브젝트> <상태>` — 오브젝트 분열 방지

`STAGING_PHRASES` 로 BLOCK 검증한다. 기준 픽스처도 EP-0091 발행본 형태다.

## 수락 기준을 과하게 잡으면 0장이 나온다

"마시 키가 화면 세로의 절반 이상" 을 하한으로 걸었더니 **발행본조차 통과 못 하는 기준**이라
에이전트가 정상 결과물을 무한 거부해 5씬 전부를 못 만들었다(2026-08-14 실측).
수락 범위는 위 실측 표를 따르고, 재생성은 **한 씬당 최대 2회**로 제한한다.
완벽한 0장보다 수락 가능한 5장이 낫다.
