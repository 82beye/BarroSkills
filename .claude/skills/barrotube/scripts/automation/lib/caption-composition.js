/**
 * caption-composition.js — 레퍼런스 자막 스타일을 HyperFrames 컴포지션으로 만든다 (파일럿).
 *
 * 지금 파이프라인의 자막은 파이썬(PIL)이 구운 **정지 PNG** 를 시간창마다 갈아 끼우는
 * 방식이다. 이 ffmpeg 빌드에 libass/drawtext 가 없어서 나온 우회로이고, 그래서 할 수
 * 있는 연출이 "색이 바뀐다" 하나뿐이었다.
 *
 * 스타일 출처: youtube ddFFtFylJZE ("AI 제대로 하려면 맥북부터 사세요") 프레임 실측.
 * 1920x1080 원본에서 잰 값 —
 *
 *   알약 배경   RGB(41,44,41) 계열 다크 그레이 (거의 불투명)
 *   모서리      스타디움(완전 라운드) — radius = 높이/2
 *   본문 색     RGB(250,250,248)  ≈ #FAFAF8
 *   강조 색     RGB(250,228,119)  ≈ #FAE477  (채도 낮은 따뜻한 노랑)
 *   외곽선      없음 — 대비는 알약이 만든다
 *   글자 높이   39px (cap) → font-size 약 62px
 *   하단 여백   프레임 높이의 7~9%
 *   정렬        가로 중앙, 알약이 텍스트 폭에 맞춰 늘어남 (풀와이드 아님)
 *   줄          한 문구 = 한 줄, 문구 단위로 통째 등장
 *
 * 세로(1080x1920)에 옮길 때 폭이 절반이 되므로 글자 수에 따라 크기를 낮추고,
 * 그래도 안 들어가면 같은 알약을 두 줄로 쌓는다. 색·모서리·여백 비율은 그대로 둔다.
 */

export const CANVAS = { w: 1080, h: 1920, fps: 30 };

/** 하단 여백. Shorts 는 YouTube UI 가 하단을 덮으므로 레퍼런스 비율보다 넉넉히 올린다. */
export const SAFE_BOTTOM = 480;

export const STYLE = {
  pillBg: 'rgba(41, 44, 41, 0.94)',
  /** 아직 발화가 지나가지 않은 단어. 실측 RGB(252,252,247). */
  base: '#FCFCF7',
  /** 발화가 지나간 단어(활성). 실측 RGB(148,197,222) — 노랑이 아니라 하늘색이다. */
  active: '#94C5DE',
  /** 고정 키워드. 스윕과 무관하게 처음부터 끝까지 노랑을 유지한다. */
  emphasis: '#FAE477',
  /** 활성 시 확대 배율. 레퍼런스는 색만 바뀌지만 운영자 요청으로 크기도 준다.
   *  transform 이라 레이아웃(알약 폭)은 흔들리지 않는다.
   *  대신 **양옆으로 번진다** — transform-origin 50% 기준으로 폭의 (scale-1)/2 씩.
   *  한글 한 글자 ≈ 1em 이므로 n 글자 단어는 좌우로 각각 (scale-1)/2 × n em 만큼 커진다.
   *  그만큼을 margin 으로 미리 벌어 둬야 옆 단어를 덮지 않는다(아래 wordMargin). */
  activeScale: 1.04,
  /** 알약 높이 = 글자 높이 × 이 값. 레퍼런스에서 위아래 패딩이 글자 높이의 약 0.3배씩. */
  padY: 0.30,
  padX: 0.52,
};

/** 강조로 뽑을 어휘 — 레퍼런스는 문구 앞머리와 핵심 수치를 노랑으로 둔다. */
const ALWAYS_EMPHASIS = /[\d]/;

/**
 * 단어 좌우 여백(em). 활성 시 확대로 번지는 양을 정확히 상쇄한다.
 *   번지는 양(한쪽) = (scale - 1) / 2 × 글자수 em
 * 최소값은 한글 공백 한 칸 정도.
 */
