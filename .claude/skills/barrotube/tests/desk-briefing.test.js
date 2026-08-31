import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildDeskPrompt, quoteTable, socialBlock } from '../scripts/automation/desk-briefing.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const json = (p) => JSON.parse(read(p));

const DESKS = json('config/desk-reporters.json');
const ROUTINES = json('config/routines.json');
const SNAPSHOT_SRC = read('scripts/automation/fetch-market-snapshot.js');

test('데스크 설정에 빈 칸이 없다', () => {
  const ids = DESKS.reporters.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'desk id 가 중복되면 리포트 파일이 덮어써진다');
  for (const r of DESKS.reporters) {
    for (const f of ['id', 'label', 'beat', 'question']) {
      assert.ok(r[f], `${r.id}: ${f} 가 비었다`);
    }
    assert.ok(Array.isArray(r.symbols), `${r.id}: symbols 는 배열이어야 한다(지정학처럼 빈 배열은 정상)`);
    assert.ok(r.search_hints?.length, `${r.id}: search_hints 가 없으면 데스크가 검색어부터 헤맨다`);
  }
  assert.ok(DESKS.editor?.selection_criteria?.length, '에디터 선정 기준이 없다');
  assert.ok(DESKS.editor?.reject?.length, '에디터가 무엇을 버릴지 없다');
});

test('데스크가 맡은 심볼은 모든 슬롯이 실제로 수집한다', () => {
  // 2026-08-25 실측: 원자재 데스크가 구리·천연가스를 담당한다고 선언돼 있는데 슬롯이
  // 그 심볼을 안 가져와서, 리포트에 "스냅샷 값이 제공되지 않아 판단하지 못했다" 가 찍혔다.
  // 설정 두 곳이 갈라지면 데스크는 매일 조용히 반쪽짜리가 된다.
  // 2026-08-30: 데스크 세트가 둘이 됐다(market / realestate). 슬롯은 자기 세트의 심볼만
  // 가져오면 된다 — 부동산 슬롯에 나스닥을 요구하면 그게 오히려 오설정이다.
  for (const [slot, v] of Object.entries(ROUTINES.slots)) {
    const deskSet = v.desk_set || 'market';
    const need = new Set(DESKS.reporters
      .filter((r) => (r.desk_set || 'market') === deskSet)
      .flatMap((r) => r.symbols || []));
    const have = new Set(v.market?.symbols || []);
    const missing = [...need].filter((s) => !have.has(s));
    assert.deepEqual(missing, [], `${slot}(desk_set=${deskSet}) 슬롯이 안 가져오는 데스크 심볼: ${missing.join(', ')}`);
  }
});

test('모든 심볼은 수집기가 아는 형태다', () => {
  // family() 가 null 을 주면 그 심볼은 조용히 error 로 떨어지고 데스크 표에서 사라진다.
  const known = /^(KOSPI|KOSDAQ)$|^FX_|^\.|^CMDT:|^BOND:|^COIN:|^RE:/;
  for (const r of DESKS.reporters) {
    for (const sym of r.symbols || []) {
      assert.match(sym, known, `${r.id}: fetch-market-snapshot 이 모르는 심볼 형태 "${sym}"`);
      // DISPLAY 표는 키를 따옴표 없이(KOSPI:) 쓰기도 하고 따옴표로('CMDT:GCcv1':) 쓰기도 한다.
      const inDisplay = SNAPSHOT_SRC.includes(`'${sym}':`) || SNAPSHOT_SRC.includes(`${sym}:`);
      assert.ok(inDisplay, `${sym}: DISPLAY 표에 한글 이름이 없다 — 데스크 표에 이름 없이 찍힌다`);
    }
  }
});

