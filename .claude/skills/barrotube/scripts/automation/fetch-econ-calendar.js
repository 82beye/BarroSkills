#!/usr/bin/env node

/**
 * fetch-econ-calendar.js — 「오늘 주요 일정」 코너용 미국 경제지표 일정 (무과금·LLM 0회)
 *
 * 벤치마크(오선 「증시 요약」)는 423편 중 17%를 「M월 D일 주요 일정 살펴보겠습니다」로
 * 닫는다 — 시각·지표·중요도를 읽어 준다. 바로경제는 이 코너를 매일 둔다(한국 아침 시청자가
 * 그날 밤 미국 지표를 미리 알게). 그런데 이 데이터가 없었다(뉴스 RSS 뿐). ForexFactory 가 공개하는 주간 JSON 을 쓴다:
 *   https://nfs.faireconomy.media/ff_calendar_thisweek.json  (일~토, 시각은 ET 오프셋 포함)
 *
 * 산출: workspace/daily-news/<KST 날짜>/econ-calendar.json
 *   { date, window: {from,to}, events: [{ kst, title, title_ko, impact, forecast, previous }] }
 *
 * 창(window)은 「발행일 KST 09:00 ~ 다음날 08:59」 — 08:00 에 보는 시청자에게 그날 밤
 * 미국 세션에서 나올 지표가 곧 「오늘 일정」이다.
 *
 * Usage:
 *   node fetch-econ-calendar.js                 # 오늘(KST)
 *   node fetch-econ-calendar.js --date 2026-10-01
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

/** 자주 나오는 미국 일정의 한국어 이름. 없으면 원문을 쓴다. 긴 키부터 맞춘다. */
const TITLE_KO = [
  ['Core PCE Price Index', '근원 PCE 물가'],
  ['PCE Price Index', 'PCE 물가'],
  ['Core CPI', '근원 소비자물가(CPI)'],
  ['CPI', '소비자물가(CPI)'],
  ['Core PPI', '근원 생산자물가(PPI)'],
  ['PPI', '생산자물가(PPI)'],
  ['ADP Non-Farm Employment Change', 'ADP 민간고용'],
  ['Non-Farm Employment Change', '비농업 고용'],
  ['Unemployment Claims', '신규 실업수당 청구건수'],
  ['Unemployment Rate', '실업률'],
  ['Average Hourly Earnings', '평균 시간당 임금'],
  ['JOLTS Job Openings', 'JOLTS 구인건수'],
  ['Challenger Job Cuts', '챌린저 감원'],
  ['Employment Cost Index', '고용비용지수'],
  ['ISM Manufacturing Prices', 'ISM 제조업 가격지수'],
  ['ISM Manufacturing PMI', 'ISM 제조업 PMI'],
  ['ISM Services PMI', 'ISM 서비스업 PMI'],
  ['Manufacturing PMI', 'S&P 글로벌 제조업 PMI'],
  ['Services PMI', 'S&P 글로벌 서비스업 PMI'],
  ['Chicago PMI', '시카고 PMI'],
  ['Empire State Manufacturing Index', '뉴욕 엠파이어스테이트 제조업지수'],
  ['Philly Fed Manufacturing Index', '필라델피아 연은 제조업지수'],
  ['Core Retail Sales', '근원 소매판매'],
  ['Retail Sales', '소매판매'],
  ['CB Consumer Confidence', '컨퍼런스보드 소비자신뢰지수'],
  ['UoM Consumer Sentiment', '미시간대 소비자심리지수'],
  ['UoM Inflation Expectations', '미시간대 기대인플레이션'],
  ['Advance GDP Price Index', 'GDP 물가지수(속보)'],
  ['Advance GDP', 'GDP 성장률(속보)'],
  ['Prelim GDP', 'GDP 성장률(잠정)'],
  ['Final GDP Price Index', 'GDP 물가지수(확정)'],
  ['Final GDP', 'GDP 성장률(확정)'],
  ['Personal Income', '개인소득'],
  ['Personal Spending', '개인소비'],
  ['Core Durable Goods Orders', '근원 내구재 주문'],
  ['Durable Goods Orders', '내구재 주문'],
  ['Industrial Production', '산업생산'],
  ['Construction Spending', '건설지출'],
  ['Building Permits', '건축허가'],
  ['Housing Starts', '주택착공'],
  ['Existing Home Sales', '기존주택 판매'],
  ['New Home Sales', '신규주택 판매'],
  ['Pending Home Sales', '잠정주택 판매'],
  ['Goods Trade Balance', '상품수지'],
  ['Trade Balance', '무역수지'],
  ['Federal Funds Rate', '연준 기준금리 결정'],
  ['FOMC Statement', 'FOMC 성명'],
  ['FOMC Press Conference', 'FOMC 기자회견'],
  ['FOMC Meeting Minutes', 'FOMC 의사록'],
  ['Beige Book', '연준 베이지북'],
  ['Crude Oil Inventories', 'EIA 원유 재고'],
  ['Natural Gas Storage', '천연가스 재고'],
  ['10-y Bond Auction', '10년물 국채 입찰'],
  ['30-y Bond Auction', '30년물 국채 입찰'],
  ['Bank Holiday', '휴장'],
];

