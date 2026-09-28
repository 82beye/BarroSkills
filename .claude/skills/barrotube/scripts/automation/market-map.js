#!/usr/bin/env node

/**
 * market-map.js — 바로경제 마켓맵 이미지 3장 생성 (+ 텔레그램 발송)
 *
 * 운영자 지시(2026-09-16): "미국 나스닥·코스피 종목별 상승을 한눈에, 테마 그룹을 보여 주고,
 * 유튜브 커뮤니티를 활성화하라." 참고본은 Finviz 히트맵과 인스타 주식테마맵.
 *
 * 산출:
 *   workspace/growth/market-map/<date>/us.png      미국 대형주 히트맵 (1080×1080)
 *   workspace/growth/market-map/<date>/kr.png      코스피 시총상위 히트맵 (1080×1080)
 *   workspace/growth/market-map/<date>/themes.png  코스피·코스닥 테마맵 (1080×1350)
 *   workspace/growth/market-map/<date>/data.json   수집 원본 (재렌더용)
 *
 * 데이터 (전부 무과금·무키):
 *   미국   Yahoo v8 chart — 종가·전일종가. 시총은 안 주므로 크기는 config 의 정적 근사치.
 *   코스피 네이버 m.stock JSON — marketValue(실시간)·등락률
 *   테마   네이버 m.stock JSON — 테마 랭킹 + 구성종목
 *
 * 정직성 규칙: 미국 등락은 "마지막 마감 세션" 기준이다. 15:50 KST 에 돌면 미국장은 아직
 * 안 열렸으므로 전일 마감이다 — 이미지에 세션 날짜를 박아 '오늘'로 오독되지 않게 한다.
 * (EP-0157 의 197일 전 기사 사고와 같은 계열의 실수를 이미지에서 반복하지 않는다.)
 *
 * Usage:
 *   node market-map.js                # 수집 + 렌더
 *   node market-map.js --telegram    # + 텔레그램 사진 3장 발송
 *   node market-map.js --render-only # 기존 data.json 으로 재렌더 (디자인 반복용)
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { getSecret } from './config-loader.js';
import {
  num, pctColor, squarify, groupedTreemap, krStocksToItems, themeModel,
  resolveEdition, EDITIONS, krSessionOf, krSessionLabel,
} from './lib/market-map.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'market-map.json'), 'utf-8'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh) BarroTube/1.0' };
/** 「직전 판과 같은 마감」이라 거른 경우의 종료 코드. 크론이 나머지 단계를 건너뛴다. */
const SKIP_EXIT = 10;

/**
 * 미국 세션 라벨. 2026-09-16 23:36 KST 첫 생성분이 ET 10:36 **장중**인데 "마감 (현지)"로
 * 나갔다 — 대본에서 그렇게 조심하던 '시점 정직성'을 이미지가 어겼다. 장중이면 장중이라 쓴다.
 */
function usSessionLabel(sessionDate) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  const todayET = `${parts.year}-${parts.month}-${parts.day}`;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (sessionDate === todayET && mins >= 570 && mins < 960) {
    return `${sessionDate} 장중 ${parts.hour}:${parts.minute} ET 기준`;
  }
  if (sessionDate === todayET && mins < 570) return `${sessionDate} 프리마켓 기준`;
  return `${sessionDate} 마감`;
}

const kstDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
const kstDay = (iso) => '일월화수목금토'[new Date(`${iso}T12:00:00+09:00`).getUTCDay() === 6 ? 6 : (new Date(`${iso}T12:00:00+09:00`).getUTCDay() + 0)];

async function getJSON(url, { retries = 2, timeoutMs = 12_000 } = {}) {
  for (let a = 0; ; a += 1) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: UA, signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (a >= retries) throw new Error(`${url.slice(0, 60)}… ${e.message}`);
      await new Promise((res) => setTimeout(res, 700 * (a + 1)));
    } finally { clearTimeout(t); }
  }
}

/** Yahoo: 마지막 마감 기준 등락. */
async function yahoo(symbol) {
  const d = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  const m = d?.chart?.result?.[0]?.meta ?? {};
  const price = m.regularMarketPrice; const prev = m.chartPreviousClose;
  if (!Number.isFinite(price) || !Number.isFinite(prev) || prev === 0) return null;
  return {
    symbol, price, pct: ((price - prev) / prev) * 100,
    sessionDate: m.regularMarketTime
      ? new Intl.DateTimeFormat('en-CA', { timeZone: m.exchangeTimezoneName || 'America/New_York' }).format(new Date(m.regularMarketTime * 1000))
      : null,
  };
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); }
  }));
  return out;
}

