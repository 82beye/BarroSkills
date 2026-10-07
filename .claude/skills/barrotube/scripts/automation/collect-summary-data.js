#!/usr/bin/env node

/**
 * collect-summary-data.js — 「미국 증시 요약」 한 편에 들어갈 숫자를 한 파일로 모은다 (LLM 0회).
 *
 * 대본(generate-summary-script.js)과 카드(render-summary-cards.js)가 같은 숫자를 읽어야
 * 화면과 내레이션이 어긋나지 않는다. 그래서 수집은 여기서 한 번만 한다.
 *
 * 입력:
 *   workspace/daily-news/<date>/market-us-close.json   (Phase 1 시세 스냅샷 — 지수·금리·원자재·환율·코인)
 *   workspace/daily-news/<date>/econ-calendar.json     (fetch-econ-calendar.js — 없으면 빈 일정)
 *   config/market-map.json us.sectors                  (미국 84종목 유니버스·시총 가중치)
 * 수집: Yahoo chart API 로 84종목 마감 등락 (market-map.js 와 같은 함수)
 * 산출: workspace/daily-news/<date>/summary-us.json
 *
 * Usage: node collect-summary-data.js [--date 2026-10-01]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { yahoo, mapPool } from './market-map.js';

const ROOT = resolve(import.meta.dirname, '../..');
const readJSON = (p, fb = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : fb);

const INDEX_SYMBOLS = ['.DJI', '.IXIC', '.INX'];
// 사상 최고치 판정용 야후 기호 (시세 스냅샷은 자체 기호를 쓴다)
const INDEX_HISTORY = { '.DJI': '^DJI', '.IXIC': '^IXIC', '.INX': '^GSPC' };
const MACRO = [
  ['BOND:US10YT=RR', '미 국채 10년물', (q) => `${q.price.toFixed(3)}%`],
  ['CMDT:CLcv1', 'WTI 유가', (q) => `$${q.price_text}`],
  ['CMDT:GCcv1', '금', (q) => `$${q.price_text}`],
  ['.DXY', '달러인덱스', (q) => q.price_text],
  ['FX_USDKRW', '원/달러', (q) => `${q.price_text}원`],
  ['COIN:bitcoin', '비트코인', (q) => `$${Math.round(q.price).toLocaleString('en-US')}`],
];

/** 뉴욕 현지 날짜·시각 → epoch ms (서머타임 자동). */
export function nyInstant(date, hour) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const nyHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(guess)));
  return guess + (((hour - nyHour) + 24) % 24) * 3600 * 1000;
}

/**
 * 시간외 등락 — 정규장 종가 대비 마감 뒤 4시간 안의 마지막 체결.
 * 실적은 대개 장 마감 뒤에 나온다. 2026-09-30 마이크론은 정규장 0.00% 였지만 그날의
 * 뉴스는 시간외 실적이었고, 벤치마크 제목도 「…마이크론 호실적 발표」였다.
 */
export function afterHoursFromChart(chart, session) {
  const ts = chart?.timestamp || []; const close = chart?.indicators?.quote?.[0]?.close || [];
  const end = nyInstant(session, 16) / 1000;
  let reg = null; let ah = null;
  for (let i = 0; i < ts.length; i++) {
    if (!Number.isFinite(close[i])) continue;
    if (ts[i] < end) reg = close[i];
    else if (ts[i] <= end + 4 * 3600) ah = close[i];
  }
  return reg && ah ? ((ah - reg) / reg) * 100 : null;
}

