/**
 * duplicate-stills.js — 같은 회차 안에서 앞 씬과 바이트가 같은 스틸 (2026-09-28)
 *
 * 브라우저 워커가 blob 다운로드에 실패하면 직전 씬이 남긴 자산을 복사하고도 "생성·저장
 * 완료"라고 보고한다. auto-pipeline 의 게이트(media_assets_ready)는 이것을 잡아
 * "images/scene_NNN.png(duplicate bytes)" 로 표시하고 폴백을 부르는데, 폴백들이 **파일이
 * 있으면 건너뛰는** 규칙이라 아무것도 하지 않았다.
 *
 * 2026-09-26 EP-2026-0184: scene_004 가 scene_003 과 같은 바이트였다. codex 폴백은
 * "Scene 004 exists" 로 건너뛰고, 재사용 폴백은 "스틸이 이미 있다" 로 건너뛰어 "채울 씬이
 * 없습니다" 를 찍은 뒤 게이트가 다시 멈춰 슬롯을 잃었다. 같은 주 09-21 EP-2026-0169 도
 * 같은 복사본(씬 002·005)이었다.
 *
 * 판정은 게이트와 같다 — 씬 번호 순으로 보며 **먼저 나온 것을 원본, 뒤에 나온 것을 중복**으로 본다.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function duplicateStills(imagesDir, sceneIds) {
  const firstByHash = new Map();
  const dup = new Set();
  for (const id of [...sceneIds].map((x) => String(x).padStart(3, '0')).sort()) {
    const p = join(imagesDir, `scene_${id}.png`);
    if (!existsSync(p) || statSync(p).size === 0) continue;
    const h = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (firstByHash.has(h)) dup.add(id);
    else firstByHash.set(h, id);
  }
  return dup;
}

export default { duplicateStills };