const FED_KO = {
  Warsh: '워시', Powell: '파월', Waller: '월러', Williams: '윌리엄스', Bowman: '보먼', Barr: '바',
  Cook: '쿡', Jefferson: '제퍼슨', Goolsbee: '굴스비', Musalem: '무살렘', Kashkari: '카시카리',
  Logan: '로건', Hammack: '해맥', Schmid: '슈미드', Collins: '콜린스', Barkin: '바킨', Daly: '데일리',
  Bostic: '보스틱', Harker: '하커', Miran: '마이런', Paulson: '폴슨', Kugler: '쿠글러',
};

export function titleKo(title) {
  const t = String(title || '');
  let m = t.match(/^Fed Chair (\w+) Speaks/);
  if (m) return `연준 의장 ${FED_KO[m[1]] || m[1]} 발언`;
  m = t.match(/^FOMC Member (\w+) Speaks/);
  if (m) return `연준 ${FED_KO[m[1]] || m[1]} 위원 발언`;
  m = t.match(/^President (\w+) Speaks/);
  if (m) return `${m[1] === 'Trump' ? '트럼프' : m[1]} 대통령 발언`;
  for (const [en, ko] of TITLE_KO) if (t.includes(en)) return ko;
  return t;
}

const kstParts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(d).map((p) => [p.type, p.value]));

/**
 * 발행일 KST 09:00 ~ 다음날 08:59 의 미국 일정. 중요도 Low 는 의장·대통령 발언만 남긴다.
 * 같은 시각·같은 한국어 이름은 하나로 합친다 (m/m·y/y 가 둘 다 오는 지표).
 */
export function pickEvents(feed, date) {
  const from = Date.parse(`${date}T09:00:00+09:00`);
  const to = from + 24 * 3600 * 1000;
  const seen = new Set();
  const out = [];
  for (const e of feed) {
    if (e.country !== 'USD') continue;
    const at = Date.parse(e.date);
    if (!Number.isFinite(at) || at < from || at >= to) continue;
    const ko = titleKo(e.title);
    const vip = /^(연준 의장|트럼프)/.test(ko) || ko === '휴장';
    if (e.impact === 'Low' && !vip) continue;
    if (e.impact === 'Holiday' || e.impact === 'Non-Economic') { if (!vip) continue; }
    const p = kstParts(new Date(at));
    const kst = `${p.hour}:${p.minute}`;
    const key = `${kst}|${ko}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at: new Date(at).toISOString(), kst, title: e.title, title_ko: ko, impact: e.impact, forecast: e.forecast || '', previous: e.previous || '' });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

async function main() {
  const { values } = parseArgs({ options: { date: { type: 'string' } } });
  const date = values.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  // 피드는 짧은 간격의 재요청을 429 로 막는다(2026-10-01 실측: 두 번째 호출부터 거절).
  // 원본을 캐시해 6시간 안에는 다시 부르지 않고, 실패하면 캐시로 대신한다.
  const cacheDir = join(ROOT, 'workspace', 'intel', 'econ-calendar');
  mkdirSync(cacheDir, { recursive: true });
  const feed = [];
  for (const url of FEEDS) {
    const cache = join(cacheDir, url.split('/').pop());
    const fresh = existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 6 * 3600 * 1000;
    if (!fresh) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 BarroTube/1.0' } });
        if (r.ok) writeFileSync(cache, JSON.stringify(await r.json()));
        else console.warn(`   ⚠ ${url.split('/').pop()} HTTP ${r.status} — 캐시를 쓴다`);
      } catch { /* 다음 주 피드는 주 후반에만 열린다 */ }
    }
    if (existsSync(cache)) feed.push(...JSON.parse(readFileSync(cache, 'utf-8')));
  }
  if (!feed.length) { console.error('❌ 경제 일정 피드를 받지 못했습니다'); process.exit(1); }
  const events = pickEvents(feed, date);
  const outDir = join(ROOT, 'workspace', 'daily-news', date);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'econ-calendar.json');
  writeFileSync(out, JSON.stringify({ date, window: 'KST 09:00 ~ 다음날 08:59', source: 'forexfactory', events }, null, 2));
  console.log(`📅 ${date} 미국 일정 ${events.length}건 → ${out}`);
  for (const e of events) console.log(`   ${e.kst} ${e.impact === 'High' ? '★★★' : '★★'} ${e.title_ko}${e.forecast ? ` (예상 ${e.forecast})` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
