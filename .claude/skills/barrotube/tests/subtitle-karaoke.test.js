import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// 카라오케 자막 PNG 렌더러(render-karaoke-png.py)의 핵심 계약:
//  1) highlight 값이 달라도 레이아웃(이미지 크기)은 동일 → 상태 전환 시 글자 지터 없음
//  2) highlight 가 오를수록 강조색(gold) 픽셀이 늘고 기본색(white)이 준다 → TTS 싱크 색변화
// PIL 이 없으면 스킵(이 렌더 파이프라인 자체가 PIL 의존이라 실환경엔 항상 있음).

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'automation', 'render-karaoke-png.py');
const PY_VENV = join(process.env.HOME || '', 'youtube-co/.venv/bin/python3');
const PY = existsSync(PY_VENV) ? PY_VENV : 'python3';

function hasPIL() {
  return spawnSync(PY, ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
}

// 투명 PNG에서 gold(#FF9A1F 근사)·white 픽셀 수 세기
const COUNT_PY = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
px = list(im.getdata())
gold = sum(1 for r,g,b,a in px if a>200 and r>230 and 120<g<190 and b<80)
white = sum(1 for r,g,b,a in px if a>200 and r>240 and g>240 and b>240)
print(im.size[0], im.size[1], gold, white)
`;

function renderAndCount(dir, name, highlight) {
  const out = join(dir, `${name}.png`);
  const r = spawnSync(PY, [SCRIPT, '테슬라 매출 신기록에도 이익이 붕괴했다', out,
    '--highlight', String(highlight), '--width', '1080', '--fontsize', '60'], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `renderer failed: ${r.stderr}`);
  const c = spawnSync(PY, ['-c', COUNT_PY, out], { encoding: 'utf-8' });
  const [w, h, gold, white] = c.stdout.trim().split(/\s+/).map(Number);
  return { w, h, gold, white };
}

test('karaoke PNG: identical layout across states, gold rises with highlight', (t) => {
  if (!hasPIL()) { t.skip('PIL unavailable'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'karaoke-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const s0 = renderAndCount(dir, 'k0', 0);   // 강조 없음
  const s3 = renderAndCount(dir, 'k3', 3);   // 앞 3단어 강조
  const s6 = renderAndCount(dir, 'k6', 6);   // 전체 강조

  // 1) 레이아웃 동일 (지터 방지)
  assert.equal(s0.w, s3.w); assert.equal(s3.w, s6.w);
  assert.equal(s0.h, s3.h); assert.equal(s3.h, s6.h);

  // 2) gold 누적 증가, white 감소
  assert.ok(s0.gold === 0, `no highlight → gold=0, got ${s0.gold}`);
  assert.ok(s3.gold > s0.gold, 'gold rises at highlight=3');
  assert.ok(s6.gold > s3.gold, 'gold rises further at highlight=6');
  assert.ok(s6.white === 0, `full highlight → white=0, got ${s6.white}`);
  assert.ok(s0.white > 0, 'base state has white text');
});
