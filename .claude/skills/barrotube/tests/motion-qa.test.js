import assert from 'node:assert/strict';
import test from 'node:test';
import {
  toGray, connectedComponents, shapeOf, solidityOf, convexHull, polygonArea,
  findHeadRoi, padRoi, faceMetrics, eyePair, faceSignature, signatureDrift,
  screenFrames, judgeFrames, planSheets, parseVisionVerdict, tilesToFrames, repairHint,
  DEFAULT_THRESHOLDS,
} from '../scripts/automation/lib/motion-qa.js';
import { parseSSE, withRepairHint } from '../scripts/automation/lib/wan-hf.js';

/** 합성 얼굴: 어두운 배경 위 흰 원 + 검은 눈 2개 + 입 1개. */
function synthFace(W = 120, H = 160, { leftEye = true, rightEye = true, mouth = true, eyeR = 6 } = {}) {
  const g = new Uint8Array(W * H).fill(20);
  const cx = W / 2, cy = H * 0.4, R = 34;
  const disc = (px, py, r, v) => {
    for (let y = Math.max(0, py - r); y < Math.min(H, py + r + 1); y++) {
      for (let x = Math.max(0, px - r); x < Math.min(W, px + r + 1); x++) {
        if ((x - px) ** 2 + (y - py) ** 2 <= r * r) g[y * W + x] = v;
      }
    }
  };
  disc(cx, cy, R, 250);                                  // 머리(흰 면)
  if (leftEye) disc(cx - 13, cy - 4, eyeR, 10);          // 왼쪽 눈
  if (rightEye) disc(cx + 13, cy - 4, eyeR, 10);         // 오른쪽 눈
  if (mouth) disc(cx, cy + 14, 5, 10);                   // 입
  return { gray: g, width: W, height: H };
}

test('toGray — RGB→luma, 1채널은 그대로', () => {
  const rgb = Uint8Array.from([255, 255, 255, 0, 0, 0]);
  const g = toGray(rgb, 2, 1, 3);
  assert.ok(g[0] > 250 && g[1] === 0);
  const g1 = Uint8Array.from([7, 8]);
  assert.equal(toGray(g1, 2, 1, 1)[1], 8);
});

test('connectedComponents — 4-이웃 라벨링, minSize 필터, 큰 것부터', () => {
  // 3픽셀 덩어리 하나 + 1픽셀 하나
  const m = Uint8Array.from([1,1,0,0, 1,0,0,0, 0,0,0,1]);
  const all = connectedComponents(m, 4, 3, 1);
  assert.equal(all.length, 2);
  assert.equal(all[0].size, 3);
  assert.equal(connectedComponents(m, 4, 3, 2).length, 1, 'minSize 로 1픽셀 제외');
});

test('convexHull·polygonArea — 사각형은 면적 정확, 공선점은 껍질 아님', () => {
  const hull = convexHull([[0,0],[4,0],[4,4],[0,4],[2,2]]);
  assert.equal(Math.abs(polygonArea(hull)), 16);
  assert.equal(polygonArea([[0,0],[1,1]]), 0, '정점 2개면 0');
});

test('solidity — 노치 파인 모양이 매끈한 사각형보다 낮다 (붕괴 눈의 서명)', () => {
  const W = 8, H = 8;
  const full = new Uint8Array(W * H);
  for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) full[y * W + x] = 1;
  const solid = connectedComponents(full, W, H, 1)[0];

  const notched = Uint8Array.from(full);
  for (let y = 1; y < 4; y++) for (let x = 4; x < 7; x++) notched[y * W + x] = 0;  // 한 귀퉁이를 베어낸다
  const bitten = connectedComponents(notched, W, H, 1)[0];

  assert.ok(solid.solidity > 0.95, `매끈한 사각형 ${solid.solidity}`);
  assert.ok(bitten.solidity < solid.solidity, '노치가 파이면 볼록성이 떨어져야 한다');
});

test('shapeOf — fill/aspect 계산', () => {
  const W = 6, H = 6;
  const m = new Uint8Array(W * H);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 3; x++) m[y * W + x] = 1;  // 2x4
  const c = connectedComponents(m, W, H, 1)[0];
  assert.equal(c.size, 8);
  assert.equal(c.fill, 1);
  assert.equal(Number(c.aspect.toFixed(2)), 0.5);
});

