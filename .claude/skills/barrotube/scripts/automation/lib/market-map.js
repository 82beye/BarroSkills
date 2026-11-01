/**
 * market-map.js — 마켓맵(히트맵·테마맵)의 순수 계산부. I/O 없음.
 *
 * 왜 만들었나 (2026-09-16 운영자 지시)
 * ────────────────────────────────
 * "종목별 상승을 한눈에 + 테마 그룹 + 유튜브 커뮤니티 활성화."
 * 참고본은 Finviz 히트맵과 인스타 주식테마맵이다. 영상(에피소드)은 하루 3편이 상한이지만
 * 이미지는 매일 만들어도 비용이 0 이다 — 커뮤니티 피드는 이 이미지로 채운다.
 *
 * 여기 있는 것: squarified 트리맵 레이아웃, 등락률→색, 네이버 API 응답 정규화.
 * 렌더(HTML·스크린샷)와 수집(fetch)은 ../market-map.js CLI 가 한다.
 */

/** "253,500" → 253500, "-1.23" → -1.23. 네이버는 숫자를 전부 문자열로 준다. */
export function num(s) {
  if (s === null || s === undefined) return null;
  const v = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/**
 * 등락률 → 칠 색. clamp 를 넘는 값은 최진하게 고정한다.
 * Finviz 관례(초록=상승)를 따른다 — 국내 관례(빨강=상승)와 반대지만, 참고본으로 주신
 * 세 이미지가 전부 이 배색이고 채널 팔레트(네이비+오렌지)와도 이쪽이 맞는다.
 */
export function pctColor(pct, clamp = 3) {
  if (pct === null || !Number.isFinite(pct)) return '#2A3550';
  const t = Math.max(-1, Math.min(1, pct / clamp));
  const a = Math.abs(t);
  // 무채색(#3A4560 근처)에서 초록/빨강으로. 감마를 줘서 0.5% 근처도 눈에 구분되게.
  const g = Math.pow(a, 0.6);
  const mix = (from, to) => Math.round(from + (to - from) * g);
  if (t >= 0) return `rgb(${mix(58, 22)},${mix(69, 163)},${mix(96, 74)})`;
  return `rgb(${mix(58, 220)},${mix(69, 38)},${mix(96, 38)})`;
}

/**
 * Squarified treemap (Bruls et al.). items: [{key, size, ...}] → [{key, x, y, w, h, ...}]
 * size 합이 rect 면적으로 정규화된다. size<=0 은 버린다.
 */
export function squarify(items, rect) {
  const list = items.filter((i) => Number.isFinite(i.size) && i.size > 0)
    .sort((a, b) => b.size - a.size);
  const total = list.reduce((s, i) => s + i.size, 0);
  if (!total) return [];
  const scale = (rect.w * rect.h) / total;
  const scaled = list.map((i) => ({ ...i, area: i.size * scale }));

  const out = [];
  let x = rect.x; let y = rect.y; let w = rect.w; let h = rect.h;
  let row = [];

  const worst = (r, side) => {
    const s = r.reduce((t, i) => t + i.area, 0);
    let mx = 0;
    for (const i of r) {
      const ratio = Math.max((side * side * i.area) / (s * s), (s * s) / (side * side * i.area));
      if (ratio > mx) mx = ratio;
    }
    return mx;
  };

  const layoutRow = (r) => {
    const s = r.reduce((t, i) => t + i.area, 0);
    if (w >= h) {  // 세로 열로 깐다
      const cw = s / h;
      let cy = y;
      for (const i of r) {
        const ch = i.area / cw;
        out.push({ ...i, x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw; w -= cw;
    } else {       // 가로 행으로 깐다
      const ch = s / w;
      let cx = x;
      for (const i of r) {
        const cw = i.area / ch;
        out.push({ ...i, x: cx, y, w: cw, h: ch });
        cx += cw;
      }
      y += ch; h -= ch;
    }
  };

  for (const item of scaled) {
    const side = Math.min(w, h);
    if (row.length && worst([...row, item], side) > worst(row, side)) {
      layoutRow(row);
      row = [item];
    } else {
      row.push(item);
    }
  }
  if (row.length) layoutRow(row);
  return out;
}

/**
 * 2단 트리맵: 섹터(그룹)를 먼저 깔고, 각 섹터 안에 종목을 깐다.
 * groups: [{name, items:[{key,label,size,pct}]}] → {sectors:[{name,rect}], cells:[{...,rect}]}
 */
export function groupedTreemap(groups, rect, { headerPx = 22 } = {}) {
  const g = groups
    .map((s) => ({ ...s, size: s.items.reduce((t, i) => t + (i.size > 0 ? i.size : 0), 0) }))
    .filter((s) => s.size > 0);
  const laid = squarify(g.map((s) => ({ key: s.name, size: s.size, ref: s })), rect);
  const sectors = []; const cells = [];
  for (const sr of laid) {
    sectors.push({ name: sr.key, x: sr.x, y: sr.y, w: sr.w, h: sr.h });
    const inner = { x: sr.x + 1, y: sr.y + headerPx, w: Math.max(0, sr.w - 2), h: Math.max(0, sr.h - headerPx - 1) };
    if (inner.w < 4 || inner.h < 4) continue;
    for (const c of squarify(sr.ref.items.map((i) => ({ ...i, size: i.size })), inner)) cells.push(c);
  }
  return { sectors, cells };
}

/**
 * 네이버 시총 응답 → 트리맵 items.
 * ETF 는 뺀다 — 시총 랭킹에 KODEX 200·TIGER 미국S&P500 이 섞여 들어와(2026-09-16 실측
 * 상위 60 중 2개) '종목' 맵에 지수 상품이 종목인 척 앉는다. stockEndType 필드가 갈라 준다.
 */
export function krStocksToItems(stocks) {
  return (stocks ?? []).filter((s) => !s.stockEndType || s.stockEndType === 'stock').map((s) => ({
    key: s.itemCode,
    label: s.stockName,
    size: num(s.marketValue) ?? 0,
    pct: num(s.fluctuationsRatio),
  })).filter((i) => i.size > 0 && i.pct !== null);
}

/** 네이버 테마 목록+구성종목 → 테마맵 모델. 등락률 내림차순 상위 topN. */
export function themeModel(groups, byNo, { topN = 6, stocksPer = 5 } = {}) {
  return (groups ?? [])
    .map((g) => ({ no: g.no, name: g.name, pct: num(g.changeRate), rise: g.riseCount, total: g.totalCount }))
    .filter((g) => g.pct !== null)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, topN)
    .map((g) => ({
      ...g,
      stocks: ((byNo[g.no] ?? [])
        .map((s) => ({ name: s.stockName, pct: num(s.fluctuationsRatio) }))
        .filter((s) => s.pct !== null)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, stocksPer)),
    }));
}

/* ── 판(edition) · 세션 ──────────────────────────────────────────────────
   하루 2회 발행(08:00 조간 / 18:00 석간)을 하면서 생긴 규약이다.
   한 회차는 **막 닫힌 시장**을 앞세우고, 아직 안 열린 시장은 직전 세션이라고 말한다.
   석간은 2026-09-28 운영자 지시로 20:00 → 18:00. 18시의 네이버 종목 값에는 KRX 시간외
   단일가가 섞여 있어, 코스피·테마는 15:45 에 떠 둔 KRX 종가 스냅샷을 쓴다(아래 KR_CLOSE_*).
   지수(야후 ^KS11)는 시간외에 계산되지 않아 영향이 없다. */

/** KST 시각 → 판. 08시 회차는 조간, 18시 회차는 석간. 수동 실행도 시각으로 자연스럽게 갈린다. */
export function resolveEdition(now = new Date()) {
  const hh = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit',
  }).format(now));
  return hh < 14 ? 'morning' : 'evening';
}

