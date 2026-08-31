# 모션 클립 — HyperFrames 로컬 엔진

씬 모션 클립(`40_assets/videos/scene_NNN.mp4`)을 브라우저 없이 로컬에서 만든다.
`render-direct.js` 는 이 파일이 없으면 exit 3 으로 멈추므로, 이 단계가 파이프라인에서
가장 자주 막히는 지점이었다.

```bash
node scripts/automation/generate-motion.js --doctor
node scripts/automation/generate-motion.js --episode workspace/episodes/EP-YYYY-NNNN --platform shorts
node scripts/automation/generate-motion.js --episode <dir> --scene 003 --force   # 한 씬만 다시
```

## 왜 바꿨나 (실측)

| | Grok Imagine (브라우저) | HyperFrames (로컬) |
|---|---|---|
| 규격 | **720x1264** — 1080x1920 로 업스케일됨 | 1080x1920 네이티브 |
| 길이 | **10.04s 고정** | TTS 길이에 정확히 맞춤 |
| 리타임 | 씬 14.8s ↔ 클립 10.04s → **0.68배속 워프** | 없음 (`retimeFactor` 1.0) |
| 캐릭터 | 스틸을 다시 상상 — ep04 에서 6개 중 **4개가 다른 캐릭터** | 승인된 PNG 자체를 움직임 → 드리프트 0 |
| 접근 | 로그인·유료 모달·일일 쿼터 | 없음 |
| 비용 | 계정 쿼터 | $0 |
| 속도 | 컷당 30~90s + 대기 | 59초 영상을 **58초**에 (EP-0092 5씬 실측) |

움직임의 **양** 자체는 기존 ffmpeg Ken Burns 와 비슷하다(프레임 차이 0.021 vs 0.022).
이 단계가 버는 것은 "브라우저 없이 · 캐릭터 드리프트 없이 · 정확한 길이로"다. 화질이
극적으로 좋아지는 단계가 아니다.

Grok 클립이 필요한 경우(실사 질감의 카메라 워크, 피사체 자체가 움직여야 하는 컷)는
그대로 `barrotube-media-render` 로 만들면 된다. 이 스크립트는 다른 엔진이 만든 클립을
`--force` 없이 덮어쓰지 않는다.

## 게이트 (모두 기계 검사)

`lib/motion-verify.js`:

1. **규격** 1080x1920
2. **길이** 목표 대비 ±0.15s — 어긋나면 render-direct 가 속도를 워프한다
3. **움직임** 앞/뒤 10% 지점 프레임 차이 ≥ `0.008`

3번이 핵심이다. `render-direct.js` 는 `videos/scene_NNN.mp4` 가 있으면 Ken Burns 를 끄고
그 클립을 그대로 쓴다. 정지 클립을 넣으면 완전히 멈춘 씬이 나오는데, **파일 개수만 세는
검사는 5/5 로 통과시킨다** — 인트로·아웃트로가 개수 검사만으로 통과했던 것과 같은 구멍이다.
그래서 QA 리포트에도 `Motion liveness` 행이 들어간다(BLOCK).

문턱 근거 (2026-08-14, EP-0092 씬1 PNG, 6초):

| 클립 | 프레임 차이 |
|---|---|
| 같은 PNG 정지 | 0.0000 |
| ffmpeg Ken Burns 1.00→1.05 (파이프라인이 내보내는 가장 얌전한 움직임) | 0.0218 |
| HyperFrames scale 1.00→1.09 | 0.0209 |
| EP-0092 실제 5씬 | 0.0174 ~ 0.0455 |

## 산출물

- `40_assets/videos/scene_NNN.mp4`
- `40_assets/videos/_engines.json` — 씬별 `engine` / `source_image` / `duration_sec` /
  `motion_diff` / `rendered_at`. QA 리포트가 이걸 읽어 `Motion liveness` 행에 엔진을 적는다.
  엔진 표기가 없는 클립은 "엔진 미상"(사람이 브라우저로 만든 것)으로 나온다.

## 컴포지션 (`lib/motion-composition.js`)

HTML 한 장 + GSAP 타임라인. 헤드리스 크롬이 프레임 단위로 seek 하고 ffmpeg 가 인코딩한다.

- 화면에 **텍스트를 얹지 않는다.** `render-direct.js` 가 이미 `subtitle_text` 를 하단
  자막으로 시간 분할해 굽는다(`narration: scene.subtitle_text || scene.narration`).
  위에 같은 문구를 또 띄우면 같은 화면에 같은 말이 두 번 나온다.
- 카메라 무브는 씬 인덱스로 **순환**한다(`MOVES` 5종). 랜덤 금지 — 같은 EP 를 다시
  렌더하면 다른 영상이 나온다.
- gsap 은 **로컬 파일**을 참조한다. `hyperframes init` 스캐폴드 기본값인 jsdelivr CDN 을
  그대로 두면 무인 cron 이 네트워크에 묶이고 버전이 올라가면 결정론이 깨진다.

## 하드하게 배운 것

- **`window.__timelines` 등록이 없으면 렌더가 무한 대기한다.** 프레임 180장 중 0장을
  뜨고 워커 6개가 전부 `Attempted to use detached Frame` 로 죽는다. 에러가 프레임 캡처
  계층에서 나와 원인이 안 보이고, `hyperframes lint` 는 경고로만 알려준다.
  → `tests/motion-engine.test.js` 가 이 등록을 고정한다.