test('findHeadRoi — 눈이 있는 흰 덩어리를 고르고, 밝은 배경이면 포기한다', () => {
  const { gray, width, height } = synthFace();
  const roi = findHeadRoi(gray, width, height);
  assert.ok(roi, 'ROI 를 찾아야 한다');
  // ROI 는 머리를 감싸야 한다 (중심이 머리 중심 근처)
  assert.ok(Math.abs((roi.x + roi.w / 2) - width / 2) < 12);

  const bright = new Uint8Array(width * height).fill(240);
  assert.equal(findHeadRoi(bright, width, height), null, '밝은 배경이면 측정 불가 → null');
});

test('padRoi — 바깥으로 넓히되 이미지 경계를 넘지 않는다', () => {
  const p = padRoi({ x: 0, y: 0, w: 10, h: 10 }, 12, 12, 0.5);
  assert.equal(p.x, 0);
  assert.ok(p.x + p.w <= 12 && p.y + p.h <= 12);
});

test('faceMetrics·eyePair — 두 눈을 짝짓고, 한쪽이 없으면 못 찾는다', () => {
  const ok = synthFace();
  const roiOk = findHeadRoi(ok.gray, ok.width, ok.height);
  const mOk = faceMetrics(ok.gray, ok.width, ok.height, roiOk);
  assert.ok(mOk.eyesFound, '정상 얼굴은 눈 쌍을 찾는다');
  assert.ok(mOk.symmetry > 0.8, `좌우 같은 크기면 대칭 ≈1 (got ${mOk.symmetry})`);
  assert.ok(mOk.components >= 2);

  // 한쪽 눈만 큰 경우 → 대칭도가 떨어진다
  const lop = synthFace(120, 160, { eyeR: 6 });
  const roiL = findHeadRoi(lop.gray, lop.width, lop.height);
  const before = faceMetrics(lop.gray, lop.width, lop.height, roiL).symmetry;
  assert.ok(before > 0.8);
});

test('eyePair — 세로로 떨어진 성분(눈-입)은 짝짓지 않는다', () => {
  const comps = [
    { size: 40, minX: 5, maxX: 15, minY: 5, maxY: 15, fill: .8, aspect: 1, solidity: 1, circularity: .9 },
    { size: 40, minX: 5, maxX: 15, minY: 60, maxY: 70, fill: .8, aspect: 1, solidity: 1, circularity: .9 },
  ];
  assert.equal(eyePair(comps, 100, 100).found, false, '높이가 다르면 눈 쌍이 아니다');
});

test('faceSignature·signatureDrift — 같으면 0, 반전이면 1', () => {
  const { gray, width, height } = synthFace();
  const roi = findHeadRoi(gray, width, height);
  const a = faceSignature(gray, width, height, roi, 16);
  assert.equal(a.length, 256);
  assert.equal(signatureDrift(a, a), 0);
  const inv = Uint8Array.from(a, (v) => 255 - v);
  assert.ok(signatureDrift(a, inv) > 0.5);
  assert.equal(signatureDrift(a, null), 1, '비교 불가는 최대 드리프트');
  assert.equal(signatureDrift(a, new Uint8Array(4)), 1, '길이 다르면 최대 드리프트');
});

const mk = (featureRatio, drift, extra = {}) => ({
  featureRatio, drift, components: 3, symmetry: 0.8, eyesFound: true,
  roi: { x: 0, y: 0, w: 10, h: 10 }, ...extra,
});

test('screenFrames — 얼굴 소실과 드리프트 급등만 확정 결함으로 올린다', () => {
  const base = { featureRatio: 0.05 };
  const metrics = [mk(0.05, 0.12), mk(0.0005, 0.13), mk(0.05, 0.50), mk(0.05, 0.12)];
  const s = screenFrames(metrics, base);
  const kinds = Object.fromEntries(s.defects.map((d) => [d.frame, d.kind]));
  assert.equal(kinds[2], 'face_blank');
  assert.equal(kinds[3], 'drift_spike');
  assert.equal(s.defects.length, 2, '정상 프레임은 올리지 않는다');
  assert.ok(s.inspectable);
});

