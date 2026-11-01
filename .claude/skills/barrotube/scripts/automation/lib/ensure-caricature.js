/**
 * ensure-caricature.js — 공인 인물이 나오는데 캐리커처 씬이 없으면 이미지를 굽기 전에 채운다 (2026-09-29)
 *
 * 왜 필요했나: 채널 정책 §2 상 외국 정치인·CEO·경제 인사는 CHARACTERIZE — 이름이 나오면
 * 캐리커처로 식별 단서를 보여 줘야 한다. 대본 작성기는 **브리프·토픽**에서 인물을 감지할
 * 때만 캐리커처 지시를 받는데, 2026-09-29 us-close(EP-2026-0193)는 토픽에 없던 트럼프를
 * 대본이 훅에 넣었다. QA 가 훅 내레이션에서 그를 감지해 CATEGORY_MISMATCH_NO_CARICATURE 로
 * 게시를 막았고, 그때는 이미 TTS·이미지·렌더 15분을 쓴 뒤였다(08:00 편이 08:25 수동 복구).
 *
 * QA 와 같은 입력(토픽 + 훅 내레이션)으로 같은 판정(detectPolicyViolations)을 미리 돌리고,
 * 막힐 판정이면 인물이 불린 씬(없으면 훅)의 image_prompt 에 등록부 단서로 만든 캐리커처 절을
 * 넣는다. 이름은 넣지 않는다 — 이미지 모델이 실명 요청을 거절할 수 있고 식별은 단서로 충분하다.
 *
 * QA 의 캐리커처 판정은 **이미지가 아니라 프롬프트 글자**로 한다. 이미 구운 씬의 프롬프트만
 * 고치면 그림엔 인물이 없는데 QA 는 통과한다 — 그래서 바꾼 씬의 스틸·클립은 옆으로 치워
 * 다시 굽게 한다.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYAML, parseDocument } from 'yaml';
import { detectPolicyViolations } from './qa-policy-detect.js';
import { resolveFiguresForBrief } from './public-figures.js';

const MISMATCH = 'CATEGORY_MISMATCH_NO_CARICATURE';
/** 한 편에 캐리커처를 새로 넣는 씬 수 상한 — 정책 씬 상한(qa-policy-detect FORMAT_SCENE_CAPS)보다 작게. */
const MAX_INSERTS = 2;

/** 등록부 인물 → 이름 없는 캐리커처 묘사. 이름이 남으면 null. */
export function caricatureDescriptor(figure) {
  if (!figure) return null;
  const names = [figure.display_name_ko, ...(figure.aliases || [])]
    .filter((n) => n && /[a-z]/i.test(String(n)))
    .map((n) => String(n).toLowerCase());
  let desc = String(figure.descriptor_short || '').replace(/\s*\(caricature\)\s*$/i, '').trim();
  if (desc.includes(':')) {
    // "Trump caricature: 단서, 단서" 꼴 — 이름표를 떼고, 명사는 긴 설명의 "as an older man with" 에서 가져온다.
    const cues = desc.slice(desc.indexOf(':') + 1).trim();
    const noun = (String(figure.descriptor_en || '').match(/\bas (an? [a-z -]+?) with\b/i) || [])[1] || 'a person';
    desc = `${noun} with ${cues}`;
  }
  if (!desc || names.some((n) => desc.toLowerCase().includes(n))) return null;
  return /^an?\s/i.test(desc) ? desc : `${/^[aeiou]/i.test(desc) ? 'an' : 'a'} ${desc}`;
}

/** image_prompt 의 BACKGROUND 앞에 캐리커처 절을 넣는다. 이미 있거나 넣을 자리가 없으면 null. */
export function insertCaricatureClause(prompt, desc) {
  const p = String(prompt || '');
  if (!desc || /cartoon caricature\b/i.test(p)) return null;
  const at = p.indexOf(' BACKGROUND:');
  if (at < 0) return null;
  const obj = (p.match(/before a single ([^,]+?) in the cent(?:re|er)/i) || [])[1] || '';
  const noun = obj ? obj.trim().split(/\s+/).pop() : 'central object';
  const head = p.slice(0, at).replace(/\s+$/, '');
  return `${head}${head.endsWith('.') ? '' : '.'} WITH: a flat cartoon caricature of ${desc}, same line-art style, similar scale, standing beside the ${noun}.${p.slice(at)}`;
}

