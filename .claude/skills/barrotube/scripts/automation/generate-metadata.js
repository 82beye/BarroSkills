#!/usr/bin/env node

/**
 * generate-metadata.js — Gemini로 70_publish_meta.json 자동 생성 (format 분기 지원)
 *
 * v1.1 (2026-04-22): format=shorts/long-3min 분기. Shorts 하드코딩 제거.
 *
 * Script + QA 결과를 바탕으로 title/description/tags + platforms.{youtube,tiktok,reels} 작성.
 * 작성 후 seo-enhance.js가 3-layer 자동 보강.
 *
 * Usage:
 *   node generate-metadata.js --episode <dir>
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';
import {
  resolveFiguresForBrief,
  pickPrimaryKeywordCandidates,
} from './lib/public-figures.js';
import { recordCost } from './lib/cost-tracker.js';
import { callClaudeCode, callCodex, resolveChain, runEngineChain } from './lib/text-engine.js';

// 스킬 루트 기준 경로. resolve('config/…') 는 CWD 의존이라
// launchd 처럼 CWD 가 다른 실행 환경에서 조용히 깨진다.
const SKILL_ROOT = resolve(import.meta.dirname, '../..');
const SERIES_CONFIG = join(SKILL_ROOT, 'config', 'series.json');

const DEFAULT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

/**
 * S9 메타데이터도 대본과 같은 체인을 쓴다.
 *
 * 2026-08-13: 대본·팩트체크를 옮긴 뒤에도 여기가 Gemini 전용이라 EP-2026-0091 이
 * 렌더까지 끝난 상태에서 429 로 멈췄다. 검색 도구가 필요 없는 순수 텍스트 생성이라
 * 대본과 동일한 claude → codex → gemini 순서를 그대로 적용한다.
 */
const ENGINE_CHAIN = resolveChain(process.env.BT_METADATA_ENGINE_CHAIN);

