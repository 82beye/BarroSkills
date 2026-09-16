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
import { competitorAgenda, formatAgenda } from './lib/competitor-agenda.js';

const ROOT = resolve(import.meta.dirname, '../..');
const INTEL_DIR = join(ROOT, 'workspace', 'intel', 'competitors');
const GROWTH_DIR = join(ROOT, 'workspace', 'growth');
const OUT_DIR = join(GROWTH_DIR, 'directives');
const SLOTS = ['us-close', 'kr-close', 'realestate'];
const MAX_CHARS = 3000; // 소비처(generate-script)의 slice(0,3000) 안에 통째로 들어가게

/** date 이전 7일치 날짜 문자열 — 경쟁 스냅샷 폴백용. */
function recentSnapshotDates(date, back = 7) {
  const base = Date.parse(`${date}T12:00:00Z`);
  return Array.from({ length: back }, (_, i) =>
    new Date(base - (i + 1) * 86400_000).toISOString().slice(0, 10));
}

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
  // has_bracket 을 뺐다. 경쟁 채널 **조회** lift 는 3.46× 로 높지만, 우리 채널의
  // **북극성(구독)** 실측은 반대다 — 2026-08-25~09-16 26편에서 대괄호가 붙은 19편은
  // 구독/1k뷰 0.77, 안 붙은 7편은 2.41 이었다. 태그가 제목 앞 8자를 먹으면서
  // '왜' 를 말할 자리가 사라졌고(story 동반율 86%→16%), 주간 순증 구독이 11→2 가 됐다.
  // 조회를 사는 처방과 구독을 사는 처방이 다르면 북극성을 따른다.
  const SAFE_POSITIVE = new Set(['has_number', 'has_percent', 'has_question', 'title_short']);
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

