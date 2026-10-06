#!/usr/bin/env node

/**
 * generate-summary-script.js — 「미국 증시 요약」 대본 (세로 3분·7씬)
 *
 * generate-script.js 는 쇼츠의 「통찰형 훅」 계약(수치 하나·인과·질문)으로 다듬어져 있다.
 * 요약 포맷의 글은 반대다 — 벤치마크(오선 「증시 요약」 427편)는 담담한 통신사 브리핑체로
 * 지수·원인·종목·월가 인용·일정을 다 읽고, 질문형 훅·구독 권유를 쓰지 않는다(0%).
 * 화면은 쇼츠와 같다(운영자 지시 2026-10-01): 씬 1 만 지수 요약 카드, 씬 2~7 은 마시 컷.
 *
 * 마시 컷의 image_prompt 는 **범용**으로 쓴다 — 그날의 회사·인물·숫자를 그리지 않고 씬의
 * 라이브러리 슬롯(<주제>/<방향>)을 대표하는 장면만 그린다. 라이브러리에 맞는 컷이 있으면
 * 그걸 쓰고(summary-assets.js), 없어서 새로 구운 컷도 다음 회차가 다시 쓸 수 있게 하려는 것이다.
 * 계약(마시 절·자세·꼬리말)은 쇼츠와 같은 generate-script.js 블록을 그대로 쓴다.
 *
 * 입력: workspace/daily-news/<date>/{summary-us.json, desk-briefing-us-close.md, research-us-close.md, topic-us-close.json, news.json}
 * 산출: workspace/episodes/<EP>/platforms/<platform>/30_script.md
 *
 * Usage: node generate-summary-script.js --episode EP-2026-NNNN [--date 2026-10-01] [--engine claude|codex]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify as stringifyYAML } from 'yaml';

import { callClaudeCode, callCodex, resolveChain, runEngineChain } from './lib/text-engine.js';
import { validateScript, formatIssue } from './lib/script-quality-contract.js';
import { MASCOT_CLAUSE, checkEpisodePrompts } from './lib/image-prompt-contract.js';
import { allSlots, PALETTE_DIRECTION } from './lib/scene-slot-taxonomy.js';
import { buildImagePromptContractBlock } from './generate-script.js';
import { readActiveRemedies, closingCtaOf, ensureClosingCta, remediesApplied } from './lib/growth-remediation.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'market-summary.json'), 'utf-8'));
const SLOTS = allSlots();
const DOW = '일월화수목금토';
// 범용 컷이 그날에 묶이는 흔한 고유명. 프롬프트에 이름이 들어가면 모델이 글자·로고를 그리고,
// 그 컷은 다른 날 재사용할 수 없다.
const PROPER = /\b(nvidia|micron|apple|tesla|intel|microsoft|google|alphabet|amazon|meta|walmart|samsung|hynix|tsmc|broadcom|oracle|netflix|fed|powell|warsh|trump|biden|opec|nasdaq|dow|s&p)\b/i;

const read = (p, max = 8000) => (existsSync(p) ? readFileSync(p, 'utf-8').slice(0, max) : '');
const readJSON = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null);

export function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return text;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return text;
}

/** 슬롯 방향과 팔레트가 맞는가. cta/generic 은 cta 팔레트. */
export function paletteFitsSlot(prompt, slot) {
  const tag = String(prompt || '').match(/\[palette:(\w+)\]/)?.[1];
  if (!tag) return false;
  if (slot === 'cta/generic') return tag === 'cta';
  return PALETTE_DIRECTION[tag] === slot.split('/')[1];
}

/**
 * 요약 포맷 계약. 문제 목록(문자열)을 돌려준다 — 비면 통과.
 * extraCta: KPI 진단이 켠 마무리 처방 문장(좋아요 요청 등). 있으면 마지막 씬에 그대로 있어야 한다.
 */