function buildSystemPrompt(format, seriesInfo, publicFiguresInfo = null) {
  const isShorts = format.startsWith('shorts');
  const formatLabel = isShorts ? `YouTube Shorts (${format === 'shorts-3min' ? '3분' : '60초'})` : 'YouTube 롱폼 (3분 시리즈)';
  // 시리즈 표시명: seriesInfo.series_name (series.json에서 동적 로드) 또는 series_id 자체.
  // 이전 코드는 sp500을 hardcode해서 다른 시리즈에도 sp500 라벨이 박혔음 — 이를 동적으로 교체.
  const seriesName = seriesInfo?.series_name || seriesInfo?.series_id || '';
  // 제목이 무엇을 말해야 하는지는 config/growth.json 의 content_policy 가 정본이다.
  // 2026-09-16 영상별 구독 실측: '왜·역설·숨은 원인' 구조가 있으면 구독/1k뷰 2.12,
  // 없으면 0.63 (26편). 조회는 수치 나열로도 받지만 구독은 안 따라온다 —
  // 최근 8편 중 7편이 수치 나열이었고 그 8편의 순증 구독 합이 1 이었다.
  // 북극성이 weekly_net_subs 이므로 이 규칙이 경쟁 채널 조회 lift 보다 위다.
  const cp = loadContentPolicy();
  const th = cp?.index_move_thresholds ?? {};
  const causalRule = cp?.title_requires_causal_clause
    ? ` · 제목은 반드시 "왜"를 말한다 — 통념과 어긋난 것/반대로 움직인 것/숨은 원인 중 하나를 제목 안에서 주장하라`
      + ` (예: "…인데도 …", "진짜 이유는 …", "금리 아니라 …")`
      + ` · **일상 등락률**(오늘 X% 올랐다/내렸다)을 제목의 주어로 쓰지 마라 — 지수 ${th.index_pct}%·환율 ${th.fx_pct}%·원자재 ${th.commodity_pct}%·금리 ${th.rate_bp}bp·개별종목 ${th.single_name_pct}% 미만은 뉴스가 아니다`
      + ` · 단, 레벨 돌파(금리 5%·유가 100달러·환율 1,400원 같은 라운드 넘버 돌파/붕괴)·N년래 최고최저·기간 누적 급등·연속기록은 등락폭과 무관하게 **반드시 제목의 메인**이다. 여럿이면 레벨돌파 > N년래최고 > 기간누적 > 연속기록 순`
      + ` · 시황 라벨([美마감]·[속보] 등)로 시작하지 마라 — 그 자리에 "왜"가 들어가야 한다`
    : '';
  const titleHint = isShorts
    ? `100자 이내, primary keyword 앞 30자에, '#Shorts' 포함 권장${causalRule}`
    : `70자 이내, primary keyword 앞 30자, 시리즈 번호 포함 예: '[${seriesName} ${seriesInfo?.series_episode || 1}/${seriesInfo?.series_total || 5}]', #Shorts 사용 금지`;
  const shortsTagValue = isShorts ? 'true' : 'false';
  const brandHashtags = isShorts ? '#BarroTube, #60초경제' : '#BarroTube, #3분경제, #경제수업';

  const seriesBlock = seriesInfo
    ? `\nSERIES CONTEXT:\n- Series: ${seriesInfo.series_id} "${seriesName}" (episode ${seriesInfo.series_episode}/${seriesInfo.series_total || '?'})\n- Title MUST include this series badge: "[${seriesName} ${seriesInfo.series_episode}/${seriesInfo.series_total || 5}]" — DO NOT substitute another series name (e.g. previous series).\n- description 상단 2~3줄에 "이 영상은 ${seriesName} 시리즈의 ${seriesInfo.series_episode}번째 편입니다." 시리즈 네비게이션 포함\n- Tags에 시리즈 관련 태그 필수 (${seriesInfo.series_id.replace(/-basic$/, '')}입문, ${seriesName.replace(/\s+입문.*$/, '')}시리즈 등)\n`
    : '';

  // Public Figures 컨텍스트 (CEO 정책 v1.0, 2026-04-26 — Metadata SEO 우선순위 강제)
  const charFigures = (publicFiguresInfo?.resolved || []).filter(r => r.treatment === 'CHARACTERIZE');
  const primaryFigureName = charFigures[0]?.figure?.display_name_ko || null;
  const figureBlock = primaryFigureName
    ? `\nPUBLIC FIGURE SEO PRIORITY (CEO 정책 v1.0, 2026-04-26):\n- 이 EP의 메인 인물: "${primaryFigureName}"${charFigures.length > 1 ? ` (외 ${charFigures.length - 1}명)` : ''}\n- title의 "primary keyword 앞 30자" 안에 "${primaryFigureName}"가 반드시 포함되어야 한다 (영문 alias 아닌 한국어 표기 우선).\n- tags 배열의 1~3번 슬롯 안에 "${primaryFigureName}" + 관련 직책/사건 키워드를 배치 (예: "${primaryFigureName} 발언", "${primaryFigureName} 영향").\n- description 첫 100자에도 "${primaryFigureName}" 등장 권장 — 결과 지표(VIX·금리·환율 등)가 인물 키워드보다 앞에 오면 안 된다.\n- 단, sensitivity=high 사건 보도(암살/사망/범죄 등)에서는 클릭베이트 톤 금지 — 사실 인용 위주로 작성.\n${charFigures.map(r => r.sensitivity === 'high' ? `- "${r.figure.display_name_ko}" sensitivity=high — 자극적 형용사("충격", "경악") 1회 이내, 정보성 톤 우선.` : '').filter(Boolean).join('\n')}\n`
    : '';

  return `You are "Metadata Writer Agent" of BarroTube (Korean economy YouTube channel).

FORMAT: ${format} (${formatLabel})
${seriesBlock}${figureBlock}
OUTPUT: Single JSON only. No markdown, no code fences.

SCHEMA:
{
  "title": "${titleHint}",
  "summary": "150자 이내 한 줄 요약",
  "description": "${isShorts ? '첫 100자에 secondary keywords, 말미에 해시태그' : '첫 100자에 시리즈 컨텍스트 + primary keyword, 중간에 본편 핵심 3가지, 다음 편 예고, 말미에 해시태그'}",
  "tags": ["18~25개, 합산 500자 이내, primary + secondary + related"],
  "categoryId": "25 (News & Politics)",
  "language": "ko",
  "shortsTag": ${shortsTagValue},
  "madeForKids": false,
  "platforms": {
    "youtube": {"caption": null, "hashtags": null},
    "tiktok": {"caption": "2200자 이내, 훅+3포인트+CTA 구조", "hashtags": ["#...", "..."]},
    "reels": {"caption": "2200자 이내", "hashtags": ["#...", "..."]}
  }
}

RULES:
- 클릭베이트/과장 금지
- 특정 종목 매수 추천 X
- 수치 구어체 (예: "4.4조" 대신 "사조사천억" 혹은 "4.4조 원")
- 브랜드 해시태그 포함: ${brandHashtags}
- privacyStatus는 절대 설정하지 마라 (사용자가 별도 지정)
${isShorts ? '- Description에 "#Shorts" 포함 필수' : '- "#Shorts" 절대 사용 금지 (롱폼은 Shorts 배지 박탈됨)'}
- description 말미에 면책 문구 포함: "본 영상은 투자 조언이 아닙니다. 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다."

CRITICAL JSON FORMATTING:
- String 값 내부에 줄바꿈이 필요하면 반드시 literal \\n 문자열을 사용 (실제 newline 금지).
- 예시: "description": "첫 줄.\\n\\n다음 줄." (O)
- 절대: "description": "첫 줄.
  다음 줄." (X — JSON invalid)
- 모든 따옴표는 \\" 로 escape.`;
}

