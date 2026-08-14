#!/usr/bin/env node
/**
 * generate-cards.js — 인트로·아웃트로 카드를 HyperFrames 로 만든다 (S6d / S6f).
 *
 * 글자를 이미지 모델에게 그리게 하지 않는다. 두 가지가 깨지기 때문이다.
 *   1) 한글 오타 — "메타"가 "머타"로 나온 적이 있고, 그래서 "저장 전 타이틀 확대 검수"
 *      라는 수동 절차가 붙어 있었다. 이 경로에서는 오타가 원천적으로 불가능하다.
 *   2) 뜻이 어긋남 — vision 검증은 철자만 본다. EP-2026-0093 인트로는 +2.42% 상승
 *      회차인데 빨간 폭락 차트와 LED "N/A" 를 그려 놓고 "철자 정확" 으로 통과했다.
 * 배경 그림만 씬 이미지에서 가져오고 글자는 여기서 얹는다.
 *
 * 문안 규칙 (발행본 EP-2026-0085 기준, 운영자 확정 2026-08-14):
 *   인트로 = **자극적인 타이틀**  "사상 최고치인데 AMD는 왜 8% 빠졌나"
 *   아웃트로 = **정의**          "이젠 얼마 버나가 아니라 얼마 쓰나를 본다"
 *
 * 타이포는 config/cards.json 이 정본이다.
 *
 * Usage:
 *   node scripts/automation/generate-cards.js --episode <dir> [--platform shorts]
 *     [--kind intro|outro|both] [--force]
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';

import { buildCardComposition, loadCardConfig } from './lib/card-composition.js';
import { resolveGsap, resolveHyperframes, resolveAssetsDir, resolveScript } from './generate-motion.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..', '..');
const BUNDLED_FONT = join(SKILL_DIR, 'assets', 'fonts', 'NotoSansKR-Black.otf');

function parseFrontmatter(mdPath) {
  const m = readFileSync(mdPath, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`No YAML frontmatter in ${mdPath}`);
  return parseYAML(m[1]);
}

/**
 * 한 줄을 카드용으로 다듬는다. 카드는 3줄까지라 길면 잘라야 하고, 문장부호로 끝나면
 * 어색하다. 강조는 `**…**` 로 넘어오면 그대로 두고, 없으면 수치 토큰 하나를 감싼다.
 */
export function toCardText(raw, { maxChars = 34 } = {}) {
  let t = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  // 부제로 밀 꼬리(괄호 주석)는 떼어낸다.
  t = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const sp = cut.lastIndexOf(' ');
    t = (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut).trim();
  }
  t = t.replace(/[.,·]$/, '');
  if (!/\*\*/.test(t)) {
    // 수치(퍼센트·금액·지수)를 하나 골라 강조한다. 없으면 강조 없이 둔다.
    const m = t.match(/([+\-−]?\d[\d,.]*\s*(?:%|퍼센트|원|달러|조원|억원|조달러|억달러|포인트|선|년))/);
    if (m) t = t.replace(m[1], `**${m[1]}**`);
  }
  return t;
}

/** 인트로 타이틀·부제. brief 지정이 최우선, 없으면 hook 씬에서 만든다. */
export function deriveIntro(briefFM, scenes) {
  const th = (briefFM && briefFM.thumbnail) || {};
  if (th.intro_headline_text) {
    return { title: th.intro_headline_text, sub: th.intro_sub || '' };
  }
  const hook = scenes.find(s => s.role === 'hook') || scenes[0] || {};
  return { title: toCardText(hook.subtitle_text || hook.narration), sub: th.intro_sub || '' };
}

/**
 * 아웃트로 정의. brief 지정이 최우선.
 * 없으면 insight → implication 순으로 찾는다 — 그 회차가 "무엇이었는지" 를 규정하는 씬이다.
 * cta 씬은 쓰지 않는다. "팔로우하세요" 는 정의가 아니다.
 */
export function deriveOutro(briefFM, scenes) {
  const th = (briefFM && briefFM.thumbnail) || {};
  if (th.outro_definition) return { title: th.outro_definition };
  const pick = scenes.find(s => s.role === 'insight')
    || scenes.find(s => s.role === 'implication')
    || scenes[Math.max(0, scenes.length - 2)] || {};
  return { title: toCardText(pick.subtitle_text || pick.narration) };
}

