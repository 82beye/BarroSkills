#!/usr/bin/env node

/**
 * reuse-scene-assets.js — 기존 마시 자산 재사용 폴백 (2026-09-22)
 *
 * 이미지를 굽는 경로가 **전부** 막혔을 때, 기존 에피소드의 씬 스틸과 모션 클립에서
 * 지금 대본에 가장 맞는 컷을 골라 복사한다. 생성 호출이 0회다.
 *
 * 왜 필요했나: 2026-09-22 us-close(EP-2026-0172) 실측 — ChatGPT 주간한도(9/25 해제),
 * codex imagegen(같은 계정·같은 한도), gpt-image-1 크레딧 고갈, Gemini 402,
 * Grok 주간한도 소진이 한꺼번에 걸렸다. Phase 7 이 halt 했고 코드로 풀 수 있는 생성
 * 경로가 하나도 없었다. 캐릭터 일관성은 이미 쌓인 자산이 담보한다 — 필요한 건 선별뿐이다.
 *
 * 이 스크립트는 **폴백**이다. 파이프라인은 브라우저 → codex imagegen → 이미지 API 를
 * 모두 시도한 뒤에만 여기로 온다. 정책은 config/asset-reuse.json 이 정본이다.
 *
 * Usage:
 *   node scripts/automation/reuse-scene-assets.js --script <30_script.md>
 *   node scripts/automation/reuse-scene-assets.js --script <...> --only 002,005
 *   node scripts/automation/reuse-scene-assets.js --script <...> --dry-run
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIndex,
  readTargetScenes,
  pickReuseSet,
  DEFAULT_POLICY,
} from './lib/scene-asset-index.js';
import { checkMany as checkManyImages } from './lib/image-quality.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'asset-reuse.json');
const QA_CACHE = join(ROOT, 'workspace', 'assets', 'image-qa-cache.json');
const EPISODES_ROOT = join(ROOT, 'workspace', 'episodes');
/**
 * 백필 라이브러리의 위치. classify-scene-assets.js 도 여기서 가져간다 — 경로를 두 벌
 * 두면 한쪽만 고쳐져 분류가 보는 자산과 재사용이 보는 자산이 갈린다.
 */
export const LIBRARY_ROOT = join(ROOT, 'workspace', 'assets', 'library');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { enabled: true, policy: DEFAULT_POLICY, reuse_motion_clips: true, ledger: null };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * 원본 클립이 **실제 모션**인지 판정한다.
 *
 * HyperFrames 클립은 복사할 이유가 없다 — 스틸만 있으면 로컬에서 무과금으로, 그것도
 * TTS 길이에 정확히 맞춰 다시 만들 수 있다(config/motion-engines.json local-only).
 * 재사용해서 이득인 건 쿼터 없이는 다시 만들 수 없는 grok·wan·ltx 클립뿐이다.
 *
 * 판정 순서:
 *   1) 원본 videos/_engines.json 의 engine 기록 — 파이프라인이 직접 쓴 값이라 정본이다.
 *   2) 기록이 없으면(_engines.json 도입 전 회차) AAC 오디오 스트림 유무.
 *      HyperFrames 클립은 설계상 무음이다. 2026-09-22 실측 204건 교차검증:
 *      grok 30/30 이 AAC, hyperframes 164/174 가 무음.
 */
export function isRealMotionClip(clipPath) {
  const enginesPath = join(dirname(clipPath), '_engines.json');
  const sceneId = (clipPath.match(/scene_(\d{3})\.mp4$/) || [])[1];

  if (sceneId && existsSync(enginesPath)) {
    try {
      const rec = JSON.parse(readFileSync(enginesPath, 'utf8'))[sceneId];
      if (rec && rec.engine) {
        return !/^hyperframes$/i.test(String(rec.engine));
      }
    } catch {
      // 손상된 기록은 없는 것으로 보고 오디오 판정으로 내려간다.
    }
  }

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', clipPath,
  ], { encoding: 'utf8' });
  return /aac/i.test(probe.stdout || '');
}

