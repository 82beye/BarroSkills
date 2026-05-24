#!/usr/bin/env node

/**
 * derive-shorts.js — 롱폼 에피소드에서 파생 Shorts 에피소드를 부트스트랩
 *
 * 롱폼 7씬 중 "임팩트 스코어"가 높은 TOP N 씬을 선정하여,
 * 새 Shorts 에피소드 디렉토리 + 00_brief.md (format=shorts, persona=barro-alert,
 * parent_episode_id, source_scenes)를 생성한다.
 *
 * 이후 `run-episode.js --episode <new_id>`로 실행하면 기존 Shorts 파이프라인이
 * 이 brief를 읽어 alert 톤으로 Hook 리라이팅 + 5씬 60초 스크립트 생성.
 *
 * Usage:
 *   node derive-shorts.js --parent EP-2026-0010
 *   node derive-shorts.js --parent EP-2026-0010 --count 2 --dry-run
 *
 * Flags:
 *   --parent <id>   (required) 롱폼 부모 에피소드 ID (format=long-3min이어야 함)
 *   --count <n>     파생 Shorts 개수 (default: 1, max: 2)
 *   --dry-run       파일 쓰지 않고 계획만 출력
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(PROJECT_ROOT, 'workspace');

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  try { return parseYAML(m[1]) || {}; } catch { return {}; }
}

// 알림 키워드: narration에 있을 경우 alert 톤으로 전환하기 좋은 소재
const ALERT_KEYWORDS = [
  '역대', '최고', '최저', '사상', '발표', '경신', '돌파', '폭락', '폭등',
  '위기', '경고', '신호', '충격', '급등', '급락', '최대', '최초', '처음',
  '달러', '조', '억', '퍼센트', '1500', '2000', '3000', '4000', '5000',
];

function scoreScene(scene) {
  let score = 0;
  const narr = scene.narration || '';

  // emphasis_tokens 밀도
  const emphasisCount = (scene.emphasis_tokens || []).length;
  score += emphasisCount * 3;

  // 숫자 (아라비아 or 한글 수사)
  const numMatches = narr.match(/\d+|사|오|육|칠|팔|구|십|백|천|만|억|조/g);
  score += (numMatches?.length || 0);

  // 알림 키워드
  for (const kw of ALERT_KEYWORDS) {
    if (narr.includes(kw)) score += 1;
  }

  // 역할 보너스
  if (scene.role === 'hook') score += 4;
  if (scene.role === 'implication') score += 3;
  if (scene.role === 'data' || scene.role?.includes('data')) score += 2;

  // 문장 단위 임팩트: 느낌표 · 물음표
  score += (narr.match(/[!?]/g)?.length || 0);

  return score;
}

function generateNextEpisodeId() {
  const year = new Date().getFullYear();
  const episodesDir = join(WORKSPACE, 'episodes');
  if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });
  const existing = readdirSync(episodesDir)
    .filter(d => d.startsWith(`EP-${year}-`))
    .sort();
  const lastNum = existing.length > 0
    ? parseInt(existing[existing.length - 1].split('-')[2], 10)
    : 0;
  return `EP-${year}-${String(lastNum + 1).padStart(4, '0')}`;
}

function buildDerivedBrief(newId, parentScript, selectedScenes, parentEpisodeId, index) {
  const parentFM = parentScript.fm;
  const fm = {
    episode_id: newId,
    channel_id: parentFM.channel_id,
    format: 'shorts',
    persona: 'barro-alert',
    derivation_type: 'derived',
    parent_episode_id: parentEpisodeId,
    parent_format: parentFM.format,
    parent_series_id: parentFM.series_id || null,
    parent_series_episode: parentFM.series_episode || null,
    derive_index: index,
    topic: `[파생 Shorts ${index}] ${parentScript.topic || parentEpisodeId}`,
    target_length_seconds: 60,
    required_disclaimer: true,
    created_at: new Date().toISOString(),
    status: 'created',
  };
  // 시리즈 표시 일관성: derived shorts도 같은 시리즈/회차 배지를 사용 (인트로 카드/썸네일에서 [N/M] 표기).
  // generate-script.js의 carry-over 로직이 fm.series_*를 script frontmatter로 복사하므로 직접 키도 노출.
  if (parentFM.series_id) {
    fm.series_id = parentFM.series_id;
    fm.series_episode = parentFM.series_episode;
    fm.series_total = parentFM.series_total;
  }

  const sourceScenesSection = selectedScenes.map((s, i) => [
    `### Source ${i + 1} — 원본 씬 ${s.scene_id} (${s.role}, score ${s.__score})`,
    '',
    `**Narration (원본 ${parentFM.format}, persona=${parentFM.persona})**:`,
    `> ${s.narration}`,
    '',
    s.emphasis_tokens?.length ? `**Emphasis tokens**: ${s.emphasis_tokens.join(', ')}` : '',
    s.bgm_mood ? `**BGM mood (원본)**: ${s.bgm_mood}` : '',
    '',
  ].filter(Boolean).join('\n')).join('\n');

  const body = [
    '---',
    stringifyYAML(fm).trim(),
    '---',
    '',
    `# Derived Shorts Brief — ${newId}`,
    '',
    `## Parent`,
    `- **Parent episode**: ${parentEpisodeId}`,
    `- **Parent format**: ${parentFM.format}`,
    parentFM.series_id ? `- **Parent series**: ${parentFM.series_id} [${parentFM.series_episode}]` : '',
    `- **Parent persona**: ${parentFM.persona}`,
    '',
    `## Derivation Instructions (Writer Agent가 참조)`,
    `- 원본은 \`${parentFM.persona}\`(친근 톤)로 제작됨`,
    `- 파생 Shorts는 **\`barro-alert\`** 페르소나(경고 톤)로 리라이팅`,
    `- 아래 선정된 원본 씬들의 **핵심 수치/메시지만 유지**하고, Hook·CTA는 완전 재작성`,
    `- 씬 1 Hook은 "${parentFM.series_id || '본편'}의 핵심만 60초로", "이거 모르면 손해" 류 패턴`,
    `- 씬 5 CTA 고정: "전체 분석은 방금 올린 롱폼에서 ↑"`,
    `- 자산 (이미지·BGM)은 원본 재활용 우선, 부족한 부분만 신규 생성`,
    '',
    `## 선정된 원본 씬 (Source Scenes)`,
    '',
    sourceScenesSection,
    '',
    '## 워크플로우',
    '- [x] S0: Derived Brief (derive-shorts로 자동 생성됨)',
    '- [ ] S1: CEO → PD 티켓 생성 (parent 승인 상속)',
    '- [~] S2: Market Research (derived는 skip)',
    '- [~] S3: Strategy (derived는 skip)',
    '- [ ] S4: Script (alert 톤 리라이팅)',
    '- [ ] S5: Fact Check (parent 이미 통과, 경량 재검증)',
    '- [ ] S6: Asset Generation (이미지 재활용 + TTS만 신규)',
    '- [ ] S7: CapCut Composition',
    '- [ ] S8: QA Review (60±2s)',
    '- [ ] S9: Metadata (#Shorts, 본편 롱폼 링크)',
    '- [ ] S10: Board Approval (parent 승인 상속으로 auto)',
    '- [ ] S11: Publish',
    '',
  ].filter(Boolean).join('\n');

  return body;
}

async function main() {
  const { values } = parseArgs({
    options: {
      parent: { type: 'string', short: 'p' },
      count: { type: 'string', short: 'c', default: '1' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.parent) {
    console.error('Usage: derive-shorts.js --parent <EP-YYYY-NNNN> [--count 1] [--dry-run]');
    process.exit(1);
  }

  const count = Math.min(parseInt(values.count, 10) || 1, 2);
  const parentId = values.parent;
  const parentDir = join(WORKSPACE, 'episodes', parentId);

  if (!existsSync(parentDir)) {
    console.error(`❌ Parent episode directory not found: ${parentDir}`);
    process.exit(1);
  }

  // v2(platforms/long/30_script.md) 우선 → v1 fallback
  const parentScriptCandidates = [
    join(parentDir, 'platforms', 'long', '30_script.md'),
    join(parentDir, '30_script.md'),
  ];
  const parentScriptPath = parentScriptCandidates.find(p => existsSync(p));
  if (!parentScriptPath) {
    console.error(`❌ Missing parent 30_script.md (tried: ${parentScriptCandidates.join(', ')})`);
    process.exit(1);
  }

  const rawScript = readFileSync(parentScriptPath, 'utf-8');
  const parentFM = parseFrontmatter(rawScript);

  if (parentFM.format !== 'long-3min') {
    console.error(`❌ Parent format must be 'long-3min', got '${parentFM.format || 'unknown'}'`);
    console.error(`   (파생은 롱폼 → Shorts 방향만 지원. Shorts에서 파생 X)`);
    process.exit(1);
  }

  const scenes = parentFM.scenes || [];
  if (!scenes.length) {
    console.error(`❌ No scenes in parent script`);
    process.exit(1);
  }

  // 씬 점수화
  const scored = scenes.map(s => ({ ...s, __score: scoreScene(s) }));
  scored.sort((a, b) => b.__score - a.__score);

  // Hook + 상위 임팩트 씬 조합으로 각 파생본에 2~3씬 선정
  const topScenes = scored.slice(0, Math.min(scored.length, 3));

  console.log(`🎯 Parent: ${parentId} (${parentFM.format}, ${scenes.length} scenes)`);
  console.log(`   Topic: ${parentFM.topic || '(no topic)'}`);
  console.log('');
  console.log('📊 Scene impact scores:');
  scored.forEach(s => {
    console.log(`   [${s.scene_id}/${s.role}] score=${s.__score}  "${(s.narration || '').slice(0, 50)}..."`);
  });
  console.log('');
  console.log(`🎬 Top ${topScenes.length} scenes selected for derived shorts source:`);
  topScenes.forEach(s => {
    console.log(`   ⭐ ${s.scene_id} (${s.role}, score ${s.__score})`);
  });
  console.log('');

  // v2 layout: 부모 EP 디렉토리 안에 platforms/shorts/ 를 생성. count > 1이면 shorts/, shorts2/ 식으로.
  // (대부분 1편이라 shorts/만 사용. 2편 이상은 같은 부모에 여러 변형 — 드문 케이스)
  const platformDirs = [];
  for (let i = 1; i <= count; i++) {
    const suffix = i === 1 ? 'shorts' : `shorts${i}`;
    platformDirs.push(join(parentDir, 'platforms', suffix));
  }

  console.log(`📋 Derivation plan: ${count} derived Shorts inside ${parentId}/platforms/`);
  platformDirs.forEach((d, i) => console.log(`   ${d.replace(WORKSPACE + '/', '')}  ← derived[${i + 1}]`));
  console.log('');

  if (values['dry-run']) {
    console.log('🧪 DRY RUN — no files written. Remove --dry-run to execute.');
    return;
  }

  // 실제 생성
  const parentScript = { fm: parentFM, topic: parentFM.topic, raw: rawScript };
  for (let i = 0; i < count; i++) {
    const platDir = platformDirs[i];

    if (existsSync(join(platDir, '00_brief.md'))) {
      console.error(`⚠️  Already bootstrapped: ${platDir}/00_brief.md (skipping). Use --force or remove manually.`);
      continue;
    }

    mkdirSync(platDir, { recursive: true });
    mkdirSync(join(platDir, '40_assets'), { recursive: true });

    // derived shorts ID는 부모와 동일 — 같은 episode_id 사용. 디스크 상에서는 platforms/shorts/로 구분.
    const briefBody = buildDerivedBrief(parentId, parentScript, topScenes, parentId, i + 1);
    writeFileSync(join(platDir, '00_brief.md'), briefBody, 'utf-8');

    console.log(`   ✅ ${parentId}/platforms/${platDir.split('/').pop()}`);
  }

  console.log('');
  console.log(`🎉 ${count} derived Shorts bootstrapped inside ${parentId}/platforms/`);
  console.log(`   Next: node produce-episode.js --episode ${parentId}  (will pick up format=shorts brief)`);
}

// 파생이 2개일 때 중복 ID 방지 (generateNextEpisodeId는 디스크 상태 기반이므로,
// 동일 호출 내에선 이미 생성한 디렉토리가 없어서 같은 번호를 두 번 반환함 — offset 적용)
function generateNextEpisodeIdWithOffset(offset) {
  const year = new Date().getFullYear();
  const episodesDir = join(WORKSPACE, 'episodes');
  if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });
  const existing = readdirSync(episodesDir)
    .filter(d => d.startsWith(`EP-${year}-`))
    .sort();
  const lastNum = existing.length > 0
    ? parseInt(existing[existing.length - 1].split('-')[2], 10)
    : 0;
  return `EP-${year}-${String(lastNum + offset).padStart(4, '0')}`;
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
