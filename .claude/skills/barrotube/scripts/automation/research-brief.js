#!/usr/bin/env node
/**
 * 리서치 브리프 — 수집된 데이터 + 소셜 검색을 종합해 토픽을 고르고 10_market_research.md 를 쓴다.
 *
 * 왜 claude -p 인가: S2 리서치는 비대화형에서 실행할 방법이 없다. Task 위임은 대화형
 * 세션 전용이고, run-episode.js 의 에이전트 호출은 프롬프트를 console.log 만 하고
 * 곧바로 completed 로 마킹하는 빈 껍데기다. 사용자가 요구한 "소셜 검색을 통한 정보 취합"을
 * cron 에서 수행하려면 헤드리스 Claude 를 띄우는 수밖에 없다.
 *
 * 산출물을 stdout 파싱이 아니라 파일로 받는다 — 모델이 형식을 흔들어도 검증이 확정적이다.
 *   <out-dir>/research-<slot>.md    — 10_market_research.md 로 설치될 본문
 *   <out-dir>/strategy-<slot>.md    — 20_strategy.md 로 설치될 본문
 *   <out-dir>/topic-<slot>.json     — { topic, angle, candidates[] }
 *
 * 실패해도 파이프라인을 죽이지 않는다. 종료코드 4 = "리서치 실패, 헤드라인 폴백하라".
 *
 * 사용:
 *   node research-brief.js --slot us-close [--date YYYY-MM-DD] [--timeout 600] [--dry-run]
 *
 * 종료코드: 0 = 성공 · 2 = 입력 오류 · 4 = 리서치 실패(폴백 권장)
 */
import { existsSync, readFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_MODEL = process.env.BT_RESEARCH_MODEL || 'sonnet';
// cron 은 비대화형이라 권한 프롬프트가 뜨면 그대로 멈춘다. 허용 툴을 좁히고
// acceptEdits 로 둔다. 더 열어야 하면 운영자가 env 로 조정한다.
const PERMISSION_MODE = process.env.BT_RESEARCH_PERMISSION_MODE || 'acceptEdits';
const ALLOWED_TOOLS = process.env.BT_RESEARCH_ALLOWED_TOOLS
  || 'Read,Write,Glob,Grep,Bash,WebSearch,WebFetch';

function loadSlot(slotName) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'routines.json'), 'utf-8'));
  const slot = cfg.slots?.[slotName];
  if (!slot) throw new Error(`알 수 없는 슬롯: ${slotName}`);
  return { slot, defaults: cfg.defaults || {}, skeleton: cfg.scene_skeleton || [] };
}