export const EDITIONS = {
  // leads = 그 회차에 막 마감한 시장. 카드 순서와 표지 문구가 여기를 따른다.
  morning: { label: '조간', at: '08:00', leads: 'us' },
  evening: { label: '석간', at: '18:00', leads: 'kr' },
};

/**
 * 코스피 세션을 **응답에서** 읽는다. 시계로 추측하지 않는다.
 *
 * 08:00 회차에는 한국장이 아직 안 열렸다. KST 날짜로 라벨을 찍으면
 * "2026-09-17 15:30 마감"처럼 오지 않은 마감을 적게 된다 — EP-0157 의
 * 197일 전 기사 사고와 같은 계열이다. 네이버 응답의 localTradedAt(마지막 체결)과
 * marketStatus 가 세션을 그대로 알려주므로 그것만 쓴다.
 */
export function krSessionOf(stocks, now = new Date()) {
  const s = (stocks ?? []).find((x) => x?.localTradedAt) ?? null;
  if (!s) return { date: null, status: null, open: false };

  // localTradedAt 은 「마지막 체결」이 아니라 응답을 만든 시각이다. 장 마감 뒤에도 계속
  // 흐르고 marketStatus 도 OPEN 으로 남는다 — 2026-09-17 18:30 실측: 마감 3시간 뒤인데
  // status=OPEN, localTradedAt=18:30:22. 그래서 이 둘만 믿으면 석간판이 「장중」으로 나간다.
  // 같은 응답의 stockExchangeType 이 거래시간(0900~1530)을 알려주므로 그걸로 판정한다.
  const ex = s.stockExchangeType ?? {};
  const start = Number(ex.startTime ?? '0900');
  const end = Number(ex.endTime ?? '1530');
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: ex.zoneId || 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  const today = `${p.year}-${p.month}-${p.day}`;
  const hhmm = Number(`${p.hour}${p.minute}`);
  const traded = String(s.localTradedAt).slice(0, 10);

  // 장중은 「거래시간 안 + 오늘 시세」일 때만. 그 밖은 전부 직전 세션의 마감이다.
  const open = traded === today && hhmm >= start && hhmm < end;
  // 장이 열리기 전이면 localTradedAt 이 직전 거래일을 가리킨다(실측 확인). 그대로 쓴다.
  return { date: traded, status: s.marketStatus ?? null, open };
}

