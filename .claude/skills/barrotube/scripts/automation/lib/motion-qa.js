/**
 * motion-qa.js — 모션 클립의 프레임 단위 캐릭터 무결성 검사 (순수 함수, I/O 없음)
 *
 * 왜 필요한가. I2V 확산 모델(Wan 2.2 등)은 우리 마스코트처럼 넓은 단색 면 위에 작은
 * 고대비 피처만 있는 플랫 캐릭터에 약하다. 모션 도중 눈이 노치 파인 사각형으로 뭉개지고
 * 입이 흰 격자 막대가 된다. 60초 5클립이면 매번 300여 장이라 사람이 넘겨볼 수 없다.
 *
 * ── 2026-09-02 실측으로 확정한 설계 근거 ──
 *
 * 1) 프롬프트로 얼굴을 얼릴 수 없다. "face frozen, no blinking, no expression change" +
 *    영문 부정 프롬프트를 넣고 재생성했더니 표정이 그대로 변했고, 오히려 입이 흰 격자
 *    막대로 뭉개진 더 심한 붕괴가 나왔다. 그래서 '변했으면 결함'이라는 단순 규약은 못 쓴다.
 *
 * 2) 고전 CV 형태 지표만으로는 못 가른다. 실제 붕괴 프레임(f31, 오른쪽 눈이 노치 파인
 *    사각형)의 수치는 solidity 1.000 · symmetry 0.64 · featureRatio 0.47 로 **정상 프레임
 *    범위 안**이었다. 반대로 면적·대칭 지표가 잡아낸 f12·15·16·30·43·44·65 는 전부
 *    정상 깜빡임이었다 — 전량 오탐. 임계를 더 조여도 단일 사례 과적합일 뿐이다.
 *
 * 3) 그래서 **비전 모델이 정본 판정기**다. 같은 프레임 격자를 주고 물었더니 f31 하나만
 *    정확히 집어내고 깜빡임·입 크기 변화는 정상으로 배제했다.
 *
 * 이 모듈의 고전 지표는 판정용이 아니라 **보조**다: 얼굴 ROI 를 찾아 잘라내(비전 판정기에
 * 얼굴만 크게 보여주려고) 주고, ROI 소실·극단 드리프트 같은 파국적 실패를 비전 호출 없이
 * 빠르게 잡는다. 정상/붕괴의 미묘한 경계는 비전 판정기에 맡긴다.
 *
 * 좌표계: 모든 함수는 raw 픽셀 버퍼(RGB 또는 그레이)와 width/height 를 받는다.
 * sharp 의존은 호출부(CLI)에 두고 여기는 순수하게 유지한다 — 테스트가 파일을 안 만든다.
 */

/** 마스코트 본체로 볼 밝기 하한. 채널 마스코트는 흰 캐릭터다. */
export const BRIGHT_MIN = 200;
/** 얼굴 피처(눈·입 윤곽)로 볼 밝기 상한. */
export const DARK_MAX = 90;
/** 성분으로 인정할 최소 픽셀 수 (해상도 대비 비율로 환산해 쓴다). */
export const MIN_COMPONENT_FRAC = 0.0008;

/** RGB 버퍼 → 그레이(luma) Uint8Array. 이미 1채널이면 그대로 돌린다. */
export function toGray(buf, width, height, channels = 3) {
  if (channels === 1) return buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += channels) {
    // Rec.601 luma — 정수 연산으로 고정해 플랫폼 간 부동소수 차이를 없앤다.
    out[i] = (buf[p] * 77 + buf[p + 1] * 150 + buf[p + 2] * 29) >> 8;
  }
  return out;
}

/**
 * 이진 마스크의 연결 성분을 라벨링한다 (4-이웃, 반복 스택 — 재귀는 깊이 폭발한다).
 * 반환: [{ size, minX, maxX, minY, maxY }] — minSize 이상만.
 */
