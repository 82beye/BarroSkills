#!/usr/bin/env node
/**
 * revise-script-factcheck.js — 팩트체크가 짚은 문장만 고쳐 대본을 갱신한다 (S5 → S4 되먹임)
 *
 * 왜 필요한가 (2026-08-17):
 * config/autonomy-pause.json 에 `factcheck_max_rewrites: 2` 가 있고 AUTO-PIPELINE.md 도
 * "2회 시도 후 escalation" 이라 적어 뒀는데, 정작 그 루프가 코드에 없었다. Phase 6 은
 * MED 부정확을 보면 곧장 halt_for_human 으로 빠졌고, 8/16·8/17 이틀 연속 에피소드가
 * 여기서 멈춰 게시가 0건이 됐다 — 리포트가 claim 마다 `수정 제안` 을 써 주는데도.
 *
 * 이 스크립트는 그 수정 제안을 실제로 적용한다. 대본 전체를 다시 굴리지 않는다:
 * 지적된 씬의 narration·subtitle_text 만 바꾸고 image_prompt·target_seconds 는 그대로 둔다.
 * 전면 재생성은 이미 통과한 씬까지 새 주사위를 굴려 새 위반을 만든다 (Phase 5 재작성에서 겪음).
 *
 * 표기 정본 (validate-tts-policy.js 와 같은 계약):
 *   narration     — ElevenLabs 로 그대로 가므로 숫자는 한글 수사. "3.4%" 금지, "삼점사 퍼센트".
 *   subtitle_text — 화면 표기용. 아라비아 숫자를 쓴다.
 *
 * Usage:
 *   node scripts/automation/revise-script-factcheck.js --episode EP-2026-0096 --platform shorts
 *   node scripts/automation/revise-script-factcheck.js --episode EP-2026-0096 --check   # 판정만, 비용 0
 *
 * Exit codes:
 *   0  고칠 게 없거나(--check) 수정 완료
 *   10 --check 결과 고칠 게 있다 (auto-pipeline 이 이 코드를 보고 루프를 돈다)
 *   1  실패
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';

import { resolvePaths } from './paths.js';
import { callClaudeCode, callCodex, resolveChain, runEngineChain } from './lib/text-engine.js';
import { validateScript, formatIssue, spokenNumberCap } from './lib/script-quality-contract.js';

/** 고쳐야 하는 판정. '사실' 은 건드리지 않는다. */
const FIXABLE_VERDICTS = ['부정확', '미확인'];

/**
 * 35_factcheck.md 의 `### [MED] Scene 001: "..."` 블록을 구조화한다.
 *
 * severity 로 거르지 않는 이유: Phase 6 게이트는 파일에 `### [MED]` 와 `부정확` 이
 * 각각 있기만 하면 멈춘다(두 grep 이 독립적이다). 심각도로 거르면 LOW 부정확이 남아
 * 게이트는 계속 걸리는데 고칠 대상은 없는 무한 루프가 된다.
 */
export function parseFactcheckFindings(md) {
  const findings = [];
  const blocks = String(md).split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = /^\[(HIGH|MED|LOW)\]\s*Scene\s*(\d+)/i.exec(block);
    if (!head) continue;
    const field = (name) => {
      const m = new RegExp(`^-\\s*\\*\\*${name}\\*\\*:\\s*([\\s\\S]*?)(?=\\n-\\s*\\*\\*|\\n### |$)`, 'm').exec(block);
      return m ? m[1].trim() : '';
    };
    const verdict = field('검증 결과');
    if (!FIXABLE_VERDICTS.includes(verdict)) continue;
    findings.push({
      severity: head[1].toUpperCase(),
      scene_id: head[2].padStart(3, '0'),
      verdict,
      claim: field('주장'),
      evidence: field('근거'),
      suggestion: field('수정 제안').replace(/^"|"$/g, ''),
      reason: field('위험 사유'),
    });
  }
  return findings;
}

function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error('30_script.md 에 frontmatter 가 없다');
  return { fm: parseYAML(m[1]) || {}, body: text.slice(m[0].length) };
}

