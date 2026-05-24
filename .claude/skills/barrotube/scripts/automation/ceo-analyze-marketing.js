#!/usr/bin/env node

/**
 * ceo-analyze-marketing.js — 마케팅 리포트를 CEO 관점으로 해석해 신규 시리즈 시드를 만든다.
 *
 * 마케팅 → CEO → Producer 자동 브릿지의 2단계.
 *
 * 입력: workspace/intel/marketing/<issue>.json (fetch-paperclip-report.js 산출)
 * 출력:
 *   workspace/channels/<channel>/series/<series-id>/curriculum.md
 *   workspace/channels/<channel>/series/<series-id>/ep-01-brief.md ~ ep-05-brief.md (long-3min)
 *   paperclip/config/series.json 에 신규 시리즈 항목 append (status: 'planned')
 *
 * 설계 원칙
 *   - **결정론적 처리가 기본**. 리포트의 액션 아이템 텍스트에서 시리즈 후보 슬롯 1~2개를
 *     안전한 휴리스틱으로 추출하고, 정해진 학습 아크(WHAT/WHY/HOW/RISK/WHEN)로 5편 시드를 만든다.
 *   - **CEO LLM 보강은 향후 옵트인**: --use-ceo-agent 가 기본 false. 활성화 시 Claude Code/Anthropic API
 *     없이도 동작하도록 시드 생성은 항상 수행되며, LLM은 보조적으로 brief 본문을 풍부화하는 역할.
 *   - 기존 series 와 id/topic이 충돌하지 않도록 회피. status='planned', source='marketing-report:<issue>'.
 *   - paperclip/config/series.json 갱신 전 자동 백업 (.bak.<timestamp>).
 *
 * Usage:
 *   node ceo-analyze-marketing.js --report workspace/intel/marketing/YOU-99.json --channel econ-daily
 *   node ceo-analyze-marketing.js --report ... --channel econ-daily --max-series 1
 *   node ceo-analyze-marketing.js --report ... --channel econ-daily --dry-run
 *   node ceo-analyze-marketing.js --report ... --series-id-prefix ai-econ-basic
 *
 * Exit codes:
 *   0  성공
 *   20 잘못된 인자 / 입력 파일 없음 / 채널 없음
 *   21 시리즈 후보 추출 실패 (마케팅 리포트에서 액션 아이템 0건)
 *   22 워크스페이스 쓰기 실패
 *   23 series.json 갱신 실패
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const SERIES_CONFIG_PATH = resolve(ROOT, 'paperclip/config/series.json');
const PIPELINE_LOG = resolve(ROOT, 'logs/marketing-pipeline.log');

// 학습 아크 5편 — 기존 sp500-basic / nasdaq100-basic 과 동일 컨벤션
const LEARNING_ARC = ['WHAT', 'WHY', 'HOW', 'RISK', 'WHEN'];

// 시리즈 후보 도출 휴리스틱 — 한국어 마케팅 리포트의 "액션 아이템" 섹션을 우선 매칭
// 우선순위: HIGH 액션 아이템 → "추천 즉시 액션" 코멘트 → 본문에서 시리즈/콘텐츠 명시
const CANDIDATE_RULES = [
  {
    matcher: /AI[\s/이가는].*?(경제|금융|투자|시장)/i,
    seedFn: () => ({
      slug: 'ai-econ-basic',
      title: 'AI가 바꾸는 경제',
      display_short: 'AI 경제 기초',
      angle: 'AI 기술이 거시경제·금융 시장·투자 패러다임에 끼치는 영향을 입문자도 3분에 이해하도록 5편 학습 아크로 풀어낸다.',
      blue_ocean_keywords: ['AI 경제', 'AI 투자', 'AI 시장', '인공지능 경제', '생성형 경제'],
      // 5편 토픽 (학습 아크 순)
      topics: [
        { axis: 'WHAT', topic: 'AI 경제란 무엇인가 — GPT부터 자율주행까지, 돈의 흐름이 바뀐다',
          hook: '아침에 일어나서 마신 커피 한 잔도 AI가 가격을 정합니다. 그게 무슨 말일까요?' },
        { axis: 'WHY',  topic: '왜 AI 시대 경제 공부가 필수인가 — 일자리·임금·주가의 동시 재편',
          hook: '내 직업이 사라진다고요? 그것보다 더 큰 변화가 자산 가격에서 일어나고 있습니다.' },
        { axis: 'HOW',  topic: 'AI 시대 자산 배분 — 빅테크·반도체·전력·데이터 4대 축',
          hook: '엔비디아만 사면 끝일까요? 진짜 수혜는 4단 사슬에 숨어 있습니다.' },
        { axis: 'RISK', topic: 'AI 거품의 진짜 위험 — 닷컴 vs 지금, 무엇이 같고 다른가',
          hook: '2000년 닷컴 버블 때 집을 팔아 산 사람들은 지금 어떻게 됐을까요?' },
        { axis: 'WHEN', topic: '언제 사고 언제 빠지나 — AI 사이클의 4단계와 매수 타이밍',
          hook: '"AI 끝물"이라는 말, 매년 듣고 있습니다. 진짜 끝물은 어떤 신호로 옵니까?' },
      ],
      thumbnail_specs: [
        { episode: 1, arc: 'WHAT', keyword: 'AI=돈',     palette: 'explainer', rationale: 'AI 기술이 곧 돈의 흐름이라는 입문 임팩트' },
        { episode: 2, arc: 'WHY',  keyword: '50%',       palette: 'bullish',   rationale: '빅테크 시총 비중 50% 돌파 — AI 시대 자산 재편' },
        { episode: 3, arc: 'HOW',  keyword: '4사슬',     palette: 'explainer', rationale: '4단 가치사슬(반도체·빅테크·전력·데이터) 분배 가이드' },
        { episode: 4, arc: 'RISK', keyword: '닷컴 -83%', palette: 'bearish',   rationale: '2000년 닷컴 -83% 데이터로 거품 위험 경고' },
        { episode: 5, arc: 'WHEN', keyword: '4단계',     palette: 'wealth',    rationale: 'AI 사이클 4단계 — 진입·확장·과열·조정 타이밍' },
      ],
    }),
  },
  {
    matcher: /(30초|3분|짧은).*?(경제|개념|Shorts|개념어)/i,
    seedFn: () => ({
      slug: '3min-econ-basic',
      title: '3분 경제 개념 기초',
      display_short: '3분 경제 기초',
      angle: '경쟁 채널이 모두 10분+ 포맷에 머무는 사이, BarroTube가 "3분 압축 입문" 포맷을 시리즈로 선점한다. 슈카월드/삼프로TV의 입문자 진입 장벽을 직접 공략.',
      blue_ocean_keywords: ['3분경제', '경제알기쉽게', '경제개념', '3분금융', '경제기초'],
      topics: [
        { axis: 'WHAT', topic: '경제란 무엇인가 — 시장·가격·돈의 3가지 본질',
          hook: '경제 뉴스 보면 외계어 같지요? 사실 단어 3개만 알면 80%가 풀립니다.' },
        { axis: 'WHY',  topic: '왜 모두가 경제를 알아야 하나 — 월급·집값·노후의 공통분모',
          hook: '내 월급이 오르지 않는 진짜 이유, 통장 잔고로는 안 보입니다.' },
        { axis: 'HOW',  topic: '경제 뉴스 똑똑하게 읽기 — GDP·CPI·금리 3가지 신호',
          hook: '뉴스 한 줄에 3가지 신호가 숨어 있습니다. 보는 법을 알면 5분이 30초로 줄어요.' },
        { axis: 'RISK', topic: '경제 공부의 함정 — "전문가 말 그대로 따라하면" 잃는 이유',
          hook: '예측 적중률 90% 라는 전문가, 사실 동전 던지기보다 못 맞춥니다.' },
        { axis: 'WHEN', topic: '언제 어떻게 행동하나 — 3분 학습이 30년 자산을 가르는 순간',
          hook: '3분짜리 콘텐츠가 30년 자산 격차를 만든다고요? 데이터로 보여드릴게요.' },
      ],
      thumbnail_specs: [
        { episode: 1, arc: 'WHAT', keyword: '단어 3개', palette: 'explainer', rationale: '시장·가격·돈 3단어 임팩트' },
        { episode: 2, arc: 'WHY',  keyword: '월급 0%',   palette: 'bearish',   rationale: '실질임금 정체 충격 데이터' },
        { episode: 3, arc: 'HOW',  keyword: 'GDP·CPI·금리', palette: 'explainer', rationale: '3대 지표 읽기' },
        { episode: 4, arc: 'RISK', keyword: '90% 함정', palette: 'bearish',   rationale: '전문가 적중률 함정' },
        { episode: 5, arc: 'WHEN', keyword: '3분→30년', palette: 'wealth',    rationale: '3분 학습이 30년 자산 격차로' },
      ],
    }),
  },
];

function readJSON(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

// Node ESM 환경에서 동기 append
function logPipeline(entry) {
  try {
    mkdirSync(dirname(PIPELINE_LOG), { recursive: true });
    appendFileSync(PIPELINE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch {/* non-fatal */}
}