/** 판 폴더를 최신순으로 훑어 `pick` 이 값을 돌려주는 가장 최근 data.json 을 찾는다. */
function findPrior(outRoot, pick) {
  let best = null;
  for (const dateDir of readdirSync(outRoot, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const ed of ['evening', 'morning', '']) {
      const p = ed ? join(outRoot, dateDir.name, ed, 'data.json') : join(outRoot, dateDir.name, 'data.json');
      if (!existsSync(p)) continue;
      let d;
      try { d = JSON.parse(readFileSync(p, 'utf-8')); } catch { continue; }
      const got = pick(d);
      if (!got) continue;
      const mt = statSync(p).mtimeMs;
      if (!best || mt > best.mt) best = { ...got, mt };
    }
  }
  return best;
}

/** 테마 등락률이 살아 있는 가장 최근 스냅샷. */
const findPriorThemes = (outRoot) => findPrior(outRoot, (d) => (
  Array.isArray(d.themes) && d.themes.length && d.themes.some((t) => t.pct || t.total)
    ? { themes: d.themes, date: d.themesSession?.date || d.krSession?.date || d.date }
    : null
));

/** 코스피 등락률이 살아 있는 가장 최근 스냅샷. 세션 라벨을 값과 함께 들고 온다. */
const findPriorKr = (outRoot) => findPrior(outRoot, (d) => (
  Array.isArray(d.kr) && d.kr.length && d.kr.some((k) => k.pct)
    ? { kr: d.kr, session: d.krSession }
    : null
));

/**
 * 같은 종류의 직전 판이 실었던 **선도 시장** 세션. 조간은 미국, 석간은 코스피가 선도다.
 */