async function afterHours(symbol, session) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true`,
    { headers: { 'User-Agent': 'Mozilla/5.0 BarroTube/1.0' } });
  if (!r.ok) return null;
  return afterHoursFromChart((await r.json())?.chart?.result?.[0], session);
}

/** 섹터별 시총 가중 평균 등락. */
/**
 * 지수 종가가 사상 최고치인지, 며칠 연속인지 (2026-10-07).
 *
 * 그날 미국장의 사건이 「나스닥 2거래일 연속·S&P500 사상 최고치」였는데 요약 영상은 지수 등락률
 * (다우 +0.49%·나스닥 +0.45%)을 썸네일·첫 문장에 걸었다 — 기록이 데이터에 없고 리서치 문장 속에만
 * 있었기 때문이다. 그래서 기록을 결정론으로 세어 대본·제목·썸네일·카드가 먼저 말하게 한다.
 *
 * daily: [{date, close}] 최근 몇 년 일별. olderBound: 그 이전 월별 **장중 고가**의 최댓값 — 종가보다
 * 크거나 같으므로 오래된 기록을 놓칠 수는 있어도 없는 기록을 만들지는 않는다.
 * 마지막 일별 날짜가 session 이 아니면(휴장·지연) 판정하지 않는다(null).
 */
export function recordFromHistory(daily, olderBound, session) {
  const rows = (daily || []).filter((r) => Number.isFinite(r.close));
  if (!rows.length || rows.at(-1).date !== session) return null;
  let run = Number.isFinite(olderBound) ? olderBound : -Infinity;
  const rec = rows.map((r) => { const hit = r.close > run; run = Math.max(run, r.close); return hit; });
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rec[i]; i -= 1) streak += 1;
  const prior = Math.max(Number.isFinite(olderBound) ? olderBound : -Infinity, ...rows.slice(0, -1).map((r) => r.close));
  return { all_time_high: rec.at(-1), streak, prior_high: Math.round(prior * 100) / 100 };
}

/** 지수 기록 → 대본·제목·썸네일이 먼저 말할 사건 문구. */
export function recordEvents(indices) {
  return (indices || []).filter((i) => i.record?.all_time_high)
    .map((i) => `${i.name} 사상 최고치 마감${i.record.streak >= 2 ? ` (${i.record.streak}거래일 연속)` : ''}`);
}

export async function indexHistory(symbol) {
  const get = async (query) => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 BarroTube/1.0' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const d = (await r.json())?.chart?.result?.[0];
    const tz = d?.meta?.exchangeTimezoneName || 'America/New_York';
    const qq = d?.indicators?.quote?.[0] || {};
    return (d?.timestamp || []).map((t, i) => ({
      date: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t * 1000)), close: qq.close?.[i], high: qq.high?.[i],
    }));
  };
  // 야후는 range=max 에 일별을 주지 않는다(월별로 바꿔 준다) — 최근 5년 일별 + 그 이전 월별 고가.
  const daily = await get('range=5y&interval=1d');
  const monthly = await get('range=max&interval=1mo');
  const start = daily?.find((r) => Number.isFinite(r.close))?.date;
  if (!start || !monthly?.length) return null;
  const older = monthly.filter((m) => m.date <= start).map((m) => (Number.isFinite(m.high) ? m.high : m.close)).filter(Number.isFinite);
  return { daily, olderBound: older.length ? Math.max(...older) : null };
}

export function sectorAverages(stocks, weights) {
  const byT = new Map(stocks.map((s) => [s.t, s]));
  return Object.entries(weights).map(([sec, m]) => {
    let wsum = 0; let acc = 0;
    for (const [t, w] of Object.entries(m)) {
      const p = byT.get(t)?.pct;
      if (Number.isFinite(p)) { wsum += w; acc += w * p; }
    }
    return { sec, pct: wsum ? acc / wsum : null };
  }).filter((s) => s.pct !== null).sort((a, b) => b.pct - a.pct);
}

/** 상승·하락 상위. 같은 세션 값만 쓴다(휴장 종목의 직전 값이 섞이지 않게). */
export function topMovers(stocks, n = 4) {
  const live = stocks.filter((s) => Number.isFinite(s.pct));
  const up = [...live].sort((a, b) => b.pct - a.pct).slice(0, n).filter((s) => s.pct > 0);
  const down = [...live].sort((a, b) => a.pct - b.pct).slice(0, n).filter((s) => s.pct < 0);
  return { up, down };
}

async function main() {
  const { values } = parseArgs({ options: { date: { type: 'string' } } });
  const date = values.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const dir = join(ROOT, 'workspace', 'daily-news', date);
  const market = readJSON(join(dir, 'market-us-close.json'));
  if (!market?.quotes?.length) { console.error(`❌ 시세 스냅샷 없음: ${join(dir, 'market-us-close.json')}`); process.exit(1); }
  const q = Object.fromEntries(market.quotes.map((x) => [x.symbol, x]));

  const cfg = readJSON(join(ROOT, 'config', 'market-map.json'));
  const names = readJSON(join(ROOT, 'config', 'market-summary.json'))?.names_ko || {};
  const weights = cfg.us.sectors;
  const universe = Object.entries(weights).flatMap(([sec, m]) => Object.keys(m).map((t) => ({ t, sec })));
  const quotes = await mapPool(universe, 8, ({ t }) => yahoo(t));
  const sessions = quotes.filter(Boolean).map((x) => x.sessionDate).filter(Boolean);
  // 가장 많은 종목이 가리키는 세션이 이번 마감이다.
  const session = sessions.sort((a, b) => sessions.filter((v) => v === b).length - sessions.filter((v) => v === a).length)[0] || null;
  const ahs = session ? await mapPool(universe, 8, ({ t }) => afterHours(t, session)) : [];
  const stocks = universe.map((u, i) => {
    const x = quotes[i];
    const pct = x && x.sessionDate === session ? x.pct : null;
    const ah = Number.isFinite(ahs[i]) ? Math.round(ahs[i] * 100) / 100 : null;
    return { ...u, name: names[u.t] || u.t, price: x?.price ?? null, pct, ah_pct: ah };
  });

  const indices = INDEX_SYMBOLS.filter((s) => q[s])
    .map((s) => ({ sym: s, name: q[s].name, price_text: q[s].price_text, change_pct: q[s].change_pct }));
  // 사상 최고치·연속 기록. 이력을 못 받으면 그 지수는 판정 없이 간다(기록이 없는 날과 같게).
  const histories = session ? await mapPool(indices, 3, (i) => indexHistory(INDEX_HISTORY[i.sym])) : [];
  indices.forEach((i, k) => {
    const h = histories[k];
    const r = h ? recordFromHistory(h.daily, h.olderBound, session) : null;
    if (r) i.record = r;
    delete i.sym;
  });
  const macro = MACRO.map(([s, name, fmt]) => q[s] && ({ name, value: fmt(q[s]), pct: q[s].change_pct })).filter(Boolean);
  const calendar = readJSON(join(dir, 'econ-calendar.json'), { events: [] });

  const out = {
    date, us_session: session, stale: !!market.stale, content_mode: market.content_mode,
    indices, events: recordEvents(indices), macro, stocks, sectors: sectorAverages(stocks, weights), movers: topMovers(stocks),
    after_hours: stocks.filter((s) => Math.abs(s.ah_pct ?? 0) >= 2).sort((a, b) => Math.abs(b.ah_pct) - Math.abs(a.ah_pct)).slice(0, 5),
    calendar: calendar.events || [],
    missing: stocks.filter((s) => s.pct === null).map((s) => s.t),
  };
  const path = join(dir, 'summary-us.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`📦 요약 데이터 ${date} (미국 세션 ${session}) — 종목 ${stocks.length - out.missing.length}/${stocks.length} · 일정 ${out.calendar.length}건`);
  console.log(`   지수: ${indices.map((i) => `${i.name} ${i.change_pct > 0 ? '+' : ''}${i.change_pct}%`).join(' · ')}`);
  console.log(`   기록: ${out.events.length ? out.events.join(' · ') : '없음'}`);
  console.log(`   상승: ${out.movers.up.map((m) => `${m.name} ${m.pct.toFixed(1)}%`).join(', ')}`);
  console.log(`   하락: ${out.movers.down.map((m) => `${m.name} ${m.pct.toFixed(1)}%`).join(', ')}`);
  console.log(`   ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
