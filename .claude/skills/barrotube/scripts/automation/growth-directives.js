#!/usr/bin/env node

/**
 * growth-directives.js — 성장 처방 생성 (성장 루프의 [처방] 단계)
 *
 * KPI 스코어카드 + 슬롯별 경쟁 분석 + 자체 성과 신호 + 진행 중 실험을
 * 대본(S4)·메타데이터(S9)가 소비 가능한 짧은 지시문으로 압축한다. 전부 결정론.
 *
 * 입력:
 *   workspace/growth/kpi/<date>.json                      (없으면 신호 섹션 축소)
 *   workspace/intel/competitors/analysis-<date>-<slot>.json (없으면 통합본 폴백)
 *   workspace/growth/experiments.json                     (현재 실험)
 * 산출:
 *   workspace/growth/directives/<date>-<slot>.md   (슬롯당 1개)
 *
 * 소비처: auto-pipeline.sh Phase 3 가 06_growth_directives.md 로 EP 에 설치 →
 *   generate-script.js(훅·소재) / generate-metadata.js(제목 패키징) 가 읽는다.
 * 길이 상한 3400자 — 대본 프롬프트가 3000자로 자르므로 핵심을 앞에 배치한다.
 *
 * Usage:
 *   node growth-directives.js --date 2026-08-31            # 3개 슬롯 전부
 *   node growth-directives.js --date 2026-08-31 --slot us-close
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const INTEL_DIR = join(ROOT, 'workspace', 'intel', 'competitors');
const GROWTH_DIR = join(ROOT, 'workspace', 'growth');
const OUT_DIR = join(GROWTH_DIR, 'directives');
const SLOTS = ['us-close', 'kr-close', 'realestate'];
const MAX_CHARS = 3000; // 소비처(generate-script)의 slice(0,3000) 안에 통째로 들어가게

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

/**
 * 제목 피처 → 사람 읽는 지시. positive 상위 2 + negative 상위 2.
 * 문구는 lib/competitor-analytics.js TITLE_FEATURES 의 측정 regex 와 1:1 로 맞춘다 —
 * 측정은 콜론·파이프·슬래시(/[:|/]/)를 재는데 처방이 대시·물결을 지목하면 근거가 성립하지
 * 않는다 (2026-08-31 리뷰에서 실제로 그렇게 오역돼 있었다). has_bracket 도 '포함'이 아니라
 * '맨 앞'(^\[) 이 측정 대상이다.
 */
export function titleDirectives(features) {
  const NAME = {
    has_bracket: '제목 맨 앞 [대괄호 태그] (예: [美마감] …)',
    has_number: '제목에 구체 수치',
    has_percent: '제목에 %·bp·배 수치',
    has_question: '질문형 제목(왜·어떻게·진짜)',
    has_superlative: '최상급·자극 표현(최대·역대·폭락·충격)',
    has_split: '콜론(:)·파이프(|)·슬래시(/) 분절',
    title_short: '30자 이내 짧은 제목',
    has_emoji: '이모지',
  };
  // '쓰기' 처방은 채널 정책과 충돌하지 않는 피처만. has_superlative 가 positive 로 잡혀도
  // 클릭베이트 금지 규칙(메타데이터 시스템 프롬프트)과 정면 충돌하므로 권하지 않는다.
  const SAFE_POSITIVE = new Set(['has_bracket', 'has_number', 'has_percent', 'has_question', 'title_short']);
  const rows = (features ?? []).filter((f) => NAME[f.feature] && f.n_with >= 10);
  const pos = rows.filter((f) => f.direction === 'positive' && SAFE_POSITIVE.has(f.feature))
    .sort((a, b) => b.lift - a.lift).slice(0, 2);
  const neg = rows.filter((f) => f.direction === 'negative').sort((a, b) => a.lift - b.lift).slice(0, 2);
  return [
    ...pos.map((f) => `- 쓰기: ${NAME[f.feature]} (경쟁 lift ${f.lift}×)`),
    ...neg.map((f) => `- 피하기: ${NAME[f.feature]} (lift ${f.lift}×)`),
  ];
}

