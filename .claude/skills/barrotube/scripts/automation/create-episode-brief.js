#!/usr/bin/env node

/**
 * create-episode-brief.js — 수기 요청 Brief 표준화 생성기 (품질 권고 #1)
 *
 * 목적:
 *   - 자율 파이프라인(마케팅 리포트 → CEO → Writer)이 빠지는 수기 요청 컨텐츠에
 *     씬 구조 / 표기 정책 v2.0 / 팩트체크 placeholder를 강제 주입하여 품질 격차 제거.
 *   - EP-0043 사례 (2025년 1분기 오류 / "오십칠조 이천억" TTS 위반) 재발 방지.
 *
 * Usage:
 *   node scripts/automation/create-episode-brief.js \
 *     --topic "주제명" \
 *     --channel econ-daily \
 *     [--format long|shorts] \
 *     [--persona barro-teacher|barro-alert] \
 *     [--target-seconds 180]
 *
 *   --help                사용법 출력
 *
 * 산출물:
 *   workspace/episodes/EP-YYYY-NNNN/00_brief.md  (씬 구조 + 표기 정책 + 팩트체크 placeholder 주입)
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(ROOT, 'workspace');
const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';

const HELP = `
create-episode-brief.js — 수기 요청 Brief 표준화 생성기

Usage:
  node scripts/automation/create-episode-brief.js \\
    --topic "주제명" \\
    --channel econ-daily \\
    [--format long|shorts] \\
    [--persona barro-teacher|barro-alert] \\
    [--target-seconds 180]

Options:
  --topic <str>            주제명 (필수)
  --channel <id>           채널 id (기본: econ-daily)
  --format long|shorts     포맷 (기본: long)
  --persona <id>           페르소나 (long → barro-teacher / shorts → barro-alert)
  --target-seconds <n>     목표 길이 (long → 180, shorts → 60)
  --episode-id <id>        EP id 강제 지정 (기본: 자동 채번)
  --help                   이 도움말

산출물: workspace/episodes/<EP-id>/00_brief.md
- 씬 구조 (long: 7씬×약26초 / shorts: 5씬×약12초)
- 표기 정책 v2.0 (TTS 강제)
- 팩트체크 placeholder
`;

const SCENE_STRUCTURE = {
  long: {
    target_seconds: 180,
    persona: 'barro-teacher',
    scenes: [
      { id: 'S1', role: 'Hook',          target: 20, hint: '첫 5초 내 시선 잡기, 핵심 숫자 또는 의외성' },
      { id: 'S2', role: '문제 제기',     target: 25, hint: '시청자가 왜 이 주제를 신경 써야 하는가' },
      { id: 'S3', role: '배경 설명',     target: 30, hint: '맥락·전제, 입문 시청자 위한 정의' },
      { id: 'S4', role: '핵심 데이터',   target: 35, hint: '구체 수치·날짜·기관명 (팩트체크 대상)' },
      { id: 'S5', role: '함의 분석',     target: 35, hint: '데이터가 의미하는 바, 시청자 입장에서의 시사점' },
      { id: 'S6', role: '전망',          target: 20, hint: '향후 시나리오, 추적 포인트' },
      { id: 'S7', role: 'CTA',           target: 15, hint: '구독·다음 화 예고·롱폼 링크' },
    ],
  },
  shorts: {
    target_seconds: 60,
    persona: 'barro-alert',
    scenes: [
      { id: 'S1', role: 'Hook',         target: 12, hint: '첫 2초 내 핵심 숫자/의외성, "야 이거 봤어?" 톤' },
      { id: 'S2', role: 'Context',      target: 12, hint: '한 문장 배경, 왜 지금 중요한가' },
      { id: 'S3', role: 'Insight',      target: 12, hint: '핵심 통찰 1개 (수치 인용)' },
      { id: 'S4', role: 'Implication',  target: 12, hint: '시청자에게 미치는 영향 한 문장' },
      { id: 'S5', role: 'CTA',          target: 12, hint: '팔로우·롱폼 영상 안내' },
    ],
  },
};

const POLICY_BLOCK = `## 표기 정책 v2.0 (Writer / TTS 강제 준수)

> EP-0043 사례 재발 방지: "오십칠조 이천억" → "57조 2,000억원"

- **숫자**: 아라비아 숫자 + 한국어 단위로 표기
  - 정상: \`57조원\`, \`1,200억원\`, \`4%\`, \`3.2배\`
  - 위반: \`오십칠조원\`, \`사 퍼센트\`, \`삼조원\`, \`천이백억\`
- **연도**: 4자리 숫자
  - 정상: \`2026년\`, \`2025년 1분기\`
  - 위반: \`이천이십육년\`, \`이천이십오년\`
- **퍼센트**: 숫자 + %
  - 정상: \`4%\`, \`-1.5%\`
  - 위반: \`사 퍼센트\`, \`마이너스 일점오 퍼센트\`
- **포인트(%p)**: 차이 표기 시 "%p" 또는 "퍼센트포인트" (한자리 숫자 단위 명시)
  - 정상: \`+0.25%p\`, \`+25bp\`
  - 권장 회피: \`이십오 베이시스 포인트\`
- **자릿수 일관성**: 조 / 억 / 만 단위가 한자리여도 숫자 사용
  - 정상: \`3조원\`, \`9억원\`, \`8천만원\`
  - 위반: \`삼조원\`, \`구억원\`

> 자동 검증: \`node scripts/automation/validate-tts-policy.js --ep <EP-id>\`
> Writer는 \`30_script.md\` 작성 후, TTS(S6a) 진입 전 위 검증기를 통과해야 한다.
`;

function generateEpisodeId() {
  const year = new Date().getFullYear();
  const dir = join(WORKSPACE, 'episodes');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir).filter(d => d.startsWith(`EP-${year}-`)).sort();
  const last = existing.length > 0 ? parseInt(existing[existing.length - 1].split('-')[2], 10) : 0;
  return `EP-${year}-${String(last + 1).padStart(4, '0')}`;
}

function buildSceneTable(scenes, totalSeconds) {
  const sum = scenes.reduce((acc, s) => acc + s.target, 0);
  const lines = [];
  lines.push(`| 씬 | 역할 | target_seconds | 작성 힌트 |`);
  lines.push(`|---|---|---|---|`);
  for (const s of scenes) {
    lines.push(`| ${s.id} | ${s.role} | ${s.target} | ${s.hint} |`);
  }
  lines.push(`| **합계** | — | **${sum}** | (목표 ${totalSeconds}초, ±2초 허용) |`);
  return lines.join('\n');
}

function buildBriefMarkdown({ epId, channel, format, persona, targetSeconds, topic }) {
  const cfg = SCENE_STRUCTURE[format];
  const sceneTable = buildSceneTable(cfg.scenes, targetSeconds);
  const sceneCount = cfg.scenes.length;
  const avgPerScene = (targetSeconds / sceneCount).toFixed(1);
  const createdAt = new Date().toISOString();

  return `---
episode_id: ${epId}
channel_id: ${channel}
created_at: ${createdAt}
topic: "${topic.replace(/"/g, '\\"')}"
target_length_seconds: ${targetSeconds}
format: ${format}
persona: ${persona}
status: created
brief_template_version: "v2.0-manual"
brief_source: "manual-cli"
# Public Figure Policy v1.0 (CEO 결정 2026-04-26) — 비워두면 디폴트 적용.
public_figures: []
sensitivity: low
policy_override: null
legal_review_approved_by: null
legal_review_approved_at: null
caricature_scene_limit_override: false
---

# EP Brief: ${topic}

- **channel**: ${channel}
- **format**: ${format}
- **persona**: ${persona}
- **target_seconds**: ${targetSeconds}
- **scene_count**: ${sceneCount} (씬당 평균 ${avgPerScene}초)

## 씬 구조 (${sceneCount}씬, 총 ${targetSeconds}초)

${sceneTable}

> Writer는 위 씬 구조를 그대로 따라 \`30_script.md\` 작성. 총 길이는 target_seconds ±2초.
> Strategist(S3)가 각 씬 hint를 채널별 angle로 구체화한다.

${POLICY_BLOCK}

## 팩트체크 대상 (Fact Checker S5 필수 검증)

> 이 placeholder를 운영자/Writer가 실제 수치로 교체. Fact Checker는 **모든 항목**을 1차 출처로 검증.

- [ ] **수치 1**: <PLACEHOLDER — 핵심 통계, e.g., "57.2조원">
- [ ] **수치 2**: <PLACEHOLDER — 보조 통계, e.g., "전년 대비 +12%">
- [ ] **수치 3**: <PLACEHOLDER — 추가 수치 (선택)>
- [ ] **날짜/기간**: <PLACEHOLDER — 분기/연도/발표일, e.g., "2026년 1분기 (4월 30일 공시)">
- [ ] **기관/기업명**: <PLACEHOLDER — 발표 주체, e.g., "삼성전자 IR 자료">
- [ ] **인용 문장**: <PLACEHOLDER — CEO 발언/논문/보고서 직접 인용 (있을 시)>

### 1차 출처 후보 (Researcher S2 채움)
- [ ] <PLACEHOLDER — 공식 발표 URL (DART, 한국은행, 통계청, 기업 IR 등)>
- [ ] <PLACEHOLDER — 보조 출처 (블룸버그·로이터·연합뉴스 등 주요 매체)>

## 토픽 개요

> 운영자가 직접 작성 (2-3줄). Strategist가 S3에서 angle로 확장한다.

<TOPIC_SUMMARY_PLACEHOLDER — 무엇이 일어났고, 왜 시청자가 알아야 하며, 핵심 통찰 한 가지를 적어 주세요.>

## 운영자 메모 (선택)

<NOTES_PLACEHOLDER>

## 워크플로우 체크리스트

- [x] S0: Brief 작성 (이 파일)
- [ ] S1: PaperClip ticket 등록
- [ ] S2: Market Research (Researcher)
- [ ] S3: Strategy (Strategist)
- [ ] S4: Script (Writer) — 표기 정책 v2.0 준수
- [ ] S5: Fact Check (Fact Checker) — 위 placeholder 전부 검증
- [ ] S5b: \`validate-tts-policy.js\` 통과 (TTS 직전 게이트)
- [ ] S6a: TTS
- [ ] S6b: Duration Sync
- [ ] S6c: Scene Images
- [ ] S6d: Intro Card
- [ ] S6e: Thumbnail
- [ ] S7: Render
- [ ] S8: QA
- [ ] S9: Metadata
- [ ] S10: Board Approval (Human-only gate)
- [ ] S11: Publish
`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        topic:           { type: 'string', short: 't' },
        channel:         { type: 'string', short: 'c' },
        format:          { type: 'string', short: 'f' },
        persona:         { type: 'string', short: 'p' },
        'target-seconds':{ type: 'string' },
        'episode-id':    { type: 'string' },
        help:            { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`[ERROR] 인자 파싱 실패: ${e.message}`);
    console.error(HELP);
    process.exit(1);
  }

  if (!values.topic) {
    console.error('[ERROR] --topic 은 필수입니다.\n');
    console.error(HELP);
    process.exit(1);
  }

  const channel = values.channel || 'econ-daily';
  const format = (values.format || 'long').toLowerCase();
  if (!['long', 'shorts'].includes(format)) {
    console.error(`[ERROR] --format 은 long 또는 shorts 만 허용 (입력: ${format})`);
    process.exit(1);
  }

  const cfg = SCENE_STRUCTURE[format];
  const persona = values.persona || cfg.persona;
  const targetSeconds = values['target-seconds']
    ? parseInt(values['target-seconds'], 10)
    : cfg.target_seconds;

  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    console.error(`[ERROR] --target-seconds 가 유효한 양의 정수가 아닙니다.`);
    process.exit(1);
  }

  // 채널 디렉토리 검증
  const channelDir = join(WORKSPACE, 'channels', channel);
  if (!existsSync(channelDir)) {
    console.error(`[WARN] 채널 디렉토리가 없습니다: workspace/channels/${channel}/`);
    console.error('       Brief은 생성되지만, S2 Researcher 단계에서 brand.md / persona를 못 찾을 수 있습니다.');
  }

  const epId = values['episode-id'] || generateEpisodeId();
  const epDir = join(WORKSPACE, 'episodes', epId);
  const briefPath = join(epDir, '00_brief.md');

  if (existsSync(briefPath)) {
    console.error(`[ERROR] 이미 brief 존재: ${briefPath}`);
    console.error('        다른 EP id 를 명시하거나 기존 EP를 정리하세요.');
    process.exit(1);
  }

  mkdirSync(epDir, { recursive: true });

  const md = buildBriefMarkdown({
    epId, channel, format, persona, targetSeconds,
    topic: values.topic,
  });
  writeFileSync(briefPath, md, 'utf-8');

  console.log(`[OK] Brief 생성 완료`);
  console.log(`     EP id      : ${epId}`);
  console.log(`     channel    : ${channel}`);
  console.log(`     format     : ${format}`);
  console.log(`     persona    : ${persona}`);
  console.log(`     target_sec : ${targetSeconds}`);
  console.log(`     scenes     : ${cfg.scenes.length}`);
  console.log(`     path       : ${briefPath}`);
  console.log('');
  console.log('다음 단계:');
  console.log('  1) brief의 <PLACEHOLDER> 항목들을 운영자가 채운다 (토픽 개요 + 팩트체크 대상)');
  console.log(`  2) node scripts/automation/register-paperclip-issue.js --episode ${epId}`);
  console.log(`  3) node scripts/automation/produce-episode.js --episode ${epId}`);
  console.log(`  4) (TTS 직전) node scripts/automation/validate-tts-policy.js --ep ${epId}`);

  // 결과 JSON
  console.log(`\n<!--RESULT-->${JSON.stringify({
    episode_id: epId,
    brief_path: briefPath,
    channel, format, persona,
    target_seconds: targetSeconds,
    scene_count: cfg.scenes.length,
    company_id: COMPANY_ID,
  })}<!--/RESULT-->`);
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