export function checkSummary(out, extraCta = null) {
  const problems = [];
  const roles = CFG.scenes.map((s) => s.role);
  const scenes = out?.scenes;
  if (!Array.isArray(scenes) || scenes.length !== roles.length) return [`씬이 정확히 ${roles.length}개여야 한다 (받은 ${scenes?.length ?? 0})`];
  scenes.forEach((s, i) => {
    const want = CFG.scenes[i];
    const n = i + 1;
    if (s.role !== want.role) problems.push(`씬 ${n} role 은 "${want.role}" 여야 한다 (받은 "${s.role}")`);
    if (/\d/.test(String(s.narration || ''))) problems.push(`씬 ${n} narration 에 아라비아 숫자가 있다 — 한글 수사로 써라 (숫자 표기는 subtitle_text 에)`);
    if (!String(s.subtitle_text || '').trim()) problems.push(`씬 ${n} subtitle_text 가 비었다`);
    if (want.card) {
      if (s.card?.type !== want.card) problems.push(`씬 ${n} 은 card {"type":"${want.card}"} 이어야 한다`);
      return;
    }
    if (s.card) problems.push(`씬 ${n} 에는 card 를 넣지 마라 — 마시 컷이다`);
    if (!SLOTS.includes(s.slot)) problems.push(`씬 ${n} slot 은 ${SLOTS.join(' | ')} 중 하나 (받은 "${s.slot}")`);
    else if (!paletteFitsSlot(s.image_prompt, s.slot)) problems.push(`씬 ${n} 팔레트가 slot ${s.slot} 방향과 안 맞는다 (up=bullish|wealth, down=bearish, neutral=explainer, cta/generic=cta)`);
    if (PROPER.test(String(s.image_prompt || ''))) problems.push(`씬 ${n} image_prompt 에 고유명이 있다 — 범용 장면으로 그려라`);
  });
  const mascot = scenes.map((s, i) => ({ sceneId: String(i + 1).padStart(3, '0'), prompt: s.image_prompt })).filter((s, i) => !CFG.scenes[i].card);
  for (const v of checkEpisodePrompts(mascot).violations) if (v.severity === 'BLOCK') problems.push(`씬 ${Number(v.sceneId)} image_prompt 계약 위반 ${v.code}: ${v.message}`);
  if (!/미국 증시 요약입니다/.test(String(scenes[0]?.narration || ''))) problems.push('씬 1 은 「… 미국 증시 요약입니다」로 열어야 한다');
  const last = String(scenes.at(-1)?.narration || '');
  if (!last.includes(CFG.disclaimer)) problems.push(`마지막 씬 narration 끝에 면책 문장 「${CFG.disclaimer}」을 그대로 넣어라`);
  if (!last.includes(CFG.cta)) problems.push(`마지막 씬 narration 에 「${CFG.cta}」를 그대로 넣어라 (면책 바로 앞)`);
  if (extraCta && !last.includes(extraCta)) problems.push(`마지막 씬 narration 에 자동 처방 문장 「${extraCta}」를 그대로 넣어라 (「${CFG.cta}」 바로 앞)`);
  const hook = String(out.title_hook || '');
  if (!hook || hook.length > CFG.title.hook_max_chars) problems.push(`title_hook 은 1~${CFG.title.hook_max_chars}자 (받은 ${hook.length}자)`);
  if (/[[\]【】()]/.test(hook)) problems.push('title_hook 에 괄호·대괄호 태그를 쓰지 마라');
  return problems;
}

/**
 * 재작성 프롬프트. 직전 응답을 함께 줘야 「지적된 것만 고쳐라」가 성립한다.
 * 2026-10-06 us-close(EP-2026-0212): 위반 목록만 주자 모델이 매번 새로 써서 시도마다 다른 곳이
 * 걸렸고(씬 수치 7>6 → 부정어 2>1 → 전체 수치 31>28) 일반 대본으로 떨어졌다.
 */
export function retryPrompt(base, problems, previous) {
  const fix = `## 재작성 지시 — 직전 응답의 위반\n${problems.map((p) => `- ${p}`).join('\n')}`;
  if (!previous) return `${base}\n\n${fix}\n지적된 것만 고치고 나머지 형식은 지켜라.`;
  return `${base}\n\n${fix}\n\n## 직전 응답 — 이것을 고쳐 JSON 하나로 다시 내라\n${JSON.stringify(previous)}\n` +
    '지적된 곳만 고치고, 위반이 없는 씬과 필드는 그대로 둬라.';
}