test('죽은 소셜 채널을 프롬프트에 박아 두지 않는다', () => {
  // twitter-cli 는 미인증이라 항상 실패한다. 예전 프롬프트가 `twitter search` 를
  // 하드코딩해서 6개 데스크가 저마다 실패하는 데 턴을 썼다 (2026-08-25).
  const src = read('scripts/automation/desk-briefing.js');
  assert.match(src, /agent-reach', \['doctor', '--json'\]/, '가용 채널을 런타임에 조회해야 한다');

  // 소스 주석에는 사고 경위로 twitter 가 나온다. 진짜 불변식은 **프롬프트**에 죽은 채널
  // 명령이 실리지 않는 것이므로, 실제로 조립된 프롬프트를 본다.
  const prompt = buildDeskPrompt({
    reporter: DESKS.reporters[0], slot: { label: 'x' }, date: '2026-08-25',
    snapshot: { quotes: [] }, outDir: '/tmp', newsPath: '/tmp/n.json', competitorPath: '/tmp/c.json',
    social: socialBlock({ available: true, ok: [{ id: 'reddit', backend: 'rdt-cli' }], dead: [{ id: 'twitter' }] }),
  });
  assert.ok(!/twitter\s+search/.test(prompt), '죽은 CLI 명령을 프롬프트에 박으면 데스크가 헛턴을 쓴다');
});

test('소셜 블록은 붙는 채널만 알려 주고 죽은 채널은 금지한다', () => {
  const block = socialBlock({
    available: true,
    ok: [{ id: 'reddit', backend: 'rdt-cli' }, { id: 'exa_search', backend: 'Exa' }],
    dead: [{ id: 'twitter' }, { id: 'instagram' }],
  });
  assert.match(block, /reddit\(rdt-cli\)/);
  assert.match(block, /시도 자체를 하지 마라.*twitter/s, '미인증 채널은 명시적으로 막아야 한다');
  assert.match(block, /재시도하지 말고/, '한 번 실패하면 WebSearch 로 넘어가야 턴을 안 태운다');

  const none = socialBlock({ available: false, ok: [], dead: [] });
  assert.match(none, /WebSearch 로만/, '채널이 없으면 검색만 쓰게 해야 한다');
  assert.ok(!/시도 자체를/.test(none));
});

test('시세 표는 스냅샷에 있는 값만 보여 준다', () => {
  const snap = { quotes: [
    { symbol: 'CMDT:GCcv1', name: '국제 금', price_text: '4,720.80', change_pct: 0.49 },
    { symbol: 'BOND:US10YT=RR', name: '미국 국채 10년', price_text: '4.7000', change_pct: -0.8, unit: 'percent' },
    { symbol: 'COIN:bitcoin', name: '비트코인', price: 78683, change_pct: 1.58, basis: '24h' },
    { symbol: '.IXIC', name: '나스닥', price_text: '25,980.19', change_pct: -0.77 },
  ] };
  const t = quoteTable(snap, ['CMDT:GCcv1', 'BOND:US10YT=RR', 'COIN:bitcoin']);
  assert.match(t, /국제 금: 4,720\.80 \(\+0\.49%\)/);
  assert.match(t, /미국 국채 10년: 4\.7000% \(-0\.8%\)/, '국채는 가격이 아니라 금리(%)다');
  assert.match(t, /비트코인: 78683 \(\+1\.58%\) \[24시간 기준\]/, '코인은 기준이 달라 표시해야 한다');
  assert.ok(!/나스닥/.test(t), '배정 안 된 심볼은 이 데스크 표에 나오면 안 된다');

  assert.match(quoteTable(snap, []), /배정된 시세 없음/, '지정학 데스크는 시세가 없다');
});

test('데스크 프롬프트에 지어내기 금지와 출처 의무가 들어간다', () => {
  const prompt = buildDeskPrompt({
    reporter: DESKS.reporters.find((r) => r.id === 'commodities'),
    slot: { label: '미국 증시 마감 브리핑' },
    date: '2026-08-25',
    snapshot: { quotes: [] },
    outDir: '/tmp/out',
    newsPath: '/tmp/out/news.json',
    competitorPath: '/tmp/intel/analysis-2026-08-25.json',
    social: socialBlock({ available: false, ok: [], dead: [] }),
  });
  assert.match(prompt, /출처 URL/, '수치에 출처를 붙이게 해야 팩트체크가 산다');
  assert.match(prompt, /지어내지 마라/);
  assert.match(prompt, /heat/, '에디터가 고를 수 있게 heat 를 받아야 한다');
  assert.match(prompt, /analysis-2026-08-25\.json/, '경쟁 인텔은 폴더가 아니라 파일을 가리켜야 한다');
  assert.match(prompt, /WebSearch 로만/, '소셜 블록이 프롬프트에 실려야 한다');
});

test('데스크 산출물이 대본·팩트체크까지 닿는다', () => {
  // 브리핑을 만들어 놓고 에피소드로 넘기지 않으면 출처 URL 이 요약 단계에서 증발한다.
  const pipeline = read('lib/auto-pipeline.sh');
  assert.match(pipeline, /desk-briefing\.js --slot/, 'Phase 2a 가 파이프라인에 걸려 있어야 한다');
  assert.match(pipeline, /cp "\$DESK_BRIEF_MD" "\$\{EP_DIR\}\/05_desk_briefing\.md"/, '에피소드로 설치해야 한다');

  // set -u 라 RESUME·FORCE_TOPIC 경로(= Phase 2 를 건너뛰는 경로)에서도 정의돼 있어야 한다.
  const defIdx = pipeline.indexOf('DESK_BRIEF_MD="${NEWS_DIR}');
  const useIdx = pipeline.indexOf('[ -s "$DESK_BRIEF_MD" ]');
  assert.ok(defIdx > 0 && defIdx < useIdx, 'DESK_BRIEF_MD 는 Phase 3 사용 지점보다 앞에서 정의돼야 한다');
  assert.ok(!/^\s{2}DESK_BRIEF_MD=/m.test(pipeline), 'Phase 2 블록 안쪽(들여쓰기) 정의가 남아 있으면 RESUME 에서 unbound 로 죽는다');

  assert.match(read('scripts/automation/generate-script.js'), /05_desk_briefing\.md/, '대본이 근거를 봐야 한다');
  assert.match(read('scripts/automation/run-factcheck.js'), /05_desk_briefing\.md/, '팩트체크가 출처를 봐야 한다');
});

test('날짜 기본값이 스크립트마다 갈리지 않는다', () => {
  // us-close 슬롯은 06:00 KST 다. toISOString() 은 UTC 라 그 시간대에 하루 전 폴더를
  // 가리키고, desk-briefing 은 KST 를 쓴다 — 손으로 돌리면 산출물이 두 폴더로 갈렸다.
  for (const f of ['fetch-market-snapshot.js', 'fetch-daily-news.js', 'research-brief.js', 'desk-briefing.js']) {
    const src = read(`scripts/automation/${f}`);
    assert.match(src, /toLocaleDateString\('sv-SE', \{ timeZone: 'Asia\/Seoul' \}\)/,
      `${f}: 날짜 기본값이 KST 가 아니다`);
    assert.ok(!/values\.date \|\| new Date\(\)\.toISOString\(\)/.test(src),
      `${f}: UTC 기본값이 남아 있다`);
  }
});

test('데스크는 사용자가 요구한 자산군을 빠짐없이 덮는다', () => {
  const beats = DESKS.reporters.map((r) => `${r.label} ${r.beat}`).join(' ');
  for (const asset of ['다우', '나스닥', '국채', '금', '은', '비트코인']) {
    assert.ok(beats.includes(asset), `어느 데스크도 ${asset} 를 담당하지 않는다`);
  }
  assert.ok(/WTI|유가|원유/.test(beats), '유가를 담당하는 데스크가 없다');
  const geo = DESKS.reporters.find((r) => r.id === 'geopolitics');
  assert.ok(/전쟁|분쟁/.test(geo.beat), '전쟁·분쟁이 자산에 미치는 경로를 볼 데스크가 없다');
});

test('오늘 실제로 데스크 산출물이 나왔다면 규격을 지킨다', () => {
  const dir = join(ROOT, 'workspace', 'daily-news');
  if (!existsSync(dir)) return;                       // workspace 심볼릭이 없는 머신
  const files = [];
  for (const d of ['2026-08-25']) {
    const md = join(dir, d, 'desk-commodities.md');
    if (existsSync(md)) files.push(md);
  }
  for (const f of files) {
    const md = readFileSync(f, 'utf-8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${f}: frontmatter 가 없으면 heat 를 못 읽어 에디터가 순위를 못 매긴다`);
    assert.match(fm[1], /heat:\s*\d+/, `${f}: heat 가 숫자가 아니다`);
    assert.match(fm[1], /headline:\s*\S/, `${f}: headline 이 비었다`);
  }
});
