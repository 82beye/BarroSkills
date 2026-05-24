#!/usr/bin/env node

/**
 * seo-enhance.js — 에피소드 메타데이터의 SEO 필드 자동 보강
 *
 * 입력: 30_script.md + 기존 70_publish_meta.json (선택)
 * 출력: 70_publish_meta.json — seo.* 필드 채움 + tags 확장 + description 재구성
 *
 * 처리 단계:
 *  1. Script의 emphasis_tokens + narration에서 primary/secondary 후보 추출
 *  2. 도메인 사전 기반 related_search_terms 확장 (econ-daily 채널용)
 *  3. Long-tail keyword 조합 (primary + 질문형 suffix)
 *  4. Tag 18~25개 조립 (YouTube 500자 제한 준수)
 *  5. Description SEO 구조로 재작성 (첫 100자 키워드 농도, 끝 해시태그 블록)
 *
 * Usage:
 *   node seo-enhance.js --episode <dir> [--channel econ-daily]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';

// v1.2 (2026-04-27): brand_tags / "Shorts" hardcode를 format-aware로 분리.
// 이전 버전은 long-3min EP에도 'Shorts'·'60초경제' 태그가 새어들어가 SEO/카테고리를 오염시켰음.
//   - brand_tags_common: 모든 format에 공통 (BarroTube, 바로튜브, 경제브리핑)
//   - brand_tags_long_3min: long-3min 전용 (3분경제, 경제수업)
//   - brand_tags_shorts: shorts 전용 (60초경제, Shorts)
//   - assembleTags()와 rebuildDescription()는 format을 받아 해당 풀을 합침.
const CHANNEL_LEXICON = {
  'econ-daily': {
    domain: 'finance',
    categoryId: '25',
    related_by_topic: {
      '코스피': ['KOSPI', '한국 증시', '증시 전망', '주가 지수', '주식 시장'],
      'AI 반도체': ['엔비디아', 'SK하이닉스', '삼성전자', 'HBM', 'TSMC', 'AI 수혜주'],
      '2차전지': ['LG에너지솔루션', '삼성SDI', '에코프로', 'SK온', '배터리 관련주', '전기차'],
      '바이오': ['삼성바이오로직스', '셀트리온', '유한양행', '신약 개발', '제약'],
      '원화': ['환율', '달러', '외환', '원달러', '외국인 자금'],
      '금리': ['한국은행', '연준', 'Fed', '기준금리', '통화정책'],
      '부동산': ['아파트', '서울 집값', '강남', '매매', '전세'],
      'AI': ['인공지능', '챗GPT', '제미나이', 'AI 시대', 'LLM'],
    },
    brand_tags_common: ['BarroTube', '바로튜브', '경제브리핑'],
    brand_tags_long_3min: ['3분경제', '경제수업'],
    brand_tags_shorts: ['60초경제', 'Shorts'],
    long_tail_templates: [
      '{kw} 왜',
      '{kw} 이유',
      '{kw} 전망',
      '{kw} 분석',
      '{kw} 수혜주',
      '2026년 {kw}',
      '{kw} 뉴스',
      '{kw} 관련주 TOP',
    ],
  },
};

/**
 * Format-aware brand 태그 풀 조립.
 * shorts: common + brand_tags_shorts
 * long-3min (또는 그 외 long format): common + brand_tags_long_3min
 */
function brandTagsForFormat(lex, format) {
  const common = lex.brand_tags_common || [];
  if (format === 'shorts') return [...common, ...(lex.brand_tags_shorts || [])];
  // long-3min이 기본. 다른 long-* format이 추가돼도 같은 풀 사용.
  return [...common, ...(lex.brand_tags_long_3min || [])];
}