/** target_seconds 합을 포맷 목표에 맞춘다 — 모델이 1~2초 어긋나게 주는 일이 잦다. */
export function normalizeSeconds(scenes, total) {
  const sum = scenes.reduce((n, s) => n + (Number(s.target_seconds) || 0), 0) || 1;
  let acc = 0;
  scenes.forEach((s, i) => {
    const v = i === scenes.length - 1 ? total - acc : Math.round((Number(s.target_seconds) || 0) * total / sum);
    s.target_seconds = v; acc += v;
  });
  return scenes;
}

function systemPrompt(extraCta = null) {
  const roles = CFG.scenes.map((s, i) => `${String(i + 1).padStart(3, '0')} role=${s.role} ${s.target_seconds}s ${s.card ? `[card ${s.card}]` : '[마시 컷]'} — ${s.intent}`).join('\n');
  return `너는 한국어 경제 채널 「바로경제」의 「${CFG.series_label}」 원고 작가다. 매일 아침 8시, 밤사이 끝난 미국장을 3분 세로 영상으로 정리한다.

## 형식 (반드시)
- 씬 정확히 ${CFG.scenes.length}개, 순서·role 고정:
${roles}
- 총 ${CFG.target_total_seconds}초. narration 은 초당 약 ${CFG.chars_per_second}자(띄어쓰기 포함, TTS 실측) — target_seconds × ${CFG.chars_per_second} ± 10%.
- 문체: 담담한 통신사 브리핑체(「~했습니다」「~전했습니다」). 시청자에게 질문하지 말 것, 「내 계좌」·구독 권유·감탄사 금지, 과장 형용사 금지.
- 씬 1 은 「<미국 장 날짜를 한글로, 예: 구월 삼십일 수요일> 미국 증시 요약입니다.」로 시작한다.
- 마지막 씬 narration 은 ${extraCta ? `「${extraCta}」 「${CFG.cta}」 다음 「${CFG.disclaimer}」 세` : `「${CFG.cta}」 다음 「${CFG.disclaimer}」 두`} 문장으로 끝낸다(문구 그대로).
- subtitle_text 는 화면에 뜨는 요약이다 — 그 씬 narration 의 핵심을 숫자 표기로 한두 줄(줄당 22자 이내).

## 사실 규칙
- 수치는 [데이터]·[데스크]·[리서치]에 있는 것만. 없는 숫자·없는 발언을 지어내지 마라.
- street 씬의 인용은 [데스크]·[리서치]에 실제로 있는 발언만, 「<소속> <이름>은 …라고 전했습니다」. 그런 발언이 없으면 매체 이름으로 시장 해석을 전한다.
- movers 씬 종목은 「종목_이유_출처포함」에 있는 종목을 먼저 쓰고, 등락률과 이유를 한 문장씩. 이유를 모르는 종목은 고르지 마라.
- 장 마감 뒤 실적(시간외 움직임·데스크에 나온 실적 발표)은 movers 나 driver 에서 다룬다.
- 날짜 기준: 지수·종목은 미국 장 날짜, 일정은 한국 시간.

## TTS 표기
- narration 에는 아라비아 숫자를 절대 쓰지 마라 — 날짜·퍼센트·소수점·금액 모두 한글 수사.
- 영문 티커 대신 한국어 회사명을 말한다.

## 화면
- 씬 1: "card": {"type":"indices"} — 지수 요약 카드. image_prompt·slot 을 넣지 않는다.
- 씬 2~7: 마시 컷. 각 씬에 "slot" 과 "image_prompt" 를 넣는다.
  slot = 이 씬 내용의 주제/방향 하나: ${SLOTS.join(', ')}
  (일정·마무리처럼 방향이 없는 씬은 cta/generic 이나 <주제>/neutral.)
- 마시 컷은 **범용 장면**으로 그린다 — 다른 날에도 같은 슬롯 씬에 그대로 다시 쓸 수 있어야 한다.
  · 회사·인물·국가·지수 이름, 로고, 국기, 날짜·숫자를 그리지 않는다. 그 슬롯을 상징하는 물건 하나로 말한다
    (금리=채권 증서·저울·계단, 반도체=웨이퍼·칩, 유가=드럼통·송유관, 환율=저울 위 동전, 고용=서류 가방·작업모 …).
  · 방향은 마시의 감정·자세와 물건의 상태로 보여 준다(상승=밀어 올림·환호, 하락=무너짐·버팀, 중립=살펴봄·설명).
  · 팔레트 태그는 slot 방향과 맞춘다: up=bullish 또는 wealth, down=bearish, neutral=explainer, cta/generic=cta.
  · 6컷 모두 자세(pose 동사)가 달라야 한다.
${buildImagePromptContractBlock(MASCOT_CLAUSE)}
- 캐리커처(WITH: 절)는 쓰지 않는다 — 범용 컷이어야 한다.

## 제목
- title_hook: 그날을 대표하는 사건 하나, ${CFG.title.hook_max_chars}자 이내. 괄호 태그 금지. 짧을수록 좋다 — 사건의 크기가 조회수를 정한다(대비 구조 「A에도 B」 허용).

## 출력
JSON 하나만. 코드펜스·설명 금지.
{"title_hook":"...","angle_summary":"<한 문장>","scenes":[
 {"scene_id":"001","role":"open","narration":"...","subtitle_text":"...","card":{"type":"indices"},"bgm_mood":"calm_explain","target_seconds":18,"emphasis_tokens":[".."]},
 {"scene_id":"002","role":"driver","narration":"...","subtitle_text":"...","slot":"rates/up","image_prompt":"[palette:bullish] ...","bgm_mood":"tense_intro","target_seconds":32,"emphasis_tokens":[".."]}, ...]}
bgm_mood 는 calm_explain·neutral_bg·tense_intro·dramatic_reveal·hopeful_outro 중 하나.`;
}