function extractActionItems(reportBody) {
  // 한국어 리포트의 "추천 즉시 액션" / "기회 영역" / "HIGH" 섹션 등을 통째로 가져옴.
  const sections = [];
  const headers = [
    /##[^\n]*(추천\s*즉시\s*액션|즉시\s*액션|HIGH\s*우선|기회\s*영역|핵심\s*발견|즉시\s*권고)/i,
    /###[^\n]*(추천|HIGH|우선순위|블루오션)/i,
  ];
  for (const re of headers) {
    let m;
    const reGlobal = new RegExp(re.source, re.flags + 'g');
    while ((m = reGlobal.exec(reportBody)) !== null) {
      const start = m.index;
      const next = reportBody.slice(start + m[0].length).search(/\n#{2,3}\s/);
      const end = next === -1 ? reportBody.length : start + m[0].length + next;
      sections.push(reportBody.slice(start, end));
    }
  }
  return sections.join('\n\n');
}

function deriveCandidates(reportBody, comments, max) {
  const haystack = [reportBody, ...comments.map(c => c.body || '')].join('\n\n');
  const actionSection = extractActionItems(reportBody) || haystack;

  const seen = new Set();
  const candidates = [];
  for (const rule of CANDIDATE_RULES) {
    if (rule.matcher.test(actionSection) || rule.matcher.test(haystack)) {
      const seed = rule.seedFn();
      if (seen.has(seed.slug)) continue;
      seen.add(seed.slug);
      candidates.push(seed);
      if (candidates.length >= max) break;
    }
  }
  return candidates;
}

function uniqueSeriesId(baseSlug, channel, existing) {
  let id = baseSlug;
  let n = 2;
  while (existing.some(s => s.id === id)) {
    id = `${baseSlug}-v${n++}`;
  }
  return id;
}

function buildCurriculum(seriesId, seriesTitle, displayShort, seed, channel) {
  const lines = [
    '---',
    `series_id: ${seriesId}`,
    `series_name: "${seriesTitle}"`,
    `series_slug: ${seriesId}`,
    `channel_id: ${channel}`,
    'format: long-3min',
    'persona: barro-teacher',
    'target_length_seconds: 180',
    `total_episodes: ${seed.topics.length}`,
    'release_cadence: "화/목/일 19:00 (주 3편)"',
    'estimated_completion_weeks: 1.7',
    'next_series: null',
    'required_disclaimer: true',
    `created_at: ${new Date().toISOString().slice(0, 10)}`,
    `source: marketing-report`,
    'status: planned',
    '---',
    '',
    `# ${seriesTitle} — Master Curriculum`,
    '',
    '## 시리즈 개요',
    '',
    seed.angle,
    '',
    '## 시청자 여정 (Learning Journey)',
    '',
    '```',
    ...seed.topics.map((t, i) => `[EP0${i+1} ${t.axis}]  → ${t.topic.split('—')[0].trim()}`),
    '         ↓',
    '[다음 시리즈 예고: TBD]',
    '```',
    '',
    '## 편별 요약',
    '',
    '| EP | 제목 | 학습 축 | Hook | 브리프 |',
    '|----|------|--------|------|--------|',
    ...seed.topics.map((t, i) => {
      const ep = String(i + 1).padStart(2, '0');
      return `| ${ep} | ${t.topic} | ${t.axis} | "${t.hook}" | [ep-${ep}-brief.md](./ep-${ep}-brief.md) |`;
    }),
    '',
    '## 마케팅 인사이트 (시리즈 추진 근거)',
    '',
    `이 시리즈는 Marketing Analyst 리포트의 액션 아이템에서 도출되었습니다.`,
    '',
    '**블루오션 키워드** (경쟁 강도 낮음, SEO 공략 대상):',
    seed.blue_ocean_keywords.map(k => `- \`${k}\``).join('\n'),
    '',
    '## 브랜드·톤 (Persona: barro-teacher)',
    '',
    '- **Tone**: 차근차근, 친근, 신뢰',
    '- **금기**: 경고·공포 프레이밍, 특정 종목 매수/매도 추천',
    '- **필수**: 음성 면책 5초',
    '',
    '## KPI (시리즈 단위)',
    '',
    '| 지표 | 목표 |',
    '|------|------|',
    '| EP01 조회수 | 3,000+ |',
    '| EP05 조회수 | 2,000+ |',
    '| EP01→EP05 완주율 | 25%+ |',
    '| 시리즈 평균 시청 비율 | 50%+ |',
    '| 파생 Shorts → 롱폼 유입 | 5%+ |',
    '',
    '## 에피소드 ID 배정',
    '',
    '실제 에피소드 ID는 `node scripts/automation/create-series.js --series ' + seriesId + '` 실행 시 자동 배정.',
    '',
  ];
  return lines.join('\n') + '\n';
}

function buildEpisodeBriefSeed(seriesId, seriesTitle, total, ep, channel) {
  const epNum = ep.index + 1;
  const fm = [
    '---',
    `series_id: ${seriesId}`,
    `series_episode: ${epNum}`,
    `series_total: ${total}`,
    `channel_id: ${channel}`,
    'format: long-3min',
    'persona: barro-teacher',
    'target_length_seconds: 180',
    `topic: "${ep.topic.replace(/"/g, '\\"')}"`,
    `theme_axis: ${ep.axis}`,
    'required_disclaimer: true',
    'status: planned',
    'source: marketing-report',
    '---',
    '',
  ].join('\n');

  const body = [
    `# EP${String(epNum).padStart(2, '0')} — ${ep.topic}`,
    '',
    '## 한 줄 요약',
    `시리즈 ${epNum}/${total}편. 학습 축 **${ep.axis}**. 마케팅 리포트가 지목한 블루오션을 입문자 3분 포맷으로 전달.`,
    '',
    '## Hook (0~15초)',
    `> "${ep.hook}"`,
    '',
    '**시각**: stick-figure 캐릭터로 후킹 장면 표현. (CEO/Writer가 시리즈 톤에 맞춰 디테일 확장 예정)',
    '',
    '## 7씬 구조 (시드 — Writer가 S4에서 확정)',
    '',
    '| 씬 | 길이 | 역할 | 내용 (시드) |',
    '|----|------|------|------|',
    '| 1 | 15s | Hook | (Hook 그대로) |',
    `| 2 | 15s | 인트로/리캡 | 인트로 카드 [${epNum}/${total}] + 학습 축 ${ep.axis} 한 줄 안내 |`,
    '| 3 | 35s | 핵심 개념 1 | (Writer 작성) |',
    '| 4 | 40s | 핵심 개념 2 | (Writer 작성) |',
    '| 5 | 35s | 데이터 / 사례 | (Fact-checker 검증 필요) |',
    '| 6 | 30s | 한국 시청자 연결 | 한국 맥락에서의 적용 |',
    '| 7 | 10s | Wrap + 티저 | 면책 + 다음 편 예고 |',
    '',
    '## 금기',
    '- ❌ 특정 종목 매수/매도 추천',
    '- ❌ 과장된 수익률 약속',
    '- ❌ "당장", "무조건", "사라집니다"',
    '',
    '## 다음 편 티저',
    `> ${epNum < total
        ? `"다음 편: ${ep.axis} 다음 축(${LEARNING_ARC[epNum] || 'TBD'}). 화/목/일 저녁 7시."`
        : '시리즈 완결 — 다음 시리즈 예고 (TBD)'}`,
    '',
    '## 비고',
    '- 이 brief는 마케팅 리포트 기반 **시드(seed) 문서**.',
    '- CEO/Writer가 데이터 검증 후 본문 7씬 디테일을 확정함.',
    '- thumbnail_specs는 series.json에 등록되어 있음.',
    '',
  ].join('\n');

  return fm + body + '\n';
}

function buildSeriesEntry(seriesId, seriesTitle, displayShort, seed, channel, sourceIssue) {
  return {
    id: seriesId,
    name: seriesTitle,
    display_name_short: displayShort,
    channel,
    format: 'long-3min',
    persona: 'barro-teacher',
    total_episodes: seed.topics.length,
    cadence: { days: ['tue', 'thu', 'sun'], time_kst: '19:00', estimated_completion_weeks: 1.7 },
    curriculum_path: `workspace/channels/${channel}/series/${seriesId}/curriculum.md`,
    brief_paths: seed.topics.map((_, i) => `workspace/channels/${channel}/series/${seriesId}/ep-${String(i+1).padStart(2,'0')}-brief.md`),
    learning_arc: LEARNING_ARC.slice(0, seed.topics.length),
    thumbnail_specs: seed.thumbnail_specs,
    next_series: null,
    required_disclaimer: true,
    auto_derive_shorts: true,
    kpi: {
      ep01_views_target: 3000,
      ep05_views_target: 2000,
      series_completion_rate_target: 0.25,
      avg_view_ratio_target: 0.5,
      derive_shorts_to_long_uplift_target: 0.05,
    },
    branding_outputs: {
      intro_card_status: 'pending',
      thumbnail_status: 'pending',
      playlist_id: null,
      layout_version: 'v2',
    },
    source: {
      kind: 'marketing-report',
      issue_identifier: sourceIssue.identifier,
      issue_id: sourceIssue.id,
      blue_ocean_keywords: seed.blue_ocean_keywords,
      angle: seed.angle,
      derived_at: new Date().toISOString(),
    },
    status: 'planned',
    created_at: new Date().toISOString().slice(0, 10),
  };
}

function backupSeriesConfig() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = SERIES_CONFIG_PATH + `.bak.${ts}`;
  copyFileSync(SERIES_CONFIG_PATH, bak);
  return bak;
}