export function connectedComponents(mask, width, height, minSize = 1) {
  const seen = new Uint8Array(mask.length);
  const out = [];
  const stack = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let size = 0, minX = width, maxX = -1, minY = height, maxY = -1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width, y = (idx / width) | 0;
      size++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < width - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && mask[idx - width] && !seen[idx - width]) { seen[idx - width] = 1; stack[sp++] = idx - width; }
      if (y < height - 1 && mask[idx + width] && !seen[idx + width]) { seen[idx + width] = 1; stack[sp++] = idx + width; }
    }
    if (size >= minSize) out.push({ size, minX, maxX, minY, maxY });
  }
  for (const c of out) Object.assign(c, shapeOf(c, mask, width, height));
  return out.sort((a, b) => b.size - a.size);
}

/**
 * 성분의 형태 지표.
 *   fill        — size / bbox면적. 매끈한 타원 ≈ 0.79, 사각 덩어리 ≈ 1.0
 *   circularity — 4πA/P² (등주비). 매끈할수록 높고 노치·각진 경계일수록 낮다.
 *
 * 이게 필요한 이유: 붕괴한 눈은 **면적이 아니라 모양**이 깨진다. 2026-09-02 파일럿
 * 31프레임의 오른쪽 눈은 크기는 멀쩡한데 노치가 파인 사각형이 됐다 — 면적·대칭
 * 지표로는 정상으로 읽혔다. 이산 격자라 P 가 과대평가돼 절대값은 이론치보다 낮게
 * 나오지만, baseline 과 같은 방식으로 재므로 상대 비교에는 문제가 없다.
 */
export function shapeOf(c, mask, width, height) {
  const bw = c.maxX - c.minX + 1;
  const bh = c.maxY - c.minY + 1;
  let perimeter = 0;
  for (let y = c.minY; y <= c.maxY; y++) {
    for (let x = c.minX; x <= c.maxX; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1
        || !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width]) perimeter++;
    }
  }
  return {
    fill: c.size / (bw * bh),
    aspect: bw / bh,
    circularity: perimeter > 0 ? (4 * Math.PI * c.size) / (perimeter * perimeter) : 0,
    solidity: solidityOf(c, mask, width),
  };
}

/**
 * 볼록성(solidity) = 성분 면적 / 볼록껍질 면적.
 * 매끈한 눈(타원)은 1 에 가깝고, 노치가 파이면 떨어진다 — 붕괴한 눈의 '베어 문 자국'을
 * 직접 잡는 지표다. 원형도와 달리 둘레 추정 노이즈를 타지 않아 작은 성분에서도 안정적이다.
 */
export function solidityOf(c, mask, width) {
  const pts = [];
  for (let y = c.minY; y <= c.maxY; y++) {
    let first = -1, last = -1;
    for (let x = c.minX; x <= c.maxX; x++) {
      if (mask[y * width + x]) { if (first < 0) first = x; last = x; }
    }
    if (first < 0) continue;
    // 픽셀 **중심**이 아니라 **모서리**를 쓴다. 중심만 모으면 껍질이 실제 영역보다
    // 한 픽셀씩 작아져 solidity 가 1 을 넘고, 클램프에 걸려 모든 모양이 1.0 으로
    // 뭉개진다 — 노치를 재려는 지표가 노치를 못 보게 된다.
    pts.push([first, y], [first, y + 1], [last + 1, y], [last + 1, y + 1]);
  }
  if (pts.length < 3) return 1;
  const hull = convexHull(pts);
  const area = Math.abs(polygonArea(hull));
  return area > 0 ? Math.min(1, c.size / area) : 1;
}

/** 단조 체인 볼록껍질. 반시계 방향 정점 배열. */
export function convexHull(points) {
  const p = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (src) => {
    const out = [];
    for (const pt of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], pt) <= 0) out.pop();
      out.push(pt);
    }
    out.pop();
    return out;
  };
  return [...build(p), ...build([...p].reverse())];
}

/** 신발끈 공식. 껍질 정점이 2개 이하면 0. */
export function polygonArea(poly) {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j][0] * poly[i][1]) - (poly[i][0] * poly[j][1]);
  }
  return s / 2;
}