function buildSystemPrompt() {
  return [
    '너는 한국어 경제 쇼츠 대본의 팩트 교정자다.',
    '팩트체커가 지적한 문장만 고친다. 지적되지 않은 내용을 새로 쓰거나 지우지 마라.',
    '',
    '표기 정본 (어기면 파이프라인이 되돌린다):',
    '- narration 은 TTS 로 그대로 읽힌다. 아라비아 숫자·기호를 절대 쓰지 마라.',
    '  "3.4%" → "삼점사 퍼센트", "2001년" → "이천일 년", "S&P" → "에스앤피", "AI" → "에이아이".',
    '- subtitle_text 는 화면 자막이다. 여기서는 아라비아 숫자를 쓴다 ("S&P500 -0.17%").',
    '- narration 은 씬당 60~90자를 지킨다. 길어지면 형용사를 버리고 사실을 남겨라.',
    '- 단정할 근거가 없으면 "~라는 해석이 나옵니다" 처럼 해석임을 밝혀라. 근거 없는 단정이 지적의 사유다.',
    '- 어느 날에 붙여도 맞는 말("지켜봐야 합니다", "주목됩니다")로 끝내지 마라.',
  ].join('\n');
}

function buildUserPrompt(scenes, findings, retryFeedback) {
  const byScene = new Map();
  for (const f of findings) {
    if (!byScene.has(f.scene_id)) byScene.set(f.scene_id, []);
    byScene.get(f.scene_id).push(f);
  }

  const parts = ['[고쳐야 할 씬]', ''];
  for (const [sceneId, items] of byScene) {
    const scene = scenes.find((s) => String(s.scene_id) === sceneId);
    if (!scene) continue;
    parts.push(`## Scene ${sceneId} (role=${scene.role}, ${scene.target_seconds}초, 말할 수치 상한 ${spokenNumberCap(scene.target_seconds)}개)`);
    parts.push(`현재 narration: ${scene.narration}`);
    parts.push(`현재 subtitle_text: ${scene.subtitle_text || ''}`);
    parts.push(`현재 emphasis_tokens: ${(scene.emphasis_tokens || []).join(', ')}`);
    parts.push('');
    for (const f of items) {
      parts.push(`- [${f.severity}/${f.verdict}] ${f.claim}`);
      if (f.reason) parts.push(`  사유: ${f.reason}`);
      if (f.evidence) parts.push(`  근거: ${f.evidence}`);
      if (f.suggestion) parts.push(`  팩트체커 수정 제안: ${f.suggestion}`);
    }
    parts.push('');
  }

  parts.push('[전체 대본 흐름 — 참고용, 고치지 마라]');
  for (const s of scenes) {
    parts.push(`${s.scene_id}(${s.role}): ${s.narration}`);
  }
  parts.push('');
  parts.push('위 "고쳐야 할 씬" 에 나온 씬만 고쳐서 아래 형식으로 내라.');
  parts.push('수정 제안을 그대로 베끼지 말고, 앞뒤 씬과 이어지도록 다듬어라.');
  parts.push('emphasis_tokens 는 자막 강조와 SEO 키워드로 그대로 쓰인다 — 화면에 박힌다.');
  parts.push('지적된 수치·표현이 거기 남아 있으면 반드시 함께 지워라. 씬당 1~3개.');
  parts.push('{"scenes":[{"scene_id":"001","narration":"...","subtitle_text":"...","emphasis_tokens":["...","..."]}]}');

  // 직전 시도가 계약을 어겼으면 그 위반을 그대로 돌려준다. 상한은 위 씬 헤더에 이미
  // 적혀 있지만 모델이 넘길 때가 있고(2026-08-23 EP-0110: 수치 3개/상한 2),
  // 되먹임 없이 다시 물으면 같은 답이 온다.
  if (retryFeedback && retryFeedback.length) {
    parts.push('');
    parts.push('[직전 시도가 거부된 이유 — 이번에는 반드시 지켜라]');
    for (const line of retryFeedback) parts.push(`- ${line}`);
    parts.push('사실 교정과 아래 제약을 동시에 만족시켜야 한다. 수치를 줄여야 하면');
    parts.push('가장 덜 중요한 수치를 문장에서 빼라 — 지적된 수치를 되살리지는 마라.');
  }

  return parts.join('\n');
}

