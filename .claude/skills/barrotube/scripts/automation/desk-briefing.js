#!/usr/bin/env node
/**
 * desk-briefing.js — 전문 기자단(데스크)이 자산군별로 조사·보고하고,
 * 데스크 에디터가 그 중 "오늘 가장 뜨거운 하나"를 골라 에피소드 기초를 만든다.
 *
 * 왜 필요한가:
 *   기존 research-brief.js 는 리서처 하나가 지수·환율만 보고 토픽을 정했다.
 *   국채·유가·금·은·코인이 스냅샷에 아예 없었고, 지정학 뉴스가 자산에 미치는 경로도
 *   다루지 못했다 (2026-08-25 확인). 데스크를 나누면 각자 자기 영역만 깊게 파고,
 *   에디터가 그 위에서 고른다 — 한 명이 전부 보려다 얕아지는 문제를 구조로 푼다.
 *
 * 왜 claude -p 인가: research-brief.js 와 같은 이유다. cron 은 비대화형이라
 * Task 위임을 못 쓴다. 데스크마다 헤드리스 Claude 를 따로 띄운다.
 *
 * 산출물 (out-dir):
 *   desk-<id>.md          데스크별 리포트
 *   desk-briefing.md      에디터가 종합한 브리핑 (research 의 입력이 된다)
 *   desk-topic.json       { topic, angle, desk, candidates[] }
 *
 * 실패해도 파이프라인을 죽이지 않는다. 데스크 일부가 죽어도 남은 것으로 에디터가 돈다.
 *
 * 사용:
 *   node desk-briefing.js --slot us-close [--date YYYY-MM-DD] [--desks equities,rates]
 *                         [--timeout 420] [--dry-run]
 *
 * 종료코드: 0 = 성공 · 2 = 입력 오류 · 4 = 전 데스크 실패(폴백 권장)
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_TIMEOUT_SEC = Number(process.env.BT_DESK_TIMEOUT || 420);
const MODEL = process.env.BT_DESK_MODEL || 'sonnet';
const PERMISSION_MODE = process.env.BT_DESK_PERMISSION_MODE || 'acceptEdits';
const ALLOWED_TOOLS = process.env.BT_DESK_ALLOWED_TOOLS
  || 'Read,Write,Glob,Grep,Bash,WebSearch,WebFetch';

/**
 * 이 머신에서 **실제로 붙는** 소셜·검색 채널만 골라낸다.
 *
 * 왜 필요한가: 프롬프트에 `twitter search ...` 를 박아 뒀는데 twitter-cli 는 미인증이라
 * 항상 실패한다 (2026-08-25 `agent-reach doctor` 실측: twitter/facebook/instagram/
 * xiaohongshu/xueqiu 전부 미인증). 6개 데스크가 저마다 그걸 시도하고 실패하는 데
 * 턴을 쓴다. 붙는 채널만 알려 주고, 죽은 채널은 아예 쓰지 말라고 못박는 게 싸다.
 *
 * doctor 가 없거나 느리면 그냥 WebSearch 만 쓰게 한다 — 여기서 파이프라인을 세우지 않는다.
 */
function detectSocialChannels() {
  const res = spawnSync('agent-reach', ['doctor', '--json'], {
    encoding: 'utf-8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0 || !res.stdout) return { ok: [], dead: [], available: false };
  let d;
  try { d = JSON.parse(res.stdout); } catch { return { ok: [], dead: [], available: false }; }
  const ok = [], dead = [];
  for (const [id, v] of Object.entries(d)) {
    if (!v || typeof v !== 'object') continue;
    (v.status === 'ok' ? ok : dead).push({ id, backend: v.active_backend || null });
  }
  return { ok, dead, available: ok.length > 0 };
}

/** 데스크 프롬프트에 넣을 "조사 수단" 안내. 붙는 채널만 이름으로 알려 준다. */
export function socialBlock(channels) {
  if (!channels.available) {
    return [
      '2. 소셜·커뮤니티 반응: 이 머신에는 붙는 소셜 채널이 없다. **WebSearch 로만** 조사하고,',
      '   소셜 반응이 필요했는데 못 봤다면 "주의" 에 한 줄 남겨라.',
    ].join('\n');
  }
  const okList = channels.ok.map((c) => `${c.id}${c.backend ? `(${c.backend})` : ''}`).join(', ');
  const deadList = channels.dead.map((c) => c.id).join(', ');
  const lines = [
    '2. 소셜·커뮤니티 반응 (선택). **오늘 이 머신에서 실제로 붙는 채널은 이것뿐이다:**',
    `     ${okList}`,
    '   사용법은 설치된 `agent-reach` 스킬 문서를 따른다. 명령이 없거나 한 번 실패하면',
    '   **재시도하지 말고** WebSearch 로 대체한 뒤 그 사실을 "주의" 에 한 줄 남겨라.',
  ];
  if (deadList) lines.push(`   아래는 미인증이라 **시도 자체를 하지 마라**: ${deadList}`);
  lines.push('   소셜은 어디까지나 보조다. 커뮤니티 반응을 사실처럼 쓰지 마라.');
  return lines.join('\n');
}

function loadJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fallback; }
}

