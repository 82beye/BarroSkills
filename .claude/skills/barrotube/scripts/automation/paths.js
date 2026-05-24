/**
 * paths.js — Episode 디렉토리 경로 헬퍼
 *
 * v2 구조 (platforms/ 레이아웃):
 *   workspace/episodes/EP-NNNN/
 *     00_brief.md              (공통)
 *     series_link.json         (선택, 시리즈 멤버십)
 *     shared/                  (선택, 플랫폼 공통 자산)
 *     platforms/
 *       long/                  (long-3min 산출물)
 *         30_script.md, 35_factcheck.md, 40_assets/, 45_intro.png,
 *         47_thumbnail.png, 55_render/video.mp4, 60_qa_report.md,
 *         70_publish_meta.json, 75_board_approval.json, 80_publish_result.json
 *       shorts/                (Shorts 산출물 — 동일 schema)
 *       tiktok/                (배포 패키지: video_vertical.mp4, caption.txt, ...)
 *       reels/                 (동일)
 *
 * v1 (legacy 평면 구조)도 자동 fallback. EP-0001~0009 등 마이그레이션 안 한 디렉토리는
 * platforms/가 없으면 episodeDir 자체를 base로 사용한다.
 *
 * 사용법:
 *   const p = resolvePaths(episodeDir, 'long-3min');
 *   p.video    // EP/platforms/long/55_render/video.mp4 (v2) or EP/55_render/video.mp4 (v1)
 *   p.intro    // 45_intro.png 절대 경로
 *   p.isV2     // true면 platforms/ 레이아웃, false면 legacy
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FORMAT_TO_PLATFORM = {
  'long-3min': 'long',
  'long': 'long',
  'shorts': 'shorts',
  'shorts-60s': 'shorts',
  'tiktok': 'tiktok',
  'reels': 'reels',
};

export function formatToPlatform(format) {
  return FORMAT_TO_PLATFORM[format] || format || 'long';
}

/**
 * Episode 디렉토리 + format/platform → 모든 산출물 경로 반환.
 *
 * @param {string} episodeDir - 절대 또는 상대 경로 (resolve 처리됨)
 * @param {string} format - 'long-3min' | 'long' | 'shorts' | 'tiktok' | 'reels'
 * @returns {object} 경로 맵
 */
export function resolvePaths(episodeDir, format = 'long-3min') {
  const epAbs = resolve(episodeDir);
  const platform = formatToPlatform(format);
  const platformDir = join(epAbs, 'platforms', platform);
  const isV2 = existsSync(join(epAbs, 'platforms')) || existsSync(platformDir);
  const base = isV2 ? platformDir : epAbs;

  return {
    isV2,
    platform,
    episodeDir: epAbs,
    base,
    // 공통 (episodeDir 레벨, v1/v2 동일)
    brief:        join(epAbs, '00_brief.md'),
    seriesLink:   join(epAbs, 'series_link.json'),
    sharedDir:    join(epAbs, 'shared'),
    // 플랫폼별 산출물
    script:       join(base, '30_script.md'),
    factcheck:    join(base, '35_factcheck.md'),
    assetsDir:    join(base, '40_assets'),
    ttsDir:       join(base, '40_assets', 'tts'),
    imagesDir:    join(base, '40_assets', 'images'),
    intro:        join(base, '45_intro.png'),
    thumbnail:    join(base, '47_thumbnail.png'),
    renderDir:    join(base, '55_render'),
    video:        join(base, '55_render', 'video.mp4'),
    qa:           join(base, '60_qa_report.md'),
    meta:         join(base, '70_publish_meta.json'),
    approval:     join(base, '75_board_approval.json'),
    publishResult: join(base, '80_publish_result.json'),
  };
}

/**
 * frontmatter 파싱 없이 episodeDir만으로 platform 추측.
 * platforms/long 만 있으면 long, shorts만 있으면 shorts. 둘 다 없으면 legacy(long).
 * 호출자가 format을 모를 때 사용 (예: 80_publish_result.json 자동 감지).
 */
export function detectPrimaryPlatform(episodeDir) {
  const epAbs = resolve(episodeDir);
  for (const p of ['long', 'shorts']) {
    if (existsSync(join(epAbs, 'platforms', p, '80_publish_result.json'))) return p;
  }
  for (const p of ['long', 'shorts']) {
    if (existsSync(join(epAbs, 'platforms', p))) return p;
  }
  return 'long'; // legacy fallback
}

/**
 * 한 episodeDir에 존재하는 모든 platform 디렉토리 나열.
 * 마이그레이션·일괄 작업·QA 통합 보고서에서 사용.
 */
export function listPlatforms(episodeDir) {
  const epAbs = resolve(episodeDir);
  if (!existsSync(join(epAbs, 'platforms'))) return [];
  return ['long', 'shorts', 'tiktok', 'reels'].filter(p =>
    existsSync(join(epAbs, 'platforms', p))
  );
}