const CARD_SYSTEM = `너는 한국 경제 쇼츠 채널의 카드 카피라이터다. 두 줄만 만든다.

INTRO — 자극적인 타이틀. 대비·반전 구조에 수치를 박는다. 질문형도 좋다.
  좋은 예: "사상 최고치인데 AMD는 왜 8% 빠졌나"
OUTRO — 정의. 그 회차가 무엇이었는지 한 줄로 규정한다. CTA 문구가 아니다.
  좋은 예: "이젠 얼마 버나가 아니라 얼마 쓰나를 본다"

규칙:
- 각 줄 28자 이내. 문장부호로 끝내지 않는다.
- 줄바꿈 위치는 | 로 표시한다 (2~3조각).
- 가장 중요한 한 덩어리를 **…** 로 감싼다.
- 대본에 없는 수치·사실을 만들지 않는다.
- 출력은 JSON 한 줄: {"intro":"…","intro_sub":"…","outro":"…"}
  intro_sub 는 14자 이내의 보조 한 줄. 없으면 빈 문자열.`;

function parseCardJson(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON 을 못 찾았다');
  const o = JSON.parse(m[0]);
  if (!o.intro || !o.outro) throw new Error('intro/outro 가 비었다');
  return o;
}

/**
 * 대본에서 카드 문안을 뽑는다. subtitle_text 는 자막용 산문이라 잘라 쓰면 문장 중간이
 * 잘린다 — "AMD는 정규장에서 7% 올랐습니다. 그런데 실적을" 같은 식이다. 그래서 모델에게
 * 카드용으로 다시 쓰게 한다. 엔진이 다 죽으면 위의 잘라쓰기로 떨어진다.
 */
export async function writeCardCopy({ briefFM, scenes, topic }) {
  const { callClaudeCode, callCodex, resolveChain, runEngineChain } = await import('./lib/text-engine.js');
  const digest = scenes.map(s => `[${s.role || '?'}] ${s.subtitle_text || s.narration || ''}`).join('\n');
  const user = `주제: ${topic || ''}\n\n대본 요약:\n${digest}`;
  const chain = resolveChain(process.env.BT_CARD_ENGINE_CHAIN, 'claude,codex');
  const runners = {
    claude: () => ({ text: callClaudeCode(CARD_SYSTEM, user, 'sonnet', 180), used: 'claude' }),
    codex: () => ({ text: callCodex(CARD_SYSTEM, user, null, 180), used: 'codex' }),
  };
  const got = await runEngineChain(chain, runners, { log: () => {}, warn: () => {}, error: () => {} });
  return parseCardJson(got.text);
}

