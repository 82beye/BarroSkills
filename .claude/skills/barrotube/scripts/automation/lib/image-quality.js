/**
 * image-quality.js — 구운 이미지의 **픽셀**을 본다 (2026-09-25)
 *
 * 왜 필요한가: 지금까지 이미지 검사는 두 가지뿐이었다.
 *   ① image-prompt-contract — **프롬프트**가 규격을 지켰는지. 그림은 안 본다.
 *   ② generate-qa-report    — 파일이 **있는지**(existsSync). 내용은 안 본다.
 * 그 사이가 비어 있었다. PRD §10 이 이 공백을 "완화 수단이 없다"로 적어 두었고,
 * EP-2026-0173 씬 003(원본 EP-2026-0087 s010)이 계약을 지킨 프롬프트로 구웠는데도
 * 손이 미튼이 아니라 손가락으로 갈라진 채 통과했다.
 *
 * 여기서 잡는 것과 못 잡는 것을 분명히 해 둔다.
 *   잡는다   — 비율 틀어짐 · 단색/평면(생성 실패) · 노출 파탄 · 근접중복(같은 그림 재생산)
 *   못 잡는다 — 캐릭터 규격(미튼 손·캡슐 몸통). 이건 사람이나 멀티모달이 봐야 한다.
 *              그래서 contactSheet() 로 한 장에 모아 육안 검수 비용을 낮추는 쪽을 택한다.
 *
 * 임계값은 발명하지 않았다. 2026-09-25 에 현행 화풍 468컷을 재서 나온 분포다 —
 * 코퍼스가 통과하고 퇴화 출력만 떨어지는 자리에 뒀다. 재현 방법은 THRESHOLDS 주석.
 */

import sharp from 'sharp';

/**
 * 2026-09-25 현행 화풍 468컷 실측 분포:
 *   비율(w/h)  min 0.558 · p50 0.563 · p95 0.563 · max 0.667   (9:16 = 0.5625)
 *   표준편차   min 24.1 · p1 32.3 · p50 60.0 · max 94.3
 *   평균휘도   min 20.6 · p1 22.2 · p50 54.1 · p99 213.0 · max 225.0
 *   dHash 해밍 p1 16 · p5 20 · p50 28  (109,278 쌍)
 *
 * 비율 max 0.667 은 2:3(1024x1536) 로 구워진 10컷이고 규격 이탈이다 — 밴드를 9:16
 * ±3% 로 잡아 그쪽을 걸러낸다. 휘도 밴드는 p1~p99 를 WARN, 그 바깥 극단만 FAIL 로
 * 둔다. 이 채널은 배경이 deep navy 라 평균 20대가 정상이어서 "어두우면 불량"이
 * 아니다 — 새까맣거나 새하얀 것만 불량이다.
 */
export const THRESHOLDS = {
  aspect: { target: 9 / 16, tolerance: 0.03 },
  minWidth: 800,
  /** 이 아래는 단색·평면이다. 코퍼스 최솟값 24.1 보다 낮게 둬서 정상 컷은 걸리지 않는다. */
  flatSd: 20,
  /** 노출 경고 밴드 (코퍼스 p1~p99). 벗어나면 WARN — 화풍이 튄다는 신호다. */
  warnMean: [22, 213],
  /** 노출 파탄. 새까맣거나 새하얀 렌더. */
  failMean: [12, 240],
  /**
   * 근접중복 해밍 하한. 코퍼스 쌍 분포의 p1 이 16 이라 4 는 "사실상 같은 그림"이다.
   * **새로 구운 컷에만** 적용한다 — 재사용 폴백이 복사한 컷은 원본과 d=0 이 당연하고
   * (2026-09-25 측정에서 d=0 쌍 다수가 그것이었다), 그걸 불량으로 보고하면 운영자가
   * 없는 문제를 쫓는다.
   */
  dupHamming: 4,
};

export const PASS = 'PASS';
export const WARN = 'WARN';
export const FAIL = 'FAIL';

/** 픽셀 지표를 뽑는다. 32x32 회색조로 줄여서 재는 이유는 원본 2MB 를 다 읽을 필요가 없기 때문이다. */
export async function measureImage(path) {
  const img = sharp(path);
  const md = await img.metadata();
  const { data } = await img.clone()
    .resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });

  const n = data.length;
  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / n;
  let sq = 0;
  for (const v of data) sq += (v - mean) ** 2;

  return {
    path,
    width: md.width,
    height: md.height,
    aspect: md.width / md.height,
    mean,
    sd: Math.sqrt(sq / n),
    hash: await dHash(img),
  };
}

/**
 * dHash — 9x8 회색조에서 가로 이웃 밝기 비교로 64비트를 만든다.
 * 크기·압축·미세한 색 차이에 둔감하고 구도 변화에 민감해서 "같은 그림인가"에 맞다.
 */
export async function dHash(input) {
  const img = typeof input === 'string' ? sharp(input) : input.clone();
  const { data } = await img
    .resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let hash = 0n;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      hash = (hash << 1n) | (data[r * 9 + c] < data[r * 9 + c + 1] ? 1n : 0n);
    }
  }
  return hash;
}

/** 해밍 거리. */
export function hamming(a, b) {
  let x = a ^ b;
  let c = 0;
  while (x) {
    c += Number(x & 1n);
    x >>= 1n;
  }
  return c;
}

/**
 * 한 컷을 판정한다.
 * @param {object} m measureImage 결과
 * @param {{hash:bigint,label:string}[]} [corpus] 근접중복을 견줄 기존 컷들. 새로 구운 컷에만 넘긴다.
 */
