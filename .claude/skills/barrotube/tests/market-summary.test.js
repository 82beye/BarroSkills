import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { titleKo, pickEvents } from '../scripts/automation/fetch-econ-calendar.js';
import { nyInstant, afterHoursFromChart, sectorAverages, topMovers, recordFromHistory, recordEvents } from '../scripts/automation/collect-summary-data.js';
import { indicesCard } from '../scripts/automation/lib/summary-cards.js';
import { cardTopic } from '../scripts/automation/generate-cards.js';
import { checkSummary, normalizeSeconds, paletteFitsSlot, firstJsonObject, retryPrompt } from '../scripts/automation/generate-summary-script.js';
import { splitPicks } from '../scripts/automation/summary-assets.js';
import { summaryTitle } from '../scripts/automation/lib/summary-title.js';
import { cardHTML, sessionLabel } from '../scripts/automation/render-summary-cards.js';
import { planGrokScenes, DEFAULTS } from '../scripts/automation/lib/grok-budget.js';
import { validateScript } from '../scripts/automation/lib/script-quality-contract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'market-summary.json'), 'utf8'));

// 실제 요약 대본(EP-2026-0203)이 낸 범용 컷 — 계약을 통과한 형태 그대로.
const PROMPT = '[palette:explainer] 마시 the 바로경제 mascot (official character sheet for the character only — large round head on a slim capsule body with thin stick limbs, white mitten hands and rounded shoe-feet, big solid black eyes with white highlights, orange (#FF9A1F) blush cheeks, no nose or ears), wary and thoughtful, crouching beside a single steep staircase of stacked bond certificates in the centre, face readable, one white mitten hand on its chin while the other points up the steps, the unified staircase of certificates climbing higher with every step. BACKGROUND: deep navy abstract trading hall, amber accent on the topmost step, faint grid texture at low contrast, bold illustrated line art, 9:16 vertical, no readable text or numbers.';

function validOut() {
  const scenes = CFG.scenes.map((s, i) => ({
    role: s.role,
    narration: i === 0 ? '구월 삼십일 수요일 미국 증시 요약입니다. 다우는 내렸고 나스닥은 올랐습니다.'
      : i === CFG.scenes.length - 1 ? `오늘 주요 일정 살펴보겠습니다. ${CFG.cta} ${CFG.disclaimer}` : '설명입니다.',
    subtitle_text: '요약',
    target_seconds: s.target_seconds,
    ...(s.card ? { card: { type: s.card } } : { slot: 'rates/neutral', image_prompt: PROMPT }),
  }));
  return { title_hook: '물가는 좋았는데 금리가 덮었다', scenes };
}

test('정본 설정: 세로 쇼츠 · 카드는 씬 1 지수 한 장 · 180초 이하', () => {
  assert.equal(CFG.platform, 'shorts');
  assert.equal(CFG.format, 'shorts-3min');
  assert.deepEqual(CFG.scenes.filter((s) => s.card).map((s) => s.card), ['indices']);
  assert.equal(CFG.scenes[0].card, 'indices');
  assert.equal(CFG.scenes.reduce((n, s) => n + s.target_seconds, 0), CFG.target_total_seconds);
  // 인트로 2초 + 패드 1초 + 엔드카드 2.5초를 더해도 쇼츠 상한 180초 안이어야 한다.
  assert.ok(CFG.target_total_seconds + 5.5 <= 180);
});