export function wordMargin(charCount) {
  const spread = ((STYLE.activeScale - 1) / 2) * charCount;
  return Math.max(0.15, Number(spread.toFixed(3)));
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 문구를 글자수 비례로 시간 배분한다. render-direct.js 의 splitNarrationByTime 과 같은 규칙. */
export function splitPhrases(text, totalSec) {
  // `·` 로는 쪼개지 않는다 — 레퍼런스도 "기본 칩 · 메모리 32GB · 1TB" 처럼 한 문구 안에서 쓴다.
  // 여기서 자르면 "삼성전자·" 같은 조각이 알약 하나를 차지한다.
  const phrases = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .flatMap(p => (p.length > 26 && /[,→]/.test(p)
      ? p.split(/(?<=[,→])\s*/).map(s => s.trim()).filter(Boolean)
      : (p.trim() ? [p.trim()] : [])));
  if (!phrases.length) return [];
  const total = phrases.reduce((a, p) => a + p.length, 0) || 1;
  let t = 0;
  return phrases.map(p => {
    const dur = (p.length / total) * totalSec;
    const entry = { text: p, start: t, duration: dur };
    t += dur;
    return entry;
  });
}

/**
 * 단어를 본문/강조로 가른다.
 *
 * 레퍼런스는 (1) 문구 앞머리 한두 단어와 (2) 수치·핵심 명사를 노랑으로 둔다.
 * emphasis_tokens 에 걸리거나 숫자를 품은 단어를 강조로 본다. 앞머리는 강조가
 * 하나도 안 잡혔을 때만 첫 단어를 올려 레퍼런스의 "리드 노랑" 느낌을 남긴다.
 */
export function markWords(phrase, emphasis = [], { leadFallback = true } = {}) {
  const words = phrase.split(/\s+/).filter(Boolean);
  const toks = (emphasis || []).map(t => String(t || '').replace(/\s+/g, '')).filter(t => t.length >= 2);
  const marked = words.map((w) => {
    const bare = w.replace(/[^\p{L}\p{N}%.+\-]/gu, '');
    const hit = ALWAYS_EMPHASIS.test(w)
      || toks.some(t => bare.includes(t) || (bare.length >= 2 && t.includes(bare)));
    return { text: w, emphasis: hit };
  });
  // 강조가 하나도 없으면 앞머리를 올린다. 단, "미"·"그" 같은 한 글자는 건너뛴다 —
  // 레퍼런스의 리드 노랑은 항상 의미 있는 덩어리다.
  if (leadFallback && marked.length && !marked.some(m => m.emphasis)) {
    const lead = marked.find(m => m.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) || marked[0];
    lead.emphasis = true;
  }
  return marked;
}

/**
 * 한 줄에 들어갈 글자 수로 크기를 정한다. 한글은 글자당 약 1em.
 * 안 들어가면 두 줄로 쪼갠다 — 레퍼런스의 알약 모양은 유지된다.
 */
export function layoutPhrase(phrase, forceSize = null) {
  const usable = CANVAS.w - 2 * 56;                 // 좌우 여백
  const SIZES = forceSize ? [forceSize] : [72, 64, 58, 52];
  const perLineAt = (fontSize) => Math.floor(usable / (fontSize * 1.06));

  const wrap = (perLine) => {
    const parts = phrase.split(' ').filter(Boolean);
    const out = [];
    let cur = '';
    for (const p of parts) {
      if (cur && (`${cur} ${p}`).length > perLine) { out.push(cur); cur = p; } else cur = cur ? `${cur} ${p}` : p;
    }
    if (cur) out.push(cur);
    return out.length ? out : [phrase];
  };

  // 한 줄로 되면 가장 큰 크기를 쓴다.
  for (const fontSize of SIZES) {
    if (phrase.length <= perLineAt(fontSize)) return { lines: [phrase], fontSize };
  }
  // 안 되면 두 줄까지 허용하되, 여전히 **가장 큰** 크기를 고른다 — 레퍼런스는 글자가 크다.
  for (const fontSize of SIZES) {
    const lines = wrap(perLineAt(fontSize));
    if (lines.length <= 2 && lines.every(l => l.length <= perLineAt(fontSize))) return { lines, fontSize };
  }
  const fontSize = SIZES[SIZES.length - 1];
  return { lines: wrap(perLineAt(fontSize)), fontSize };
}

/**
 * 자막 트랙 컴포지션. 배경은 렌더 쪽에서 깔고 여기서는 **투명 배경 위의 자막만** 그린다
 * — WebM(alpha)으로 뽑아 ffmpeg 로 얹기 위해서다.
 */
export function buildCaptionComposition({
  text, durationSec, emphasis = [], fontRel, gsapRel,
  /** 여러 씬을 한 트랙에 담을 때 사용. [{ text, start, duration, emphasis }] */
  segments = null,
  /** 트랙 전체 길이. segments 를 줄 때 필요(마지막 씬 뒤의 아웃트로까지 덮으려면). */
  totalSec = null,
  /**
   * 배경 영상 상대경로. 주면 HyperFrames 가 영상을 직접 깔고 그 위에 자막을 그린다
   * — 알파 WebM 을 따로 뽑아 ffmpeg 로 덮는 두 단계가 사라진다(VP9 알파 인코딩이
   * 이 파이프라인에서 제일 느린 구간이었다). 안 주면 투명 배경으로 나온다.
   */
  videoRel = null,
}) {
  if (!segments && !(durationSec > 0)) throw new Error('durationSec 가 있어야 한다');
  if (!fontRel || !gsapRel) throw new Error('fontRel·gsapRel 이 있어야 한다');

  const dur = Number((totalSec ?? durationSec).toFixed(3));
  // 씬별 구간을 각각 문구로 쪼갠 뒤 절대 시각으로 옮긴다. 인트로·아웃트로 구간에는
  // 자막이 없어야 하므로 그 사이는 비워 둔다.
  const phrases = segments
    ? segments.flatMap(seg => splitPhrases(seg.text, seg.duration)
      .map(p => ({ ...p, start: seg.start + p.start, emphasis: seg.emphasis || [] })))
    : splitPhrases(text, dur);
  const nodes = [];
  const tweens = [];

  // 한 씬 안에서 글자 크기가 문구마다 달라지면 눈에 띈다 — 레퍼런스는 일정하다.
  // 가장 긴 문구에 맞춘 크기 하나로 통일한다.
  const sceneFontSize = phrases.length
    ? Math.min(...phrases.map(p => layoutPhrase(p.text).fontSize))
    : 72;

  phrases.forEach((ph, pi) => {
    const { lines } = layoutPhrase(ph.text, sceneFontSize);
    const fontSize = sceneFontSize;

    // 발화 위치를 단어에 배분한다. 줄이 나뉘어도 문구 전체를 한 흐름으로 훑어야
    // 스윕이 줄바꿈에서 끊기지 않는다 — 그래서 문구 단위로 먼저 시간을 나눈다.
    // 강조 판정은 **문구 단위**로 한다. 줄마다 따로 보면 키워드가 없는 줄에서 리드 폴백이
    // 또 발동해 한 문구에 노란 덩어리가 두 개 생긴다.
    const flat = [];
    // segments 모드에서는 씬마다 emphasis_tokens 가 다르다 — 문구가 들고 온 것을 쓴다.
    const phEmphasis = ph.emphasis || emphasis;
    lines.forEach((line, li) => markWords(line, phEmphasis, { leadFallback: false })
      .forEach(m => flat.push({ ...m, li })));
    if (flat.length && !flat.some(w => w.emphasis)) {
      const lead = flat.find(w => w.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) || flat[0];
      lead.emphasis = true;
    }
    const totalChars = flat.reduce((a, w) => a + w.text.length, 0) || 1;
    let acc = ph.start;
    flat.forEach((w) => {
      w.start = acc;
      acc += (w.text.length / totalChars) * ph.duration;
    });

    let k = 0;
    const rows = lines.map((line, li) => {
      const spans = flat.filter(w => w.li === li).map((w) => {
        const id = `w${pi}_${k++}`;
        w.id = id;
        const mg = wordMargin(w.text.length);
        return `<span id="${id}" class="w${w.emphasis ? ' em' : ''}" style="margin:0 ${mg}em">${escapeHtml(w.text)}</span>`;
      }).join('');   // 간격은 .w 의 margin 이 만든다 — 공백 문자는 확대에 덮인다
      return `<div class="pill">${spans}</div>`;
    }).join('\n        ');

    nodes.push(
      `      <div id="p${pi}" class="phrase clip" data-start="${ph.start.toFixed(3)}" `
      + `data-duration="${ph.duration.toFixed(3)}" data-track-index="${pi + 1}" `
      + `style="font-size:${fontSize}px">\n        ${rows}\n      </div>`
    );
    // 레퍼런스는 문구가 통째로 나타난다 — 단어별 팝이 없다. 짧게 올라오며 뜨는 정도만.
    tweens.push(
      `      tl.fromTo("#p${pi}", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.14, ease: "power2.out" }, ${ph.start.toFixed(3)});`
    );

    // 카라오케 스윕 — 발화가 지나간 단어는 색이 바뀌고 커진 채 **그대로 남는다**(누적).
    // 실측: 프레임이 갈수록 하늘색 구간이 왼쪽부터 늘어나고, 노란 키워드는 계속 노랗다.
    flat.forEach((w) => {
      const at = Math.max(ph.start, w.start).toFixed(3);
      const color = w.emphasis ? STYLE.emphasis : STYLE.active;
      tweens.push(
        `      tl.to("#${w.id}", { color: "${color}", scale: ${STYLE.activeScale}, duration: 0.10, ease: "power2.out" }, ${at});`
      );
    });
  });

  return `<!doctype html>
<html lang="ko" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${CANVAS.w}, height=${CANVAS.h}" />
    <script src="${gsapRel}"></script>
    <style>
      @font-face {
        font-family: "BarroKR";
        src: url("${fontRel}") format("opentype");
        font-weight: 900;
        font-display: block;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${CANVAS.w}px; height: ${CANVAS.h}px; overflow: hidden;
        background: ${videoRel ? '#000' : 'transparent'};
      }
      #root { position: relative; width: ${CANVAS.w}px; height: ${CANVAS.h}px; }
      #bg { position: absolute; inset: 0; width: ${CANVAS.w}px; height: ${CANVAS.h}px; object-fit: cover; }
      .phrase {
        position: absolute;
        left: 0; right: 0; bottom: ${SAFE_BOTTOM}px;
        display: flex; flex-direction: column; align-items: center; gap: 12px;
        font-family: "BarroKR", sans-serif;
        font-weight: 900;
      }
      /* 알약은 글자 폭만큼만 늘어난다 — 레퍼런스처럼 풀와이드가 아니다. */
      .pill {
        display: inline-block;
        padding: ${STYLE.padY}em ${STYLE.padX}em;
        background: ${STYLE.pillBg};
        border-radius: 999px;
        color: ${STYLE.base};
        line-height: 1.0;
        white-space: nowrap;
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38);
      }
      /* inline-block + transform 이라 확대해도 알약 폭이 흔들리지 않는다.
         단어 사이를 공백 문자로 두면 활성 단어가 1.08 배로 커질 때 그 공백을 덮어
         "삼성전자·SK하이닉스강세" 처럼 붙어 보인다(2026-08-14 실측). 그래서 공백 대신
         margin 으로 벌린다 — 확대는 transform 이라 margin 을 침범하지 못한다. */
      .w { display: inline-block; transform-origin: 50% 85%; }
      .w.em { color: ${STYLE.emphasis}; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${dur}"
         data-width="${CANVAS.w}" data-height="${CANVAS.h}" data-fps="${CANVAS.fps}">
${videoRel ? `      <video id="bg" class="clip" src="${videoRel}" data-start="0" data-duration="${dur}" data-track-index="0" data-volume="1"></video>\n` : ''}${nodes.join('\n')}
    </div>
    <script>
      // 이 등록이 없으면 렌더가 프레임을 한 장도 못 뜨고 무한 대기한다 (references/MOTION.md).
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
${tweens.join('\n')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}