/** QA(generate-qa-report)와 같은 감지 입력 — 토픽 + 훅 내레이션. */
export function detectionText(briefFM, scenes) {
  const hook = (scenes.find((s) => s.role === 'hook') || scenes[0])?.narration || '';
  return `${briefFM.topic || ''}\n${hook}`;
}

/** 순수 계획: 막힐 판정이면 어느 씬에 무엇을 넣을지. */
export function planCaricatureFix({ briefFM = {}, scriptFM = {}, channel = 'econ-daily', format = 'shorts' }) {
  const scenes = Array.isArray(scriptFM.scenes) ? scriptFM.scenes : [];
  const check = (list) => detectPolicyViolations({
    briefFM, scriptFM: { ...scriptFM, scenes: list }, channel, format, topicText: detectionText(briefFM, list), meta: null,
  }).blocks.some((b) => b.code === MISMATCH);
  if (!check(scenes)) return { needed: false, changes: [], resolved: true, scenes };

  const figures = resolveFiguresForBrief(channel, briefFM, detectionText(briefFM, scenes)).resolved
    .filter((r) => r.treatment === 'CHARACTERIZE' && !r.blockReason)
    .map((r) => r.figure);
  const next = scenes.map((s) => ({ ...s }));
  const changes = [];
  for (const fig of figures) {
    if (changes.length >= MAX_INSERTS) break;
    const desc = caricatureDescriptor(fig);
    if (!desc) continue;
    const aliases = [fig.display_name_ko, ...(fig.aliases || [])].filter(Boolean).map(String);
    const used = new Set(changes.map((c) => c.index));
    let idx = next.findIndex((s, i) => !used.has(i) && aliases.some((a) => String(s.narration || '').includes(a)));
    if (idx < 0) idx = next.findIndex((s, i) => !used.has(i) && s.role === 'hook');
    if (idx < 0) continue;
    const after = insertCaricatureClause(next[idx].image_prompt, desc);
    if (!after) continue;
    next[idx].image_prompt = after;
    changes.push({ index: idx, sceneId: String(next[idx].scene_id).padStart(3, '0'), figureId: fig.id });
  }
  return { needed: true, changes, resolved: !check(next), scenes: next };
}

/** 에피소드에 적용: 대본을 고치고, 이미 구운 해당 씬 스틸·클립은 옆으로 치운다. */
export function ensureCaricature({ epDir, platform = 'shorts', write = true }) {
  const base = existsSync(join(epDir, 'platforms', platform, '30_script.md')) ? join(epDir, 'platforms', platform) : epDir;
  const scriptPath = join(base, '30_script.md');
  const raw = readFileSync(scriptPath, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { needed: false, changes: [], resolved: true };
  const scriptFM = parseYAML(m[1]) || {};
  let briefFM = {};
  const briefPath = join(epDir, '00_brief.md');
  if (existsSync(briefPath)) {
    const b = readFileSync(briefPath, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    if (b) { try { briefFM = parseYAML(b[1]) || {}; } catch { briefFM = {}; } }
  }
  const plan = planCaricatureFix({
    briefFM, scriptFM,
    channel: scriptFM.channel_id || briefFM.channel_id || 'econ-daily',
    format: scriptFM.format || platform,
  });
  if (!plan.needed || !plan.changes.length || !write) return plan;

  const doc = parseDocument(m[1]);
  for (const c of plan.changes) doc.setIn(['scenes', c.index, 'image_prompt'], plan.scenes[c.index].image_prompt);
  writeFileSync(scriptPath, raw.replace(m[0], () => `---\n${doc.toString().replace(/\n$/, '')}\n---`));

  for (const c of plan.changes) {
    for (const [dir, ext] of [['images', 'png'], ['videos', 'mp4']]) {
      const f = join(base, '40_assets', dir, `scene_${c.sceneId}.${ext}`);
      if (existsSync(f)) renameSync(f, f.replace(`.${ext}`, `.pre-caricature.${ext}`));
    }
  }
  return plan;
}