test('경제 일정: 발행일 09:00~다음날 08:59 KST · Low 는 의장·대통령만 · 같은 시각 같은 지표는 하나', () => {
  const feed = [
    { country: 'USD', date: '2026-10-01T08:30:00-04:00', impact: 'Medium', title: 'Unemployment Claims', forecast: '201K' },
    { country: 'USD', date: '2026-10-01T10:00:00-04:00', impact: 'Low', title: 'Construction Spending m/m' },
    { country: 'USD', date: '2026-10-01T10:00:00-04:00', impact: 'Medium', title: 'FOMC Member Waller Speaks' },
    { country: 'USD', date: '2026-10-02T08:30:00-04:00', impact: 'High', title: 'CPI m/m' },
    { country: 'USD', date: '2026-10-02T08:30:00-04:00', impact: 'High', title: 'CPI y/y' },
    { country: 'EUR', date: '2026-10-01T08:30:00-04:00', impact: 'High', title: 'CPI' },
    { country: 'USD', date: '2026-09-30T20:00:00-04:00', impact: 'High', title: 'Fed Chair Warsh Speaks' },
  ];
  const a = pickEvents(feed, '2026-10-01');
  assert.deepEqual(a.map((e) => `${e.kst} ${e.title_ko}`), ['09:00 연준 의장 워시 발언', '21:30 신규 실업수당 청구건수', '23:00 연준 월러 위원 발언']);
  const b = pickEvents(feed, '2026-10-02');
  assert.equal(b.filter((e) => e.title_ko === '소비자물가(CPI)').length, 1);
  assert.equal(titleKo('Core PCE Price Index m/m'), '근원 PCE 물가');
  assert.equal(titleKo('President Trump Speaks'), '트럼프 대통령 발언');
});

test('시간외 등락: 서머타임을 따라 16:00 ET 이후 4시간의 마지막 체결', () => {
  assert.equal(new Date(nyInstant('2026-09-30', 16)).toISOString(), '2026-09-30T20:00:00.000Z'); // EDT
  assert.equal(new Date(nyInstant('2026-12-01', 16)).toISOString(), '2026-12-01T21:00:00.000Z'); // EST
  const end = nyInstant('2026-09-30', 16) / 1000;
  const chart = { timestamp: [end - 300, end + 600, end + 3600, end + 5 * 3600], indicators: { quote: [{ close: [100, 105, 110, 200] }] } };
  assert.equal(Math.round(afterHoursFromChart(chart, '2026-09-30')), 10);
  assert.equal(afterHoursFromChart({ timestamp: [end - 300], indicators: { quote: [{ close: [100] }] } }, '2026-09-30'), null);
});

test('섹터 평균은 시총 가중 · 상승/하락 상위는 부호를 지킨다', () => {
  const stocks = [{ t: 'A', pct: 2 }, { t: 'B', pct: -1 }, { t: 'C', pct: null }, { t: 'D', pct: -3 }];
  const avg = sectorAverages(stocks, { 반도체: { A: 3, B: 1, C: 5 }, 금융: { D: 1 } });
  assert.deepEqual(avg.map((s) => [s.sec, s.pct]), [['반도체', 1.25], ['금융', -3]]);
  const m = topMovers(stocks, 2);
  assert.deepEqual(m.up.map((s) => s.t), ['A']);
  assert.deepEqual(m.down.map((s) => s.t), ['D', 'B']);
});

test('요약 대본 계약: 통과 형태 · 카드 자리 · TTS 숫자 · 팔레트/슬롯 · 고유명 · 면책', () => {
  assert.deepEqual(checkSummary(validOut()), []);

  const card = validOut(); card.scenes[2].card = { type: 'indices' };
  assert.ok(checkSummary(card).some((p) => p.includes('card 를 넣지 마라')));

  const digits = validOut(); digits.scenes[1].narration = '금리가 5.3% 입니다.';
  assert.ok(checkSummary(digits).some((p) => p.includes('아라비아 숫자')));

  const pal = validOut(); pal.scenes[1].slot = 'rates/up';
  assert.ok(checkSummary(pal).some((p) => p.includes('팔레트')));

  const proper = validOut(); proper.scenes[3].image_prompt = PROMPT.replace('bond certificates', 'Nvidia chips');
  assert.ok(checkSummary(proper).some((p) => p.includes('고유명')));

  const noDisc = validOut(); noDisc.scenes.at(-1).narration = '끝입니다.';
  assert.ok(checkSummary(noDisc).some((p) => p.includes('면책')));
  assert.ok(checkSummary(noDisc).some((p) => p.includes('팔로우')));

  const hook = validOut(); hook.title_hook = '[속보] 금리';
  assert.ok(checkSummary(hook).some((p) => p.includes('괄호')));
});