/** 시스템에 그 폰트가 실제로 있는지. 없으면 번들 폰트로 떨어진다. */
function systemFontAvailable(family) {
  if (!family) return false;
  const r = spawnSync('fc-list', [`:family=${family}`, 'family'], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function renderCard({ hfBin, gsapPath, cfg, variant, bgPath, outPath }) {
  const useSystem = systemFontAvailable(cfg.fontFamily);
  const projectDir = mkdtempSync(join(tmpdir(), 'bt-cards-'));
  try {
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    copyFileSync(gsapPath, join(projectDir, 'assets', 'gsap.min.js'));
    copyFileSync(bgPath, join(projectDir, 'assets', 'bg.png'));
    if (!useSystem) copyFileSync(BUNDLED_FONT, join(projectDir, 'assets', 'kr.otf'));
    writeFileSync(join(projectDir, 'hyperframes.json'), JSON.stringify({ paths: { assets: 'assets' } }, null, 2));
    writeFileSync(join(projectDir, 'index.html'), buildCardComposition({
      variants: [variant],
      imageRel: 'assets/bg.png',
      gsapRel: 'assets/gsap.min.js',
      fontRel: useSystem ? null : 'assets/kr.otf',
      fontFamily: useSystem ? cfg.fontFamily : null,
      treatment: cfg.treatment || {},
      tone: cfg.tone || 'accent',
      cta: cfg.cta || null,
      ctaLead: cfg.ctaLead || '',
      disclaimer: cfg.disclaimer || '',
    }));

    const res = spawnSync(process.execPath, [hfBin, 'snapshot', projectDir, '--at', '0.5'], {
      encoding: 'utf-8',
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' },
      timeout: 15 * 60 * 1000,
    });
    if (res.status !== 0) {
      throw new Error(`snapshot 실패 (exit ${res.status}): ${`${res.stderr || ''}${res.stdout || ''}`.trim().slice(-400)}`);
    }
    const snapDir = join(projectDir, 'snapshots');
    const frame = readdirSync(snapDir).filter(f => /^frame-\d+-at-/.test(f)).sort()[0];
    if (!frame) throw new Error('스냅샷이 안 나왔다');
    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(join(snapDir, frame), outPath);
    return { outPath, font: useSystem ? cfg.fontFamily : 'NotoSansKR-Black(폴백)' };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

export async function generateCards({ episodeDir, platform = null, kind = 'both', force = false }) {
  const hfBin = resolveHyperframes();
  const gsapPath = resolveGsap();
  if (!hfBin || !gsapPath) throw new Error('hyperframes/gsap 없음 — generate-motion.js --doctor');

  const epDir = resolve(episodeDir);
  const scriptPath = resolveScript(epDir, platform);
  const baseDir = dirname(scriptPath);
  const assetsDir = resolveAssetsDir(baseDir);
  const meta = parseFrontmatter(scriptPath);
  const scenes = meta.scenes || [];
  if (!scenes.length) throw new Error('대본에 씬이 없다');

  let briefFM = {};
  try { briefFM = parseFrontmatter(join(epDir, '00_brief.md')); } catch { /* 없으면 대본에서 만든다 */ }

  const sceneImg = (i) => {
    const id = scenes[i]?.scene_id || String(i + 1).padStart(3, '0');
    return join(assetsDir, 'images', `scene_${id}.png`);
  };

  // 모델에게 카드 문안을 맡기고, 실패하면 대본에서 잘라 쓰는 폴백으로 간다.
  let copy = null;
  const th = (briefFM && briefFM.thumbnail) || {};
  const needsCopy = !(th.intro_headline_text && th.outro_definition);
  if (needsCopy) {
    try {
      copy = await writeCardCopy({ briefFM, scenes, topic: briefFM.topic || meta.topic });
      console.log(`   문안 생성: intro="${copy.intro}" / outro="${copy.outro}"`);
    } catch (e) {
      console.warn(`   ⚠ 문안 생성 실패 (${String(e.message).slice(0, 80)}) — 대본에서 잘라 쓴다`);
    }
  }

  const intro = th.intro_headline_text
    ? { title: th.intro_headline_text, sub: th.intro_sub || '' }
    : (copy ? { title: copy.intro, sub: copy.intro_sub || '' } : deriveIntro(briefFM, scenes));
  const outro = th.outro_definition
    ? { title: th.outro_definition }
    : (copy ? { title: copy.outro } : deriveOutro(briefFM, scenes));

  const jobs = [];
  if (kind === 'intro' || kind === 'both') {
    jobs.push({ name: 'intro', cfg: loadCardConfig('intro'), variant: intro,
      bg: sceneImg(0), out: join(baseDir, '45_intro.png') });
  }
  if (kind === 'outro' || kind === 'both') {
    jobs.push({ name: 'outro', cfg: loadCardConfig('outro'), variant: outro,
      bg: sceneImg(scenes.length - 1), out: join(baseDir, '48_outro.png') });
  }

  const results = [];
  for (const j of jobs) {
    if (existsSync(j.out) && !force) {
      console.log(`  ⏭  ${j.name}: 이미 있음 — skip (${j.out.split('/').pop()})`);
      results.push({ ...j, skipped: true });
      continue;
    }
    if (!existsSync(j.bg)) throw new Error(`배경 그림 없음: ${j.bg}`);
    if (!j.variant.title) throw new Error(`${j.name} 문안을 만들 수 없다 — brief.thumbnail 또는 대본 subtitle_text 확인`);
    const r = renderCard({ hfBin, gsapPath, cfg: j.cfg, variant: j.variant, bgPath: j.bg, outPath: j.out });
    console.log(`  ✅ ${j.name}: "${j.variant.title.replace(/\|/g, ' / ').replace(/\*\*/g, '')}" [${r.font}]`);
    results.push({ ...j, skipped: false });
  }
  return results;
}

function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string' },
      platform: { type: 'string' },
      kind: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.episode) {
    console.error('Usage: generate-cards.js --episode <dir> [--platform shorts] [--kind intro|outro|both] [--force]');
    process.exit(2);
  }
  console.log('🎴 인트로·아웃트로 카드 (HyperFrames 텍스트 합성)');
  return generateCards({
    episodeDir: values.episode,
    platform: values.platform || null,
    kind: values.kind || 'both',
    force: values.force,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
