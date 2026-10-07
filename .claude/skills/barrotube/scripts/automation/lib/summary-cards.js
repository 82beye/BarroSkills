/**
 * summary-cards.js — 「미국 증시 요약」 씬 1 지수 요약 카드 (세로 1080×1920).
 *
 * 화면은 쇼츠와 같다 — 마시 컷이 기본이고, 데이터 화면은 이 카드 한 장뿐이다(운영자 지시
 * 2026-10-01). 순수 함수만 둔다 — 데이터 수집·캡처는 render-summary-cards.js 가 한다.
 *
 * 배치: 위 14% 는 쇼츠 UI, 아래 480px 위로는 자막(lib/caption-composition.js SAFE_BOTTOM)이
 * 쌓이므로 지수 정보는 그 사이 띠에 둔다.
 * 색: 상승 초록·하락 빨강(Finviz 관례) — 마켓맵(lib/market-map.js)과 같게.
 */

import { join, resolve } from 'node:path';

const FONT_DIR = resolve(import.meta.dirname, '../../../assets/fonts');
export const W = 1080;
export const H = 1920;

const C = { bg: '#0D1B2A', panel: '#13263D', text: '#FFFFFF', sub: '#9FB3C8', accent: '#F4A261', up: '#16A34A', down: '#DC2626', flat: '#64748B' };

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function signPct(p, digits = 2) {
  if (!Number.isFinite(p)) return '—';
  return `${p > 0 ? '+' : ''}${p.toFixed(digits)}%`;
}
const tone = (p) => (!Number.isFinite(p) || Math.abs(p) < 0.005 ? C.flat : p > 0 ? C.up : C.down);
const arrow = (p) => (!Number.isFinite(p) || Math.abs(p) < 0.005 ? '' : p > 0 ? '▲' : '▼');

/** 기록 배지 — 사상 최고치 지수에만. 그날의 사건이 카드에서도 먼저 보이게 한다(2026-10-07). */
export function recordBadge(record) {
  if (!record?.all_time_high) return '';
  const label = `사상 최고${record.streak >= 2 ? ` · ${record.streak}일 연속` : ''}`;
  return ` <span style="display:inline-block;margin-left:18px;padding:4px 18px;border-radius:999px;background:${C.accent};color:${C.bg};font-size:36px;font-weight:900;vertical-align:middle">${esc(label)}</span>`;
}

/** 3대 지수 요약 카드. items: [{name, price_text, change_pct, record?}], dateLabel: "미국 2026.09.30 (수) 마감" */
export function indicesCard({ items, dateLabel, series = '미국 증시 요약' }) {
  const tiles = items.map((i) => `<div style="background:${C.panel};border-radius:32px;padding:34px 44px;border-left:14px solid ${tone(i.change_pct)}">
  <div style="font-size:46px;color:${C.sub}">${esc(i.name)}${recordBadge(i.record)}</div>
  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:6px">
    <span style="font-size:84px;font-weight:900;letter-spacing:-1px">${esc(i.price_text)}</span>
    <span style="font-size:64px;font-weight:900;color:${tone(i.change_pct)}">${arrow(i.change_pct)}${signPct(i.change_pct)}</span></div></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'NSK';font-weight:700;src:url('file://${join(FONT_DIR, 'NotoSansKR-Bold.otf')}')}
@font-face{font-family:'NSK';font-weight:900;src:url('file://${join(FONT_DIR, 'NotoSansKR-Black.otf')}')}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;height:${H}px;overflow:hidden;background:${C.bg};color:${C.text};font-family:'NSK',sans-serif;font-weight:700}
#card{position:relative;width:${W}px;height:${H}px;overflow:hidden}
</style></head><body><div id="card">
<div style="position:absolute;left:64px;right:64px;top:300px">
  <div style="font-size:40px;color:${C.accent};font-weight:900">바로경제</div>
  <div style="font-size:92px;font-weight:900;letter-spacing:-2px;margin-top:4px">${esc(series)}</div>
  <div style="font-size:40px;color:${C.sub};margin-top:8px">${esc(dateLabel)}</div>
</div>
<div style="position:absolute;left:64px;right:64px;top:600px;display:flex;flex-direction:column;gap:30px">${tiles}</div>
</div></body></html>`;
}
