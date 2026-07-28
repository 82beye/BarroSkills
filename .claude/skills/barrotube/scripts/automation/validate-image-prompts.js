#!/usr/bin/env node
/**
 * image_prompt 계약 검사 — 이미지를 굽기 전에 거는 게이트.
 *
 * 왜 QA(S8)가 아니라 여기인가: 정책 검사는 이미지가 나온 뒤에 돌아도 되지만,
 * 프롬프트 규격은 S6c 전에 걸려야 한다. 어긋난 프롬프트로 이미지를 만들면
 * 과금 + Grok 모션 클립 재생성까지 딸려온다(EP-2026-0070 실사례).
 *
 * 누가 대본을 썼든(Claude / Codex / Gemini / 사람) 같은 판정을 받는다 —
 * 모델 출력은 신뢰할 수 없고 게이트는 신뢰할 수 있다.
 *
 * 사용:
 *   node validate-image-prompts.js --episode <epdir> [--platform shorts] [--json]
 *   node validate-image-prompts.js --script <30_script.md 경로>
 *
 * 종료코드: 0 = 통과(WARN 은 통과) · 1 = BLOCK 있음 · 2 = 입력 오류
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkEpisodePrompts } from './lib/image-prompt-contract.js';

function scriptPath(values) {
  if (values.script) return values.script;
  if (!values.episode) return null;
  const platform = values.platform || 'shorts';
  const v2 = join(values.episode, 'platforms', platform, '30_script.md');
  const v1 = join(values.episode, '30_script.md');           // 구 레이아웃
  return existsSync(v2) ? v2 : v1;
}

function readScenes(path) {
  const text = readFileSync(path, 'utf-8');
  const ids = [...text.matchAll(/scene_id:\s*"?([\w-]+)"?/g)].map(m => m[1]);
  return [...text.matchAll(/image_prompt:\s*"((?:[^"\\]|\\.)*)"/gs)]
    .map((m, i) => ({ sceneId: ids[i] || `#${i + 1}`, prompt: m[1] }));
}

function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      script: { type: 'string', short: 's' },
      platform: { type: 'string', short: 'p' },
      json: { type: 'boolean', default: false },
    },
  });

  const path = scriptPath(values);
  if (!path || !existsSync(path)) {
    console.error('Usage: validate-image-prompts.js --episode <epdir> [--platform shorts] [--json]');
    if (path) console.error(`대본을 찾지 못했습니다: ${path}`);
    process.exit(2);
  }

  const scenes = readScenes(path);
  if (!scenes.length) {
    console.error(`image_prompt 가 하나도 없습니다: ${path}`);
    process.exit(2);
  }

  const result = checkEpisodePrompts(scenes);

  if (values.json) {
    console.log(JSON.stringify({ script: path, ...result }, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const s = result.stats;
  console.log(`\n📐 image_prompt 계약 검사 — ${path}`);
  console.log(`   ${s.scenes}컷 · 평균 ${s.avgChars}자 · 마스코트가 주어 ${s.subjectShare}% ` +
    `· 금지어 ${s.avgNegations}개 · 프레임% ${s.frameRatioSpecs}개`);
  console.log('   기준점 EP-2026-0069: 696자 · 58% · 0.2개 · 0개\n');

  if (!result.violations.length) {
    console.log('   ✅ 위반 없음\n');
    process.exit(0);
  }

  for (const v of result.violations) {
    const mark = v.severity === 'BLOCK' ? '⛔' : '⚠️ ';
    console.log(`   ${mark} [${v.code}] ${v.sceneId ? v.sceneId + ' ' : ''}${v.message}`);
  }

  const blocks = result.violations.filter(v => v.severity === 'BLOCK').length;
  console.log(`\n   ${blocks ? `⛔ BLOCK ${blocks}건 — 이미지 생성 전에 고치세요.` : '⚠️  경고만 — 진행 가능.'}`);
  console.log('   작성 규격: references/IMAGE-PROMPT.md\n');
  process.exit(result.ok ? 0 : 1);
}

main();