function parseFrontmatter(mdPath) {
  const md = readFileSync(mdPath, 'utf-8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('No YAML frontmatter');
  return parseYAML(m[1]);
}

/**
 * Script에서 키워드 후보 추출
 */
function extractKeywordCandidates(script) {
  const tokens = new Set();
  for (const scene of script.scenes || []) {
    for (const t of scene.emphasis_tokens || []) {
      if (t && typeof t === 'string') tokens.add(t.trim());
    }
  }
  return Array.from(tokens);
}

/**
 * Primary keyword = title 앞부분의 명사구 or 숫자 포함 인접 토큰 결합
 *  1. title에서 첫 쉼표/기호 앞 구문 (3~20자)
 *  2. candidates 중 숫자 토큰 + 직전 명사 토큰 결합
 *  3. emphasis_tokens 첫 항목
 */
function pickPrimaryKeyword(candidates, title) {
  if (title) {
    const firstPhrase = title.split(/[,.()·|·#]/)[0].trim()
      .replace(/\s+(시대|시장|전망|분석|뉴스|핵심|소식|정보|이야기|이슈)$/, '')
      .trim();
    if (firstPhrase.length >= 3 && firstPhrase.length <= 20) {
      return firstPhrase;
    }
  }
  if (candidates.length) {
    // 숫자 포함 토큰의 직전 토큰과 결합 시도
    for (let i = 0; i < candidates.length; i++) {
      if (/\d/.test(candidates[i])) {
        const prev = candidates[i - 1];
        if (prev && !/\d/.test(prev)) return `${prev} ${candidates[i]}`;
        return candidates[i];
      }
    }
    return candidates[0];
  }
  return '';
}

/**
 * 연관어 확장 — 채널 lexicon 기반 (키워드가 포함된 주제 매치)
 */
function expandRelated(candidates, channel) {
  const lex = CHANNEL_LEXICON[channel] || CHANNEL_LEXICON['econ-daily'];
  const out = new Set();
  for (const cand of candidates) {
    for (const [topic, related] of Object.entries(lex.related_by_topic)) {
      if (cand.includes(topic) || topic.includes(cand)) {
        related.forEach(r => out.add(r));
      }
    }
  }
  return Array.from(out);
}

/**
 * Long-tail 조합 생성
 */
function generateLongTails(primary, channel) {
  const lex = CHANNEL_LEXICON[channel] || CHANNEL_LEXICON['econ-daily'];
  return lex.long_tail_templates.map(tpl => tpl.replace('{kw}', primary));
}

/**
 * Tag 배열 조립 — 합산 500자 제약.
 * brand는 이미 brandTagsForFormat()으로 format에 맞게 들어옴 (Shorts 토큰은 shorts일 때만 포함).
 * 'Shorts' 하드코딩 append 제거 — long-3min에 Shorts 태그 새어드는 회귀 차단.
 */
function assembleTags(primary, secondary, longTails, related, brand) {
  const all = [
    primary,
    ...secondary,
    ...longTails.slice(0, 3),
    ...related,
    ...brand,
  ].filter(Boolean).map(s => s.trim()).filter(Boolean);

  // 중복 제거 (대소문자 무시)
  const seen = new Set();
  const unique = [];
  for (const t of all) {
    const key = t.toLowerCase().replace(/\s/g, '');
    if (!seen.has(key)) { seen.add(key); unique.push(t); }
  }

  // 500자 제약
  const picked = [];
  let total = 0;
  for (const t of unique) {
    const addLen = t.length + (picked.length ? 1 : 0); // 쉼표 포함
    if (total + addLen > 500) break;
    picked.push(t);
    total += addLen;
  }
  return picked;
}

/**
 * SEO 친화적 description 재구성.
 * format-aware brand 해시태그 사용 — long-3min에 'Shorts'/'60초경제' 해시태그 새어드는 회귀 차단.
 */
function rebuildDescription(script, seo, existingDesc, format) {
  const lines = [];
  // 첫 줄: primary keyword 포함 훅
  const hook = script.scenes?.[0]?.narration || seo.primary_keyword;
  lines.push(hook);
  lines.push('');

  // 본문: secondary + long-tail 자연 삽입
  if (existingDesc) {
    lines.push(existingDesc);
  } else {
    const teaser = format === 'shorts'
      ? `${seo.secondary_keywords.slice(0, 3).join(', ')} 관련 핵심을 1분에 정리합니다.`
      : `${seo.secondary_keywords.slice(0, 3).join(', ')} 관련 핵심을 3분에 정리합니다.`;
    lines.push(teaser);
  }
  lines.push('');

  // Long-tail 질문 섹션
  lines.push('▶ 함께 보면 좋은 키워드');
  for (const lt of seo.long_tail_keywords.slice(0, 4)) lines.push(`  · ${lt}`);
  lines.push('');

  // 해시태그 블록 — format-aware brand
  const brandHashes = format === 'shorts'
    ? ['BarroTube', '60초경제', 'Shorts']
    : ['BarroTube', '3분경제', '경제수업'];
  const hashSet = [
    seo.primary_keyword,
    ...seo.secondary_keywords.slice(0, 4),
    ...seo.related_search_terms.slice(0, 5),
    ...brandHashes,
  ].filter(Boolean).map(s => `#${s.replace(/\s/g, '')}`);
  lines.push([...new Set(hashSet)].join(' '));

  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      channel: { type: 'string', short: 'c' },
    },
  });
  if (!values.episode) {
    console.error('Usage: seo-enhance.js --episode <dir> [--channel econ-daily]');
    process.exit(1);
  }

  const epDir = resolve(values.episode);
  const scriptCandidates = [
    join(epDir, 'platforms', 'long', '30_script.md'),
    join(epDir, 'platforms', 'shorts', '30_script.md'),
    join(epDir, '30_script.md'),
  ];
  const scriptPath = scriptCandidates.find(p => existsSync(p));
  if (!scriptPath) { console.error('❌ Missing 30_script.md'); process.exit(1); }
  const baseDir = scriptPath.replace(/\/30_script\.md$/, '');
  const script = parseFrontmatter(scriptPath);
  const channel = values.channel || script.channel_id || 'econ-daily';

  const metaPath = join(baseDir, '70_publish_meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : {};
  meta.episode_id = script.episode_id;
  meta.channel_id = channel;
  meta.language = meta.language || 'ko';
  meta.shortsTag = meta.shortsTag !== false;

  // 1. 키워드 후보
  const candidates = extractKeywordCandidates(script);
  // generate-metadata.js가 public-figure 정책에 따라 primary_keyword를 미리 박아두면 그쪽 우선
  // (CEO 정책 v1.0 §4 — Metadata SEO 우선순위: 인물명 1순위)
  const presetPrimary = meta.seo?.primary_keyword;
  const presetSource = meta.seo?.primary_keyword_source;
  const primary = presetPrimary || pickPrimaryKeyword(candidates, meta.title);
  if (presetPrimary && presetSource === 'public-figure-policy-v1.0') {
    console.log(`   📌 primary_keyword 사전 지정: "${primary}" (source=${presetSource})`);
  }
  const secondary = candidates.filter(c => c !== primary).slice(0, 5);

  // 2. 연관어 확장
  const related = expandRelated(candidates, channel);

  // 3. Long-tail
  const longTails = generateLongTails(primary, channel);

  // 4. Brand — format-aware (long-3min vs shorts 분리). Shorts 태그는 shorts EP에만.
  const lex = CHANNEL_LEXICON[channel] || CHANNEL_LEXICON['econ-daily'];
  const format = script.format || 'shorts';
  const brand = brandTagsForFormat(lex, format);

  // 5. SEO 블록
  meta.seo = {
    primary_keyword: primary,
    secondary_keywords: secondary,
    long_tail_keywords: longTails,
    related_search_terms: related,
    search_intent: 'informational',
    category_signal: lex.domain,
    generated_at: new Date().toISOString(),
  };
  if (presetSource) meta.seo.primary_keyword_source = presetSource;

  // 6. tags 조립
  meta.tags = assembleTags(primary, secondary, longTails, related, brand);
  meta.categoryId = meta.categoryId || lex.categoryId;

  // 7. description 재구성 (기존 있으면 preserve) — format에 따라 brand hashtag 분기
  if (!meta.description || meta.description.length < 200) {
    meta.description = rebuildDescription(script, meta.seo, meta.description, format);
  }

  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

  console.log(`✅ SEO enhanced: ${metaPath}`);
  console.log(`   Primary: ${primary}`);
  console.log(`   Secondary: ${secondary.join(', ')}`);
  console.log(`   Related: ${related.length}개`);
  console.log(`   Long-tail: ${longTails.length}개`);
  console.log(`   Tags: ${meta.tags.length}개 (총 ${meta.tags.join(',').length}자)`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
