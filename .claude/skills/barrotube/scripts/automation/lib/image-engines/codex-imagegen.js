/**
 * codex-imagegen.js — Codex 내장 ImageGen 어댑터 (2026-08-20)
 *
 * `codex exec` 를 통해 Codex 런타임의 내장 `imagegen` 툴을 부른다.
 * ChatGPT 계정 인증(`codex login status` → "Logged in using ChatGPT")을 쓰므로
 * **OpenAI API 크레딧과 무관**하다. gpt-image-1(openai-gpt-image.js)이
 * credit_balance_exhausted 로 막힌 상태에서도 이 경로는 동작한다(2026-08-20 실측).
 *
 * 브라우저 ChatGPT(media-render) 대비 이점 — 실측(EP-2026-0105 5컷):
 *   - 무인 실행 가능: CLI 라 cron/배치에서 그대로 돈다. 브라우저 첨부가 막혀
 *     EP-0101·0102·0104 가 죽은 지점이 사라진다.
 *   - 파일을 작업 디렉터리에 직접 저장 — Downloads→History DB→Finder 우회 불필요.
 *   - 컷당 약 1분 (브라우저는 2~10분, DOM 정체·중복 다운로드 재시도 포함).
 *   - 5/5 성공, 중복 0.
 *
 * 주의: 프롬프트만 그대로 넘기면 캐릭터가 무너진다. 1차 실측에서 캡슐 몸통이
 * 사라지고 미튼 손이 손가락으로 변형됐다. 아래 CHARACTER_LOCK 을 반드시
 * 앞에 붙인다 — 붙인 뒤 5컷 전부 비율이 균일했다.
 *
 * 사용:
 *   import { generateImageCodex } from './lib/image-engines/codex-imagegen.js';
 *   await generateImageCodex({ prompt, outPath, channel: 'econ-daily' });
 */