/** 스냅샷에서 이 데스크가 맡은 심볼만 뽑아 표로 만든다 — 없는 값을 지어내지 못하게. */
export function quoteTable(snapshot, symbols) {
  const quotes = snapshot?.quotes || [];
  const picked = symbols.length
    ? quotes.filter((q) => symbols.includes(q.symbol))
    : [];
  if (!picked.length) return '  (이 데스크에 배정된 시세 없음 — 뉴스·검색으로만 판단)';
  return picked.map((q) => {
    if (q.error) return `  - ${q.name || q.symbol}: 수집 실패 (${q.error})`;
    const unit = q.unit === 'percent' ? '%' : '';
    const basis = q.basis === '24h' ? ' [24시간 기준]' : '';
    return `  - ${q.name}: ${q.price_text ?? q.price}${unit} (${q.change_pct > 0 ? '+' : ''}${q.change_pct}%)${basis}`;
  }).join('\n');
}

export function buildDeskPrompt({ reporter, slot, date, snapshot, outDir, newsPath, competitorPath, social }) {
  const table = quoteTable(snapshot, reporter.symbols || []);
  const hints = (reporter.search_hints || []).map((h) => `"${h}"`).join(', ');
  const caveats = [reporter.unit_caveat, reporter.scope_caveat].filter(Boolean)
    .map((c) => `- ${c}`).join('\n');

  return `너는 바로경제(econ-daily) 채널의 **${reporter.label}** 기자다. 오늘(${date}) ${slot.label} 브리핑을 위해 네 담당 영역만 조사한다.

## 네 담당 (beat)
${reporter.beat}

## 오늘 네 영역의 시세 (스냅샷 실측값 — 이 숫자만 쓴다. 지어내지 마라)
${table}

## 네가 답해야 할 질문
${reporter.question}

## 참고 파일 (경로다. 필요하면 읽어라)
  - 뉴스: ${newsPath}
  - 경쟁 채널 인텔: ${competitorPath}

## 조사 방법
1. WebSearch 로 오늘 네 영역의 핵심 사건을 찾아라. 검색어 예: ${hints}
${social}
3. **인과를 하나 짚어라.** 나열이 아니라 "A 때문에 B 가 움직였다" 를 찾는 게 네 일이다.
${caveats ? `\n## 이 데스크의 주의사항\n${caveats}` : ''}

## 반드시 지킬 것
- 모든 수치에 **출처 URL** 을 붙여라. 못 찾으면 그 수치를 쓰지 마라.
- 위 스냅샷에 없는 당일 등락률을 만들어내지 마라.
- 특정 언론사 문장을 그대로 옮기지 마라. 사실만 취하고 표현은 새로 써라.
- 투자 권유·목표가 제시 금지.

## 산출물 — 아래 파일 하나를 Write 로 저장해라
${join(outDir, `desk-${reporter.id}.md`)}

형식:
---
desk: ${reporter.id}
label: ${reporter.label}
date: ${date}
heat: <1~10, 오늘 네 영역이 얼마나 뜨거운가. 조용하면 낮게 줘라. 정직하게.>
headline: <한 문장. 오늘 네 영역에서 가장 중요한 것>
---

## 오늘의 사실
(수치 + 출처 URL)

## 인과
(무엇이 무엇을 움직였나. 확실하지 않으면 "불확실" 이라고 써라)

## 한국 시청자 함의
(손익·체감과 어떻게 연결되나)

## 주의 (선택)
(과장된 해석, 반대 증거, 확인 못 한 것)

heat 를 후하게 주지 마라. 6개 데스크가 경쟁하고 에디터가 하나만 고른다.
네 영역이 오늘 조용했다면 3점을 주는 게 정직한 보고다.`;
}

function runClaude({ prompt, cwd, timeoutSec, addDirs = [] }) {
  const args = [
    '-p', prompt,
    '--model', MODEL,
    '--permission-mode', PERMISSION_MODE,
    '--allowed-tools', ALLOWED_TOOLS,
  ];
  // workspace/ 는 ~/BarroTubeData 로 나가는 심볼릭이다. 실경로를 명시하지 않으면
  // 쓰기가 "민감 파일"로 차단된다 — 모델은 리포트를 다 써놓고 저장만 못 한 채
  // "승인해 주시겠어요?" 로 끝난다 (2026-08-25 geopolitics 데스크 실측).
  for (const d of addDirs) if (d) args.push('--add-dir', d);
  const started = Date.now();
  const res = spawnSync('claude', args, {
    cwd, encoding: 'utf-8', timeout: timeoutSec * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, BT_DESK_CHILD: '1' },
  });
  const sec = Math.round((Date.now() - started) / 1000);
  // 모델이 파일을 안 쓰고 끝내는 경우가 있다 — 그때 이유는 stdout 에만 있다.
  // 버리면 "산출물 없음" 이라는 결과만 남아 원인을 못 찾는다 (2026-08-25 실측).
  const tail = String(res.stdout || '').trim().slice(-600);
  if (res.error) return { ok: false, sec, why: res.error.message, tail };
  if (res.status !== 0) return { ok: false, sec, why: `exit ${res.status}: ${String(res.stderr || '').slice(-300)}`, tail };
  return { ok: true, sec, tail };
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function main() {
  const { values } = parseArgs({ options: {
    slot: { type: 'string' },
    date: { type: 'string' },
    desks: { type: 'string' },
    timeout: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  } });

  if (!values.slot) { console.error('❌ --slot 필요'); process.exit(2); }
  const date = values.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const timeoutSec = Number(values.timeout || DEFAULT_TIMEOUT_SEC);

  const cfg = loadJson(join(ROOT, 'config', 'desk-reporters.json'));
  if (!cfg) { console.error('❌ config/desk-reporters.json 없음'); process.exit(2); }
  const routines = loadJson(join(ROOT, 'config', 'routines.json'), {});
  const slot = routines.slots?.[values.slot];
  if (!slot) { console.error(`❌ 알 수 없는 슬롯: ${values.slot}`); process.exit(2); }

  const outDirLink = join(ROOT, 'workspace', 'daily-news', date);
  mkdirSync(outDirLink, { recursive: true });
  // 심볼릭이 아니라 실경로를 프롬프트에 넣는다 (위 --add-dir 와 짝이다).
  const outDir = realpathSync(outDirLink);
  const dataRoot = outDir.replace(/\/workspace\/daily-news\/.*$/, '');

  const snapPath = join(outDir, `market-${values.slot}.json`);
  const snapshot = loadJson(snapPath);
  const newsPath = join(outDir, 'news.json');
  // 폴더 경로만 주면 데스크가 어느 파일을 읽어야 할지 몰라 뒤진다. 오늘 자 분석본이 있으면
  // 그 파일을 바로 가리킨다. 심볼릭이 아니라 실경로여야 --add-dir 와 짝이 맞는다.
  const competitorDir = join(ROOT, 'workspace', 'intel', 'competitors');
  // 슬롯별 분석본을 먼저 본다. 전체 27채널을 한 코퍼스로 섞으면 부동산 21개가 증시 갭을
  // 묻어 버린다 (2026-08-30: 증시 최상위 갭이 '집값' 으로 바뀌었다). 없으면 통합본으로 폴백.
  const scopedAnalysis = join(competitorDir, `analysis-${date}-${values.slot}.json`);
  const competitorAnalysis = existsSync(scopedAnalysis)
    ? scopedAnalysis
    : join(competitorDir, `analysis-${date}.json`);
  const competitorPath = existsSync(competitorAnalysis)
    ? realpathSync(competitorAnalysis)
    : (existsSync(competitorDir) ? realpathSync(competitorDir) : competitorDir);

  // 슬롯이 어느 데스크 세트를 부르는지로 먼저 거른다. 이게 없으면 부동산 슬롯이
  // 증시 데스크 6개까지 같이 돌려 스냅샷에 없는 심볼을 물어보게 된다 (2026-08-30 realestate 개설).
  const deskSet = slot.desk_set || 'market';
  let reporters = (cfg.reporters || []).filter((r) => (r.desk_set || 'market') === deskSet);
  if (!reporters.length) { console.error(`❌ desk_set "${deskSet}" 에 해당하는 데스크가 없습니다`); process.exit(2); }
  if (values.desks) {
    const want = values.desks.split(',').map((s) => s.trim());
    reporters = reporters.filter((r) => want.includes(r.id));
  }

  console.log(`\n📰 데스크 브리핑 — ${slot.label} (${date})`);
  console.log(`   스냅샷: ${existsSync(snapPath) ? `${snapshot?.quotes?.length ?? 0}종` : '없음'}`);
  console.log(`   데스크: ${reporters.map((r) => r.id).join(', ')}`);

  // 소셜 채널은 여기서 한 번만 조회해 모든 데스크에 같은 목록을 준다.
  // 데스크마다 doctor 를 돌리면 6번 나가고, 붙는 채널은 어차피 같다.
  const channels = values['dry-run'] ? { ok: [], dead: [], available: false } : detectSocialChannels();
  const social = socialBlock(channels);
  console.log(`   소셜: ${channels.available ? channels.ok.map((c) => c.id).join(', ') : '없음 (WebSearch 만)'}`);
  console.log(`   경쟁 인텔: ${existsSync(competitorPath) ? competitorPath.split('/').pop() : '없음'}\n`);

  if (values['dry-run']) {
    for (const r of reporters) console.log(`  [DRY_RUN] ${r.label} → desk-${r.id}.md`);
    console.log(`  [DRY_RUN] 에디터 → desk-briefing-${values.slot}.md`);
    process.exit(0);
  }

  // ── 데스크 병렬이 아니라 순차. claude -p 를 6개 동시에 띄우면 쿼터·부하가 튄다.
  const results = [];
  for (const r of reporters) {
    const outFile = join(outDir, `desk-${r.id}.md`);
    process.stdout.write(`  ▶ ${r.label} … `);
    const prompt = buildDeskPrompt({ reporter: r, slot, date, snapshot, outDir, newsPath, competitorPath, social });
    const run = runClaude({ prompt, cwd: ROOT, timeoutSec, addDirs: [outDir, dataRoot] });
    if (!run.ok || !existsSync(outFile)) {
      console.log(`❌ ${run.why || '산출물 없음'} (${run.sec}s)`);
      if (run.tail) console.log(`     모델 마지막 응답: ${run.tail.replace(/\n+/g, ' | ').slice(0, 400)}`);
      results.push({ id: r.id, label: r.label, ok: false, why: run.why || '산출물 없음', tail: run.tail });
      continue;
    }
    const fm = parseFrontmatter(readFileSync(outFile, 'utf-8'));
    const heat = Number(fm.heat) || 0;
    console.log(`✅ heat=${heat} — ${(fm.headline || '').slice(0, 46)} (${run.sec}s)`);
    results.push({ id: r.id, label: r.label, ok: true, heat, headline: fm.headline || '', path: outFile });
  }

  const ok = results.filter((r) => r.ok);
  if (!ok.length) {
    console.error('\n❌ 전 데스크 실패 — 폴백 권장');
    process.exit(4);
  }
  ok.sort((a, b) => b.heat - a.heat);
  console.log(`\n🔥 heat 순위: ${ok.map((r) => `${r.id}(${r.heat})`).join(' > ')}`);

  // ── 에디터
  // 에디터도 세트별로 갈린다. 증시 에디터에게 부동산 리포트를 주면
  // '오늘 가장 뜨거운 자산'을 찾는 기준으로 읽어 중립 규약이 통째로 빠진다.
  const ed = cfg.editors?.[deskSet] || cfg.editor;
  const deskLines = ok.map((r) => `  - ${r.label} [heat ${r.heat}] ${r.path}\n      ${r.headline}`).join('\n');
  const failLines = results.filter((r) => !r.ok).map((r) => `  - ${r.label}: 실패`).join('\n');
  const editorPrompt = `너는 바로경제(econ-daily) 채널의 **${ed.label}** 다. ${ed.role}

## 오늘(${date}) ${slot.label} 데스크 리포트 (heat 높은 순)
${deskLines}
${failLines ? `\n## 실패한 데스크\n${failLines}` : ''}

## 각 리포트를 **직접 읽어라** (경로가 위에 있다)

## 선정 기준
${ed.selection_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## 이런 건 고르지 마라
${ed.reject.map((c) => `- ${c}`).join('\n')}
${ed.neutrality_rules ? `
## 중립 규약 — 어기면 이 리포트는 폐기다
${ed.neutrality_rules.map((c) => `- ${c}`).join('\n')}` : ''}${ed.bias_guard ? `

## 편향 경고
${ed.bias_guard}` : ''}

## 중요
- heat 점수는 **참고값**이다. 점수가 낮아도 인과가 선명하면 그걸 골라라.
- 여러 데스크가 **같은 원인**을 가리키면 그게 오늘의 이야기다. 그 연결을 각도로 삼아라
  (예: 지정학 → 유가 → 인플레 기대 → 금리 → 나스닥).
- 자산 나열식 요약을 만들지 마라. **인과 하나**를 ${slot.target_seconds || 60}초에 설명하는 게 목적이다.

## 산출물 — 아래 두 파일을 Write 로 저장해라

1. ${join(outDir, `desk-briefing-${values.slot}.md`)}
   - 오늘의 한 줄 (에피소드가 될 이야기)
   - 왜 이걸 골랐나 (근거 데스크와 수치)
   - 인과 사슬 (A → B → C, 각 단계에 출처)
   - 다른 데스크가 본 것 중 이 이야기를 보강하는 것
   - 쓰지 않기로 한 것과 그 이유
   - ${slot.target_seconds || 60}초 안에 다룰 범위

2. ${join(outDir, `desk-topic-${values.slot}.json`)}
   {"topic": "<한 문장 주제>", "angle": "<차별화 각도>", "desk": "<주도 데스크 id>",
    "supporting_desks": ["..."], "candidates": ["<후보2>", "<후보3>"],
    "evidence": [{"claim": "...", "value": "...", "source": "<URL>"}]}

   topic 은 대본 작성자가 그대로 쓸 수 있게 구체적으로 써라.`;

  process.stdout.write(`\n  ▶ ${ed.label} … `);
  const edRun = runClaude({ prompt: editorPrompt, cwd: ROOT, timeoutSec: timeoutSec + 120, addDirs: [outDir, dataRoot] });
  // 슬롯별로 파일을 가른다. 예전엔 셋(us-close·kr-close·realestate)이 같은 날
  // desk-briefing.md 하나를 덮어써서, 나중에 돈 슬롯이 앞 슬롯의 브리핑을 지웠다.
  // research-brief 는 그걸 읽으므로 대본이 엉뚱한 슬롯 기준으로 쓰이게 된다.
  const briefPath = join(outDir, `desk-briefing-${values.slot}.md`);
  const topicPath = join(outDir, `desk-topic-${values.slot}.json`);
  if (!edRun.ok || !existsSync(briefPath)) {
    console.log(`❌ ${edRun.why || '산출물 없음'} (${edRun.sec}s)`);
    if (edRun.tail) console.log(`     모델 마지막 응답: ${edRun.tail.replace(/\n+/g, ' | ').slice(0, 400)}`);
    console.error('\n⚠️  에디터 실패 — 데스크 리포트는 남아 있다. 리서치가 이어받을 수 있다.');
    process.exit(4);
  }
  const topic = loadJson(topicPath, {});
  console.log(`✅ (${edRun.sec}s)`);
  console.log(`\n📌 오늘의 토픽: ${topic.topic || `(desk-briefing-${values.slot}.md 참조)`}`);
  if (topic.desk) console.log(`   주도 데스크: ${topic.desk}`);
  console.log(`\n✅ 저장: ${briefPath}`);
  process.exit(0);
}

// import 만 해도 main 이 돌면 테스트에서 못 쓴다 — 레포의 다른 CLI 와 같은 가드를 둔다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