/**
 * 마스코트 얼굴 ROI 를 찾는다.
 *
 * 마스코트는 어두운 배경 위의 흰 캐릭터고, 검은 윤곽선이 머리 안쪽 흰 면을 팔·다리와
 * 끊어 놓는다. 그래서 '밝은 연결 성분' 중 머리 안쪽 원이 독립 덩어리로 잡힌다.
 *
 * 후보 중 무엇이 얼굴인지는 **눈이 있는 것**으로 고른다 — 배 상부구조처럼 흰 덩어리는
 * 많지만 안쪽에 두 개짜리 어두운 피처를 품은 건 얼굴뿐이다. 이 자기검증이 없으면
 * '가장 큰 밝은 덩어리' 휴리스틱이 조용히 엉뚱한 데를 재게 된다.
 *
 * ROI 는 찾은 원을 바깥으로 살짝 넓힌다. 그래야 검은 윤곽선이 ROI 경계에 닿아
 * '가장자리 성분 제외' 규칙에 걸려 빠지고, 눈·입만 내부 피처로 남는다.
 * (넓히지 않으면 윤곽선이 ROI 밖이라 안 걸리는 대신, 경계에 붙은 눈이 잘려 나간다 —
 *  2026-09-02 실측에서 65프레임 중 64개가 featureRatio 0 으로 읽힌 원인이었다.)
 *
 * 밝은 배경 씬에서는 분리가 불가능하다 — null 을 돌려 호출부가 검사를 접게 한다.
 * 추정으로 엉뚱한 영역을 재느니 '측정 불가'가 정직하다.
 */
export function findHeadRoi(gray, width, height, { brightMin = BRIGHT_MIN, pad = 0.10, darkMax = DARK_MAX } = {}) {
  const mask = new Uint8Array(gray.length);
  let bright = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] >= brightMin) { mask[i] = 1; bright++; }
  }
  if (bright > gray.length * 0.45) return null;
  const comps = connectedComponents(mask, width, height, Math.round(gray.length * 0.002));
  let best = null;
  for (const c of comps.slice(0, 12)) {
    const cw = c.maxX - c.minX + 1;
    const ch = c.maxY - c.minY + 1;
    if (cw < width * 0.06 || ch < height * 0.03) continue;
    const aspect = cw / ch;
    if (aspect < 0.55 || aspect > 1.9) continue;   // 얼굴은 대체로 원형이다
    const roi = padRoi({ x: c.minX, y: c.minY, w: cw, h: ch }, width, height, pad);
    const m = faceMetrics(gray, width, height, roi, { darkMax });
    // 눈 2개(+입)를 품은 후보만 얼굴로 본다.
    const score = m.components >= 2 ? m.components * 1e6 + c.size : c.size;
    if (m.components >= 2 && (!best || score > best.score)) best = { roi, score };
  }
  return best?.roi ?? null;
}

/** ROI 를 비율만큼 바깥으로 넓히고 이미지 경계로 자른다. */
export function padRoi(roi, width, height, frac = 0.10) {
  const dx = Math.round(roi.w * frac);
  const dy = Math.round(roi.h * frac);
  const x = Math.max(0, roi.x - dx);
  const y = Math.max(0, roi.y - dy);
  return {
    x, y,
    w: Math.min(width - x, roi.w + 2 * dx),
    h: Math.min(height - y, roi.h + 2 * dy),
  };
}

/**
 * ROI 안의 얼굴 피처를 잰다.
 *   featureRatio — 어두운 픽셀 / ROI 면적. 눈·입이 지워지면 0 에 수렴한다.
 *   components   — 의미 있는 크기의 어두운 덩어리 수. 정상 2~3 (눈 2 + 입).
 *   symmetry     — min(좌,우)/max(좌,우) 의 어두운 면적 비. 한쪽 눈이 날아가면 0 에 가깝다.
 *
 * 주의: ROI 는 머리 윤곽선(검은 테두리)을 포함할 수 있다. 테두리는 ROI 가장자리에
 * 붙어 있어 성분 하나로 뭉치므로, 가장자리에 닿는 성분은 피처에서 뺀다.
 */