export function judge(m, corpus = []) {
  const issues = [];
  const t = THRESHOLDS;

  const lo = t.aspect.target * (1 - t.aspect.tolerance);
  const hi = t.aspect.target * (1 + t.aspect.tolerance);
  if (!(m.aspect >= lo && m.aspect <= hi)) {
    issues.push({ severity: FAIL, code: 'ASPECT_OFF_SPEC',
      message: `비율 ${m.aspect.toFixed(3)} (${m.width}x${m.height}) — 9:16 밴드 ${lo.toFixed(3)}~${hi.toFixed(3)} 밖입니다.` });
  }
  if (m.width < t.minWidth) {
    issues.push({ severity: FAIL, code: 'TOO_SMALL',
      message: `가로 ${m.width}px — 최소 ${t.minWidth}px 미달. 렌더가 중간에 끊겼을 수 있습니다.` });
  }
  if (m.sd < t.flatSd) {
    issues.push({ severity: FAIL, code: 'FLAT_IMAGE',
      message: `표준편차 ${m.sd.toFixed(1)} — 단색·평면입니다(코퍼스 최솟값 24.1). 생성 실패로 봅니다.` });
  }
  if (m.mean < t.failMean[0] || m.mean > t.failMean[1]) {
    issues.push({ severity: FAIL, code: 'EXPOSURE_BROKEN',
      message: `평균휘도 ${m.mean.toFixed(1)} — 허용 ${t.failMean[0]}~${t.failMean[1]} 밖. 새까맣거나 새하얀 렌더입니다.` });
  } else if (m.mean < t.warnMean[0] || m.mean > t.warnMean[1]) {
    issues.push({ severity: WARN, code: 'EXPOSURE_OUTLIER',
      message: `평균휘도 ${m.mean.toFixed(1)} — 코퍼스 p1~p99 (${t.warnMean[0]}~${t.warnMean[1]}) 밖입니다. 화풍이 튈 수 있어 눈으로 한 번 보세요.` });
  }

  for (const c of corpus) {
    const d = hamming(m.hash, c.hash);
    if (d <= t.dupHamming) {
      issues.push({ severity: FAIL, code: 'NEAR_DUPLICATE',
        message: `기존 컷과 해밍 거리 ${d} (${c.label}) — 사실상 같은 그림입니다. 새로 굽는 의미가 없습니다.` });
      break;
    }
  }

  const verdict = issues.some((i) => i.severity === FAIL) ? FAIL
    : issues.some((i) => i.severity === WARN) ? WARN : PASS;
  return { verdict, issues };
}

/** 측정 + 판정을 한 번에. */
export async function checkImage(path, corpus = []) {
  const m = await measureImage(path);
  return { ...m, ...judge(m, corpus) };
}

/**
 * 콘택트시트 — 여러 컷을 한 장으로 붙인다.
 *
 * 캐릭터 규격(미튼 손·캡슐 몸통) 검사는 그림을 봐야 하고 자동 판정 수단이 없다.
 * 그래서 비용을 줄이는 쪽으로 간다 — 한 장이면 사람도 멀티모달도 한 번에 본다.
 */
export async function contactSheet(paths, outPath, { cols = 4, cell = 320 } = {}) {
  if (!paths.length) throw new Error('contactSheet: 이미지가 없습니다');
  const rows = Math.ceil(paths.length / cols);
  const cellH = Math.round(cell * 16 / 9);
  const tiles = [];
  for (let i = 0; i < paths.length; i++) {
    tiles.push({
      input: await sharp(paths[i]).resize(cell, cellH, { fit: 'contain', background: '#0b1220' }).png().toBuffer(),
      left: (i % cols) * cell,
      top: Math.floor(i / cols) * cellH,
    });
  }
  await sharp({
    create: { width: cols * cell, height: rows * cellH, channels: 3, background: '#0b1220' },
  }).composite(tiles).png().toFile(outPath);
  return { outPath, count: paths.length, cols, rows };
}

export default { THRESHOLDS, PASS, WARN, FAIL, measureImage, dHash, hamming, judge, checkImage, contactSheet };

/**
 * 여러 컷을 캐시와 함께 판정한다.
 *
 * 캐시가 필요한 이유: 재사용 폴백은 매 회차마다 후보 460여 컷을 훑는다. 매번 전부
 * 디코딩하면 폴백이 느려지고, 폴백은 이미 "다른 게 다 막혔을 때" 도는 마지막 수단이라
 * 거기서 시간을 더 쓰면 안 된다. 키는 경로+수정시각+크기라 파일이 바뀌면 자동으로
 * 무효가 된다.
 *
 * 근접중복은 여기서 보지 않는다 — 기존 컷끼리는 재사용 복사로 d=0 이 정상이다.
 */
export async function checkMany(paths, { cachePath = null, statSync: statFn = null } = {}) {
  const { readFileSync, writeFileSync, existsSync, statSync: nodeStat, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const stat = statFn || nodeStat;

  let cache = {};
  if (cachePath && existsSync(cachePath)) {
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
  }

  const out = new Map();
  let fresh = 0;
  for (const p of paths) {
    let key;
    try {
      const st = stat(p);
      key = `${p}|${Math.round(st.mtimeMs)}|${st.size}`;
    } catch {
      continue;
    }
    if (cache[key]) { out.set(p, cache[key]); continue; }
    try {
      const m = await measureImage(p);
      const { verdict, issues } = judge(m);
      const rec = { verdict, codes: issues.map((i) => i.code), width: m.width, height: m.height,
        mean: Number(m.mean.toFixed(2)), sd: Number(m.sd.toFixed(2)) };
      cache[key] = rec;
      out.set(p, rec);
      fresh += 1;
    } catch (e) {
      out.set(p, { verdict: FAIL, codes: ['UNREADABLE'], error: String(e.message || e) });
    }
  }

  if (cachePath && fresh) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
  }
  return { results: out, fresh };
}