export function buildDirective({ date, slot, analysis, kpi, experiment, policy, agenda }) {
  const lines = [`# 성장 지시 — ${date} · ${slot}`, ''];

  // 1) 실험 — 최우선. 주 1개 실험이 로테이션의 핵심이라 맨 위.
  if (experiment?.directive) {
    const target = experiment.target === 'script' ? '대본(훅)' : '제목(메타데이터)';
    lines.push(`## 이번 주 실험 (${experiment.id} · 적용 대상: ${target})`, `- ${experiment.directive}`, '');
  }

  // 1.5) 오늘 경쟁사 의제 — **주제 선정의 1순위 입력**.
  // 기존 경쟁 분석은 토큰 빈도 갭이라 「이렇게·겁니다·1부」 같은 조각을 내놨다(2026-09-15 실측).
  // 여기서는 서로 다른 채널 몇 개가 같은 것을 말하는지(합의)를 센다.
  if (agenda?.agenda?.length) {
    lines.push(...formatAgenda(agenda));
    lines.push('> 위 1순위 의제가 우리 슬롯의 사건이면 **그것을 메인으로 잡아라.** 경쟁사가 이미 다 다루고 있다는 뜻이다.');
    lines.push('> 우리의 차별점은 "무엇을 다루느냐"가 아니라 "왜 그런지를 어떻게 말하느냐"다.');
    lines.push('');
  }

  // 2) 제목 패키징 (S9 메타데이터가 소비)
  // 채널 정책이 경쟁 처방보다 위다 — 경쟁 lift 는 남의 채널 '조회'로 잰 값이고,
  // 아래는 우리 채널 '구독'으로 잰 값이다. 북극성이 다르면 우리 값을 따른다.
  if (policy?.title_requires_causal_clause) {
    const th = policy.index_move_thresholds ?? {};
    lines.push('## 제목 규칙 (채널 정책 · 경쟁 처방보다 우선)');
    lines.push('- **제목은 "왜"를 말해야 한다.** 통념과 어긋난 것, 반대로 움직인 것, 숨은 원인 중 하나를');
    lines.push('  제목 안에서 주장하라 (예: "…인데도 …", "진짜 이유는 …", "금리 아니라 …").');
    lines.push('  실측: 이 구조가 있으면 구독/1k뷰 2.12, 없으면 0.63 (26편, 3.4배).');
    lines.push(`- **일상 등락률을 제목의 주어로 쓰지 마라.** "오늘 X% 올랐다/내렸다"는 지수 ${th.index_pct}% ·`);
    lines.push(`  환율 ${th.fx_pct}% · 원자재 ${th.commodity_pct}% · 금리 ${th.rate_bp}bp · 개별종목 ${th.single_name_pct}% 미만이면 뉴스가 아니다.`);
    lines.push('  수치 나열 제목은 조회는 받아도 구독으로 이어지지 않는다 (최근 8편 중 7편이 수치 나열, 구독 0).');
    lines.push('- **단, 아래는 등락폭과 무관하게 반드시 메인이다** (작은 움직임이어도):');
    lines.push('  ① 레벨 돌파·붕괴 — 라운드 넘버를 뚫는 순간 (미 10년물 5%, 유가 100달러, 원/달러 1,400원, 코스피 7000선)');
    lines.push('  ② N년래 최고·최저 경신   ③ 주·월·분기 누적 급등 (유가, 9월에만 20%)   ④ 연속기록 시작·중단');
    lines.push('  여럿이 겹치면 ① > ② > ③ > ④ 순으로 고른다. 그때도 제목은 "무엇이 그렇게 만들었나"를 함께 말한다.');
    lines.push('- 시황 라벨([美마감]·[속보] 등)로 제목을 시작하면 "왜"를 말할 자리가 사라진다. 쓰지 않는 쪽을 기본으로 한다.');
    lines.push('');
  }
  const tf = analysis?.patterns?.title_features;
  const td = titleDirectives(tf);
  if (td.length) lines.push('## 제목 패키징 (경쟁 채널 조회 기준 · 위 정책과 충돌하면 위를 따른다)', ...td, '');

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
      lines.push(...reds, ...tops);
      // 이 목록은 **구조를 보라고** 주는 것이지 베끼라고 주는 게 아니다.
      // 2026-09-14 EP-2026-0154: 지시문이 「[美마감] 국채금리 4.97%, 2023년 이후 최고치」(372/일)를
      // '잘된 것'으로 올렸고, 메타 작성기가 「[美금리비상] 10년물 4.97%, 2023년來 최고치」를 냈다 —
      // 이틀 전 채널 1위 영상의 제목을 수치까지 그대로 복제한 것이다. 같은 수치를 반복한 영상의
      // 48h 조회 실측이 -68% · -64% · -32% 라, 이 되먹임은 자기 최고작을 깎아먹는다.
      if (tops.length) {
        lines.push('> 위 제목은 **짜임새만** 참고한다. 수치·최상급·핵심어를 그대로 가져오지 마라 —');
        lines.push('> 같은 수치를 반복한 편은 48h 조회가 최대 68% 낮았다. 오늘 새로운 것으로 제목을 열어라.');
      }
      lines.push('');
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
  const date = values.date || new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid --date');
  const slots = values.slot ? [values.slot] : SLOTS;
  if (slots.some((slot) => !SLOTS.includes(slot))) throw new Error('Invalid --slot');

  const kpi = loadJSON(join(GROWTH_DIR, 'kpi', `${date}.json`));
  const expState = loadJSON(join(GROWTH_DIR, 'experiments.json'), {});
  // 채널 콘텐츠 정책 — 제목·훅이 무엇을 말해야 하는지의 정본.
  const policy = (loadJSON(join(ROOT, 'config', 'growth.json'), {}) || {}).content_policy || null;
  mkdirSync(OUT_DIR, { recursive: true });

  for (const slot of slots) {
    const analysis = loadJSON(join(INTEL_DIR, `analysis-${date}-${slot}.json`))
      ?? loadJSON(join(INTEL_DIR, `analysis-${date}.json`));
    // 경쟁 스냅샷은 날짜별 파일이다. 오늘 것이 아직 없으면(경쟁 크론은 15:20) 가장 최근 것을 쓴다 —
    // 하루 묵은 의제라도 없는 것보다 낫고, 30시간 창이라 대개 같은 사건을 담는다.
    const snapPath = [date, ...recentSnapshotDates(date)]
      .map((d) => join(INTEL_DIR, '..', 'competitors', `${d}.json`))
      .find((f) => existsSync(f));
    const snap = snapPath ? loadJSON(snapPath) : null;
    // 기준 시각은 **스냅샷이 수집된 때**다. 오늘 날짜로 물으면, 어제 수집분을 쓸 때
    // 30시간 창이 스냅샷보다 뒤에 놓여 한 편도 안 잡힌다 (2026-09-16 실측: 0편).
    const fetchedAt = Date.parse(snap?.fetched_at ?? '');
    const asOf = Number.isFinite(fetchedAt)
      ? new Date(Math.min(fetchedAt, Date.parse(`${date}T23:59:59+09:00`)))
      : new Date(`${date}T23:59:59+09:00`);
    const agenda = snap
      ? competitorAgenda(snap, asOf, { slot, minChannels: 2, limit: 6 })
      : null;
    const md = buildDirective({ date, slot, analysis, kpi, experiment: expState.current, policy, agenda });
    const outPath = join(OUT_DIR, `${date}-${slot}.md`);
    writeFileSync(outPath, md);
    console.log(`✓ ${outPath.replace(ROOT + '/', '')} (${md.length}자${analysis ? '' : ' · 경쟁 분석 없음'})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