export function priorLeadSession(outRoot, edition, selfPath) {
  const { leads } = EDITIONS[edition];
  // 기준일은 selfPath 의 날짜 폴더다. 예전에는 mtime 최대값을 "직전 판"으로 삼았는데,
  // 그건 **오늘 판을 만드는 중**이라 미래 판이 없다는 가정에서만 맞는다. 지난 판을
  // 다시 만들면(백필·수정) 그 판의 mtime 이 가장 커져서 자기보다 나중 판을 직전으로
  // 집는다. 폴더명이 YYYY-MM-DD 라 사전순 비교가 곧 날짜순이다.
  const selfDate = typeof selfPath === 'string'
    ? (selfPath.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null
    : null;
  let best = null;
  for (const dateDir of readdirSync(outRoot, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const p = join(outRoot, dateDir.name, edition, 'data.json');
    if (!existsSync(p) || p === selfPath) continue;
    if (selfDate && dateDir.name >= selfDate) continue;
    let d;
    try { d = JSON.parse(readFileSync(p, 'utf-8')); } catch { continue; }
    const session = leads === 'us' ? d.usSession : d.krSession?.date;
    if (!session) continue;
    if (!best || dateDir.name > best.date) best = { session, date: dateDir.name, mt: statSync(p).mtimeMs };
  }
  return best;
}

async function collect() {
  const date = kstDate();
  // 미국 유니버스 + 지수 4종
  const usTickers = Object.entries(CFG.us.sectors).flatMap(([sec, m]) => Object.keys(m).map((t) => ({ t, sec })));
  const quotes = await mapPool(usTickers, 8, ({ t }) => yahoo(t));
  const us = usTickers.map((u, i) => quotes[i] && ({ ...u, ...quotes[i] })).filter(Boolean);
  const missed = usTickers.length - us.length;
  const idx = {};
  for (const [k, sym] of Object.entries(CFG.indices)) idx[k] = await yahoo(sym).catch(() => null);

  // 코스피 시총 상위
  const krRaw = await getJSON(`https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=1&pageSize=${CFG.kr.top_n}`);
  let kr = krStocksToItems(krRaw.stocks);
  // 세션은 시계가 아니라 응답이 정본이다 — 08:00 회차엔 한국장이 안 열려 직전 세션이다.
  let krSession = krSessionOf(krRaw.stocks, new Date());
  // 아래 테마 주석은 「시총 API 는 직전 종가 등락률을 준다」고 적었지만 실측은 반대였다:
  // 2026-09-17·18 조간에서 58종목의 fluctuationsRatio 가 전부 0 이었다. 라벨은 krSessionOf
  // 가 직전 거래일을 가리키므로, 그대로 두면 「2026-09-17 15:30 마감」 밑에 전 종목 +0.00%
  // 를 싣는다 — 오지 않은 보합을 마감 실적으로 발표하는 셈이다(그날 한화시스템은 +15.70%
  // 였다). 테마와 같은 규칙으로 직전 유효 스냅샷을 그 세션 라벨째로 끌어온다.
  if (!krSession.open && kr.length && kr.every((k) => !k.pct)) {
    const prior = findPriorKr(join(ROOT, CFG.output_dir));
    if (prior) {
      kr = prior.kr;
      krSession = { ...prior.session, carried: true };
      console.log(`   \u23ea 코스피가 전부 0 (장 시작 전) — ${prior.session?.date} 스냅샷을 끌어온다`);
    } else {
      console.log('   \u26a0 코스피가 전부 0 이고 직전 스냅샷도 없다 — 등락 없이 시총만 싣는다');
    }
  }

  // 테마 랭킹 + 상위 테마 구성종목
  const themesRaw = await getJSON('https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=40');
  const topGroups = (themesRaw.groups ?? [])
    .filter((g) => num(g.changeRate) !== null)
    .sort((a, b) => num(b.changeRate) - num(a.changeRate))
    .slice(0, CFG.themes.top_n);
  const byNo = {};
  for (const g of topGroups) {
    const d = await getJSON(`https://m.stock.naver.com/api/stocks/theme/${g.no}?page=1&pageSize=12`).catch(() => null);
    byNo[g.no] = d?.stocks ?? [];
  }
  let themes = themeModel(themesRaw.groups, byNo, { topN: CFG.themes.top_n, stocksPer: CFG.themes.stocks_per_theme });
  // 08:00 조간 회차에는 한국장이 안 열려(marketStatus=PREOPEN) 네이버 테마 API 가
  // **오늘** 등락률, 즉 0 을 돌려준다. 시총 API 는 직전 종가 등락률을 주기 때문에
  // 종목 카드는 멀쩡한데 테마 카드만 「광통신 +0.00% · 0중 0개 상승」으로 빈다.
  // 2026-09-17 08:00 실제 산출에서 6개 테마가 전부 그랬다.
  // 직전 유효 스냅샷을 끌어와 그 세션 날짜로 라벨한다 — 조간이 어제 마감 테마를
  // 싣는 건 자연스럽고, 0 을 싣는 건 거짓이다.
  let themesSession = { date: krSession.date ?? date, carried: false };
  if (themes.length && themes.every((t) => !t.pct && !t.total)) {
    const prior = findPriorThemes(join(ROOT, CFG.output_dir));
    if (prior) {
      themes = prior.themes;
      themesSession = { date: prior.date, carried: true };
      console.log(`   ⏪ 테마가 전부 0 (장 시작 전) — ${prior.date} 스냅샷을 끌어온다`);
    } else {
      themes = [];
      console.log('   ⚠ 테마가 전부 0 이고 직전 스냅샷도 없다 — 테마 카드를 뺀다');
    }
  }

  const usSession = us.find((u) => u.sessionDate)?.sessionDate ?? null;
  console.log(`📊 수집 — 미국 ${us.length}/${usTickers.length}종목${missed ? ` (누락 ${missed})` : ''} · 코스피 ${kr.length}종목 · 테마 ${themes.length}개`);
  console.log(`   미국 세션: ${usSession} · 코스피 세션: ${krSession.date} (${krSession.status})`);
  if (us.length < usTickers.length * 0.8) throw new Error(`미국 시세 누락 과다 (${us.length}/${usTickers.length}) — 이미지를 만들지 않는다`);
  if (kr.length < CFG.kr.top_n * 0.8) throw new Error(`코스피 시세 누락 과다 (${kr.length})`);
  return { date, usSession, krSession, themesSession, idx, us, kr, themes };
}

/* ── 렌더 ───────────────────────────────────────────────────────────── */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fpct = (p) => (p === null || p === undefined ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);

function cellDiv(c, clamp, { compact = false } = {}) {
  const area = c.w * c.h;
  if (c.w < 30 || c.h < 15) {
    return `<div class="cell" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;background:${pctColor(c.pct, clamp)}"></div>`;
  }
  const fs = Math.max(10, Math.min(30, Math.sqrt(area) / (compact ? 5.2 : 6.5)));
  const showPct = c.h >= 34 && c.w >= 44;
  return `<div class="cell" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;background:${pctColor(c.pct, clamp)}">
    <span class="tk" style="font-size:${fs}px">${esc(c.label ?? c.key)}</span>
    ${showPct ? `<span class="pc" style="font-size:${Math.max(9, fs * 0.62)}px">${fpct(c.pct)}</span>` : ''}
  </div>`;
}

function idxChip(label, q) {
  if (!q) return '';
  const up = q.pct >= 0;
  return `<span class="chip"><b>${label}</b> ${q.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
    <i style="color:${up ? '#4ADE80' : '#F87171'}">${fpct(q.pct)}</i></span>`;
}

function buildHTML(d) {
  const W = 1080;
  const usGroups = Object.entries(CFG.us.sectors).map(([name, m]) => ({
    name,
    items: d.us.filter((u) => u.sec === name).map((u) => ({ key: u.t, label: u.t, size: m[u.t] ?? 0, pct: u.pct })),
  }));
  const usMap = groupedTreemap(usGroups, { x: 0, y: 0, w: W - 40, h: 880 }, { headerPx: 24 });
  // 시총 원값으로 깔면 삼성전자+SK하이닉스가 화면 55%를 먹어 나머지 58종목이 안 읽힌다
  // (2026-09-16 1차 산출). ^0.6 거듭제곱으로 지배력을 눌러 순서는 지키되 꼬리를 살린다.
  // 각주도 '크기 ∝ 시가총액'으로 바꿔 정비례라고 말하지 않는다.
  // 2026-09-16 운영자 지시: 코스피도 미국처럼 **테마 그룹** 트리맵으로 — 그룹 헤더에 테마명,
  // 안에 종목·등락률. 매핑은 config kr.groups(itemCode 기준), 없는 코드는 '기타'.
  const codeToGroup = {};
  for (const [gname, members] of Object.entries(CFG.kr.groups ?? {})) {
    if (gname.startsWith('_')) continue;
    for (const code of Object.keys(members)) codeToGroup[code] = gname;
  }
  const krByGroup = {};
  for (const k of d.kr) {
    const g = codeToGroup[k.key] ?? '기타';
    (krByGroup[g] ??= []).push({ ...k, size: Math.pow(k.size, 0.6) });
  }
  const krGroups = Object.entries(krByGroup).map(([name, items]) => ({ name, items }));
  const krMap = groupedTreemap(krGroups, { x: 0, y: 0, w: W - 40, h: 880 }, { headerPx: 24 });
  const usLabel = usSessionLabel(d.usSession ?? d.date);
  const krLbl = krSessionLabel(d.krSession, d.date);

  const themeCard = (t) => `
    <div class="tcard">
      <div class="thead"><span class="tname">${esc(t.name)}</span>
        <span class="tpct" style="color:${t.pct >= 0 ? '#4ADE80' : '#F87171'}">${fpct(t.pct)}</span></div>
      <div class="tmeta">${t.total}종목 중 ${t.rise}개 상승</div>
      ${t.stocks.map((s) => `<div class="trow"><span>${esc(s.name)}</span>
        <b style="color:${s.pct >= 0 ? '#4ADE80' : '#F87171'}">${fpct(s.pct)}</b></div>`).join('')}
    </div>`;

  return `<!doctype html><meta charset="utf-8"><style>
  * { margin:0; box-sizing:border-box; font-family:'Apple SD Gothic Neo','Pretendard',-apple-system,sans-serif; }
  body { background:#05080F; }
  .board { width:${W}px; background:#0A0F1C; position:relative; overflow:hidden; padding:20px; }
  .hd { display:flex; align-items:baseline; gap:14px; margin-bottom:6px; }
  .hd h1 { color:#FFFFFF; font-size:40px; font-weight:800; letter-spacing:-1px; }
  .hd .accent { color:#FF9A1F; }
  .hd .date { color:#8B98AD; font-size:20px; font-weight:600; }
  .chips { display:flex; gap:10px; margin:8px 0 14px; flex-wrap:wrap; }
  .chip { background:#131B2A; border:1px solid #1C2A44; color:#C6D0E0; font-size:17px;
          padding:6px 12px; border-radius:8px; font-variant-numeric:tabular-nums; }
  .chip b { color:#E8ECF3; margin-right:6px; } .chip i { font-style:normal; font-weight:700; margin-left:6px; }
  .canvas { position:relative; width:${W - 40}px; height:880px; background:#0A0F1C; }
  .sec { position:absolute; border:1px solid #05080F; }
  .sec .sh { position:absolute; top:0; left:0; right:0; height:24px; background:#101A30;
             color:#8B98AD; font-size:13px; font-weight:700; padding:4px 8px; letter-spacing:.5px;
             white-space:nowrap; overflow:hidden; }
  .cell { position:absolute; border:1px solid rgba(5,8,15,.55); display:flex; flex-direction:column;
          align-items:center; justify-content:center; overflow:hidden; }
  .cell .tk { color:#FFFFFF; font-weight:800; text-shadow:0 1px 3px rgba(0,0,0,.45); line-height:1.05; }
  .cell .pc { color:rgba(255,255,255,.92); font-weight:600; font-variant-numeric:tabular-nums; }
  .ft { margin-top:12px; display:flex; justify-content:space-between; color:#8B98AD; font-size:16px; }
  .ft b { color:#FF9A1F; }
  /* 테마맵 */
  .tgrid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .tcard { background:#131B2A; border:1px solid #1C2A44; border-radius:12px; padding:16px 18px; }
  .thead { display:flex; justify-content:space-between; align-items:baseline; }
  .tname { color:#FFFFFF; font-size:25px; font-weight:800; letter-spacing:-.5px; }
  .tpct { font-size:26px; font-weight:800; font-variant-numeric:tabular-nums; }
  .tmeta { color:#8B98AD; font-size:14px; margin:4px 0 10px; }
  .trow { display:flex; justify-content:space-between; color:#C6D0E0; font-size:19px; padding:5px 0;
          border-top:1px solid #1C2A44; font-variant-numeric:tabular-nums; }
  .trow b { font-weight:700; }
  </style>

  <div class="board" id="us" style="height:1080px">
    <div class="hd"><h1>바로경제 <span class="accent">미국 마켓맵</span></h1><span class="date">${usLabel}</span></div>
    <div class="chips">${idxChip('나스닥', d.idx.nasdaq)}${idxChip('S&P500', d.idx.sp500)}</div>
    <div class="canvas">
      ${usMap.sectors.map((s) => `<div class="sec" style="left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px"><div class="sh">${esc(s.name)}</div></div>`).join('')}
      ${usMap.cells.map((c) => cellDiv(c, CFG.us.clamp_pct)).join('')}
    </div>
    <div class="ft"><span>크기 = 시가총액 · 색 = 등락률</span><span><b>바로경제</b> 매일 08·20시 브리핑</span></div>
  </div>

  <div class="board" id="kr" style="height:1080px">
    <div class="hd"><h1>바로경제 <span class="accent">코스피 마켓맵</span></h1><span class="date">${krLbl.date}(${kstDay(krLbl.date)}) ${krLbl.text}</span></div>
    <div class="chips">${idxChip('코스피', d.idx.kospi)}${idxChip('코스닥', d.idx.kosdaq)}</div>
    <div class="canvas">
      ${krMap.sectors.map((sct) => `<div class="sec" style="left:${sct.x}px;top:${sct.y}px;width:${sct.w}px;height:${sct.h}px"><div class="sh">${esc(sct.name)}</div></div>`).join('')}
      ${krMap.cells.map((c) => cellDiv(c, CFG.kr.clamp_pct, { compact: true })).join('')}
    </div>
    <div class="ft"><span>시총 상위 ${d.kr.length}종목 · 테마별 그룹 · 크기 ∝ 시가총액 · 색 = 등락률</span><span><b>바로경제</b> 매일 08·20시 브리핑</span></div>
  </div>

  <div class="board" id="themes">
    <div class="hd"><h1>바로경제 <span class="accent">오늘의 테마맵</span></h1><span class="date">${d.date}(${kstDay(d.date)})</span></div>
    <div class="chips">${idxChip('코스피', d.idx.kospi)}${idxChip('코스닥', d.idx.kosdaq)}</div>
    <div class="tgrid">${d.themes.map(themeCard).join('')}</div>
    <div class="ft" style="margin-top:16px"><span>등락률 상위 테마 · 출처: 네이버증권 집계</span><span><b>바로경제</b> 구독하고 매일 받아보기</span></div>
  </div>`;
}

async function render(d, outDir) {
  const html = buildHTML(d);
  const htmlPath = join(outDir, 'map.html');
  writeFileSync(htmlPath, html);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1200, height: 1500 } });
    const page = await ctx.newPage();
    await page.goto(`file://${htmlPath}`);
    await page.waitForTimeout(400);
    const out = [];
    for (const id of ['us', 'kr', 'themes']) {
      const p = join(outDir, `${id}.png`);
      await page.locator(`#${id}`).screenshot({ path: p });
      out.push(p);
    }
    return out;
  } finally { await browser.close().catch(() => {}); }
}

