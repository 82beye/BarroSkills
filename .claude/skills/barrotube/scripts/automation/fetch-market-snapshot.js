#!/usr/bin/env node
/**
 * 시세 스냅샷 — 네이버 증권에서 지수·환율 종가와 등락률을 수집한다.
 *
 * 왜 필요한가: fetch-daily-news.js 는 RSS 헤드라인만 가져온다. "증시 브리핑"인데
 * "코스피 몇 포인트, 몇 % 마감" 을 쓸 수 없으면 콘텐츠가 헤드라인 나열로 전락한다.
 *
 * 엔드포인트 3종 (키 불필요, Referer 필요):
 *   국내지수  polling.finance.naver.com/api/realtime/domestic/index/{KOSPI|KOSDAQ}
 *   해외지수  api.stock.naver.com/index/{.INX|.IXIC|.DJI}/basic
 *   환율·DXY  api.stock.naver.com/marketindex/majors/exchange   (배열, reutersCode 로 선택)
 *
 * 비공식 엔드포인트라 예고 없이 막힐 수 있다. 그래서 실패는 파이프라인을 세우지 않고
 * available:false 로 기록만 하며, 대본은 헤드라인 전용으로 강등된다.
 *
 * 사용:
 *   node fetch-market-snapshot.js --slot us-close|kr-close [--date YYYY-MM-DD]
 *   node fetch-market-snapshot.js --symbols KOSPI,FX_USDKRW [--no-wait]
 *
 * 종료코드: 0 = 수집 성공(일부 실패 포함) · 1 = 전부 실패 · 2 = 입력 오류
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');

const HEADERS = {
  // 네이버는 UA·Referer 가 없으면 차단한다 (실측)
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://m.stock.naver.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko,en-US;q=0.9',
};

/** 마감 미확정일 때 재시도 — 서머타임 종료기 미 증시 마감(06:00 KST)이 루틴 시작과 겹치기 때문 */
const CLOSE_RETRIES = 3;
const CLOSE_RETRY_MS = 5 * 60 * 1000;

const DISPLAY = {
  KOSPI: '코스피', KOSDAQ: '코스닥',
  '.INX': 'S&P 500', '.IXIC': '나스닥', '.DJI': '다우존스', '.DXY': '달러인덱스',
  FX_USDKRW: '원/달러', FX_EURKRW: '원/유로', FX_JPYKRW: '원/엔(100)', FX_CNYKRW: '원/위안',
  // 원자재·국채·코인 (2026-08-25 추가) — 브리핑이 지수·환율만 다루던 한계를 메운다.
  'CMDT:GCcv1': '국제 금', 'CMDT:SIcv1': '은', 'CMDT:HGcv1': '구리',
  'CMDT:CLcv1': 'WTI', 'CMDT:LCOcv1': '브렌트유', 'CMDT:NGcv1': '천연가스',
  'BOND:US10YT=RR': '미국 국채 10년', 'BOND:KR10YT=RR': '한국 국채 10년',
  'BOND:JP10YT=RR': '일본 국채 10년', 'BOND:DE10YT=RR': '독일 국채 10년',
  'COIN:bitcoin': '비트코인', 'COIN:ethereum': '이더리움',
};

/**
 * 네이버 marketindex 카테고리 (2026-08-25 실측으로 확인한 경로).
 *   /marketindex/metals            금·은·구리·백금
 *   /marketindex/energy            WTI·브렌트·천연가스
 *   /marketindex/majors/bond       각국 10년물 금리
 * 지수 API(/index/<sym>/basic)는 이 심볼들을 모른다 — "지원하지 않는 지수" 를 준다.
 */
const MARKETINDEX_CATEGORY = {
  CMDT_METALS: 'metals',
  CMDT_ENERGY: 'energy',
  BOND: 'majors/bond',
};