export function faceMetrics(gray, width, height, roi, { darkMax = DARK_MAX, minComponentFrac = MIN_COMPONENT_FRAC } = {}) {
  const { x, y, w, h } = roi;
  const area = w * h;
  const sub = new Uint8Array(area);
  let darkAll = 0, leftDark = 0, rightDark = 0;
  const midX = w / 2;
  for (let j = 0; j < h; j++) {
    const srcRow = (y + j) * width;
    for (let i = 0; i < w; i++) {
      const v = gray[srcRow + x + i];
      if (v <= darkMax) {
        sub[j * w + i] = 1;
        darkAll++;
        if (i < midX) leftDark++; else rightDark++;
      }
    }
  }
  const minSize = Math.max(4, Math.round(area * minComponentFrac));
  const all = connectedComponents(sub, w, h, minSize);
  // 머리 윤곽선 제거: ROI 경계에 닿는 성분은 얼굴 피처가 아니다.
  const inner = all.filter((c) => c.minX > 0 && c.minY > 0 && c.maxX < w - 1 && c.maxY < h - 1);
  const innerDark = inner.reduce((s, c) => s + c.size, 0);
  const eyes = eyePair(inner, w, h);
  return {
    featureRatio: innerDark / area,
    components: inner.length,
    symmetry: eyes.balance,
    eyesFound: eyes.found,
    circularity: eyes.circularity,
    solidity: eyes.solidity,
    shapeMatch: eyes.shapeMatch,
    fill: eyes.fill,
    darkRatioAll: darkAll / area,
    roi,
  };
}

/**
 * 내부 피처들 중 '눈 한 쌍'을 찾아 좌우 균형을 잰다.
 *
 * ROI 중심선으로 좌/우 면적을 가르는 방식은 못 쓴다 — 마스코트가 주먹을 얼굴 옆으로
 * 들면 흰 덩어리가 머리+주먹으로 붙어 bbox 가 옆으로 늘고, 중심선이 얼굴 밖으로
 * 밀려 두 눈이 모두 한쪽에 몰린다 (2026-09-02 실측: 정상 프레임 1~8 이 symmetry 0.00).
 * 그래서 중심선이 아니라 **눈처럼 생긴 두 성분을 직접 짝지어** 크기 비를 본다.
 *
 * 눈의 조건: 세로 위치가 비슷하고(같은 높이) 가로로 떨어져 있다.
 */
export function eyePair(components, w, h) {
  const cy = (c) => (c.minY + c.maxY) / 2;
  const cx = (c) => (c.minX + c.maxX) / 2;
  const bySize = [...components].sort((a, b) => b.size - a.size).slice(0, 6);
  let best = null;
  for (let i = 0; i < bySize.length; i++) {
    for (let j = i + 1; j < bySize.length; j++) {
      const a = bySize[i], b = bySize[j];
      if (Math.abs(cy(a) - cy(b)) > h * 0.18) continue;   // 같은 높이여야 눈이다
      if (Math.abs(cx(a) - cx(b)) < w * 0.08) continue;   // 가로로 떨어져 있어야 한다
      const total = a.size + b.size;
      if (!best || total > best.total) {
        const ratio = (p, q) => (Math.max(p, q) > 0 ? Math.min(p, q) / Math.max(p, q) : 1);
        best = {
          total,
          balance: Math.min(a.size, b.size) / Math.max(a.size, b.size),
          // 두 눈 중 더 망가진 쪽을 대표값으로 쓴다 — 한쪽만 뭉개져도 화면은 깨져 보인다.
          circularity: Math.min(a.circularity ?? 1, b.circularity ?? 1),
          solidity: Math.min(a.solidity ?? 1, b.solidity ?? 1),
          fill: Math.max(a.fill ?? 0, b.fill ?? 0),
          // 붕괴의 결정적 신호: 정상 프레임의 두 눈은 서로 닮았고(깜빡임도 둘이 같이
          // 감긴다), 붕괴는 **한쪽만** 망가져 좌우 형태가 어긋난다.
          shapeMatch: Math.min(ratio(a.fill ?? 0, b.fill ?? 0), ratio(a.aspect ?? 1, b.aspect ?? 1)),
        };
      }
    }
  }
  return best
    ? {
      found: true, balance: best.balance, circularity: best.circularity,
      solidity: best.solidity, fill: best.fill, shapeMatch: best.shapeMatch,
    }
    : { found: false, balance: 0, circularity: 0, solidity: 0, fill: 0, shapeMatch: 0 };
}