function buildPrompt({ slotName, slot, defaults, skeleton, date, inputs, outDir }) {
  const skeletonLines = skeleton.map((s) => `  ${s.n}. ${s.role} — ${s.intent}`).join('\n');
  const inputLines = Object.entries(inputs)
    .map(([k, v]) => `  - ${k}: ${v.exists ? v.path : `(없음 — ${v.path})`}`)
    .join('\n');
  const weekday = new Intl.DateTimeFormat('ko-KR', {
    weekday: 'long', timeZone: 'Asia/Seoul',
  }).format(new Date(`${date}T12:00:00+09:00`));
  const requiredClosed = slot.market?.require_closed?.join(', ') || '없음';

  // 파일 내용은 넣지 않고 경로만 준다 (CLAUDE.md brief 원칙).
  return `너는 바로경제(econ-daily) 채널의 리서처다. 오늘(${date}, ${weekday}) "${slot.label}" 쇼츠 1편의 리서치를 완성한다.

## 입력 (경로다. 직접 읽어라)
${inputLines}

## 앵글
${slot.angle}

## 시청자
${slot.audience_context}

## 반드시 지킬 제약
${slot.timing_caveat}

## 휴장일·주말 대체 규칙 (위 앵글과 5컷 구조보다 우선)
- 필수 마감 지수: ${requiredClosed}
- 시세 스냅샷의 content_mode를 우선 따른다: 토요일은 closed_market_issue, 일요일은 sunday_preopen이다. 평일에는 필수 지수 거래일(traded_at)에 신규 종가가 없으면 closed_market_issue다.
- ${slot.closed_market_policy}
- 대체 모드에서는 없는 당일 등락률을 만들지 말고, 아래 5컷 구조의 숫자 요구도 최신 이슈·영향·다음 개장 관전 포인트로 바꿔라.

## 소셜 검색 (필수)
설치된 CLI 로 시장 반응을 확인해라. 실패하면 건너뛰고 그 사실을 문서에 남겨라.
  agent-reach doctor --json      # 사용 가능한 백엔드 확인
  twitter search "<키워드>" -n 10
  opencli reddit search "<키워드>" -f yaml
헤드라인이 말하지 않는 것(투자자 정서, 논쟁 지점, 과장 여부)을 잡아내는 게 목적이다.

## 산출물 — 아래 세 파일을 반드시 Write 로 저장해라
1. ${join(outDir, `research-${slotName}.md`)}
   - 시세 요약(스냅샷의 수치를 그대로. 임의로 지어내지 마라)
   - 오늘의 핵심 사건 3개와 각각의 근거 링크
   - 소셜 반응 요약 (검색 실패 시 "소셜 검색 불가"라고 명시)
   - 경쟁 채널이 이미 다룬 주제 (아래 "경쟁 인텔" 절 참조)
   - 60초 안에 다룰 수 있는 범위로 좁힌 결론

2. ${join(outDir, `strategy-${slotName}.md`)}
   - 선정 토픽과 한 문장 앵글
   - 시청자가 얻어갈 핵심 1개
   - **분석 명제** — 아래 네 줄을 반드시 이 이름 그대로 쓴다. 대본의 인과는 여기서만 나온다.
     * 관찰: 오늘 데이터에서 확인되는 사실 (지수 등락률 말고, 통념과 어긋나는 쪽)
     * 메커니즘: 왜 그렇게 됐는지 한 문장. "A 때문에 B"
     * 함의: 한국 시청자가 이 때문에 다르게 봐야 할 것 하나
     * 반증: 이 해석이 틀렸다면 내일 무엇이 보일지
   - 아래 5컷 구조에 맞춘 씬별 메시지
   - 단정하면 안 되는 주장과 팩트체크 우선순위
     근거가 약할 때 "두루뭉술하게 쓰라" 고 지시하지 마라. 그건 대본을 아무 말도 안 하는
     문장으로 만든다. 대신 관찰과 해석을 쪼개라 — 확인된 사실은 좁고 정확하게 단정하고,
     해석은 해석이라고 표시해서 넘겨라.
     예) 나쁨: "일부 대형주는 상대적으로 잠잠했다"
         좋음: "코히런트는 실적을 이기고도 5% 빠졌다(사실). 시장이 실적보다 AI 수요를
               보고 있다는 해석이 가능하다(해석)"

3. ${join(outDir, `topic-${slotName}.json`)}
   {
     "topic": "<선정된 토픽 한 문장. 대본 생성의 입력이 된다>",
     "angle": "<이 토픽을 어떤 각도로 풀지>",
    "content_mode": "market_close|closed_market_issue|sunday_preopen",
     "key_numbers": ["<대본에 반드시 들어갈 수치>", "..."],
     "candidates": [{"topic":"...","why":"..."}, ...],
     "social_searched": true|false,
     "competitor_gap_used": "<반영한 content_gaps 의 term. 연결점이 없으면 null>",
     "avoided_duplicates": ["<outliers 에 있어 피한 주제>", "..."],
     "competitor_intel_at": "<사용한 분석 파일의 date. 없으면 null>"
   }

## 경쟁 인텔 (분석 파일이 있을 때만 수행 — 없으면 이 절 전체를 건너뛰고 세 필드를 null/[] 로 둔다)
입력의 "경쟁 인텔 분석" 파일을 읽고 아래 셋을 반드시 처리해라.

1. content_gaps 상위 5개 중 오늘 시세·뉴스와 실제로 연결되는 것이 있으면
   candidates 에 최소 1개 포함하고 competitor_gap_used 에 그 term 을 적어라.
   억지로 갖다 붙이지 마라 — 연결이 없으면 null 이 정답이다.
2. outliers 에 오른 주제는 오늘 다루지 마라. 이미 소진된 화제다.
   피한 주제를 avoided_duplicates 에 적어라.
3. patterns.title_features 에서 direction=positive 인 피처를 angle 에 반영해라.
   (예: has_number 의 lift 가 1.3 이상이면 앵글에 구체 수치를 넣는다)

경쟁 채널의 제목·문장을 그대로 베끼지 마라. 다루는 '주제'만 참고한다.

## 대본이 따를 구조 (참고 — 토픽을 이 5컷에 담을 수 있어야 한다)
${skeletonLines}
총 ${defaults.target_seconds}초, ${defaults.scene_count}컷.

## 금지
- 수치를 지어내지 마라. 스냅샷/뉴스에 없는 숫자는 쓰지 마라.
- 특정 종목 매수·매도 권유를 하지 마라.
- 파일을 저장하지 않고 끝내지 마라. 저장이 이 작업의 산출물이다.`;
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

/** 경쟁 인텔 분석 파일은 며칠까지 유효한 것으로 볼 것인가 */
const INTEL_MAX_AGE_DAYS = 3;

/**
 * date 를 포함해 과거로 maxAge 일까지 거슬러 가장 최근 analysis-*.json 을 찾는다.
 * 당일 수집이 실패해도 며칠 전 인텔로 계속 굴러가게 하려는 것.
 */
function newestAnalysisPath(date, maxAge) {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  for (let back = 0; back <= maxAge; back++) {
    const d = new Date(base - back * 86400_000).toISOString().slice(0, 10);
    const p = join(ROOT, 'workspace', 'intel', 'competitors', `analysis-${d}.json`);
    if (existsSync(p)) return p;
  }
  return null;
}

function writeFallbackAnalysis({ slotName, slot, skeleton, date, inputs, outDir }) {
  const market = readJson(inputs['시세 스냅샷'].path, {});
  const news = readJson(inputs['뉴스'].path, {});
  const items = (news.sources || []).flatMap((source) => source.items || []).slice(0, 3);
  const quotes = market.quotes || [];
  const topic = items[0]?.title || (quotes.length ? `${slot.label}: 주요 지수와 환율 흐름` : '');
  if (!topic) return false;

  const weekday = new Date(`${date}T12:00:00+09:00`).getUTCDay();
  const contentMode = market.content_mode
    || (weekday === 6 ? 'closed_market_issue' : weekday === 0 ? 'sunday_preopen' : 'market_close');
  const quoteLines = quotes.length
    ? quotes.map((q) => `- ${q.name || q.symbol}: ${q.price_text ?? q.price ?? '값 없음'} (${q.change_pct == null ? '변동률 없음' : `${q.change_pct}%`}, ${q.traded_at || '거래시각 없음'})`).join('\n')
    : '- 시세 스냅샷 없음 — 수치 단정 금지';
  const newsLines = items.length
    ? items.map((item) => `- [${item.title}](${item.link || ''})${item.description ? ` — ${item.description}` : ''}`).join('\n')
    : '- 뉴스 없음';
  const sceneLines = skeleton.map((scene) => `- ${scene.n}. ${scene.role}: ${scene.intent}`).join('\n');

  writeFileSync(join(outDir, `research-${slotName}.md`), `---\ndate: ${date}\nslot: ${slotName}\nsource: deterministic-fallback\ncontent_mode: ${contentMode}\n---\n\n# 시장 리서치\n\n## 선정 토픽\n\n${topic}\n\n## 시세 스냅샷\n\n${quoteLines}\n\n## 주요 뉴스\n\n${newsLines}\n\n## 분석 한계\n\n자동 리서치 모델을 사용할 수 없어 수집 원문만 정리했다. 소셜 반응과 기사 밖 주장은 사용하지 않으며, 모든 수치는 대본 팩트체크에서 다시 검증한다.\n`);
  writeFileSync(join(outDir, `strategy-${slotName}.md`), `---\ndate: ${date}\nslot: ${slotName}\nsource: deterministic-fallback\ncontent_mode: ${contentMode}\n---\n\n# 콘텐츠 전략\n\n## 한 문장 앵글\n\n${slot.angle}: ${topic}\n\n## 시청자 가치\n\n${slot.audience_context}\n\n## 5씬 구조\n\n${sceneLines}\n\n## 팩트 경계\n\n시세 스냅샷과 링크된 뉴스에 없는 수치·인과·최상급 표현은 단정하지 않는다. 휴장 모드에서는 직전 종가를 거래일과 함께 참고값으로만 사용한다.\n`);
  writeFileSync(join(outDir, `topic-${slotName}.json`), `${JSON.stringify({
    topic,
    angle: slot.angle,
    content_mode: contentMode,
    key_numbers: quotes.filter((q) => q.price_text != null || q.price != null)
      .map((q) => `${q.name || q.symbol} ${q.price_text ?? q.price}`).slice(0, 5),
    candidates: items.map((item) => ({ topic: item.title, why: '수집 뉴스 헤드라인' })),
    social_searched: false,
    // 폴백은 LLM 없이 도는 경로라 경쟁 인텔을 해석할 주체가 없다.
    // 필드는 유지해 스키마를 일관되게 두되 값은 비워 둔다 (소비 측이 분기 없이 읽는다).
    competitor_gap_used: null,
    avoided_duplicates: [],
    competitor_intel_at: null,
    fallback: true,
  }, null, 2)}\n`);
  return true;
}

function main() {
  const { values } = parseArgs({
    options: {
      slot: { type: 'string' },
      date: { type: 'string', short: 'd' },
      'out-dir': { type: 'string' },
      timeout: { type: 'string' },
      model: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      fallback: { type: 'boolean', default: false },
    },
  });

  if (!values.slot) {
    console.error('Usage: research-brief.js --slot us-close|kr-close [--date YYYY-MM-DD] [--timeout 600] [--dry-run]');
    process.exit(2);
  }

  let cfg;
  try { cfg = loadSlot(values.slot); } catch (e) { console.error(`❌ ${e.message}`); process.exit(2); }
  const { slot, defaults, skeleton } = cfg;

  const date = values.date || new Date().toISOString().slice(0, 10);
  const outDir = values['out-dir'] || join(ROOT, 'workspace', 'daily-news', date);
  mkdirSync(outDir, { recursive: true });

  const inputs = {
    '시세 스냅샷': { path: join(outDir, `market-${values.slot}.json`) },
    '뉴스': { path: join(outDir, 'news.json') },
    '경쟁 채널': { path: join(ROOT, 'workspace', 'intel', 'competitors', `${date}.json`) },
    '경쟁 인텔 분석': { path: newestAnalysisPath(date, INTEL_MAX_AGE_DAYS) },
  };
  for (const v of Object.values(inputs)) v.exists = v.path ? existsSync(v.path) : false;

  const researchPath = join(outDir, `research-${values.slot}.md`);
  const strategyPath = join(outDir, `strategy-${values.slot}.md`);
  const topicPath = join(outDir, `topic-${values.slot}.json`);

  // workspace/ 는 ~/BarroTubeData 로 가는 심볼릭이라 실경로가 프로젝트 밖이다.
  // --add-dir 에 심볼릭 경로를 주면 쓰기가 "민감 파일"로 차단되고, 비대화형이라
  // 승인해 줄 사람이 없어 리서치가 통째로 버려진다 (실측 확인). 실경로로 넘긴다.
  const realOutDir = existsSync(outDir) ? realpathSync(outDir) : outDir;

  const prompt = buildPrompt({
    slotName: values.slot, slot, defaults, skeleton, date, inputs, outDir: realOutDir,
  });

  const timeoutSec = Number(values.timeout || DEFAULT_TIMEOUT_SEC);
  const model = values.model || DEFAULT_MODEL;

  console.log(`\n🔎 리서치 브리프 — ${values.slot} (${date})`);
  for (const [k, v] of Object.entries(inputs)) console.log(`   ${v.exists ? '✓' : '✗'} ${k}`);
  console.log(`   model=${model} timeout=${timeoutSec}s permission=${PERMISSION_MODE}`);

  if (values['dry-run']) {
    console.log('\n[DRY_RUN] claude -p 호출 생략. 프롬프트 길이:', prompt.length, '자');
    process.exit(0);
  }

  if (values.fallback) {
    if (!writeFallbackAnalysis({
      slotName: values.slot, slot, skeleton, date, inputs, outDir: realOutDir,
    })) {
      console.error('❌ 폴백 분석에 사용할 시세·뉴스가 없습니다.');
      process.exit(4);
    }
    console.log(`\n⚠️  결정론적 폴백 분석 완료\n   ${researchPath}\n   ${strategyPath}\n   ${topicPath}`);
    process.exit(0);
  }

  if (!inputs['시세 스냅샷'].exists && !inputs['뉴스'].exists) {
    console.error('❌ 시세·뉴스가 모두 없습니다 — 리서치할 재료가 없어 중단합니다.');
    process.exit(4);
  }

  const args = [
    '-p', prompt,
    '--model', model,
    '--permission-mode', PERMISSION_MODE,
    '--allowed-tools', ...ALLOWED_TOOLS.split(','),
    '--add-dir', realOutDir,
  ];

  const r = spawnSync('claude', args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutSec * 1000,
    env: process.env,
  });

  if (r.error?.code === 'ENOENT') {
    console.error('\n❌ claude CLI 를 찾을 수 없습니다. launchd plist 의 PATH 에 ~/.local/bin 이 있는지 확인하세요.');
    process.exit(4);
  }
  if (r.signal === 'SIGTERM') {
    console.error(`\n❌ 리서치 타임아웃 (${timeoutSec}s) — 헤드라인 폴백으로 진행하세요.`);
    process.exit(4);
  }
  if (r.status !== 0) {
    console.error(`\n❌ claude -p 종료코드 ${r.status}`);
    process.exit(4);
  }

  // 파일로 검증한다 — 모델이 "했다"고 말하는 것과 실제로 쓴 것은 다르다.
  const missing = [];
  if (!existsSync(researchPath) || !readFileSync(researchPath, 'utf-8').trim()) missing.push(researchPath);
  if (!existsSync(strategyPath) || !readFileSync(strategyPath, 'utf-8').trim()) missing.push(strategyPath);
  if (!existsSync(topicPath)) missing.push(topicPath);
  if (missing.length) {
    console.error(`\n❌ 산출물 누락:\n   ${missing.join('\n   ')}`);
    process.exit(4);
  }

  let topic;
  try {
    topic = JSON.parse(readFileSync(topicPath, 'utf-8'));
  } catch (e) {
    console.error(`\n❌ topic JSON 파싱 실패: ${e.message}`);
    process.exit(4);
  }
  if (!topic.topic || typeof topic.topic !== 'string' || topic.topic.trim().length < 5) {
    console.error('\n❌ topic.topic 이 비어 있거나 너무 짧습니다.');
    process.exit(4);
  }

  console.log(`\n✅ 리서치 완료`);
  console.log(`   토픽: ${topic.topic}`);
  console.log(`   소셜 검색: ${topic.social_searched ? '수행' : '미수행'}`);
  console.log(`   ${researchPath}`);
  console.log(`   ${strategyPath}`);
  console.log(`   ${topicPath}`);
  process.exit(0);
}

main();