test('팔레트는 슬롯 방향을 따른다', () => {
  assert.ok(paletteFitsSlot('[palette:bullish] x', 'semis/up'));
  assert.ok(paletteFitsSlot('[palette:wealth] x', 'index/up'));
  assert.ok(paletteFitsSlot('[palette:bearish] x', 'energy/down'));
  assert.ok(paletteFitsSlot('[palette:cta] x', 'cta/generic'));
  assert.ok(!paletteFitsSlot('[palette:bullish] x', 'rates/down'));
  assert.ok(!paletteFitsSlot('no tag', 'rates/down'));
});

test('target_seconds 합은 포맷 목표로 맞춘다', () => {
  const s = normalizeSeconds([{ target_seconds: 20 }, { target_seconds: 30 }, { target_seconds: 31 }], 165);
  assert.equal(s.reduce((n, x) => n + x.target_seconds, 0), 165);
});

test('요약 대본 재작성은 직전 응답을 함께 준다 — 지적된 곳만 고치게', () => {
  // 2026-10-06 EP-2026-0212: 위반 목록만 주자 모델이 매번 새로 써서 시도마다 다른 위반이 났다.
  const prev = { title_hook: '훅', scenes: [{ role: 'open', narration: '가' }] };
  const p = retryPrompt('BASE', ['씬 6 수치 7개 (상한 6)'], prev);
  assert.ok(p.startsWith('BASE'));
  assert.match(p, /씬 6 수치 7개/);
  assert.ok(p.includes(JSON.stringify(prev)), '직전 응답이 프롬프트에 있어야 한다');
  // JSON 이 깨져 직전 응답이 없으면 위반 목록만 준다
  assert.doesNotMatch(retryPrompt('BASE', ['JSON 파싱 실패'], null), /직전 응답 —/);
});

test('JSON 뒤에 덧붙은 설명은 버린다', () => {
  assert.deepEqual(JSON.parse(firstJsonObject('앞말 {"a":"}{","b":{"c":1}} 뒷말 {"z":2}')), { a: '}{', b: { c: 1 } });
});

test('라이브러리 재사용: 약한 매칭·완주용 배정은 비워 새로 굽는다', () => {
  const { keep, gaps } = splitPicks([
    { sceneId: '002', weak: false }, { sceneId: '003', weak: true },
    { sceneId: '004', weak: false, filled_generic: true }, { sceneId: '005' },
  ]);
  assert.deepEqual(keep, ['002', '005']);
  assert.deepEqual(gaps, ['003', '004']);
});

test('제목은 시리즈 틀 + 미국 장 날짜', () => {
  assert.equal(summaryTitle(CFG.title.template, '물가는 좋았는데 금리가 덮었다', '2026-09-30'),
    '【미국 증시 요약】 물가는 좋았는데 금리가 덮었다 | 26.09.30(수) #Shorts');
  assert.equal(sessionLabel('2026-09-30'), '미국 2026.09.30 (수) 마감');
});

test('카드는 지수 요약 하나뿐이다', () => {
  const data = { us_session: '2026-09-30', indices: [{ name: '다우존스', price_text: '50,906.05', change_pct: -0.86 }] };
  assert.match(cardHTML({ type: 'indices' }, data), /다우존스[\s\S]*-0\.86%/);
  assert.equal(cardHTML({ type: 'heatmap' }, data), null);
});