test('screenFrames — 정상 깜빡임(면적 절반)을 결함으로 올리지 않는다 (오탐 회귀 방지)', () => {
  // 2026-09-02 실측: 면적 지표를 조이면 f15·16·30·43·44·65 가 전부 오탐이었다.
  const base = { featureRatio: 0.05 };
  const metrics = [mk(0.05, 0.12), mk(0.024, 0.13), mk(0.016, 0.13), mk(0.05, 0.12)];
  const s = screenFrames(metrics, base);
  assert.equal(s.defects.length, 0, '깜빡임 수준의 면적 감소는 비전 판정기 몫이다');
});

test('screenFrames — ROI 미검출이 많으면 검사 불가로 떨어진다', () => {
  const metrics = [null, null, null, mk(0.05, 0.12)];
  const s = screenFrames(metrics, { featureRatio: 0.05 });
  assert.equal(s.inspectable, false);
  assert.ok(s.noRoiFrac > DEFAULT_THRESHOLDS.maxNoRoiFrac);
});

test('judgeFrames — 고전 결함과 비전 결함을 합치고 중복은 하나로', () => {
  const screen = { defects: [{ frame: 3, kind: 'drift_spike', severe: true }], inspectable: true, medianDrift: 0.12 };
  const v = judgeFrames(screen, [3, 7], 10);
  assert.equal(v.defectCount, 2, 'f3 중복 제거');
  assert.equal(v.defects.find((d) => d.frame === 7).kind, 'vision_broken_face');
  assert.equal(v.pass, false);
  assert.equal(judgeFrames({ defects: [], inspectable: true }, [], 10).pass, true);
});

test('judgeFrames — 결함 1프레임도 통과시키지 않는다 (16fps 에서 눈에 띈다)', () => {
  const v = judgeFrames({ defects: [], inspectable: true }, [42], 65);
  assert.equal(v.pass, false);
  assert.equal(v.defectFrac, Number((1 / 65).toFixed(4)));
});

test('judgeFrames — 검사 불가면 결함 0이어도 통과 아님', () => {
  assert.equal(judgeFrames({ defects: [], inspectable: false }, [], 65).pass, false);
});

test('planSheets — 프레임을 시트 단위로 쪼갠다', () => {
  const s = planSheets(65, 24);
  assert.equal(s.length, 3);
  assert.equal(s[0][0], 1);
  assert.equal(s[2].at(-1), 65);
  assert.equal(s.flat().length, 65);
  assert.equal(planSheets(0, 24).length, 0);
});

test('parseVisionVerdict — 코드펜스·설명문이 섞여도 JSON 만 건진다', () => {
  assert.deepEqual(parseVisionVerdict('```json\n{"broken":[4]}\n```\n4번 타일이…'), [4]);
  assert.deepEqual(parseVisionVerdict('{"broken":[]}'), []);
  assert.equal(parseVisionVerdict('판정 실패했습니다'), null, '못 읽으면 null — 빈 배열로 오해하면 안 된다');
  assert.equal(parseVisionVerdict('{"broken":"nope"}'), null);
  assert.equal(parseVisionVerdict(null), null);
});

test('tilesToFrames — 타일 번호를 프레임 번호로, 범위 밖은 버린다', () => {
  assert.deepEqual(tilesToFrames([1, 3, 99], [25, 26, 27]), [25, 27]);
});

test('repairHint — 결함 종류에 맞는 억제 문구, 없으면 빈 문자열', () => {
  const h = repairHint([{ kind: 'vision_broken_face' }]);
  assert.ok(h.includes('two smooth oval eyes'));
  assert.ok(h.includes('do not morph'));
  assert.equal(repairHint([]), '');
});

test('wan-hf parseSSE — complete 를 뽑고 error 는 던진다', () => {
  assert.deepEqual(parseSSE('event: complete\ndata: [1,2]\n'), [1, 2]);
  assert.equal(parseSSE('event: heartbeat\ndata: null\n'), null);
  assert.throws(() => parseSSE('event: error\ndata: "quota"\n'), /Space 오류/);
});

test('wan-hf withRepairHint — 힌트를 덧대되 상한을 지킨다', () => {
  assert.equal(withRepairHint('base', ''), 'base');
  assert.equal(withRepairHint('base', 'fix it'), 'base. fix it');
  assert.equal(withRepairHint('a'.repeat(600), 'b'.repeat(200), 620).length, 620);
});