function loadLedger(cfg) {
  if (!cfg.ledger) return { path: null, entries: [] };
  const path = join(ROOT, cfg.ledger);
  if (!existsSync(path)) return { path, entries: [] };
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    return { path, entries: Array.isArray(d.entries) ? d.entries : [] };
  } catch {
    return { path, entries: [] };
  }
}

/** 프롬프트 출처 파일. 기존 생성기가 쓰는 scene_NNN.prompt.txt 와 같은 형식이다. */
function provenanceText(pick, scene) {
  return [
    `# scene_${pick.sceneId} (${scene.role || '?'})`,
    `# engine=reuse score=${pick.score}${pick.weak ? ' WEAK' : ''}`,
    `# source=${pick.source.episodeId} scene_${pick.source.sceneId}`,
    `# source_path=${relative(ROOT, pick.source.image)}`,
    `# reused_at=${new Date().toISOString()}`,
    '',
    '# 아래는 이 컷에 요청됐던 프롬프트다. 실제 그림은 위 source 에서 복사했으므로',
    '# 프롬프트와 완전히 일치하지 않는다 — 재사용 폴백의 구조적 한계다.',
    '',
    scene.prompt,
    '',
    '# --- 원본이 생성될 때 쓰인 프롬프트 ---',
    pick.source.prompt,
  ].join('\n');
}