test('Grok 은 카드 씬을 고르지 않고, 카드 씬은 로컬 모션으로 간다', () => {
  const scenes = [{ id: '001', role: 'open', card: true }, { id: '002', role: 'driver' }, { id: '003', role: 'sectors' }, { id: '004', role: 'movers' }];
  const p = planGrokScenes({ scenes, episode: 'EP-T', ledger: { submissions: [] }, budget: DEFAULTS, now: new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(p.grok, ['002', '004']);
  assert.ok(p.local.includes('001'));
});

test('요약 대본은 수치가 내용이라 쇼츠 상한 대신 요약 상한을 쓴다', () => {
  const nums = '영 점 팔 육 퍼센트, 영 점 이 사 퍼센트, 영 점 이 오 퍼센트, 오 점 이 퍼센트';
  const shorts = [{ scene_id: '001', role: 'context', narration: nums, target_seconds: 20 }];
  assert.ok(validateScript(shorts).some((i) => i.rule === 'spoken-number-budget'));
  const summary = [{ ...shorts[0], card: { type: 'indices' } }];
  assert.ok(!validateScript(summary).some((i) => i.rule === 'spoken-number-budget'));
});

test('지수 사상 최고치·연속 기록을 일별 종가로 센다 — 오래된 구간은 장중 고가 상한으로 보수적으로', () => {
  // 2026-10-06 미국장 실측: 나스닥 2거래일 연속·S&P500 사상 최고치, 다우는 아님.
  const day = (date, close) => ({ date, close });
  // 9월에 더 높은 종가가 있어 10-01·10-02 는 기록이 아니다 — 연속은 10-05·10-06 두 날.
  const nasdaq = [day('2026-09-25', 27300), day('2026-10-01', 26872), day('2026-10-02', 27190.86), day('2026-10-05', 27477.31), day('2026-10-06', 27599.89)];
  assert.deepEqual(recordFromHistory(nasdaq, 26800, '2026-10-06'), { all_time_high: true, streak: 2, prior_high: 27477.31 });
  const spx = [day('2026-09-25', 7798.99), day('2026-10-02', 7723), day('2026-10-05', 7774), day('2026-10-06', 7818.93)];
  assert.deepEqual(recordFromHistory(spx, 7000, '2026-10-06'), { all_time_high: true, streak: 1, prior_high: 7798.99 }, '10-05 는 기록이 아니어서 연속은 1');
  const dow = [day('2026-09-20', 54349.12), day('2026-10-06', 51521.28)];
  assert.equal(recordFromHistory(dow, 40000, '2026-10-06').all_time_high, false);
  assert.equal(recordFromHistory(spx, 7900, '2026-10-06').all_time_high, false, '예전 장중 고가 상한을 못 넘으면 기록이라 하지 않는다');
  assert.equal(recordFromHistory(spx, 7000, '2026-10-07'), null, '마지막 날이 세션이 아니면 판정하지 않는다');
  const idx = [{ name: '다우존스', record: { all_time_high: false, streak: 0 } }, { name: '나스닥', record: { all_time_high: true, streak: 2 } },
    { name: 'S&P 500', record: { all_time_high: true, streak: 1 } }, { name: '기록 없음' }];
  assert.deepEqual(recordEvents(idx), ['나스닥 사상 최고치 마감 (2거래일 연속)', 'S&P 500 사상 최고치 마감']);
});

test('기록이 있는 날은 씬 1 두 번째 문장과 제목 훅이 기록을 먼저 말한다', () => {
  // 2026-10-07 EP-2026-0214: 씬 1 이 지수 등락률부터 읽고 신고가는 세 번째 문장, 나스닥 기록은 빠졌다.
  const events = ['나스닥 사상 최고치 마감 (2거래일 연속)', 'S&P 500 사상 최고치 마감'];
  const plain = validOut();
  const p1 = checkSummary(plain, null, events);
  assert.ok(p1.some((p) => p.includes('씬 1 은 「…요약입니다.」 바로 다음 문장에서 오늘의 기록')), '등락률로 열면 되돌린다');
  assert.ok(p1.some((p) => p.includes('title_hook 은 오늘의 기록을 이름으로')));
  assert.deepEqual(checkSummary(plain), [], '기록이 없는 날은 예전과 같다');
  const led = validOut();
  led.scenes[0].narration = '시월 육일 화요일 미국 증시 요약입니다. 나스닥이 이틀 연속, 에스앤피 오백이 사상 최고치로 마감했습니다. 다우도 올랐습니다.';
  led.title_hook = '나스닥·S&P500 나란히 사상 최고치';
  assert.deepEqual(checkSummary(led, null, events), []);
  const late = validOut();
  late.scenes[0].narration = '시월 육일 화요일 미국 증시 요약입니다. 다우와 나스닥이 올랐습니다. 에스앤피 오백은 사상 최고치로 마감했습니다.';
  late.title_hook = '나스닥·S&P500 나란히 사상 최고치';
  assert.ok(checkSummary(late, null, events).some((p) => p.includes('바로 다음 문장')), '세 번째 문장에 묻히면 안 된다');
});

test('기록은 데이터·지시문·카드·썸네일까지 이어진다 — 썸네일 헤드라인은 지수 등락률이 아니라 제목 훅', () => {
  const gen = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-summary-script.js'), 'utf8');
  assert.match(gen, /오늘의_기록: data\.events\?\.length \? data\.events : '\(없음\)'/, '대본 작가가 기록을 데이터로 받는다');
  assert.match(gen, /전날 한국장\(코스피·외국인 수급\)을 주제나 비교 축으로 끌어오지 마라/, '새벽 미국장 영상의 주제는 미국장');
  assert.match(gen, /thumbnail: \{ headline_text: out\.title_hook \}/);
  const thumb = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-thumbnail.js'), 'utf8');
  assert.match(thumb, /headline_text: briefThumb\.headline_text \|\| scriptThumb\.headline_text \|\|/, '대본이 정한 헤드라인이 첫 씬 자막 파생보다 먼저');
  const card = indicesCard({ items: [
    { name: '나스닥', price_text: '27,599.79', change_pct: 0.45, record: { all_time_high: true, streak: 2 } },
    { name: '다우존스', price_text: '51,521.28', change_pct: 0.49, record: { all_time_high: false, streak: 0 } },
  ], dateLabel: '미국 2026.10.06 (화) 마감' });
  assert.match(card, /사상 최고 · 2일 연속/);
  assert.equal((card.match(/사상 최고/g) || []).length, 1, '기록이 아닌 지수에는 배지가 없다');
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'market-summary.json'), 'utf8'));
  assert.match(cfg.scenes[0].intent, /오늘의_기록/);
});

test('요약 포맷 인트로 카드는 브리프의 한·미 대비 토픽이 아니라 대본이 정한 그날의 사건으로 쓴다', () => {
  // 2026-10-07 EP-2026-0214 인트로: 「S&P 사상 최고치인데 외국인은 1조 7,661억 원 던졌다」 — 전날 한국장이 섞였다.
  const brief = { topic: '…서울은 외국인 1조 7,661억 원 순매도를 먼저 맞았고, …S&P500이 사상 최고치로 마감했다' };
  const summary = { form: 'market-summary', title_hook: '나스닥·S&P500 나란히 사상 최고치', events: ['나스닥 사상 최고치 마감 (2거래일 연속)', 'S&P 500 사상 최고치 마감'] };
  assert.equal(cardTopic(summary, brief), '나스닥·S&P500 나란히 사상 최고치 · 나스닥 사상 최고치 마감 (2거래일 연속) · S&P 500 사상 최고치 마감');
  assert.equal(cardTopic({ form: 'shorts', topic: 'x' }, brief), brief.topic, '다른 포맷은 예전처럼 브리프 토픽');
});
