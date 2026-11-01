#!/usr/bin/env node

/**
 * generate-summary-script.js — 「미국 증시 요약」 대본 (세로 3분·7씬)
 *
 * generate-script.js 는 쇼츠의 「통찰형 훅」 계약(수치 하나·인과·질문)으로 다듬어져 있다.
 * 요약 포맷의 글은 담담한 통신사 브리핑체이고 질문형 훅을 쓰지 않는다(벤치마크 오선 「증시 요약」 427편).
 * 다만 지수·원인·종목·월가 인용·일정을 칸마다 읽는 벤치마크 구성은 버렸다 — 2026-10-15 운영자
 * (EP-2026-0234): 「열거 형태로 또 생성됐다, 그날의 이슈가 주제·제목이어야 한다」. 한 편은 그날의
 * 이야기(thesis) 하나이고, 7씬은 그 이야기의 단계다(config/market-summary.json scenes).
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
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';

import { callClaudeCode, callCodex, resolveChain, runEngineChain } from './lib/text-engine.js';
import { validateScript, formatIssue } from './lib/script-quality-contract.js';
import { MASCOT_CLAUSE, checkEpisodePrompts } from './lib/image-prompt-contract.js';
import { allSlots, PALETTE_DIRECTION } from './lib/scene-slot-taxonomy.js';
import { buildImagePromptContractBlock } from './generate-script.js';
import { reviewSummaryBrief, reviewSummarySpine } from './lib/editorial-spine.js';
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
/** 대본이 그날의 기록(사상 최고치 등)을 말했는지 — 「사상 최고」·「최고치」·「신고가」 중 하나. */
const RECORD_WORDS = /사상 최고|최고치|신고가/;

export function checkSummary(out, extraCta = null, events = []) {
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
  // 기록이 있는 날은 기록이 주제다 — 2026-10-07 EP-2026-0214: 나스닥 2연속·S&P500 사상 최고치인 날
  // 씬 1 이 지수 등락률부터 읽고 신고가는 세 번째 문장에, 나스닥 기록은 아예 빠졌다.
  if (events.length) {
    const opening = String(scenes[0]?.narration || '').split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    if (!RECORD_WORDS.test(opening)) problems.push(`씬 1 은 「…요약입니다.」 바로 다음 문장에서 오늘의 기록을 먼저 말해야 한다: ${events.join(' · ')}`);
    if (!RECORD_WORDS.test(hook)) problems.push(`title_hook 은 오늘의 기록을 이름으로 써야 한다 (예: 「나스닥·S&P500 나란히 사상 최고치」): ${events.join(' · ')}`);
  }
  return problems;
}

// 한 편 = 한 이야기. 2026-10-15 EP-2026-0234: 씬이 업종 순위·종목 등락·금·비트코인을 칸마다 채웠고,
// 그날 시장을 흔든 사건(CPI 쇼크로 연준 추가 인상 세 차례가 가격에 들어갔다)은 제목에도 대본에도 없었다.
// 어느 날에나 맞는 말은 핵심어로 세지 않는다 — 「시장」을 핵심어로 두면 모든 씬이 통과한다.
const BROAD_TERMS = new Set(['미국', '증시', '시장', '주식', '주가', '투자', '오늘', '지수', '한국', '뉴욕', '경제']);
const squash = (s) => String(s || '').replace(/\s+/g, '');