export async function reuseSceneAssets({ scriptPath, only = null, dryRun = false, nowMs = Date.now() }) {
  const cfg = loadConfig();
  if (cfg.enabled === false) {
    throw new Error('config/asset-reuse.json 에서 enabled=false — 재사용 폴백이 꺼져 있습니다');
  }

  const scriptAbs = resolve(scriptPath);
  const base = dirname(scriptAbs);
  const imagesDir = join(base, '40_assets', 'images');
  const videosDir = join(base, '40_assets', 'videos');

  const allScenes = readTargetScenes(scriptAbs);
  const onlySet = only ? new Set(only.split(',').map((s) => s.trim().padStart(3, '0'))) : null;

  // 이미 정상 스틸이 있는 씬은 건드리지 않는다 — 파이프라인 전체가 top-up 방식이고,
  // 생성에 성공한 신선한 컷을 재활용으로 덮으면 품질이 거꾸로 간다.
  const scenes = allScenes.filter((s) => {
    if (onlySet && !onlySet.has(s.sceneId)) return false;
    const existing = join(imagesDir, `scene_${s.sceneId}.png`);
    if (existsSync(existing) && statSync(existing).size > 0) {
      console.log(`  ⏭  씬 ${s.sceneId}: 스틸이 이미 있다 — 건너뜀`);
      return false;
    }
    return true;
  });

  if (scenes.length === 0) {
    console.log('✅ 채울 씬이 없습니다.');
    return { picks: [], unmatched: [], copiedClips: 0 };
  }

  const episodeId = (readFileSync(scriptAbs, 'utf8').match(/episode_id:\s*(\S+)/) || [, ''])[1];
  const rawCandidates = buildIndex(EPISODES_ROOT, {
    excludeEpisodeIds: [episodeId].filter(Boolean),
    libraryRoot: LIBRARY_ROOT,
  });

  /**
   * 픽셀 QA 로 불량 원본을 후보에서 뺀다.
   *
   * 왜 필요한가: 폴백은 '무엇을 그렸나'만 보고 골랐다. 그래서 규격을 벗어난 원본을
   * 그대로 새 회차로 옮겼다 — 2026-09-25 실측에서 EP-2026-0178 이 EP-2026-0093·0094
   * 의 2:3(1024x1536) 컷을, EP-2026-0175 가 720x1280 컷을 받았다. 불량을 세탁해
   * 최신 회차로 내보내는 경로였다. 여기서 끊는다.
   */
  const { results: qa } = await checkManyImages(rawCandidates.map((c) => c.image), { cachePath: QA_CACHE });
  const candidates = rawCandidates.filter((c) => (qa.get(c.image)?.verdict ?? 'PASS') !== 'FAIL');
  const droppedByQa = rawCandidates.length - candidates.length;
  if (droppedByQa) {
    console.log(`  🔍 픽셀 QA 로 ${droppedByQa}컷 제외 — 규격 이탈·평면·노출 파탄`);
  }
  console.log(`📚 재사용 인덱스: ${candidates.length}컷 (클립 보유 ${candidates.filter((c) => c.video).length})`);

  const ledger = loadLedger(cfg);
  const { picks, unmatched } = pickReuseSet({
    scenes,
    candidates,
    policy: cfg.policy || {},
    ledger: ledger.entries,
    nowMs,
  });

  if (unmatched.length) {
    // 후보가 마르는 건 쿨다운·연령 조건이 너무 센 것이지 코드 결함이 아니다.
    // 무엇을 풀면 되는지 같이 알려 준다.
    console.warn(`⚠ 재사용 후보를 못 찾은 씬: ${unmatched.join(', ')}`);
    console.warn('  config/asset-reuse.json 의 min_source_age_days / cooldown_days 를 낮추면 후보가 늘어납니다.');
  }

  if (!dryRun) {
    mkdirSync(imagesDir, { recursive: true });
    mkdirSync(videosDir, { recursive: true });
  }

  let copiedClips = 0;
  const engines = {};
  const enginesPath = join(videosDir, '_engines.json');
  if (existsSync(enginesPath)) {
    try {
      Object.assign(engines, JSON.parse(readFileSync(enginesPath, 'utf8')));
    } catch { /* 손상되면 새로 쓴다 */ }
  }

  for (const pick of picks) {
    const scene = scenes.find((s) => s.sceneId === pick.sceneId);
    const destImg = join(imagesDir, `scene_${pick.sceneId}.png`);
    const wantClip = cfg.reuse_motion_clips !== false
      && pick.source.video
      && isRealMotionClip(pick.source.video);

    const tag = `${pick.source.episodeId} s${pick.source.sceneId}`;
    const mark = pick.filled_generic
      ? (pick.generic_object ? ' 🧩범용구도' : ' 🧩완주배정')
      : (pick.weak ? ' ⚠약함' : '');
    console.log(`  ♻︎ 씬 ${pick.sceneId} ← ${tag}  score=${pick.score}${mark}${wantClip ? ' +클립' : ''}`);

    // dry-run 도 **복사될 개수**를 세야 한다. 세지 않으면 요약이 "클립 0개" 로 나와
    // 운영자가 모션 없이 나간다고 잘못 읽는다.
    if (wantClip) copiedClips += 1;
    if (dryRun) continue;

    copyFileSync(pick.source.image, destImg);
    writeFileSync(join(imagesDir, `scene_${pick.sceneId}.prompt.txt`), provenanceText(pick, scene));

    if (wantClip) {
      copyFileSync(pick.source.video, join(videosDir, `scene_${pick.sceneId}.mp4`));
      engines[pick.sceneId] = {
        engine: 'reuse',
        source_episode: pick.source.episodeId,
        source_scene: pick.source.sceneId,
        source_image: `images/scene_${pick.sceneId}.png`,
        reused_at: new Date().toISOString(),
      };
    }
  }

  if (!dryRun && picks.length) {
    if (Object.keys(engines).length) {
      writeFileSync(enginesPath, `${JSON.stringify(engines, null, 2)}\n`);
    }

    // 재사용 명세. QA·회고가 "이 편의 어느 컷이 재활용인지"를 한 파일에서 읽는다.
    //
    // **기존 항목과 합친다.** --only 로 한 컷만 다시 고르면 통째로 덮어써서 나머지 컷의
    // 출처가 사라졌다(2026-09-23 EP-2026-0174 실측 — 5컷 중 1컷만 남았다). 그러면
    // doctor 의 asset_reuse 집계가 줄어들고 운영자가 무엇이 재활용인지 추적할 수 없다.
    const manifestPath = join(base, '40_assets', '_reuse.json');
    const prior = existsSync(manifestPath)
      ? (() => { try { return JSON.parse(readFileSync(manifestPath, 'utf8')).scenes || []; } catch { return []; } })()
      : [];
    const bySceneId = new Map(prior.map((s) => [s.scene_id, s]));
    for (const p of picks) {
      bySceneId.set(p.sceneId, {
        scene_id: p.sceneId,
        score: p.score,
        weak: p.weak,
        source_episode: p.source.episodeId,
        source_scene: p.source.sceneId,
        source_path: relative(ROOT, p.source.image),
        clip_reused: existsSync(join(videosDir, `scene_${p.sceneId}.mp4`))
          && engines[p.sceneId]?.engine === 'reuse',
        filled_generic: !!p.filled_generic,
        generic_object: !!p.generic_object,
      });
    }
    writeFileSync(manifestPath, `${JSON.stringify({
      version: 1,
      episode_id: episodeId,
      reused_at: new Date().toISOString(),
      reason: 'image generation unavailable (all engines exhausted)',
      scenes: [...bySceneId.values()].sort((a, b) => a.scene_id.localeCompare(b.scene_id)),
      unmatched,
    }, null, 2)}\n`);

    // 원장. 같은 원본이 연속 회차에 다시 박히는 걸 막는 쿨다운의 근거다.
    if (ledger.path) {
      mkdirSync(dirname(ledger.path), { recursive: true });
      const entries = [...ledger.entries];
      for (const p of picks) {
        entries.push({
          source_dir: p.source.sceneDir,
          source_scene_id: p.source.sceneId,
          source_episode: p.source.episodeId,
          used_by: episodeId,
          used_scene_id: p.sceneId,
          used_at: new Date().toISOString(),
          score: p.score,
        });
      }
      // 쿨다운 상한의 4배를 넘은 기록은 판정에 쓰이지 않는다 — 원장이 무한정 자라는 걸 막는다.
      const keepMs = (cfg.policy?.cooldown_days ?? DEFAULT_POLICY.cooldown_days) * 86400000 * 4;
      const kept = entries.filter((e) => {
        const t = Date.parse(e.used_at || '');
        return !Number.isFinite(t) || nowMs - t < keepMs;
      });
      writeFileSync(ledger.path, `${JSON.stringify({ version: 1, entries: kept }, null, 2)}\n`);
    }
  }

  return { picks, unmatched, copiedClips };
}