/** 심볼 → 어느 엔드포인트 계열인지. 사이트별 분기가 아니라 심볼 형태 규칙이다. */
function family(symbol) {
  if (/^(KOSPI|KOSDAQ)$/.test(symbol)) return 'domestic';
  if (/^FX_/.test(symbol) || symbol === '.DXY') return 'exchange';
  if (symbol.startsWith('CMDT:')) return 'commodity';
  if (symbol.startsWith('BOND:')) return 'bond';
  if (symbol.startsWith('COIN:')) return 'coin';
  if (symbol.startsWith('.')) return 'world';
  return null;
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 네이버는 숫자를 "6,023.66" 같은 천단위 문자열로 준다. 대본이 계산에 쓰므로 수치도 함께 남긴다. */
function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalize(symbol, raw) {
  let dir = raw.compareToPreviousPrice?.name || null;     // RISING | FALLING | STEADY
  const price = num(raw.closePrice);
  const ratio = num(raw.fluctuationsRatio);
  let change = num(raw.compareToPreviousClosePrice);

  // FALLING 인데 부호가 없는 응답이 있어 방향으로 부호를 보정한다
  if (change !== null && dir === 'FALLING' && change > 0) change = -change;

  // majors/exchange 는 등락률만 주고 등락폭·방향을 안 준다 (실측). 브리핑에서
  // "환율 12원 하락" 을 쓰려면 폭이 필요하므로 등락률에서 역산한다.
  if (change === null && price !== null && ratio !== null && ratio !== -100) {
    change = Math.round((price - price / (1 + ratio / 100)) * 100) / 100;
  }
  if (!dir && ratio !== null) dir = ratio > 0 ? 'RISING' : ratio < 0 ? 'FALLING' : 'STEADY';

  return {
    symbol,
    name: DISPLAY[symbol] || raw.stockName || raw.indexName || symbol,
    price,
    price_text: raw.closePrice ?? null,
    change,
    change_pct: ratio,
    direction: dir,
    market_status: raw.marketStatus || null,           // OPEN | CLOSE
    traded_at: raw.localTradedAt || null,
  };
}

async function fetchDomestic(symbol) {
  const d = await getJson(`https://polling.finance.naver.com/api/realtime/domestic/index/${symbol}`);
  const row = d?.datas?.[0];
  if (!row) throw new Error('datas 비어 있음');
  return normalize(symbol, row);
}

async function fetchWorld(symbol) {
  const d = await getJson(`https://api.stock.naver.com/index/${encodeURIComponent(symbol)}/basic`);
  if (d?.code) throw new Error(d.message || d.code);
  if (!d?.closePrice) throw new Error('closePrice 없음');
  return normalize(symbol, d);
}

/** 환율·달러인덱스는 한 번의 호출로 전부 오므로 캐시해 재사용한다 */
let exchangeCache = null;
async function fetchExchange(symbol) {
  if (!exchangeCache) exchangeCache = await getJson('https://api.stock.naver.com/marketindex/majors/exchange');
  const row = (exchangeCache || []).find((r) => r.reutersCode === symbol);
  if (!row) throw new Error(`majors/exchange 에 ${symbol} 없음`);
  return normalize(symbol, row);
}

// 카테고리 응답은 한 번만 받아 캐시한다 (금·은·구리가 같은 응답에 들어 있다).
const categoryCache = new Map();
async function fetchCategory(path) {
  if (!categoryCache.has(path)) {
    categoryCache.set(path, await getJson(`https://api.stock.naver.com/marketindex/${path}`));
  }
  return categoryCache.get(path);
}

/** CMDT:GCcv1 → metals/energy 중 맞는 카테고리에서 찾는다. */
async function fetchCommodity(symbol) {
  const code = symbol.slice('CMDT:'.length);
  for (const cat of [MARKETINDEX_CATEGORY.CMDT_METALS, MARKETINDEX_CATEGORY.CMDT_ENERGY]) {
    const rows = await fetchCategory(cat);
    const row = (rows || []).find((r) => r.reutersCode === code);
    if (row) return normalize(symbol, row);
  }
  throw new Error(`metals·energy 에 ${code} 없음`);
}

/** BOND:US10YT=RR → majors/bond. 값은 "가격" 이 아니라 **금리(%)** 다. */
async function fetchBond(symbol) {
  const code = symbol.slice('BOND:'.length);
  const rows = await fetchCategory(MARKETINDEX_CATEGORY.BOND);
  const row = (rows || []).find((r) => r.reutersCode === code);
  if (!row) throw new Error(`majors/bond 에 ${code} 없음`);
  const out = normalize(symbol, row);
  out.unit = 'percent';   // 대본이 "포인트" 로 읽지 않도록 명시한다
  out.metric = 'yield';
  return out;
}

/**
 * COIN:bitcoin → CoinGecko simple/price (키 불필요).
 * 네이버에는 코인 시세가 없다. 24시간 변동률을 등락률로 쓴다 — 주식의 "전일 대비"와
 * 기준이 다르므로 대본이 섞어 쓰지 않도록 basis 를 남긴다.
 */
async function fetchCoin(symbol) {
  const id = symbol.slice('COIN:'.length);
  const d = await getJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}`
    + '&vs_currencies=usd&include_24hr_change=true',
  );
  const row = d?.[id];
  if (!row || row.usd === undefined) throw new Error(`CoinGecko 에 ${id} 없음`);
  const price = num(row.usd);
  const rate = num(row.usd_24h_change);
  // normalize() 와 같은 스키마로 맞춘다 — 리포트·대본이 price/change_pct 를 읽는다.
  const out = normalize(symbol, {
    closePrice: price === null ? null : String(price),
    fluctuationsRatio: rate === null ? null : rate.toFixed(2),
    marketStatus: 'OPEN',     // 코인은 24시간 거래
  });
  out.currency = 'USD';
  out.basis = '24h';          // 전일 종가 대비가 아니다 — 대본이 섞어 쓰지 않도록
  out.source = 'coingecko';
  return out;
}

async function fetchSymbol(symbol) {
  const fam = family(symbol);
  if (!fam) return { symbol, error: `알 수 없는 심볼 형식: ${symbol}` };
  try {
    if (fam === 'domestic') return await fetchDomestic(symbol);
    if (fam === 'world') return await fetchWorld(symbol);
    if (fam === 'commodity') return await fetchCommodity(symbol);
    if (fam === 'bond') return await fetchBond(symbol);
    if (fam === 'coin') return await fetchCoin(symbol);
    return await fetchExchange(symbol);
  } catch (e) {
    return { symbol, name: DISPLAY[symbol] || symbol, error: e.message };
  }
}

async function collect(symbols) {
  exchangeCache = null;
  const out = [];
  for (const s of symbols) {
    process.stdout.write(`  ${(DISPLAY[s] || s).padEnd(10)} `);
    const r = await fetchSymbol(s);
    out.push(r);
    if (r.error) console.log(`❌ ${r.error}`);
    else console.log(`✅ ${r.price_text} (${r.change_pct > 0 ? '+' : ''}${r.change_pct}%) ${r.market_status || ''}`);
  }
  return out;
}

function loadSlot(slotName) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'routines.json'), 'utf-8'));
  const slot = cfg.slots?.[slotName];
  if (!slot) throw new Error(`알 수 없는 슬롯: ${slotName} (가능: ${Object.keys(cfg.slots || {}).join(', ')})`);
  return slot;
}

// us-close 는 06:00 KST 에 돈다 — 직전 ET 세션은 언제나 "전날"이다.
// 주말을 건너뛰며 되짚으면 월요일이 금요일 종가를 새 종가로 보는데, 그 종가는 토요일 편에서
// 이미 다뤘다. EP-2026-0096(월) 대본이 금요일 마감을 "오늘"이라 써서 팩트체크에 걸렸다.
function previousDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function resolveContentMode(slotName, date, quotes = [], requireClosed = []) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (day === 0) return { content_mode: 'sunday_preopen', expected_session_date: null };
  if (day === 6) return { content_mode: 'closed_market_issue', expected_session_date: null };

  const expected = slotName === 'us-close' ? previousDay(date) : date;
  // 직전 세션일이 주말이면 새 종가가 없다 — us-close 월요일(전날=일요일)이 여기 걸린다.
  if ([0, 6].includes(new Date(`${expected}T00:00:00Z`).getUTCDay())) {
    return { content_mode: 'closed_market_issue', expected_session_date: null };
  }
  const required = quotes.filter((q) => requireClosed.includes(q.symbol));
  const noFreshClose = required.length === requireClosed.length && required.length > 0
    && required.every((q) => /^\d{4}-\d{2}-\d{2}/.test(q.traded_at || '')
      && q.traded_at.slice(0, 10) < expected);
  return {
    content_mode: noFreshClose ? 'closed_market_issue' : 'market_close',
    expected_session_date: expected,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      slot: { type: 'string' },
      symbols: { type: 'string' },
      date: { type: 'string', short: 'd' },
      'no-wait': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values.slot && !values.symbols) {
    console.error('Usage: fetch-market-snapshot.js --slot us-close|kr-close [--date YYYY-MM-DD] [--no-wait]');
    console.error('       fetch-market-snapshot.js --symbols KOSPI,FX_USDKRW');
    process.exit(2);
  }

  let symbols, requireClosed = [], slotName = values.slot || 'adhoc';
  if (values.symbols) {
    symbols = values.symbols.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    let slot;
    try { slot = loadSlot(values.slot); } catch (e) { console.error(`❌ ${e.message}`); process.exit(2); }
    symbols = slot.market?.symbols || [];
    requireClosed = slot.market?.require_closed || [];
  }

  // KST 기준이다. toISOString() 은 UTC 라 00~09시 KST 에는 하루 전 폴더를 가리킨다 —
  // us-close 슬롯이 06:00 KST 라 정확히 그 구간이고, desk-briefing.js 는 KST 를 쓴다.
  // --date 없이 손으로 돌리면 산출물이 두 폴더로 갈렸다 (2026-08-25).
  const date = values.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  console.log(`\n📈 시세 스냅샷 — ${slotName} (${date})`);

  let quotes = await collect(symbols);

  // 마감 확정 대기: require_closed 심볼이 아직 OPEN 이면 재시도한다.
  let stale = false;
  if (requireClosed.length && !values['no-wait']) {
    for (let attempt = 1; attempt <= CLOSE_RETRIES; attempt++) {
      const open = quotes.filter((q) => requireClosed.includes(q.symbol) && q.market_status === 'OPEN');
      if (!open.length) break;
      if (attempt === CLOSE_RETRIES) {
        stale = true;
        console.log(`\n⚠️  마감 미확정: ${open.map((q) => q.name).join(', ')} — stale 로 기록하고 진행`);
        break;
      }
      console.log(`\n⏳ 마감 미확정 (${open.map((q) => q.name).join(', ')}) — ${CLOSE_RETRY_MS / 60000}분 후 재시도 ${attempt}/${CLOSE_RETRIES - 1}`);
      await new Promise((r) => setTimeout(r, CLOSE_RETRY_MS));
      quotes = await collect(symbols);
    }
  }

  const ok = quotes.filter((q) => !q.error);
  const content = resolveContentMode(slotName, date, quotes, requireClosed);
  const snapshot = {
    slot: slotName,
    date,
    fetched_at: new Date().toISOString(),
    source: 'naver-finance',
    available: ok.length > 0,
    stale,
    ...content,
    quotes,
    errors: quotes.filter((q) => q.error).map((q) => ({ symbol: q.symbol, error: q.error })),
  };

  const outDir = join(ROOT, 'workspace', 'daily-news', date);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `market-${slotName}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf-8');

  if (values.json) console.log(JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ 저장: ${outPath}`);
  console.log(`   ${ok.length}/${quotes.length} 수집${stale ? ' · ⚠️ stale' : ''}`);
  console.log(`   콘텐츠 모드: ${snapshot.content_mode}`);

  process.exit(ok.length ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}

export { resolveContentMode };
