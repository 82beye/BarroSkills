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
   하루 2회 발행(08:00 조간 / 20:00 석간)을 하면서 생긴 규약이다.
   한 회차는 **막 닫힌 시장**을 앞세우고, 아직 안 열린 시장은 직전 세션이라고 말한다. */

/** KST 시각 → 판. 08시 회차는 조간, 20시 회차는 석간. 수동 실행도 시각으로 자연스럽게 갈린다. */
export function resolveEdition(now = new Date()) {
  const hh = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit',
  }).format(now));
  return hh < 14 ? 'morning' : 'evening';
}

export const EDITIONS = {
  // leads = 그 회차에 막 마감한 시장. 카드 순서와 표지 문구가 여기를 따른다.
  morning: { label: '조간', at: '08:00', leads: 'us' },
  evening: { label: '석간', at: '20:00', leads: 'kr' },
};

/**
 * 코스피 세션을 **응답에서** 읽는다. 시계로 추측하지 않는다.
 *
 * 08:00 회차에는 한국장이 아직 안 열렸다. KST 날짜로 라벨을 찍으면
 * "2026-09-17 15:30 마감"처럼 오지 않은 마감을 적게 된다 — EP-0157 의
 * 197일 전 기사 사고와 같은 계열이다. 네이버 응답의 localTradedAt(마지막 체결)과
 * marketStatus 가 세션을 그대로 알려주므로 그것만 쓴다.
 */
export function krSessionOf(stocks) {
  const s = (stocks ?? []).find((x) => x?.localTradedAt) ?? null;
  return {
    date: s?.localTradedAt ? String(s.localTradedAt).slice(0, 10) : null,
    status: s?.marketStatus ?? null,
  };
}

/** 코스피 세션 라벨. status 가 OPEN 이면 장중, 아니면 마감. 날짜는 응답이 정본. */
export function krSessionLabel(krSession, fallbackDate) {
  const date = krSession?.date || fallbackDate;
  return { date, text: krSession?.status === 'OPEN' ? '장중' : '15:30 마감' };
}