/**
 * 얼굴 ROI 를 고정 크기 그레이 패치로 정규화한다 (최근접 샘플링).
 *
 * 프레임마다 ROI 크기·위치가 조금씩 달라서 픽셀을 그대로 빼면 위치 차이가 곧 차이로
 * 읽힌다. 같은 격자로 리샘플해 '얼굴 안에서 무엇이 달라졌나'만 남긴다.
 */
export function faceSignature(gray, width, height, roi, size = 32) {
  const out = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const sy = Math.min(height - 1, roi.y + Math.floor((j + 0.5) * roi.h / size));
    for (let i = 0; i < size; i++) {
      const sx = Math.min(width - 1, roi.x + Math.floor((i + 0.5) * roi.w / size));
      out[j * size + i] = gray[sy * width + sx];
    }
  }
  return out;
}

/**
 * 두 얼굴 서명의 드리프트 = 평균 절대 차 / 255 (0=동일, 1=완전 반전).
 *
 * 얼굴을 얼려 놓고 배경만 움직이게 생성하면, 이 값이 곧 '얼굴이 깨졌는가'가 된다.
 * 표정 변화가 정상인지 붕괴인지 판별하는 어려운 문제를, 변화 자체를 금지해
 * **변했으면 결함**이라는 판정 가능한 문제로 바꾸는 게 이 지표의 목적이다.
 * (2026-09-02: 표정을 허용한 채로 형태 지표만으로 붕괴를 가리려다 실패했다 —
 *  노치 파인 사각형 눈이 solidity 1.00 으로 읽혀 정상 프레임과 구분되지 않았다.)
 */
export function signatureDrift(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / (a.length * 255);
}

/**
 * 기본 임계.
 *
 * 고전 지표 임계는 **파국적 실패만** 잡도록 느슨하게 잡았다. 미묘한 붕괴를 여기서
 * 잡으려고 조이면 정상 깜빡임이 대량 오탐된다는 걸 실측으로 확인했다 (모듈 헤더 §2).
 * 정상/붕괴의 경계 판정은 비전 판정기 몫이다.
 */
export const DEFAULT_THRESHOLDS = {
  // 얼굴이 통째로 사라진 수준 — 깜빡임으로 설명 불가. 소스 대비 피처 면적 비.
  blankRatioFloor: 0.02,
  // 클립 자체 중앙값 대비 드리프트 배수. 프레임 하나가 확 튀면 붕괴 신호다.
  driftSpikeMultiple: 2.2,
  // ROI 를 못 찾은 프레임 비율이 이보다 크면 검사 자체가 성립하지 않는다.
  maxNoRoiFrac: 0.15,
  // 최종 허용 결함 프레임 비율. 16fps 에서 1프레임은 62ms — 눈에 띈다.
  maxDefectFrac: 0.0,
};

/**
 * 고전 지표 사전 선별. **비전 판정기를 대체하지 않는다** — 비전 호출 없이도 확실한
 * 파국(얼굴 소실·ROI 소실·드리프트 급등)만 잡고, 나머지는 비전에 넘길 후보를 고른다.
 *
 * 반환 defects 는 '확실한 결함', suspects 는 '비전이 봐야 할 후보'다.
 */