async function callGemini(systemPrompt, userPrompt, model = DEFAULT_MODEL, maxTokens = 4000, costContext = {}) {
  const key = getSecret('GOOGLE_AI_API_KEY');
  if (!key) throw new Error('GOOGLE_AI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.3,
        maxOutputTokens: maxTokens,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();

  // Cost tracking — best-effort. Use usageMetadata when Gemini returns it; fall back to char-length estimate.
  const usage = data.usageMetadata || {};
  const inTok = Number(usage.promptTokenCount) || Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  const outTok = Number(usage.candidatesTokenCount) ||
                 Math.ceil((data.candidates?.[0]?.content?.parts?.[0]?.text?.length || 0) / 4);
  recordCost('metadata-writer', {
    model,
    input_tokens: inTok,
    output_tokens: outTok,
    episode: costContext.episode || null,
    stage: costContext.stage || 'S9',
    note: costContext.note || null,
  });

  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * 목표 공개 시각이 지났다면, 얼마나 지났는지(시간). 아직 안 지났으면 null.
 *
 * 이 기계는 노트북이라 예약 시각을 놓치는 일이 구조적으로 생긴다 — 일과 중(08~18시)
 * 잠들어 있다가 늦게 깨면 10:00 목표가 13:00 에 도달한다. 그때 선택지는 둘뿐이다:
 *   (a) private 로 남긴다 → 아무도 안 보는 사이 영영 묻힌다 (텔레그램도 죽어 있다)
 *   (b) 즉시 공개한다     → 늦었지만 나간다
 * 뉴스 채널이므로 조금 늦은 건 (b)가 맞고, 너무 늦으면 내용이 죽었으니 (a)가 맞다.
 * 경계는 config/routines.json 의 guards.publish_late_grace_hours.
 */
function hoursLate(input, now) {
  const s = String(input ?? '').trim();
  let target = null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) target = new Date(s);
  else {
    const m = s.match(/^(?:\+(\d)d\s+)?(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
    const day = m[1]
      ? new Date(Date.parse(`${today}T00:00:00Z`) + Number(m[1]) * 86400_000).toISOString().slice(0, 10)
      : today;
    target = new Date(`${day}T${m[2].padStart(2, '0')}:${m[3]}:00+09:00`);
  }
  if (!target || Number.isNaN(target.getTime())) return null;
  const late = (now.getTime() - target.getTime()) / 3600_000;
  return late > 0 ? late : null;
}

/** config/growth.json 의 content_policy. 없으면 null — 규칙 없이 기존 동작. */
function loadContentPolicy() {
  try {
    const p = join(resolve(import.meta.dirname, '../..'), 'config', 'growth.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')).content_policy ?? null;
  } catch { return null; }
}

/** 늦은 게시를 즉시 내보낼 유예 시간(h). 기본 6 — 반나절 넘으면 뉴스가 죽는다. */
function loadLateGraceHours() {
  try {
    const p = join(resolve(import.meta.dirname, '../..'), 'config', 'routines.json');
    const v = JSON.parse(readFileSync(p, 'utf-8'))?.guards?.publish_late_grace_hours;
    return Number.isFinite(v) && v >= 0 ? v : 6;
  } catch { return 6; }
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m ? parseYAML(m[1]) : null;
}

/**
 * "HH:MM" 또는 "+Nd HH:MM" (KST) → "YYYY-MM-DDTHH:MM:00+09:00". 완전한 ISO8601 이면 그대로 통과.
 *
 * "+Nd" 는 **만든 날과 공개하는 날을 떼어 놓기 위한** 것이다. 2026-09-14 실측(채널
 * Analytics 09-01~09-11): 하루에 2편을 올린 날 채널 총 조회 중앙값 1249(n=5), 3편을 올린
 * 날 1239(n=3) — 셋째 편은 도달을 **넓히지 않고 같은 파이를 나눈다**(편당 625 → 413).
 * 그런데 금요일만 us-close·realestate·kr-close 가 겹쳐 3편이고 토·일은 1편씩이라, 주 13편
 * 중 한 편이 구조적으로 낭비되고 있었다. realestate 를 토요일 공개로 미루면 같은 13편으로
 * 주간 도달이 +3.7~10.7% 늘어난다(제작 추가 0).
 * 크론 자체를 토요일로 옮기지 않는 이유 — 한국부동산원 주간지수가 목요일 발표라 금요일
 * 생성이 가장 신선하고, 금 10:00 은 kr-close(16:00) 와 겹치지 않도록 2026-09-10 에 고른
 * 자리다. 생성은 그대로 두고 공개만 미루는 편이 두 제약을 다 지킨다.
 *
 * 달력일은 실행 머신 TZ 가 아니라 Asia/Seoul 기준으로 잡는다 — launchd plist 에 TZ 가
 * 빠져 있던 이력이 있어 머신 TZ 를 신뢰하지 않는다.
 * 과거 시각이면 null 을 돌려 예약을 걸지 않는다: YouTube 가 과거 publishAt 을 거부하고,
 * 억지로 넣으면 영상이 private 로 남아 조용히 사라진다. 예약 없이 private 로 두고
 * 운영자가 처리하게 하는 편이 안전하다.
 */
export function resolvePublishAt(input, now = new Date()) {
  const s = String(input ?? '').trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const at = new Date(s);
    if (Number.isNaN(at.getTime())) return null;
    // 전체 ISO 도 **과거 검사를 받아야 한다.** 예전에는 여기서 그대로 통과시켰고,
    // HH:MM 경로에만 있던 5분 가드를 건너뛰었다. 2026-09-16 EP-2026-0156 실측:
    // 07:18 에 시작하며 10:00 을 목표로 넘겼는데 Grok 실패·폴백으로 13:09 에야 업로드돼
    // publishAt 이 3시간 전이 됐다 — 유튜브가 즉시 공개해 버렸고, 파이프라인은
    // 그걸 `status: scheduled` 로 보고했다. 의도한 시각도 아니고 보고도 틀렸다.
    if (at.getTime() - now.getTime() < 5 * 60 * 1000) return null;
    return s;
  }

  const m = s.match(/^(?:\+(\d)d\s+)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const plusDays = m[1] ? Number(m[1]) : 0;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return null;

  // 달력일을 KST 로 잡은 뒤 일수를 더한다. UTC 자정 기준으로 더해야 서머타임 없는
  // KST 에서 날짜가 어긋나지 않는다.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const day = plusDays === 0 ? today
    : new Date(Date.parse(`${today}T00:00:00Z`) + plusDays * 86400_000).toISOString().slice(0, 10);
  const iso = `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`;

  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  if (when.getTime() - now.getTime() < 5 * 60 * 1000) return null;
  return iso;
}

async function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string', short: 'e' },
    platform: { type: 'string' },
    engine: { type: 'string' },         // claude | codex | gemini | auto(기본)
    model: { type: 'string', short: 'm' },
    'publish-at': { type: 'string' },   // "HH:MM" (KST) 또는 완전한 ISO8601. 예약 공개.
  } });
  if (!values.episode) { console.error('Usage: generate-metadata.js --episode <dir> [--platform long|shorts] [--engine claude|codex|gemini] [--publish-at HH:MM]'); process.exit(1); }

  // produce-episode.js 가 S9 를 spawn 할 때 인자를 갈아끼우지 않아도 되도록 env 도 받는다
  // (BT_IMAGE_ENGINE 과 같은 관례 — 상위 오케스트레이터가 export 하면 그대로 전달됨).
  const publishAtArg = values['publish-at'] || process.env.BT_PUBLISH_AT || null;

  const epDir = resolve(values.episode);
  const platformHint = values.platform;
  const scriptCandidates = platformHint
    ? [join(epDir, 'platforms', platformHint, '30_script.md')]
    : [
        join(epDir, 'platforms', 'long', '30_script.md'),
        join(epDir, 'platforms', 'shorts', '30_script.md'),
        join(epDir, '30_script.md'),
      ];
  const scriptPath = scriptCandidates.find(p => existsSync(p));
  if (!scriptPath) { console.error('❌ Missing 30_script.md'); process.exit(1); }
  const baseDir = scriptPath.replace(/\/30_script\.md$/, '');

  const scriptMd = readFileSync(scriptPath, 'utf-8');
  const fm = parseFrontmatter(scriptMd);
  if (!fm) { console.error('❌ No frontmatter'); process.exit(1); }

  const format = fm.format || 'shorts';
  // series_name을 paperclip/config/series.json에서 동적으로 로드 → 다른 시리즈에 sp500 라벨 박히는 회귀 방지
  let seriesName = null, thumbnailSpec = null;
  if (fm.series_id) {
    try {
      const cfg = JSON.parse(readFileSync(SERIES_CONFIG, 'utf-8'));
      const s = (cfg.series || []).find(x => x.id === fm.series_id);
      seriesName = s?.name || null;
      thumbnailSpec = s?.thumbnail_specs?.find(t => t.episode === fm.series_episode) || null;
    } catch {}
  }
  const seriesInfo = fm.series_id ? {
    series_id: fm.series_id,
    series_name: seriesName,
    series_episode: fm.series_episode,
    series_total: fm.series_total || 5,
  } : null;

  const brief = existsSync(join(epDir, '00_brief.md')) ? readFileSync(join(epDir, '00_brief.md'), 'utf-8') : '';
  const refs = existsSync(join(epDir, '05_topic_references.md')) ? readFileSync(join(epDir, '05_topic_references.md'), 'utf-8').slice(0, 1500) : '';
  // 성장 처방 — 제목 패키징 지시(경쟁 제목 피처 lift 기반). growth-directives.js 산출.
  const growthDirectives = existsSync(join(epDir, '06_growth_directives.md'))
    ? readFileSync(join(epDir, '06_growth_directives.md'), 'utf-8').slice(0, 1500) : '';

  // brief frontmatter + topic 추출 (public-figures 감지용)
  let briefFM = {};
  let topicFromBrief = '';
  if (brief) {
    const fmMatch = brief.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      try { briefFM = parseYAML(fmMatch[1]) || {}; } catch { briefFM = {}; }
    }
    topicFromBrief = briefFM.topic || '';
    if (!topicFromBrief) {
      const tm = brief.match(/^topic:\s*["']?(.+?)["']?\s*$/m);
      if (tm) topicFromBrief = tm[1].trim();
    }
  }

  // Public Figures 결정 (CEO 정책 v1.0, 2026-04-26 — SEO primary_keyword 1순위)
  // hook narration까지 포함해 fallback 감지 (brief에 명시 없을 때 회귀 방지)
  const hookNar = (fm.scenes || []).find(s => s.role === 'hook')?.narration || '';
  const detectionText = `${topicFromBrief}\n${hookNar}`;
  const publicFiguresInfo = resolveFiguresForBrief(fm.channel_id, briefFM, detectionText);
  const figurePrimaryCandidates = pickPrimaryKeywordCandidates(publicFiguresInfo.resolved);

  console.log(`📝 Generating metadata for ${fm.episode_id}`);
  console.log(`   Format: ${format}`);
  if (seriesInfo) console.log(`   Series: ${seriesInfo.series_id} [${seriesInfo.series_episode}/${seriesInfo.series_total}]`);
  if (figurePrimaryCandidates.length) {
    console.log(`   Public Figure (SEO primary): ${figurePrimaryCandidates.join(', ')}`);
  }

  const systemPrompt = buildSystemPrompt(format, seriesInfo, publicFiguresInfo);

  const userPrompt = [
    `[EPISODE]`, fm.episode_id, `Channel: ${fm.channel_id}`, `Format: ${format}`,
    seriesInfo ? `Series: ${seriesInfo.series_id} ep ${seriesInfo.series_episode}/${seriesInfo.series_total}` : '',
    '',
    `[BRIEF]`, brief.slice(0, 800), '',
    `[SCRIPT SCENES]`,
    // narration 은 TTS 정본이라 숫자가 한글 수사다("국채 삼십년물", "이천이십일년").
    // 그게 설명문·태그로 그대로 새면 읽기도 나쁘고 검색도 안 된다 — 2026-08-15 EP-0094
    // 는 태그에 "이천일년" 이 박혀서 나갔다. subtitle_text 가 같은 사실의 아라비아 숫자
    // 표기이므로 함께 준다.
    fm.scenes.map(s => (s.subtitle_text
      ? `- [${s.role}] ${s.narration}\n      (표기용 숫자: ${s.subtitle_text})`
      : `- [${s.role}] ${s.narration}`)).join('\n'),
    '',
    `[표기 규칙] 제목·설명·태그의 숫자·연도·퍼센트는 반드시 아라비아 숫자로 쓴다`,
    `(예: "삼점사 퍼센트"→"3.4%", "이천일년"→"2001년", "에이아이"→"AI").`,
    `대본 narration 의 한글 수사 표기를 그대로 옮기지 마라. 태그에도 한글 수사 숫자를 넣지 마라.`,
    '',
    refs ? `[NEWS REFERENCES]\n${refs}\n` : '',
    growthDirectives ? `[GROWTH DIRECTIVES]\n제목 작성 시 아래 '제목 패키징' 지시와, '이번 주 실험' 중 적용 대상이 제목(메타데이터)인 것을 반영하라.\n표기 규칙·공인 인물 SEO 정책·클릭베이트 금지 규칙과 충돌하면 그쪽이 항상 우선이다:\n${growthDirectives}\n` : '',
    `[TASK]`,
    `위 에피소드의 YouTube${format.startsWith('shorts') ? '/TikTok/Reels' : ''} 배포 메타데이터를 JSON으로 작성하라.`,
  ].filter(Boolean).join('\n');

  // Long-form needs more tokens (description is longer + series context)
  const maxTokens = format.endsWith('3min') ? 8000 : 4000;
  const requested = values.engine || process.env.BT_METADATA_ENGINE || 'auto';
  const chain = requested === 'auto' ? ENGINE_CHAIN : [requested];
  const runners = {
    claude: () => ({ json: callClaudeCode(systemPrompt, userPrompt, values.model || 'sonnet'), used: 'claude-code' }),
    codex:  () => ({ json: callCodex(systemPrompt, userPrompt, values.model || null), used: 'codex' }),
    gemini: async () => ({
      json: await callGemini(systemPrompt, userPrompt, values.model || DEFAULT_MODEL, maxTokens, {
        episode: fm.episode_id, stage: 'S9', note: 'metadata-gen',
      }),
      used: values.model || DEFAULT_MODEL,
    }),
  };
  const { json: raw, engineUsed } = await runEngineChain(chain, runners, { log: console.error, warn: console.error });

  function safeParse(text) {
    try { return JSON.parse(text); } catch {}
    const fixed = text.replace(/"((?:[^"\\]|\\.)*)"/gs, (m, inner) => {
      const esc = inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
      return `"${esc}"`;
    });
    try { return JSON.parse(fixed); } catch (e) {
      console.error('❌ JSON parse failed (after fix-up):', e.message);
      console.error(text.slice(0, 500));
      process.exit(1);
    }
  }

  const meta = safeParse(raw);

  // 필수 필드 주입/보정
  meta.episode_id = fm.episode_id;
  meta.channel_id = fm.channel_id;
  meta.format = format;
  if (seriesInfo) {
    meta.series_id = seriesInfo.series_id;
    meta.series_episode = seriesInfo.series_episode;
    meta.series_name = seriesInfo.series_name;
    // playlist 자동 등록을 위한 hint
    meta.playlist = {
      series_id: seriesInfo.series_id,
      series_episode: seriesInfo.series_episode,
      register_after_publish: true,
    };
  }
  // 시리즈 thumbnail_specs를 메타에 박아서 publisher가 47_thumbnail.png + 키워드를 매칭할 수 있게.
  // generate-thumbnail이 이미 적용했지만 메타 차원에서도 보존 (audit · 재생성 시 참고).
  if (thumbnailSpec) {
    meta.thumbnail_spec = {
      keyword: thumbnailSpec.keyword,
      palette: thumbnailSpec.palette,
      rationale: thumbnailSpec.rationale,
    };
  }
  meta.thumbnail = meta.thumbnail || '47_thumbnail.png';
  meta.privacyStatus = 'private'; // 기본 private, 운영자가 필요 시 변경

  // 예약 공개 — publish-approval.js 가 publishAt 이 있으면 privacyStatus 를 private 로 강제하고
  // publish-youtube.js 가 status.publishAt 으로 실어 보낸다. 여기서는 값만 정확히 만든다.
  if (publishAtArg) {
    const publishAt = resolvePublishAt(publishAtArg);
    if (publishAt) {
      meta.publishAt = publishAt;
      console.log(`  ⏰ 예약 공개: ${publishAt}`);
    } else if (hoursLate(publishAtArg, new Date()) !== null) {
      // 목표를 놓쳤다. 얼마나 놓쳤는지로 갈린다.
      const late = hoursLate(publishAtArg, new Date());
      const grace = loadLateGraceHours();
      if (late <= grace) {
        meta.publishAt = null;
        meta.publish_late = { target: String(publishAtArg), hours_late: Number(late.toFixed(2)), action: 'publish_now' };
        console.warn(`  ⏱  목표 ${publishAtArg} 를 ${late.toFixed(1)}시간 놓쳤습니다 (유예 ${grace}h 이내) — 예약 없이 **즉시 공개**합니다.`);
      } else {
        meta.publish_late = { target: String(publishAtArg), hours_late: Number(late.toFixed(2)), action: 'hold_private' };
        console.warn(`  ⚠ 목표 ${publishAtArg} 를 ${late.toFixed(1)}시간 놓쳤습니다 (유예 ${grace}h 초과) — 내용이 낡았을 수 있어 private 로 둡니다. 운영자 확인 필요.`);
      }
    } else {
      console.warn(`  ⚠ --publish-at 형식을 해석하지 못해 무시합니다: ${publishAtArg}`);
    }
  }

  // Enforce format-aligned shortsTag (Gemini sometimes ignores)
  meta.shortsTag = format.startsWith('shorts');

  // 회귀 가드 (2026-04-27): long-3min EP에 Shorts/60초경제 태그·해시태그가 새어들어가는 사고 방지.
  // EP-2026-0028 사례: Gemini가 description 해시태그 블록에, seo-enhance.js가 tags 풀에 'Shorts'/'60초경제'를 추가해
  // SEO·카테고리가 혼탁해졌음. 여기서 sanitize를 강제하여 시리즈/롱폼 태그 무결성 보장.
  if (format === 'long-3min') {
    const longBlocked = ['shorts', '60초경제', '60초 경제', '60sec', '#shorts', '#60초경제'];
    if (Array.isArray(meta.tags)) {
      const before = meta.tags.length;
      meta.tags = meta.tags.filter(t => {
        const lc = String(t).toLowerCase().replace(/\s/g, '');
        return !longBlocked.some(b => lc.includes(b.toLowerCase().replace(/\s/g, '')));
      });
      if (meta.tags.length < before) {
        console.warn(`   ⚠ long-3min sanitize: removed ${before - meta.tags.length} shorts-only tag(s) from meta.tags`);
      }
    }
    if (typeof meta.description === 'string') {
      const sanitized = meta.description
        .replace(/#Shorts\b/gi, '')
        .replace(/#60초경제\b/g, '')
        .replace(/[ \t]+/g, ' ');
      if (sanitized !== meta.description) {
        console.warn(`   ⚠ long-3min sanitize: removed #Shorts/#60초경제 from description`);
        meta.description = sanitized;
      }
    }
  }

  // Public Figure SEO primary_keyword 1순위 강제 (CEO 정책 v1.0 §4)
  // seo-enhance.js가 후속 단계에서 meta.seo를 채우지만, primary_keyword를 미리 박아두면
  // 회귀(EP-0027 "VIX 지수"가 인물 키워드를 묻는 케이스) 방지.
  if (figurePrimaryCandidates.length) {
    const primary = figurePrimaryCandidates[0];
    meta.seo = meta.seo || {};
    meta.seo.primary_keyword = primary;
    meta.seo.primary_keyword_source = 'public-figure-policy-v1.0';
    // tags 1순위에 인물명 강제 (없으면 prepend)
    if (Array.isArray(meta.tags)) {
      const lowered = meta.tags.map(t => String(t).trim().toLowerCase());
      if (!lowered.includes(primary.toLowerCase())) {
        meta.tags = [primary, ...meta.tags];
      } else if (meta.tags[0] !== primary) {
        // primary 인물명을 1번 슬롯으로 끌어올림
        meta.tags = [primary, ...meta.tags.filter(t => t !== primary)];
      }
    }
  }

  // 다른 시리즈 라벨이 잘못 들어갔을 경우 title 보정 (Gemini가 종종 환각으로 sp500 prefix를 박음)
  if (seriesInfo && meta.title) {
    const expectedBadge = `[${seriesInfo.series_name} ${seriesInfo.series_episode}/${seriesInfo.series_total}]`;
    const wrongPattern = /\[[^\]]*입문\s+\d+\/\d+\]/;
    const m = meta.title.match(wrongPattern);
    if (m && !meta.title.startsWith(expectedBadge)) {
      const corrected = meta.title.replace(wrongPattern, expectedBadge);
      console.warn(`   ⚠ Title series badge 보정: ${m[0]} → ${expectedBadge}`);
      meta.title = corrected;
    }
  }

  // 어느 엔진이 만들었는지 남긴다 — 폴백이 일어난 EP 를 사후에 가릴 수 있어야 한다.
  meta.generated_by = `metadata-writer (${engineUsed})`;

  // EXP-02-distinct-headline: 최근 3일 제목과 같은 수치를 또 쓰면 표시해 둔다.
  try {
    const idxPath = join(resolve(import.meta.dirname, '../..'), 'workspace', 'growth', 'channel', 'videos.json');
    if (existsSync(idxPath) && meta.title) {
      const hit = findHeadlineCollision(meta.title, JSON.parse(readFileSync(idxPath, 'utf-8')), new Date());
      if (hit) {
        meta.headline_conflict = { shared: hit.shared, with: hit.title, published_at: hit.publishedAt };
        console.warn(`   ⚠ 제목 수치 충돌: ${hit.shared.join(', ')} — 최근 회차 「${String(hit.title).slice(0, 40)}」 와 겹친다`);
      }
    }
  } catch (e) {
    console.warn(`   ⚠ 제목 충돌 검사 건너뜀: ${e.message}`);
  }

  const outPath = join(baseDir, '70_publish_meta.json');
  writeFileSync(outPath, JSON.stringify(meta, null, 2), 'utf-8');

  console.log(`✅ Metadata saved: ${outPath}`);
  console.log(`   Title: ${meta.title}`);
  console.log(`   shortsTag: ${meta.shortsTag}`);
  console.log(`   Tags: ${meta.tags?.length || 0}개`);
}