/** UTF-16 서로게이트 페어(이모지) 한가운데를 자르지 않는 절단. */
export function cut(s, n) {
  const t = String(s).slice(0, n);
  const c = t.charCodeAt(t.length - 1);
  return c >= 0xd800 && c <= 0xdbff ? t.slice(0, -1) : t;
}

/** 소진된 화제: 이상치 상위에서 제목 앞부분만 추린다. */
export function exhaustedTopics(outliers, limit = 3) {
  return (outliers ?? []).slice(0, limit)
    .map((o) => `- ${cut(o.title, 45)}… (${o.channel}, ${o.multiple ?? o.vpd_multiple ?? ''}× 소진)`);
}

export function buildDirective({ date, slot, analysis, kpi, experiment }) {
  const lines = [`# 성장 지시 — ${date} · ${slot}`, ''];

  // 1) 실험 — 최우선. 주 1개 실험이 로테이션의 핵심이라 맨 위.
  if (experiment?.directive) {
    const target = experiment.target === 'script' ? '대본(훅)' : '제목(메타데이터)';
    lines.push(`## 이번 주 실험 (${experiment.id} · 적용 대상: ${target})`, `- ${experiment.directive}`, '');
  }

  // 2) 제목 패키징 (S9 메타데이터가 소비)
  const tf = analysis?.patterns?.title_features;
  const td = titleDirectives(tf);
  if (td.length) lines.push('## 제목 패키징', ...td, '');

  // 3) 소재 신호 (S4 대본이 소비)
  const gaps = (analysis?.content_gaps ?? []).slice(0, 3)
    .filter((g) => (g.term ?? '').length >= 2)
    .map((g) => `- 노려볼 갭: "${g.term}" (경쟁 ${g.comp_df}개 채널 · 조회 ${Number(g.comp_views).toLocaleString()})`);
  const blue = (analysis?.blue_ocean_keywords ?? []).slice(0, 2)
    .map((b) => `- 블루오션: "${b.keyword}" (경쟁도 ${b.competition})`);
  const spent = exhaustedTopics(analysis?.outliers);
  if (gaps.length || blue.length || spent.length) {
    lines.push('## 소재 신호');
    lines.push(...gaps, ...blue);
    if (spent.length) lines.push('**이미 소진된 화제 — 같은 각도 반복 금지, 다음 질문으로 전환:**', ...spent);
    lines.push('');
  }

  // 4) 우리 채널 신호 (KPI 스코어카드에서)
  if (kpi) {
    const reds = (kpi.kpis ?? []).filter((k) => k.grade === 'RED').map((k) => `- 🔴 ${k.label}: ${k.display}`);
    const tops = (kpi.top_videos ?? []).slice(0, 2).map((v) => `- 잘된 것: "${cut(v.title, 40)}" (${v.vpd}/일)`);
    if (reds.length || tops.length) {
      lines.push('## 우리 채널 신호');
      lines.push(...reds, ...tops, '');
    }
  }

  lines.push('> 이 지시는 훅·소재 선택·제목 표기에만 적용한다. 사실·수치를 왜곡하거나 근거 없는 주장을 만들지 마라.');
  let md = lines.join('\n') + '\n';
  if (md.length > MAX_CHARS) md = cut(md, MAX_CHARS - 2) + '\n';
  return md;
}

function main() {
  const { values } = parseArgs({ options: {
    date: { type: 'string' },
    slot: { type: 'string' },
  } });
  const date = values.date || new Date().toISOString().slice(0, 10);
  const slots = values.slot ? [values.slot] : SLOTS;

  const kpi = loadJSON(join(GROWTH_DIR, 'kpi', `${date}.json`));
  const expState = loadJSON(join(GROWTH_DIR, 'experiments.json'), {});
  mkdirSync(OUT_DIR, { recursive: true });

  for (const slot of slots) {
    const analysis = loadJSON(join(INTEL_DIR, `analysis-${date}-${slot}.json`))
      ?? loadJSON(join(INTEL_DIR, `analysis-${date}.json`));
    const md = buildDirective({ date, slot, analysis, kpi, experiment: expState.current });
    const outPath = join(OUT_DIR, `${date}-${slot}.md`);
    writeFileSync(outPath, md);
    console.log(`✓ ${outPath.replace(ROOT + '/', '')} (${md.length}자${analysis ? '' : ' · 경쟁 분석 없음'})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