function userPrompt(date, data, extra) {
  const big = data.stocks.filter((s) => Number.isFinite(s.pct) && Math.abs(s.pct) >= 1.5)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 20)
    .map((s) => `${s.t}(${s.name}) ${s.pct > 0 ? '+' : ''}${s.pct.toFixed(2)}% [${s.sec}]`);
  const d = {
    발행일_KST: date, 미국_장_날짜: data.us_session, 요일: DOW[new Date(`${data.us_session}T12:00:00Z`).getUTCDay()],
    지수: data.indices, 금리_원자재_환율: data.macro,
    섹터_시총가중_등락: data.sectors.map((s) => `${s.sec} ${s.pct > 0 ? '+' : ''}${s.pct.toFixed(2)}%`),
    상승_상위: data.movers.up.map((m) => `${m.t}(${m.name}) +${m.pct.toFixed(2)}%`),
    하락_상위: data.movers.down.map((m) => `${m.t}(${m.name}) ${m.pct.toFixed(2)}%`),
    '1.5%_이상_움직인_종목': big,
    종목_이유_출처포함: Object.entries(data.reasons || {}).map(([t, r]) => `${t}: ${r.why} — ${r.detail} (${r.url})`),
    시간외_움직임: (data.after_hours || []).map((s) => `${s.t}(${s.name}) 시간외 ${s.ah_pct > 0 ? '+' : ''}${s.ah_pct}%`),
    오늘_일정_KST: data.calendar.map((e) => `${e.kst} ${e.title_ko} (${e.impact}${e.forecast ? `, 예상 ${e.forecast}` : ''}${e.previous ? `, 이전 ${e.previous}` : ''})`),
  };
  return [
    '[데이터]', JSON.stringify(d, null, 1),
    '', '[데스크 — 기자단 브리핑(출처 포함)]', extra.desk || '(없음)',
    '', '[리서치 — 출처 포함]', extra.research || '(없음)',
    '', '[선정 토픽]', extra.topic || '(없음)',
    '', '[뉴스 헤드라인]', extra.headlines || '(없음)',
  ].join('\n');
}

function toMarkdown(epId, date, data, out, engine, growthRemedies = []) {
  const fm = {
    episode_id: epId, channel_id: 'econ-daily', format: CFG.format, form: 'market-summary', persona: 'barro-teacher',
    target_total_seconds: CFG.target_total_seconds, language: 'ko', writer: `summary-writer (${engine})`,
    created_at: new Date().toISOString(), revision: 1, summary_date: date, us_session: data.us_session,
    title_hook: out.title_hook, angle_summary: out.angle_summary || '',
    ...(growthRemedies.length ? { growth_remedies: growthRemedies } : {}),
    scenes: out.scenes.map((s, i) => ({
      scene_id: String(i + 1).padStart(3, '0'), role: s.role, narration: s.narration, subtitle_text: s.subtitle_text,
      ...(CFG.scenes[i].card ? { card: s.card } : { slot: s.slot, image_prompt: s.image_prompt }),
      bgm_mood: s.bgm_mood || 'calm_explain', target_seconds: s.target_seconds, emphasis_tokens: s.emphasis_tokens || [],
    })),
  };
  return `---\n${stringifyYAML(fm, { lineWidth: 0 })}---\n\n# ${epId} — ${CFG.series_label} (${data.us_session} 마감)\n\n${out.angle_summary || ''}\n`;
}