async function main() {
  const { values } = parseArgs({
    options: {
      script: { type: 'string' },
      only: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });

  if (!values.script) {
    console.error('Usage: reuse-scene-assets.js --script <30_script.md> [--only 002,005] [--dry-run]');
    process.exit(2);
  }

  console.log('♻︎  씬 자산 재사용 폴백 — 이미지 생성 호출 0회');
  const { picks, unmatched, copiedClips } = await reuseSceneAssets({
    scriptPath: values.script,
    only: values.only || null,
    dryRun: !!values['dry-run'],
  });

  const generic = picks.filter((p) => p.filled_generic).length;
  const weak = picks.filter((p) => p.weak && !p.filled_generic).length;
  console.log(`\n✅ 스틸 ${picks.length}컷 재사용 (클립 ${copiedClips}개 동반)`
    + `${weak ? `, 시각 매칭 약함 ${weak}컷` : ''}`
    + `${generic ? `, 완주용 범용 배정 ${generic}컷` : ''}`);
  if (generic) {
    console.log('   🧩 1차 후보가 말라 신선도 조건을 풀고 채웠다 — 주제가 덜 맞을 수 있으니 렌더 전 확인하세요.');
  }

  // 한 컷이라도 못 채웠으면 실패다. 호출한 파이프라인이 게이트로 다시 판정하지만,
  // 종료코드가 0 이면 로그만 보는 운영자가 성공으로 읽는다.
  if (unmatched.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