- **기본 렌더 옵션으로는 이 맥에서 프레임이 안 나온다.** 기본값은 워커 auto(6) +
  `beginFrame` 캡처인데 위와 같은 증상이 난다. `--low-memory-mode` 가 워커 1개 +
  `screenshot` 캡처로 고정해 준다.
- **`optionalDependencies` 로 넣으면 npm 이 하위 의존성을 빠뜨린다.** `hyperframes` 를
  optional 로 설치하면 `hono` 가 트리에서 사라져 CLI 가 `ERR_MODULE_NOT_FOUND` 로 죽는다
  (lock 에는 `hono: ^4.0.0` 이 적혀 있는데 `node_modules/hono` 항목이 안 생긴다).
  일반 `dependencies` 로 옮기면 정상 설치된다.
- **시스템 폰트를 그냥 쓰면 52MB 를 임베드한다.** 컴포지션에서 텍스트를 쓸 일이 생기면
  `assets/fonts/NotoSansKR-*.otf` 를 `@font-face` 로 명시할 것. 지금 씬 컴포지션에는
  텍스트가 없어 해당 없음.

## 아직 안 켠 것 — HeyGen BGM·효과음

강의에서 하이퍼프레임스를 고른 이유 중 하나가 "헤이젠의 음악·효과음을 무료로 쓸 수 있다"
였다. 이 CLI 에도 음악 경로가 있지만 둘 다 **운영자가 직접 켜야 한다.**

| 경로 | 여는 방법 | 성격 |
|---|---|---|
| HeyGen 호스팅 | `npx hyperframes auth login` (HeyGen OAuth) | 계정 로그인 — 대신 해 주지 않는다 |
| 로컬 MusicGen | `pip install transformers torch soundfile numpy` | 계정 불필요, 무겁다 |

지금 BGM 은 `build-bgm-library.js` 가 archive.org 의 CC 트랙을 카테고리별로 받아 쓰고,
믹스와 사이드체인 더킹은 `render-direct.js` 가 이미 한다(`sidechaincompress`,
threshold 0.03 / ratio 14). 즉 **음악 파이프라인 자체는 이미 있고**, HeyGen 은 음원
품질을 올리는 선택지다. 구조가 바뀌는 일이 아니라 뒤로 미뤘다.

## 출처

HyperFrames — HeyGen, Apache-2.0, <https://github.com/heygen-com/hyperframes>.
HTML/CSS 를 헤드리스 크롬으로 프레임 단위 캡처해 결정론적 MP4 로 만든다. 도입 계기는
"클로드 코드로 영상 편집" 라이브(VSIsHredA5U)에서 리모션 대신 하이퍼프레임스를 쓰는
이유로 든 것들 — 에이전트가 쓰기 좋고, 라이선스 비용이 0 이고, 결정적 렌더를 도구가
강제한다.

## Grok AppleScript 실패 진단 — 에러 문구를 믿지 마라 (2026-08-30, EP-0124)

`execute javascript` 가 이렇게 죽을 때가 있다:

> Google Chrome에 오류 발생: AppleScript를 통한 자바스크립트 실행 기능이 꺼져 있습니다.
> ... 보기 > 개발자 > Apple Events의 자바스크립트 허용으로 이동하세요. (12)

**메뉴는 이미 체크돼 있다.** 설정 문제가 아니다. 원인은 **Chrome 인스턴스 모호성**이다.

`tell application "Google Chrome"` 은 같은 번들이 여러 프로세스로 떠 있을 때 어느
인스턴스를 잡을지 보장하지 않는다. auto-pipeline 은 Phase 6 에서 codex imagegen 이
Playwright 로 Chrome 을 하나 더 띄우고(`--user-data-dir=~/.codex/playwright…`),
그 프로필에는 Apple Events 권한이 없다. 그 인스턴스가 남아 있으면 Phase 7 의 모든
JS 호출이 실패한다 — 사용자 Chrome 은 멀쩡히 켜져 있는데도.

진단 순서:

```bash
# 1) Chrome 인스턴스가 둘 이상인가 (Helper 제외)
ps -eo pid,etime,command | grep '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' | grep -v Helper
# 2) 자동화 프로필이 섞였는가
ps -eo pid,command | grep -o 'user-data-dir=[^ ]*' | sort | uniq -c
```

자동화 인스턴스를 내리면 즉시 복구된다. `grok-motion-applescript.js` 의
`killShadowChromes()` 가 시작 시 이 정리를 자동으로 한다 (`.codex/`·`.barrotube/`·
`/tmp/`·`/var/folders/` 프로필만 대상, 사용자 기본 프로필은 건드리지 않는다).

**함의: codex 이미지젠과 Grok 모션을 병렬로 돌리지 마라.** 순차로 돌리거나,
모션 시작 전에 위 정리를 반드시 거쳐야 한다.

같은 날 함께 고친 것 두 가지:

- **진행 신호** — 대기 루프가 본문의 `생성 중 NN%` 만 봤다. 현재 UI 는 버튼
  aria-label 로만 `미디어 생성 진행 중` 을 남긴다. %만 보면 5초 만에 완료로 오판하고
  아직 없는 다운로드 버튼을 찾다 죽는다. 이제 두 신호를 다 보고, 다운로드 버튼 자체를
  완료 신호로 쓴다. 재시도도 60초 → 120초.
- **AppleEvent 타임아웃** — `with timeout of 300 seconds` 로 감쌌다. 없으면 60초에
  끊겨 `-1712` 로 죽는데, 영상 생성 중인 Chrome 은 그보다 오래 멈춰 있을 수 있다.