import { existsSync, mkdtempSync, writeFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';

/**
 * 캐릭터 고정 블록.
 *
 * 시트를 `-i` 로 첨부해도 imagegen 은 "참고"만 하고 비율을 재창작한다.
 * 2026-08-20 EP-0105 scene_001 1차: 머리에 팔다리가 직접 붙어 캡슐 몸통이 소실,
 * 손은 손가락이 갈라진 장갑으로 변형. 같은 프롬프트에 이 블록만 덧붙인 2차에서
 * 몸통·미튼이 복원됐고, 5컷 연속으로도 유지됐다.
 *
 * 이 문구는 씬 프롬프트(30_script.md 의 image_prompt)에 넣지 않는다 —
 * image-prompt-contract.js 의 길이 밴드(640~780자)를 깨고, 엔진이 바뀌면
 * 무의미해지는 생성 시점 지시이기 때문이다. 엔진 어댑터가 소유한다.
 */
export const CHARACTER_LOCK = [
  'CRITICAL character fidelity rules — the attached sheet is the ONLY reference:',
  '- The mascot has a LARGE ROUND HEAD sitting on a VISIBLE SLIM CAPSULE BODY.',
  '  The body must read as a separate rounded torso below the head — never a head',
  '  with limbs attached directly.',
  '- Hands are WHITE MITTENS with NO separated fingers.',
  '- Feet are rounded shoe-shapes. Limbs are thin sticks.',
  '- Head-to-body width ratio must match the sheet (body roughly 0.6x the head width).',
  '- Full body visible, standing on the floor, NOT sitting on or straddling any object.',
].join('\n');

/**
 * 노출 고정 블록.
 *
 * imagegen 산출물은 브라우저 ChatGPT 대비 전반적으로 어둡다 — 같은 5컷 비교에서
 * 씬 001·003 배경이 검게 가라앉아 쇼츠 피드 가독성이 떨어졌다. 씬 프롬프트의
 * `[palette:*]` 와 BACKGROUND 절은 그대로 두고, 노출만 여기서 끌어올린다.
 *
 * "밝게"라고만 쓰면 배경이 회색으로 뜨면서 브랜드 다크 톤이 깨진다. 그래서
 * 배경은 어둡게 유지하되 **피사체 분리와 중간톤 디테일**을 요구하는 형태로 쓴다.
 */
export const EXPOSURE_LOCK = [
  'EXPOSURE — the image must read clearly in a small phone feed thumbnail:',
  '- Keep the deep navy brand background, but lift it out of pure black: the',
  '  background must retain visible mid-tone detail and texture, never a flat',
  '  black field.',
  '- The mascot is the brightest element in the frame, clearly separated from the',
  '  background by its own rim light.',
  '- The central scene object is fully lit and readable, not a dark silhouette.',
  '- Overall exposure is bright and punchy with strong local contrast.',
].join('\n');

/** 채널 캐릭터시트 경로. openai-gpt-image.js 의 sheetPath 와 같은 규칙이다. */
export function sheetPath(channel) {
  if (!channel) return null;
  const p = resolve('workspace', 'docs', `${channel === 'econ-daily' ? '바로경제' : channel}_캐릭터시트.png`);
  return existsSync(p) ? p : null;
}

/**
 * codex exec 로 이미지 1장을 만든다.
 *
 * @param {object}  o
 * @param {string}  o.prompt        씬 image_prompt (30_script.md 원문 그대로)
 * @param {string}  o.outPath       저장 경로 (.png)
 * @param {string} [o.channel]      캐릭터시트 조회용 (예: 'econ-daily')
 * @param {number} [o.timeoutMs]    기본 8분. 컷당 실측 약 1분.
 * @param {boolean}[o.characterLock] 기본 true. 마스코트가 없는 컷이면 false.
 * @param {boolean}[o.exposureLock]  기본 true.
 * @returns {'codex-imagegen'}
 */
export function generateImageCodex({
  prompt,
  outPath,
  channel = null,
  timeoutMs = 8 * 60 * 1000,
  characterLock = true,
  exposureLock = true,
}) {
  if (!prompt) throw new Error('generateImageCodex: prompt is required');
  if (!outPath) throw new Error('generateImageCodex: outPath is required');

  // codex 는 -C 로 준 디렉터리를 작업 루트로 삼고 거기에 파일을 만든다.
  // 에피소드 폴더를 그대로 열어주면 에이전트가 다른 파일을 건드릴 수 있으므로
  // 빈 임시 디렉터리에서 만들고 결과만 복사한다.
  const workDir = mkdtempSync(join(tmpdir(), 'bt-codex-img-'));
  const fileName = basename(outPath);

  try {
    const sheet = sheetPath(channel);
    const task = [
      `Use the imagegen tool to generate ONE 9:16 portrait image and save it as ${fileName} in the current working directory.`,
      '',
      ...(sheet && characterLock ? [CHARACTER_LOCK, ''] : []),
      ...(exposureLock ? [EXPOSURE_LOCK, ''] : []),
      'Image prompt:',
      String(prompt).replace(/\s+/g, ' ').trim(),
      '',
      'Do not write any other file. Report the final absolute file path when done.',
    ].join('\n');

    const taskPath = join(workDir, '_task.txt');
    writeFileSync(taskPath, task);

    const args = ['exec', '--skip-git-repo-check', '-C', workDir, '-s', 'workspace-write'];
    if (sheet) args.push('-i', sheet);

    const res = spawnSync('codex', args, {
      input: task,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });

    if (res.error) throw new Error(`codex exec 실행 실패: ${res.error.message}`);
    if (res.status !== 0) {
      const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().slice(-800);
      throw new Error(`codex exec exit ${res.status}: ${tail}`);
    }

    const produced = join(workDir, fileName);
    if (!existsSync(produced)) {
      const tail = `${res.stdout || ''}`.trim().slice(-800);
      throw new Error(`codex 가 ${fileName} 을 만들지 않았다. 마지막 출력:\n${tail}`);
    }
    if (statSync(produced).size < 10_000) {
      throw new Error(`codex 산출 파일이 비정상적으로 작다 (${statSync(produced).size} B): ${produced}`);
    }

    copyFileSync(produced, outPath);
    return 'codex-imagegen';
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