/* ── KRX 공식 종가 스냅샷 ────────────────────────────────────────────────
   네이버 종목 응답의 최상위 값(closePrice·fluctuationsRatio)은 KRX 거래소 시세다 — NXT 는
   overMarketPriceInfo, 통합은 integratedPriceInfo 로 따로 온다(실시간 폴링 API 로 확인).
   그런데 KRX 시세 자체가 정규장 마감(15:30) 뒤 **시간외 단일가**(16:00~18:00, 16:10 부터
   10분마다 체결)로 움직이고, 밤늦게야 공식 종가로 돌아온다. 2026-09-28 18:09 석간은
   58종목 중 45종목을 공식 종가와 다르게 실었다 — 최대 1.16%p (S-Oil +4.24% vs +5.40%).
   첫 시간외 체결 전인 15:35~16:09 에는 최상위 값이 곧 공식 종가라 그때 떠 두고,
   18:00 석간이 그것을 쓴다 (lib/market-map-krclose.sh, 평일 15:45). */
export const KR_CLOSE_FILE = 'kr-close.json';
export const KR_CLOSE_WINDOW = { from: 1535, until: 1609 };

function kstNow(now) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: Number(`${p.hour}${p.minute}`) };
}

/** 지금 뜬 코스피 값이 공식 종가인가. session 은 krSessionOf 결과. */
export function krCloseSnapshotWindow(session, now = new Date()) {
  const k = kstNow(now);
  if (!session?.date || session.date !== k.date) return { ok: false, why: `오늘(${k.date}) KRX 세션이 없다 — 휴장` };
  if (session.open || k.hhmm < KR_CLOSE_WINDOW.from) return { ok: false, why: '정규장 종가가 아직 확정되지 않았다' };
  if (k.hhmm > KR_CLOSE_WINDOW.until) return { ok: false, why: '16:10 이후라 시간외 단일가가 섞였다' };
  return { ok: true, why: '' };
}

