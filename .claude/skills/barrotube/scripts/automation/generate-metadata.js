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

const DEFAULT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

function buildSystemPrompt(format, seriesInfo, publicFiguresInfo = null) {
  const isShorts = format === 'shorts';
  const formatLabel = isShorts ? 'YouTube Shorts (60초)' : 'YouTube 롱폼 (3분 시리즈)';
  // 시리즈 표시명: seriesInfo.series_name (series.json에서 동적 로드) 또는 series_id 자체.
  // 이전 코드는 sp500을 hardcode해서 다른 시리즈에도 sp500 라벨이 박혔음 — 이를 동적으로 교체.
  const seriesName = seriesInfo?.series_name || seriesInfo?.series_id || '';
  const titleHint = isShorts
    ? "100자 이내, primary keyword 앞 30자에, '#Shorts' 포함 권장"
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

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m ? parseYAML(m[1]) : null;
}

async function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string', short: 'e' },
    platform: { type: 'string' },
  } });
  if (!values.episode) { console.error('Usage: generate-metadata.js --episode <dir> [--platform long|shorts]'); process.exit(1); }

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
      const cfg = JSON.parse(readFileSync(resolve('paperclip/config/series.json'), 'utf-8'));
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
    fm.scenes.map(s => `- [${s.role}] ${s.narration}`).join('\n'),
    '',
    refs ? `[NEWS REFERENCES]\n${refs}\n` : '',
    `[TASK]`,
    `위 에피소드의 YouTube${format === 'shorts' ? '/TikTok/Reels' : ''} 배포 메타데이터를 JSON으로 작성하라.`,
  ].filter(Boolean).join('\n');

  // Long-form needs more tokens (description is longer + series context)
  const maxTokens = format === 'long-3min' ? 8000 : 4000;
  const raw = await callGemini(systemPrompt, userPrompt, DEFAULT_MODEL, maxTokens, {
    episode: fm.episode_id,
    stage: 'S9',
    note: 'metadata-gen',
  });

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

  // Enforce format-aligned shortsTag (Gemini sometimes ignores)
  if (format === 'long-3min') meta.shortsTag = false;

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

  const outPath = join(baseDir, '70_publish_meta.json');
  writeFileSync(outPath, JSON.stringify(meta, null, 2), 'utf-8');

  console.log(`✅ Metadata saved: ${outPath}`);
  console.log(`   Title: ${meta.title}`);
  console.log(`   shortsTag: ${meta.shortsTag}`);
  console.log(`   Tags: ${meta.tags?.length || 0}개`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
