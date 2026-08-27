import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SHORTS_SAFE, safeTop, CANVAS_H } from '../scripts/automation/lib/thumbnail-composer.js';

const ROOT = join(import.meta.dirname, '..');

/** 안전구역 도입(2026-08-27) 전에 발행돼 되돌릴 수 없는 회차. 새로 추가되면 회귀다. */
const KNOWN_VIOLATIONS = new Set(['EP-2026-0117', 'EP-2026-0118']);

// 2026-08-27 EP-2026-0118(운영자 스크린샷): 인트로 타이틀이 상단 5.8% 에서 시작해
// Shorts 의 상태바·뒤로가기·검색·⋮ 아이콘이 첫 줄 위에 얹혔다. EP-0117 도 8.6%.
// generate-cards.js 로 만든 EP-0114(22.6%)·EP-0116(24.4%)은 안전했다 — 경로마다
// 값이 달라 생긴 회귀다. 값을 한 곳에 두고 세 경로가 같이 보게 한다.

test('안전구역 값이 Shorts UI 를 실제로 덮을 만큼은 된다', () => {
  assert.ok(SHORTS_SAFE.topPct >= 0.12, `상단 ${SHORTS_SAFE.topPct} — 12% 미만이면 네비 아이콘에 걸린다`);
  assert.ok(SHORTS_SAFE.bottomPct >= 0.18, '하단은 채널·제목·설명·공유 바가 차지한다');
  assert.ok(SHORTS_SAFE.rightPct >= 0.12, '우측은 좋아요·댓글·공유·리믹스 열이다');
});

test('safeTop 은 위로 올라간 값을 안전선까지 민다', () => {
  const line = Math.round(CANVAS_H * SHORTS_SAFE.topPct);
  assert.equal(safeTop(80), line, '80(4.2%) 은 상태바 아래다 — 밀어야 한다');
  assert.equal(safeTop(240), line, '240(12.5%) 도 안전선보다 위다');
  assert.equal(safeTop(line + 50), line + 50, '이미 안전하면 건드리지 않는다');
});

test('합성기가 헤드라인을 safeTop 으로 통과시킨다', () => {
  const src = readFileSync(join(ROOT, 'scripts/automation/lib/thumbnail-composer.js'), 'utf-8');
  assert.match(src, /const blockTop = safeTop\(/,
    '헤드라인 위치를 상수로 박으면 안전선을 우회한다');
  assert.ok(!/const blockTop = isIntro \? 80 : 240;/.test(src),
    '옛 고정값이 남아 있으면 회귀한다');
});

test('브라우저 경로 지시문에도 안전구역이 적혀 있다', () => {
  // 0117·0118 을 만든 건 합성기가 아니라 브라우저(codex) 경로다. 코드만 고치면
  // 그쪽은 그대로 상단에 그린다. 게다가 "최근 완료 EP 를 참고하라" 는 지시가
  // 틀린 배치를 복제하므로, 안전구역이 그보다 우선한다는 것도 적어야 한다.
  const mr = readFileSync(join(ROOT, '..', 'barrotube-media-render', 'SKILL.md'), 'utf-8');
  assert.match(mr, /상단 14% 아래에서 시작한다/, '인트로 지시에 안전구역이 있어야 한다');
  assert.match(mr, /틀린 배치도 복제한다/, '참고본을 그대로 따라 하지 말라고 해야 한다');
  assert.match(readFileSync(join(ROOT, 'SKILL.md'), 'utf-8'), /상단 14% 아래에서 시작한다/);
});

test('발행된 인트로가 안전구역을 지킨다', { skip: !existsSync(join(ROOT, 'workspace', 'episodes')) && 'workspace 없음' }, async () => {
  // 산출물을 직접 본다 — 코드가 맞아도 브라우저 경로가 어기면 여기서 잡힌다.
  const sharp = (await import('sharp')).default;
  const epRoot = join(ROOT, 'workspace', 'episodes');
  const eps = readdirSync(epRoot).filter((d) => /^EP-\d{4}-\d{4}$/.test(d)).sort().slice(-2);
  const line = Math.round(SHORTS_SAFE.topPct * 1000) / 10;
  for (const ep of eps) {
    const f = join(epRoot, ep, 'platforms', 'shorts', '45_intro.png');
    if (!existsSync(f)) continue;
    const { data, info } = await sharp(f).greyscale().raw().toBuffer({ resolveWithObject: true });
    let first = -1;
    for (let y = 0; y < Math.round(info.height * 0.3) && first < 0; y++) {
      let bright = 0;
      for (let x = 0; x < info.width; x += 3) if (data[y * info.width + x] > 190) bright++;
      if (bright > info.width / 3 / 25) first = y;
    }
    if (first < 0) continue;                       // 상단에 글자가 없으면 통과
    const pct = (first / info.height) * 100;
    // 수정 이전에 발행된 회차는 이미 YouTube 에 올라가 있어 되돌릴 수 없다. 여기 적어 두는
    // 것은 면제가 아니라 **기록**이다 — 이 목록이 늘어나면 수정이 안 먹고 있다는 뜻이다.
    if (KNOWN_VIOLATIONS.has(ep)) {
      assert.ok(pct < line, `${ep}: 고쳐졌다면 KNOWN_VIOLATIONS 에서 빼라 (현재 ${pct.toFixed(1)}%)`);
      continue;
    }
    assert.ok(pct >= line,
      `${ep}: 인트로 타이틀이 상단 ${pct.toFixed(1)}% 에서 시작한다 (안전선 ${line}%) — Shorts UI 가 덮는다`);
  }
});