/* ── 텔레그램 (사진 3장 한 묶음) ─────────────────────────────────────── */
async function sendTelegram(files, caption) {
  const token = getSecret('TELEGRAM_BOT_TOKEN'); const chat = getSecret('TELEGRAM_CHAT_ID');
  if (!token || !chat) { console.warn('⚠ 텔레그램 시크릿 없음 — 발송 생략'); return false; }
  // node fetch 가 아니라 curl -4 다. 이 네트워크는 api.telegram.org 의 IPv6 경로가
  // 타임아웃이라 fetch(IPv6 우선)는 ETIMEDOUT 으로 죽는다 — notify.js·guards.sh 와
  // 같은 이유, 같은 처방이다 (2026-08-14 실측 주석 참조. 2026-09-16 이 스크립트도 재확인).
  const { execFileSync } = await import('node:child_process');
  const media = JSON.stringify(files.map((f, i) => ({
    type: 'photo', media: `attach://p${i}`, ...(i === 0 ? { caption } : {}),
  })));
  const args = ['-sS', '-4', '-m', '60',
    `https://api.telegram.org/bot${token}/sendMediaGroup`,
    '--form-string', `chat_id=${chat}`, '--form-string', `media=${media}`,
    ...files.flatMap((f, i) => ['-F', `p${i}=@${f};type=image/png`])];
  try {
    const out = execFileSync('curl', args, { encoding: 'utf-8' });
    const j = JSON.parse(out);
    if (!j.ok) { console.error('❌ 텔레그램 발송 실패:', out.slice(0, 200)); return false; }
    console.log('📨 텔레그램 사진 3장 발송 완료');
    return true;
  } catch (e) {
    console.error('❌ 텔레그램 발송 실패:', e.message.slice(0, 200));
    return false;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    telegram: { type: 'boolean', default: false },
    'render-only': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    date: { type: 'string' },
    edition: { type: 'string' },
  } });
  const date = values.date || kstDate();
  const edition = values.edition || resolveEdition();
  if (!EDITIONS[edition]) throw new Error(`알 수 없는 판: ${edition} (morning | evening)`);
  const outDir = join(ROOT, CFG.output_dir, date, edition);
  mkdirSync(outDir, { recursive: true });
  const dataPath = join(outDir, 'data.json');

  let data;
  if (values['render-only'] && existsSync(dataPath)) {
    data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    console.log('♻️  기존 data.json 으로 재렌더');
  } else {
    data = await collect();
    writeFileSync(dataPath, JSON.stringify(data, null, 2));

    // 장이 안 열린 날은 직전 판과 **똑같은 마감**을 다시 싣게 된다. 2026-09-19~20 주말에
    // 금요일 마감이 네 번 나갈 뻔했다(토 석간·일 조간·일 석간이 전부 9/18 마감). 달력으로
    // 막지 않는다 — 선도 시장(조간=미국, 석간=코스피)의 세션이 직전 같은 판과 같으면 거른다.
    // 휴장일·연휴도 같은 규칙으로 걸리고, 월요일 조간(미국은 아직 금요일 마감)도 걸린다.
    const { leads } = EDITIONS[edition];
    const mine = leads === 'us' ? data.usSession : data.krSession?.date;
    const prior = priorLeadSession(join(ROOT, CFG.output_dir), edition, dataPath);
    if (!values.force && mine && prior?.session === mine) {
      console.log(`⏭  ${leads === 'us' ? '미국' : '코스피'} ${mine} 마감은 `
        + `${prior.date} ${EDITIONS[edition].label}판이 이미 실었다 — 이번 판은 거른다 (--force 로 강행)`);
      process.exit(SKIP_EXIT);
    }
  }

  console.log(`🗞  ${date} ${EDITIONS[edition].label}판`);
  const files = await render(data, outDir);
  for (const f of files) console.log(`🖼  ${f}`);

  if (values.telegram) {
    const top = data.themes[0];
    await sendTelegram(files, `📊 바로경제 마켓맵 ${data.date}\n미국(${data.usSession} 마감)·코스피·테마\n오늘 1위 테마: ${top?.name} ${top ? (top.pct >= 0 ? '+' : '') + top.pct.toFixed(2) + '%' : ''}\n\n이 이미지로 커뮤니티 게시 →`);
  }
}

// 테스트가 priorLeadSession 을 import 할 수 있게 main 을 막는다.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