/** narration 에 아라비아 숫자가 남으면 TTS 가 영어로 읽는다 — 되돌린다. */
function arabicDigitScenes(scenes) {
  return scenes.filter((s) => /\d/.test(String(s.narration || ''))).map((s) => s.scene_id);
}

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      platform: { type: 'string', short: 'p', default: 'shorts' },
      engine: { type: 'string' },
      check: { type: 'boolean', default: false },
      // 계약 위반은 되먹임으로 고쳐진다 — 단발로 포기하면 파이프라인이 사람을 부른다
      // (2026-08-23 EP-2026-0110: spoken-number-budget 1건으로 Phase 6 halt).
      attempts: { type: 'string' },
    },
  });

  if (!values.episode) {
    console.error('Usage: revise-script-factcheck.js --episode <EP-YYYY-NNNN> [--platform shorts|long] [--check]');
    process.exit(1);
  }

  let epDir = values.episode;
  if (!epDir.startsWith('/') && !epDir.startsWith('workspace/')) {
    epDir = join('workspace/episodes', values.episode);
  }
  const p = resolvePaths(resolve(epDir), values.platform);

  if (!existsSync(p.factcheck)) {
    console.error(`❌ ${p.factcheck} 없음 — S5 팩트체크 먼저 실행`);
    process.exit(1);
  }
  if (!existsSync(p.script)) {
    console.error(`❌ ${p.script} 없음`);
    process.exit(1);
  }

  const findings = parseFactcheckFindings(readFileSync(p.factcheck, 'utf-8'));

  if (findings.length === 0) {
    console.log('✅ 팩트체크에 고칠 주장이 없다 (부정확·미확인 0건)');
    process.exit(0);
  }

  const scenesTouched = [...new Set(findings.map((f) => f.scene_id))];
  console.log(`🔧 팩트체크 지적 ${findings.length}건 · 씬 ${scenesTouched.join(', ')}`);
  findings.forEach((f) => console.log(`   [${f.severity}/${f.verdict}] 씬 ${f.scene_id}: ${f.claim.slice(0, 50)}...`));

  if (values.check) process.exit(10);

  const { fm, body } = splitFrontmatter(readFileSync(p.script, 'utf-8'));
  const scenes = Array.isArray(fm.scenes) ? fm.scenes : [];
  if (scenes.length === 0) {
    console.error('❌ 대본에 scenes 가 없다');
    process.exit(1);
  }

  const systemPrompt = buildSystemPrompt();
  // 체인에 여기 없는 엔진(gemini 등)이 섞이면 runEngineChain 이 폴백 도중 그 자리에서 죽는다.
  const chain = (values.engine ? [values.engine] : resolveChain(process.env.BT_SCRIPT_ENGINE_CHAIN))
    .filter((name) => ['claude', 'codex'].includes(name));
  if (chain.length === 0) {
    console.error('❌ 쓸 수 있는 엔진이 없다 (지원: claude, codex)');
    process.exit(1);
  }

  const MAX_ATTEMPTS = (() => {
    const raw = values.attempts || process.env.BT_FACTCHECK_REVISE_ATTEMPTS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  })();

  let retryFeedback = [];
  let attempt = 0;
  // 시도마다 프롬프트를 다시 만든다 — 직전 거부 사유를 되먹여야 같은 답이 안 온다.
  // 계약 위반은 회복 가능한 실패로 보고, 소진했을 때만 원본을 남기고 죽는다.
  for (;;) {
    attempt += 1;
    const lastTry = attempt >= MAX_ATTEMPTS;
    const giveUp = (msg) => {
      if (lastTry) { console.error(msg); process.exit(1); }
      console.warn(`   ↻ ${msg.replace(/^❌\s*/, '')} — 재시도 ${attempt + 1}/${MAX_ATTEMPTS}`);
    };

    const userPrompt = buildUserPrompt(scenes, findings, retryFeedback);
    const runners = {
      claude: () => ({ json: callClaudeCode(systemPrompt, userPrompt, 'sonnet', 600), used: 'claude' }),
      codex: () => ({ json: callCodex(systemPrompt, userPrompt, null, 600), used: 'codex' }),
    };

    const { json, engineUsed: used } = await runEngineChain(chain, runners);

    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      giveUp(`❌ 응답 JSON 파싱 실패: ${e.message}`);
      retryFeedback = ['직전 응답이 JSON 으로 파싱되지 않았다. 지정한 JSON 한 덩어리만 내라.'];
      continue;
    }

    const revisions = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    if (revisions.length === 0) {
      giveUp('❌ 수정된 씬이 하나도 없다');
      retryFeedback = ['직전 응답에 scenes 배열이 비어 있었다. 지적된 씬을 실제로 고쳐서 내라.'];
      continue;
    }

  // 지적되지 않은 씬을 모델이 건드렸으면 버린다 — 통과한 씬을 다시 굴리지 않는 게 이 단계의 요점이다.
  const applied = [];
  const nextScenes = scenes.map((s) => ({ ...s }));
  for (const r of revisions) {
    const sceneId = String(r.scene_id || '').padStart(3, '0');
    if (!scenesTouched.includes(sceneId)) {
      console.warn(`   ⚠ 씬 ${sceneId} 는 지적 대상이 아니다 — 무시`);
      continue;
    }
    const target = nextScenes.find((s) => String(s.scene_id) === sceneId);
    if (!target) continue;
    const before = JSON.stringify([target.narration, target.subtitle_text, target.emphasis_tokens]);
    if (r.narration) target.narration = String(r.narration).trim();
    if (r.subtitle_text) target.subtitle_text = String(r.subtitle_text).trim();
    // emphasis_tokens 는 자막에 박히고 SEO 키워드가 된다 — 근거 없는 수치가 여기 남으면
    // narration 을 고쳐도 팩트체커가 계속 같은 주장을 잡아 루프가 상한까지 헛돈다.
    if (Array.isArray(r.emphasis_tokens) && r.emphasis_tokens.length) {
      target.emphasis_tokens = r.emphasis_tokens.map((t) => String(t).trim()).filter(Boolean).slice(0, 3);
    }
    if (JSON.stringify([target.narration, target.subtitle_text, target.emphasis_tokens]) !== before) applied.push(sceneId);
  }

    if (applied.length === 0) {
      giveUp('❌ 적용된 수정이 없다');
      retryFeedback = ['직전 응답이 지적된 씬의 문장을 실제로 바꾸지 않았다. 원문과 다른 문장을 내라.'];
      continue;
    }

    const digitScenes = arabicDigitScenes(nextScenes.filter((x) => applied.includes(String(x.scene_id))));
    if (digitScenes.length) {
      giveUp(`❌ narration 에 아라비아 숫자가 남았다 — 씬 ${digitScenes.join(', ')} (TTS 표기 정본 위반)`);
      retryFeedback = [`씬 ${digitScenes.join(', ')} narration 에 아라비아 숫자가 남았다. 전부 한글 수사로 바꿔라.`];
      continue;
    }

    // 고치려다 분석 밀도 계약을 깨면 이득이 없다. error 만 막고 warn 은 통과시킨다
    // (generate-script.js 도 error 만 재작성 트리거로 쓴다).
    const issues = validateScript(nextScenes);
    issues.forEach((i) => console.warn(`   ${formatIssue(i)}`));
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      giveUp(`❌ 수정본이 품질 계약 error ${errors.length}건 — 원본을 남기고 중단한다`);
      retryFeedback = errors.map((i) => formatIssue(i).replace(/^\s*[❌⚠]\s*/, ''));
      continue;
    }

    fm.scenes = nextScenes;
    fm.revision = (Number(fm.revision) || 1) + 1;
    fm.factcheck_revised_at = new Date().toISOString();
    fm.factcheck_revised_scenes = applied;
    fm.factcheck_revised_by = `factcheck-reviser (${used}${attempt > 1 ? `, ${attempt}회차` : ''})`;

    writeFileSync(p.script, ['---', stringifyYAML(fm).trim(), '---', '', body.replace(/^\n+/, '')].join('\n'), 'utf-8');

    console.log(`✅ 대본 갱신: ${p.script}`);
    console.log(`   revision ${fm.revision} · 씬 ${applied.join(', ')} · 엔진 ${used}`
      + (attempt > 1 ? ` · 시도 ${attempt}/${MAX_ATTEMPTS}` : ''));
    applied.forEach((id) => {
      const sc = nextScenes.find((x) => String(x.scene_id) === id);
      console.log(`   [${id}] ${sc.narration.length}자 · "${sc.narration.slice(0, 46)}..."`);
    });
    return;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