/** thesis 가 제목과 모든 씬을 꿰는가. 문제 목록(문자열)을 돌려준다. */
export function checkThesis(out) {
  const problems = [];
  if (String(out?.thesis || '').trim().length < 10) problems.push('thesis 에 오늘의 이야기를 한 문장으로 적어라');
  const terms = (Array.isArray(out?.thesis_terms) ? out.thesis_terms : []).map((t) => String(t).trim()).filter(Boolean);
  if (terms.length < 1 || terms.length > 4) return [...problems, 'thesis_terms 에 이야기의 핵심어를 1~4개 적어라 (예: ["금리 인상","연준"])'];
  const keys = terms.map(squash).filter((t) => t.length >= 2 && !BROAD_TERMS.has(t));
  if (keys.length < terms.length) {
    problems.push(`thesis_terms 에 어느 날에나 맞는 말이 있다(${terms.filter((t) => !keys.includes(squash(t))).join('·')}) — 오늘 이야기만의 핵심어를 써라`);
  }
  if (!keys.length) return problems;
  const has = (text) => keys.some((k) => squash(text).includes(k));
  if (!has(out.title_hook)) problems.push(`title_hook 이 오늘의 이야기를 말하지 않는다 — thesis_terms(${terms.join('·')}) 중 하나를 넣어라`);
  const off = (out.scenes || []).map((s, i) => (has(s.narration) ? 0 : i + 1)).filter(Boolean);
  if (off.length) {
    problems.push(`씬 ${off.join('·')} narration 이 이야기에서 벗어났다(thesis_terms ${terms.join('·')} 없음) — 그 씬의 사실이 오늘 이야기의 어느 단계인지 그 말로 이어라. 이야기와 무관한 자료면 빼고 다른 사실로 채워라`);
  }
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

## 한 편 = 한 이야기 (가장 중요)
- 오늘 미국장의 이야기 하나를 thesis 로 정한다. 그날 시장이 스스로 지목한 주된 사건 — 통신사 마감 시황 헤드라인이 지수 등락의 원인으로 꼽은 것
  (예: 물가 쇼크로 연준 추가 인상 기대가 뛰었다 · 실적 쇼크 · 사상 최고치) — 이 주제다.
  [에피소드 브리프]·[데스크]가 지엽적인 반직관 사실을 주제로 골랐어도 입력 안에 시장을 더 크게 흔든 사건이 있으면 그 사건을 주제로 삼고,
  반직관 사실은 twist 씬의 한 장면으로 다룬다.
- 발표된 지표·실적은 방아쇠(trigger 씬)다. 이야기의 주어는 시장이 그것을 보고 다시 가격에 넣은 것 — 연준 금리 경로(인상·인하 확률과 횟수)·
  실적 전망 같은 기대의 변화와, 시장이 그것을 받아들인 감정(공포·안도·환호)이다. thesis·title_hook 을 「물가 예상 상회」처럼
  지표 결과로 쓰지 말고 그 결과가 바꾼 기대로 써라(예: 「물가 예상 상회」가 아니라 「연준 추가 인상 공포」).
- ${CFG.scenes.length}씬은 자료 칸이 아니라 그 이야기의 단계다(선언 → 사건 → 반응 → 이유 → 반대 신호 → 한국 → 다음 장). 모든 씬이 thesis 를 한 걸음씩 전진시킨다.
- thesis_terms 는 이야기의 핵심어 1~4개(예: "금리 인상", "연준"). 모든 씬 narration 과 title_hook 에 그중 하나가 들어가야 한다.
  「미국」「증시」「시장」처럼 어느 날에나 맞는 말은 핵심어가 아니다.
- 열거 금지: 업종 순위, 상승·하락 상위 종목, 금·은·비트코인·유가·환율 시세를 자료에 있다는 이유로 읽지 마라. 이야기를 증명하거나 이야기에 단서를 보탤 때만 쓴다.

## 시청자에게 말하지 않는 것 — 제작 과정
- 기사 본문을 읽었는지, 제목·요약만 봤는지, 검증·확인했는지, 스냅샷·자료에 있는지, 「추정입니다」 같은 작가 메모는 narration·subtitle_text 에 쓰지 않는다.
  [데스크]·[리서치]의 「확인 못 함」「추정」 표시는 너에게 주는 메모다 — 그 사실을 쓸지 뺄지만 정하고, 낭독하지 마라.
- 확인 못 한 사실은 문장째 뺀다. 출처가 지목한 원인은 「<매체>는 …때문이라고 분석했습니다」, 시장 해석은 「…라는 해석이 나옵니다」로 전한다.
  해석임을 밝히는 것과 제작 과정을 말하는 것은 다르다.

## 형식 (반드시)
- 씬 정확히 ${CFG.scenes.length}개, 순서·role 고정:
${roles}
- 총 ${CFG.target_total_seconds}초. narration 은 초당 약 ${CFG.chars_per_second}자(띄어쓰기 포함, TTS 실측) — target_seconds × ${CFG.chars_per_second} ± 10%.
- 문체: 담담한 통신사 브리핑체(「~했습니다」「~전했습니다」). 시청자에게 질문하지 말 것, 「내 계좌」·구독 권유·감탄사 금지, 과장 형용사 금지.
- 씬 1 은 「<미국 장 날짜를 한글로, 예: 구월 삼십일 수요일> 미국 증시 요약입니다.」로 시작한다.
- 화면 카드가 3대 지수·등락률을 보여준다. 음성으로 다시 세 지수를 읽지 말고, 오늘 설명할 사건과 그 경제적 의미를 먼저 말한다. 기록이 있는 날은 기록을 우선한다.
- 마지막 씬 narration 은 ${extraCta ? `「${extraCta}」 「${CFG.cta}」 다음 「${CFG.disclaimer}」 세` : `「${CFG.cta}」 다음 「${CFG.disclaimer}」 두`} 문장으로 끝낸다(문구 그대로).
- subtitle_text 는 화면에 뜨는 요약이다 — 그 씬 narration 의 핵심을 숫자 표기로 한두 줄(줄당 22자 이내).

## 사실 규칙
- 수치는 [데이터]·[데스크]·[리서치]에 있는 것만. 없는 숫자·없는 발언을 지어내지 마라.
- 인용은 [데스크]·[리서치]에 실제로 있는 발언만, 「<소속> <이름>은 …라고 전했습니다」. 그런 발언이 없으면 매체 이름으로 시장 해석을 전한다.
- reaction 씬 종목은 「종목_이유_출처포함」에 있으면서 이야기와 이어지는 종목. 이유를 모르는 종목은 고르지 마라.
- 장 마감 뒤 실적(시간외 움직임·데스크에 나온 실적 발표)은 이야기와 이어질 때만 trigger 나 reaction 에서 다룬다.
- 날짜 기준: 지수·종목은 미국 장 날짜, 일정은 한국 시간.
- 같은 사실을 두 씬에서 다시 읽지 마라. trigger 의 사건을 mechanism·twist 에서 되풀이하지 말고 이유·반대 신호·파급 결과 중 새 정보를 보태라.
- 전제와 결과를 혼동하지 마라. '금리가 오르면 자금조달 비용이 높아질 수 있다'는 조건부 경로이고, 특정 기업의 실적 악화가 확인됐다는 뜻은 아니다. 근거가 없는 연결은 editorial_spine 에 unknown 으로 적고 대본에서는 말하지 마라. 확정 전망·종목 행동 권유를 만들지 마라.
- 다음 신호는 실제 확인 가능한 발표·실적·관측 변수여야 한다. 일정 입력이 비면 시각을 꾸미지 말고, 중심 사건과 직접 관련된 검증 신호를 선택한다. 신호가 전제와 다른 방향일 때 해석이 어떻게 달라지는지도 근거 범위 안에서 설명한다.

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

## 그날의 주제 — 기록이 먼저
- [데이터] 오늘의_기록(사상 최고치·연속 기록)은 그날 미국장의 사건이다. 있으면 그것이 주제다:
  씬 1 은 「…요약입니다.」 바로 다음 문장에서 그 기록을 먼저 말하고(여러 지수면 함께, 연속이면 며칠째인지),
  필요한 지수 하나만 음성 근거로 붙이고 나머지는 카드로 보인다. title_hook 도 그 기록을 이름으로 쓴다. 등락률만으로 열지 마라.
- 이 영상은 밤사이 끝난 미국장 정리다. 다만 [에피소드 브리프]가 한·미 대비를 주제로 선정했다면 코스피·외국인 수급 등 핵심 숫자를 빼지 마라.
  이 경우 첫 씬에서 코스피와 미국장의 대비를 열고, 뒤 씬에서 근거와 한계를 설명한다.
  한국의 같은 날짜 장은 미국 정규장이 시작되기 전에 마감한다. "한국 장 마감 뒤 그날 밤 미국 장에서…"처럼 순서를 밝히고,
  나중에 나온 미국 종목 종가가 앞선 한국 급락의 원인이라고 쓰지 마라. 두 시장의 공통 악재도 확인된 보도 범위에서만 설명한다.

## 제목
- title_hook: thesis 를 압축한 말 — 그날 시장을 흔든 사건, 시장이 그것을 어떻게 받아들였는지(공포·안도·환호)까지 담아도 좋다. ${CFG.title.hook_max_chars}자 이내. 괄호 태그 금지.
  짧을수록 좋다 — 사건의 크기가 조회수를 정한다(대비 구조 「A에도 B」 허용). 이야기 안의 세부 반전을 제목으로 올리지 마라.

## 출력
JSON 하나만. 코드펜스·설명 금지.
editorial_spine 은 검토용 메모다(화면·음성에 나가지 않는다). observation은 확인된 사건, mechanism은 출처가 지목한 원인 또는 '원인 미확인', transmission은 경제적 전달 경로, viewer_result는 조건을 붙인 시청자 결과, watch_signal은 실제 확인할 변수다. evidence_refs는 입력에 있는 URL 또는 원자료 식별자 summary-us.json만 쓴다. 이 메모를 채우려고 근거 없는 인과를 새로 만들지 마라.
{"thesis":"<오늘의 이야기 한 문장>","thesis_terms":["..",".."],"title_hook":"...","angle_summary":"<한 문장>","editorial_spine":{"observation":"...","mechanism":"...","transmission":"...","viewer_result":"...","watch_signal":"...","evidence_refs":["summary-us.json"]},"scenes":[
 {"scene_id":"001","role":"open","narration":"...","subtitle_text":"...","card":{"type":"indices"},"bgm_mood":"calm_explain","target_seconds":16,"emphasis_tokens":[".."]},
 {"scene_id":"002","role":"trigger","narration":"...","subtitle_text":"...","slot":"rates/up","image_prompt":"[palette:bullish] ...","bgm_mood":"tense_intro","target_seconds":28,"emphasis_tokens":[".."]}, ...]}
bgm_mood 는 calm_explain·neutral_bg·tense_intro·dramatic_reveal·hopeful_outro 중 하나.`;
}

function userPrompt(date, data, extra) {
  const big = data.stocks.filter((s) => Number.isFinite(s.pct) && Math.abs(s.pct) >= 1.5)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 20)
    .map((s) => `${s.t}(${s.name}) ${s.pct > 0 ? '+' : ''}${s.pct.toFixed(2)}% [${s.sec}]`);
  const d = {
    발행일_KST: date, 미국_장_날짜: data.us_session, 요일: DOW[new Date(`${data.us_session}T12:00:00Z`).getUTCDay()],
    지수: data.indices, 오늘의_기록: data.events?.length ? data.events : '(없음)', 금리_원자재_환율: data.macro,
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
    '', '[에피소드 브리프 — 선정한 주제]', extra.briefTopic || '(없음)',
    '', '[데스크 — 기자단 브리핑(출처 포함)]', extra.desk || '(없음)',
    '', '[리서치 — 출처 포함]', extra.research || '(없음)',
    '', '[선정 토픽]', extra.topic || '(없음)',
    '', '[뉴스 헤드라인]', extra.headlines || '(없음)',
  ].join('\n');
}

export function evidenceRefs(data, extra) {
  const input = [extra.briefTopic, extra.desk, extra.research, extra.topic,
    ...Object.values(data.reasons || {}).map((reason) => reason.url || '')].join('\n');
  return ['summary-us.json', ...new Set(input.match(/https?:\/\/[^\s)\]"'<>]+/g) || [])];
}

function toMarkdown(epId, date, data, out, engine, growthRemedies = []) {
  const fm = {
    episode_id: epId, channel_id: 'econ-daily', format: CFG.format, form: 'market-summary', persona: 'barro-teacher',
    target_total_seconds: CFG.target_total_seconds, language: 'ko', writer: `summary-writer (${engine})`,
    created_at: new Date().toISOString(), revision: 1, summary_date: date, us_session: data.us_session,
    title_hook: out.title_hook, thesis: out.thesis, thesis_terms: out.thesis_terms, angle_summary: out.angle_summary || '',
    editorial_spine: out.editorial_spine,
    ...(data.events?.length ? { events: data.events } : {}),
    // 썸네일 헤드라인은 제목 훅(그날의 사건)이다. 없으면 생성기가 씬 1 자막(지수 등락률)을 걸었다 —
    // 2026-10-07 EP-2026-0214 썸네일이 「다우 +0.49% 나스닥 +0.45% S&P500」이었다.
    thumbnail: { headline_text: out.title_hook },
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
  const briefText = read(join(ROOT, 'workspace', 'episodes', values.episode, '00_brief.md'), 6000);
  const briefTopic = briefText.match(/^---\n([\s\S]*?)\n---/)?.[1];
  let selectedTopic = '';
  if (briefTopic) {
    try { selectedTopic = String(parseYAML(briefTopic)?.topic || ''); } catch { /* old brief without valid YAML */ }
  }
  const extra = {
    briefTopic: selectedTopic,
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
      problems = checkSummary(out, extraCta, data.events || []);
      problems.push(...checkThesis(out));
      problems.push(...reviewSummarySpine(out, evidenceRefs(data, extra)));
      problems.push(...reviewSummaryBrief(out, selectedTopic));
      const q = validateScript((out.scenes || []).map((s, i) => ({ ...s, scene_id: String(i + 1).padStart(3, '0') })))
        .filter((i) => i.severity === 'error');
      problems.push(...q.map((i) => formatIssue(i).trim()));
    }
    if (!problems.length) break;
    console.warn(`   ↻ 계약 위반 ${problems.length}건 (시도 ${attempt}/3)`);
    problems.forEach((p) => console.warn(`     - ${p}`));
    prompt = retryPrompt(userPrompt(date, data, extra), problems, out);
  }
  // Exit 3 is a content failure. The pipeline must not silently replace this
  // with the generic writer after all editorial rewrites failed.
  if (problems.length) { console.error('❌ 요약 대본 계약을 맞추지 못했다'); process.exit(3); }

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
