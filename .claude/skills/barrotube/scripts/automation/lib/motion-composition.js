/**
 * motion-composition.js — 승인된 씬 정지컷을 HyperFrames 컴포지션(HTML)으로 바꾼다.
 *
 * 배경. render-direct.js 는 `40_assets/videos/scene_NNN.mp4` 가 없으면 exit 3 으로 멈춘다
 * (--allow-stills 는 레거시 예외이며 그 산출물은 publish QA 를 통과하지 못한다). 그래서
 * 에피소드마다 브라우저로 Grok 클립 5개를 만들어야 했고, 그 경로가 파이프라인에서 가장
 * 자주 막히는 지점이다 — 로그인·유료 모달·일일 쿼터·10초 고정 길이.
 *
 * 게다가 Grok 은 스틸을 **다시 상상**한다. barrotube-media-render/SKILL.md 에 기록된
 * 실측: today.myo ep04 에서 6개 중 4개가 다른 고양이로 돌아왔다. 우리가 캐릭터시트까지
 * 붙여 어렵게 승인받은 그 컷이 클립에서 다른 그림이 되는 것이다.
 *
 * HyperFrames 는 **승인된 그 PNG 자체**를 헤드리스 크롬으로 움직인다. 캐릭터 드리프트가
 * 원천적으로 0 이고, 길이를 TTS 에 정확히 맞출 수 있어 render-direct 의 리타임(±3배
 * 속도 워프)도 필요 없다. 브라우저·쿼터·비용이 모두 사라진다.
 *
 * 화면에 텍스트를 얹지 않는다. 하단 자막이 이미 subtitle_text 를 시간 분할로 보여준다
 * (render-direct.js `narration: scene.subtitle_text || scene.narration`). 위에 같은 문구를
 * 또 띄우면 중복이다.
 */

/** 채널 규격 — render-direct.js 의 캔버스와 같아야 한다. */
export const CANVAS = { w: 1080, h: 1920, fps: 30 };

/**
 * 카메라 무브 — 컷마다 같은 방향으로 밀면 슬라이드쇼로 보인다.
 * 인덱스로 순환시킨다. 랜덤 금지: 같은 EP 를 다시 렌더하면 다른 영상이 나온다.
 *
 * ffmpeg zoompan 이 하던 1.0→1.05 선형 줌과 달리 방향이 바뀌고 ease 가 붙는다.
 */
export const MOVES = [
  { scale: [1.00, 1.09], x: [0, -1.3], y: [0, -0.9], ease: 'power1.inOut' },
  { scale: [1.08, 1.00], x: [1.0, 0], y: [0.6, 0], ease: 'power1.out' },
  { scale: [1.00, 1.07], x: [0, 1.2], y: [0, 0.8], ease: 'power1.inOut' },
  { scale: [1.06, 1.00], x: [-1.1, 0], y: [-0.7, 0], ease: 'power1.out' },
  { scale: [1.00, 1.10], x: [0, 0], y: [0, -1.2], ease: 'power1.in' },
];

export function moveFor(index) {
  return MOVES[((index % MOVES.length) + MOVES.length) % MOVES.length];
}

/**
 * 컴포지션 HTML.
 *
 * gsap 은 로컬 파일을 참조한다. 스캐폴드 기본값인 CDN(jsdelivr)을 그대로 두면 렌더가
 * 네트워크에 묶여 무인 cron 에서 조용히 실패할 수 있고, 버전이 바뀌면 결정론도 깨진다.
 *
 * @param {object} o
 * @param {string} o.imageRel  컴포지션 기준 상대 경로 (예: 'assets/scene.png')
 * @param {string} o.gsapRel   상대 경로의 gsap.min.js
 * @param {number} o.durationSec
 * @param {number} [o.index]   씬 순번(0-based) — 카메라 무브 선택용
 */
export function buildSceneComposition({ imageRel, gsapRel, durationSec, index = 0 }) {
  if (!(durationSec > 0)) throw new Error('durationSec 가 있어야 한다');
  if (!imageRel || !gsapRel) throw new Error('imageRel·gsapRel 이 있어야 한다');
  const mv = moveFor(index);
  const dur = Number(durationSec.toFixed(3));

  return `<!doctype html>
<html lang="ko" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${CANVAS.w}, height=${CANVAS.h}" />
    <script src="${gsapRel}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${CANVAS.w}px; height: ${CANVAS.h}px; overflow: hidden; background: #081320; }
      #plate {
        position: absolute; inset: 0;
        background-image: url("${imageRel}");
        background-size: cover; background-position: center;
        transform-origin: 50% 46%;
      }
      /* 가장자리를 살짝 눌러 인물이 가운데로 모이게 한다. 정보는 더하지 않는다. */
      #vignette {
        position: absolute; inset: 0; pointer-events: none;
        background: radial-gradient(120% 78% at 50% 44%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.34) 100%);
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${dur}"
         data-width="${CANVAS.w}" data-height="${CANVAS.h}" data-fps="${CANVAS.fps}">
      <div id="plate" class="clip" data-start="0" data-duration="${dur}" data-track-index="0"></div>
      <div id="vignette" class="clip" data-start="0" data-duration="${dur}" data-track-index="1"></div>
    </div>
    <script>
      // 이 등록이 없으면 렌더가 프레임을 한 장도 못 뜨고 무한 대기한다 (2026-08-14 실측:
      // 180프레임 중 0 완료, "Attempted to use detached Frame" 로 6워커 전부 실패).
      // hyperframes lint 는 이것을 경고로만 알려주므로 사람이 놓치기 쉽다.
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#plate",
        { scale: ${mv.scale[0]}, xPercent: ${mv.x[0]}, yPercent: ${mv.y[0]} },
        { scale: ${mv.scale[1]}, xPercent: ${mv.x[1]}, yPercent: ${mv.y[1]}, duration: ${dur}, ease: "${mv.ease}" }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}