export function screenFrames(metrics, baseline, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const base = baseline?.featureRatio ?? 0;
  const drifts = metrics.filter((m) => m && Number.isFinite(m.drift)).map((m) => m.drift).sort((a, b) => a - b);
  const medDrift = drifts.length ? drifts[Math.floor(drifts.length / 2)] : 0;

  const defects = [];
  const suspects = [];
  let noRoi = 0;
  metrics.forEach((m, i) => {
    const frame = i + 1;
    if (!m) { noRoi++; suspects.push({ frame, kind: 'no_roi' }); return; }
    const rel = base > 0 ? m.featureRatio / base : 1;
    if (rel <= t.blankRatioFloor) {
      defects.push({ frame, kind: 'face_blank', severe: true, rel: round3(rel), drift: round3(m.drift) });
      return;
    }
    if (medDrift > 0 && m.drift >= medDrift * t.driftSpikeMultiple) {
      defects.push({ frame, kind: 'drift_spike', severe: true, rel: round3(rel), drift: round3(m.drift) });
      return;
    }
    if (!m.eyesFound) suspects.push({ frame, kind: 'eyes_unclear', rel: round3(rel), drift: round3(m.drift) });
  });

  return {
    defects,
    suspects,
    medianDrift: round3(medDrift),
    noRoiFrac: metrics.length ? noRoi / metrics.length : 0,
    inspectable: metrics.length > 0 && (noRoi / metrics.length) <= t.maxNoRoiFrac,
    thresholds: t,
  };
}

const round3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);

/**
 * 고전 선별 + 비전 판정 결과를 합쳐 최종 판정을 낸다.
 * visionDefects 는 프레임 번호 배열 (1-based).
 */
export function judgeFrames(screen, visionDefects = [], frameCount = 0, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const byFrame = new Map();
  for (const d of screen.defects) byFrame.set(d.frame, d);
  for (const f of visionDefects) {
    if (!byFrame.has(f)) byFrame.set(f, { frame: f, kind: 'vision_broken_face', severe: true });
  }
  const defects = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  const frac = frameCount ? defects.length / frameCount : 0;
  return {
    pass: screen.inspectable && frac <= t.maxDefectFrac,
    inspectable: screen.inspectable,
    defectCount: defects.length,
    defectFrac: Number(frac.toFixed(4)),
    frameCount,
    defects,
    medianDrift: screen.medianDrift,
    thresholds: t,
  };
}

/**
 * 프레임을 비전 판정기에 보낼 시트 단위로 쪼갠다.
 * 타일이 너무 많으면 모델이 격자 번호를 헷갈린다 — 24개(6x4)가 실측상 안정적이다.
 */
export function planSheets(frameCount, perSheet = 24) {
  const out = [];
  for (let i = 0; i < frameCount; i += perSheet) {
    out.push(Array.from({ length: Math.min(perSheet, frameCount - i) }, (_, k) => i + k + 1));
  }
  return out;
}

/**
 * 비전 판정기 응답에서 깨진 타일 번호를 뽑는다.
 * 모델이 코드펜스·설명문을 섞어도 첫 JSON 객체만 건져 쓴다. 못 읽으면 null —
 * 호출부가 '판정 실패'로 다루게 한다 (빈 배열로 오해해 PASS 시키면 안 된다).
 */
export function parseVisionVerdict(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*?"broken"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.broken)) return null;
    return j.broken.map(Number).filter((n) => Number.isInteger(n) && n >= 1);
  } catch { return null; }
}

/** 시트 내 타일 번호(1-based) → 실제 프레임 번호. 범위 밖은 버린다. */
export function tilesToFrames(tiles, sheetFrames) {
  return tiles.map((t) => sheetFrames[t - 1]).filter((f) => Number.isInteger(f));
}

/** 결함 종류 → 재생성 시 프롬프트에 덧댈 억제 문구. */
export function repairHint(defects) {
  const kinds = new Set(defects.map((d) => d.kind));
  const hints = [];
  if (kinds.has('vision_broken_face')) {
    hints.push('render the character face cleanly in every frame: two smooth oval eyes and one simple mouth, no jagged or blocky shapes');
  }
  if (kinds.has('face_blank')) hints.push('keep both eyes and the mouth clearly visible at all times');
  if (kinds.has('drift_spike')) hints.push('keep the character stable, avoid sudden jumps or flicker');
  if (hints.length) hints.push('do not morph, erase, or redraw the facial features');
  return hints.join(', ');
}