/**
 * 최근 회차가 이미 쓴 수치를 제목에 또 박았는지 본다.
 *
 * 2026-09-14 실측(48h 조회, 2026-09-01~09-11): 3일 안에 같은 수치를 제목에 반복한
 * 두 번째 영상은 -68%(고용·코스피 1.64%) · -64%(코스피 4.61%) · -32%(브렌트유 100달러)
 * 였다. 반대로 같은 사건을 다른 각도·다른 수치로 연 회차는 +67% · +48% 였다.
 * 하루 두 편(us-close·kr-close)을 돌리는 채널이라 이 충돌이 구조적으로 생긴다.
 *
 * 막지는 않는다 — 제목 하나 때문에 게시를 멈추면 손실이 더 크다. 표시만 남겨
 * 거부창에서 사람이 판단하게 하고, 주간 회고가 EXP-02 를 실측할 근거로 쓴다.
 */
const NUM_TOKEN = /\d+(?:[.,]\d+)?\s*(?:%|퍼센트|달러|원|bp|배|선|조|억|만|포인트)/g;

export function headlineNumberTokens(title) {
  return new Set((String(title || '').match(NUM_TOKEN) || []).map((t) => t.replace(/\s+/g, '')));
}

export function findHeadlineCollision(title, videosIndex, now, { days = 3 } = {}) {
  const mine = headlineNumberTokens(title);
  if (!mine.size) return null;
  const cutoff = now.getTime() - days * 86400_000;
  for (const v of Object.values(videosIndex?.videos ?? {})) {
    const t = Date.parse(v?.publishedAt ?? '');
    if (!Number.isFinite(t) || t < cutoff || t > now.getTime()) continue;
    const shared = [...headlineNumberTokens(v.title)].filter((x) => mine.has(x));
    if (shared.length) return { title: v.title, publishedAt: v.publishedAt, shared };
  }
  return null;
}

// 직접 실행일 때만 main. resolvePublishAt 을 테스트에서 import 할 수 있게 한다.
// (build-distribution.js:159 와 같은 관례. node 가 argv[1] 을 절대경로로 해석하므로
//  produce-episode.js 가 상대경로로 spawn 해도 성립한다 — 실측 확인.)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}