async function main() {
  const { values } = parseArgs({
    options: {
      report:           { type: 'string' },
      channel:          { type: 'string' },
      'max-series':     { type: 'string' },
      'series-id-prefix':{ type: 'string' },
      'dry-run':        { type: 'boolean', default: false },
      'use-ceo-agent':  { type: 'boolean', default: false }, // 향후 LLM 보강 옵션 (현재 no-op)
    },
  });

  if (!values.report || !values.channel) {
    console.error('Usage: ceo-analyze-marketing.js --report <path> --channel <id> [--max-series 1] [--dry-run]');
    process.exit(20);
  }

  const reportPath = resolve(values.report);
  if (!existsSync(reportPath)) {
    console.error(`❌ Report not found: ${reportPath}`);
    process.exit(20);
  }

  const channel = values.channel;
  const channelDir = join(ROOT, 'workspace/channels', channel);
  if (!existsSync(channelDir)) {
    console.error(`❌ Channel directory not found: ${channelDir}`);
    process.exit(20);
  }

  const maxSeries = Math.max(1, parseInt(values['max-series'] || '1', 10));
  const dryRun = values['dry-run'];

  console.log(`📥 Report: ${reportPath}`);
  console.log(`📺 Channel: ${channel}`);
  console.log(`🎯 Max new series: ${maxSeries}${dryRun ? ' (dry-run)' : ''}`);

  const bundle = readJSON(reportPath);
  const reportBody = bundle?.report?.body || '';
  const comments = bundle?.comments || [];
  const sourceIssue = bundle?.issue || { identifier: 'unknown', id: 'unknown' };

  if (!reportBody) {
    console.error('❌ report.body 누락');
    process.exit(21);
  }

  const candidates = deriveCandidates(reportBody, comments, maxSeries);
  if (candidates.length === 0) {
    console.error('❌ 마케팅 리포트에서 시리즈 후보를 추출하지 못했습니다.');
    console.error('   휴리스틱 룰을 충족하는 액션 아이템 텍스트가 없는지 확인하세요.');
    logPipeline({ stage: 'ceo-analyze', status: 'no_candidate', source: sourceIssue.identifier });
    process.exit(21);
  }

  console.log(`\n🧠 추출된 시리즈 후보 ${candidates.length}개:`);
  candidates.forEach((c, i) => {
    console.log(`   ${i+1}. ${c.title} (slug: ${c.slug}) — ${c.topics.length}편`);
    console.log(`      keywords: ${c.blue_ocean_keywords.join(', ')}`);
  });

  // series.json 로드 / 백업
  const seriesConfig = readJSON(SERIES_CONFIG_PATH);
  const existing = seriesConfig.series || [];
  const newEntries = [];
  const writePlan = [];

  for (const seed of candidates) {
    const baseSlug = (values['series-id-prefix'] || seed.slug).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const seriesId = uniqueSeriesId(baseSlug, channel, [...existing, ...newEntries]);

    const seriesDir = join(channelDir, 'series', seriesId);
    const curriculumPath = join(seriesDir, 'curriculum.md');
    const briefPaths = seed.topics.map((_, i) => join(seriesDir, `ep-${String(i+1).padStart(2,'0')}-brief.md`));

    writePlan.push({
      seriesId, seriesDir, curriculumPath, briefPaths, seed,
      curriculum: buildCurriculum(seriesId, seed.title, seed.display_short, seed, channel),
      briefs: seed.topics.map((t, i) => buildEpisodeBriefSeed(seriesId, seed.title, seed.topics.length, { ...t, index: i }, channel)),
      entry: buildSeriesEntry(seriesId, seed.title, seed.display_short, seed, channel, sourceIssue),
    });
    newEntries.push({ id: seriesId });
  }

  console.log(`\n📋 쓰기 계획:`);
  writePlan.forEach(p => {
    console.log(`   • ${p.seriesId}`);
    console.log(`     - ${p.curriculumPath}`);
    p.briefPaths.forEach(b => console.log(`     - ${b}`));
  });
  console.log(`   • paperclip/config/series.json — append ${writePlan.length} entries`);

  if (dryRun) {
    console.log('\n🧪 DRY RUN — no files written.');
    logPipeline({ stage: 'ceo-analyze', status: 'dry_run', source: sourceIssue.identifier, candidates: writePlan.map(p => p.seriesId) });
    console.log(`<!--RESULT-->${JSON.stringify({ ok: true, dry_run: true, candidates: writePlan.map(p => p.seriesId) })}<!--/RESULT-->`);
    return;
  }

  // 쓰기
  try {
    for (const plan of writePlan) {
      mkdirSync(plan.seriesDir, { recursive: true });
      writeFileSync(plan.curriculumPath, plan.curriculum, 'utf-8');
      plan.briefs.forEach((b, i) => writeFileSync(plan.briefPaths[i], b, 'utf-8'));
      console.log(`   ✅ ${plan.seriesId} → ${plan.seriesDir}`);
    }
  } catch (e) {
    console.error(`❌ 워크스페이스 쓰기 실패: ${e.message}`);
    process.exit(22);
  }

  // series.json 갱신
  let bakPath = null;
  try {
    bakPath = backupSeriesConfig();
    seriesConfig.series = [...existing, ...writePlan.map(p => p.entry)];
    writeFileSync(SERIES_CONFIG_PATH, JSON.stringify(seriesConfig, null, 2) + '\n', 'utf-8');
    console.log(`   ✅ paperclip/config/series.json updated (backup → ${bakPath})`);
  } catch (e) {
    console.error(`❌ series.json 갱신 실패: ${e.message}${bakPath ? ' (백업 → ' + bakPath + ')' : ''}`);
    process.exit(23);
  }

  logPipeline({
    stage: 'ceo-analyze',
    status: 'ok',
    source: sourceIssue.identifier,
    new_series: writePlan.map(p => p.seriesId),
    series_config_backup: bakPath,
  });

  console.log(`\n🎉 마케팅 리포트 → ${writePlan.length}개 신규 시리즈 시드 등록 완료.`);
  console.log(`   다음 단계: producer-trigger-series.js --series ${writePlan[0].seriesId} (또는 --auto-pick-planned)`);
  console.log(`<!--RESULT-->${JSON.stringify({ ok: true, new_series: writePlan.map(p => p.seriesId) })}<!--/RESULT-->`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('❌', e.message || e); process.exit(20); });
}

export { deriveCandidates, buildSeriesEntry };