async function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string' }, date: { type: 'string' }, engine: { type: 'string' }, model: { type: 'string' },
  } });
  if (!values.episode) { console.error('Usage: generate-summary-script.js --episode EP-2026-NNNN [--date YYYY-MM-DD]'); process.exit(1); }
  const date = values.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const dir = join(ROOT, 'workspace', 'daily-news', date);
  const data = readJSON(join(dir, 'summary-us.json'));
  if (!data) { console.error(`❌ summary-us.json 없음 — collect-summary-data.js 를 먼저 돌려라 (${dir})`); process.exit(1); }
  const news = readJSON(join(dir, 'news.json'));
  const extra = {
    desk: read(join(dir, 'desk-briefing-us-close.md'), 9000),
    research: read(join(dir, 'research-us-close.md'), 7000),
    topic: read(join(dir, 'topic-us-close.json'), 2000),
    headlines: (news?.sources || []).flatMap((s) => (s.items || []).map((it) => `- ${it.title}`))
      .filter((l) => l.length > 14).slice(0, 40).join('\n'),
  };

  const chain = values.engine ? [values.engine] : resolveChain(process.env.BT_SCRIPT_ENGINE_CHAIN, 'claude,codex');
  // KPI 진단이 켠 마무리 처방(growth-diagnose.js). 프롬프트로 요구하고, 빠지면 결정론으로 넣는다.
  const remedies = readActiveRemedies(ROOT, { slot: 'us-close' });
  const extraCta = closingCtaOf(remedies);
  const sys = systemPrompt(extraCta);
  let prompt = userPrompt(date, data, extra);
  let out = null; let engine = null; let problems = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const got = await runEngineChain(chain, {
      claude: () => ({ json: callClaudeCode(sys, prompt, values.model || 'sonnet'), used: 'claude-code' }),
      codex: () => ({ json: callCodex(sys, prompt, values.model || null), used: 'codex' }),
    });
    engine = got.engineUsed;
    try { out = JSON.parse(firstJsonObject(got.json)); } catch (e) { problems = [`JSON 파싱 실패: ${e.message}`]; out = null; }
    if (out) {
      normalizeSeconds(out.scenes || [], CFG.target_total_seconds);
      ensureClosingCta(out.scenes, extraCta);
      problems = checkSummary(out, extraCta);
      const q = validateScript((out.scenes || []).map((s, i) => ({ ...s, scene_id: String(i + 1).padStart(3, '0') })))
        .filter((i) => i.severity === 'error');
      problems.push(...q.map((i) => formatIssue(i).trim()));
    }
    if (!problems.length) break;
    console.warn(`   ↻ 계약 위반 ${problems.length}건 (시도 ${attempt}/3)`);
    problems.forEach((p) => console.warn(`     - ${p}`));
    prompt = retryPrompt(userPrompt(date, data, extra), problems, out);
  }
  if (problems.length) { console.error('❌ 요약 대본 계약을 맞추지 못했다'); process.exit(1); }

  const base = join(ROOT, 'workspace', 'episodes', values.episode, 'platforms', CFG.platform);
  mkdirSync(base, { recursive: true });
  const path = join(base, '30_script.md');
  // 이 포맷은 대본 처방을 읽지 않는다 — 실제로 넣은 마무리 문장만 받은 처방으로 남긴다
  writeFileSync(path, toMarkdown(values.episode, date, data, out, engine,
    remediesApplied(remedies, { targets: ['closing'], scenes: out.scenes })));
  console.log(`✅ 요약 대본 (${engine}) → ${path}`);
  console.log(`   제목 훅: ${out.title_hook}`);
  out.scenes.forEach((s, i) => console.log(`   [${String(i + 1).padStart(3, '0')}/${s.role}] ${s.target_seconds}s · ${String(s.narration).length}자 · ${s.card ? `card=${s.card.type}` : `slot=${s.slot}`}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