/**
 * 판이 실을 코스피·테마 값. 석간은 같은 세션의 종가 스냅샷이 있으면 그것을 쓴다.
 * 없으면 실시간 값으로 가되, 시간외 단일가가 섞일 시각이면 warn 을 단다 — 조용히 넘기지 않는다.
 */
export function pickKrForEdition({ edition, live, snapshot = null, now = new Date() }) {
  if (edition === 'evening' && snapshot?.krSession?.date && snapshot.krSession.date === live.krSession?.date) {
    return { kr: snapshot.kr, themes: snapshot.themes, krSession: snapshot.krSession, source: 'krx-close', fetchedAt: snapshot.fetchedAt ?? null, warn: null };
  }
  const k = kstNow(now);
  const afterHours = edition === 'evening' && live.krSession?.date === k.date && k.hhmm > KR_CLOSE_WINDOW.until;
  return {
    kr: live.kr, themes: live.themes, krSession: live.krSession,
    source: afterHours ? 'live-after-hours' : 'live', fetchedAt: null,
    warn: afterHours ? 'KRX 종가 스냅샷이 없다 — 코스피·테마에 시간외 단일가가 섞였을 수 있다 (15:45 market-map-krclose 확인)' : null,
  };
}

/** 코스피 세션 라벨. status 가 OPEN 이면 장중, 아니면 마감. 날짜는 응답이 정본. */
export function krSessionLabel(krSession, fallbackDate) {
  const date = krSession?.date || fallbackDate;
  // status 가 아니라 거래시간으로 판정한 open 을 쓴다 (위 주석 참조).
  return { date, text: krSession?.open ? '장중' : '15:30 마감' };
}

/**
 * 네이버 수집이 백오프 뒤에도 실패했을 때 대신 실을 코스피·테마. 없으면 null — 판을 실패로 둔다.
 * 오늘 15:45 KRX 종가 스냅샷이 있으면 그것(석간은 어차피 이걸 쓴다). 조간은 직전 유효 스냅샷을
 * 세션 라벨째로 끌어온다 — 08:00 엔 한국장이 안 열려 평소에도 직전 세션을 싣는다.
 * 석간은 코스피가 선도 시장이라 직전 값으로 대신하지 않는다: 오늘 아침 장중 값을 「석간」으로 내보내게 된다.
 */
export function krFallback({ edition, snapshot = null, priorKr = null, priorThemes = null }) {
  if (snapshot?.kr?.length && snapshot.krSession?.date) {
    return { kr: snapshot.kr, themes: snapshot.themes ?? [], krSession: snapshot.krSession, themesDate: null };
  }
  if (edition !== 'morning' || !priorKr?.kr?.length) return null;
  return {
    kr: priorKr.kr, themes: priorThemes?.themes ?? [],
    krSession: { ...priorKr.session, carried: true }, themesDate: priorThemes?.date ?? null,
  };
}

/** 네트워크 재시도 간격(ms). 0.7·1.4초로는 DarkWake 직후·순간 끊김을 못 넘겼다 — 1.5·3·6초. */
export const backoffMs = (attempt) => 1500 * 2 ** attempt;

/**
 * Chrome 을 띄운다. 실패하면 한 번만 다시 띄운다 (2026-10-20 조간: launch 180초 타임아웃으로 판 전체가 죽었다).
 * chromium 은 playwright-core 의 것을 넘긴다 — 테스트가 가짜를 넣을 수 있게.
 */
export async function launchChrome(chromium, { tries = 2, waitMs = 5000, log = console.warn, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let a = 1; ; a += 1) {
    try {
      return await chromium.launch({ channel: 'chrome', headless: true });
    } catch (e) {
      if (a >= tries) throw e;
      log(`⚠ Chrome 실행 실패 (${a}/${tries}) — ${String(e?.message ?? e).split('\n')[0]} · ${Math.round(waitMs / 1000)}초 뒤 다시 띄운다`);
      await wait(waitMs);
    }
  }
}
