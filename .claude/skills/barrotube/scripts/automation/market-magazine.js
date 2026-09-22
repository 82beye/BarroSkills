#!/usr/bin/env node

/**
 * market-magazine.js — 마켓맵 데이터를 **밝은 카드뉴스 10장**으로 조판한다.
 *
 * 왜 이 모양인가
 * ──────────────
 * market-map.js 는 어두운 포스터 3장을 찍는다. 각 장이 제 머리말을 다시 달고 서로를
 * 참조하지 않아 "단산 한장 한장"이라는 지적을 받았다(2026-09-17). 1차로 5면짜리
 * 어두운 매거진을 짰고, 운영자가 다시 **카드뉴스 + 밝은 테마**를 지시했다.
 *
 * 카드뉴스의 규칙은 매거진과 다르다 — 한 장에 메시지 하나, 활자는 크게, 여백은 넓게,
 * 장마다 같은 자리에 진행 표시. 밀도를 버리고 스와이프 가능성을 산다.
 * 그래서 면은 5 → 10 으로 늘고, 각 장이 담는 정보는 줄었다.
 *
 * 산출: <outdir>/magazine/*.dc.html + canvas.json  (1080×1350, 10장)
 * 입력은 market-map.js 가 이미 쓴 data.json 하나. 수집을 다시 하지 않는다.
 *
 * Usage:  node market-magazine.js [--date 2026-09-16]
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getSecret } from './config-loader.js';
import {
  groupedTreemap, resolveEdition, EDITIONS, krSessionLabel,
} from './lib/market-map.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'market-map.json'), 'utf-8'));

/* ── 밝은 테마 토큰 ─────────────────────────────────────────────────────
   브랜드 강조색 #FF9A1F 는 그대로 쓰되, 흰 종이 위 **글자**로는 명도대비가
   2:1 밖에 안 나와 읽히지 않는다. 그래서 채움(막대·칩·괘선)은 gold,
   글자는 어둡게 내린 goldInk 로 나눈다. */
const T = {
  paper: '#F5F6F8', paperAlt: '#EBEEF2', card: '#FFFFFF',
  ink: '#0E1620', body: '#3B4757', muted: '#77859A', faint: '#9AA6B6',
  hair: '#D9DEE5',
  gold: '#FF9A1F', goldInk: '#A55B00', goldSoft: '#FFF1DF',
  up: '#10864A', down: '#C0302F',
};
const FD = "'Hahmlet','Nanum Myeongjo','Apple SD Gothic Neo',serif";
const FB = "'IBM Plex Sans KR','Apple SD Gothic Neo',-apple-system,sans-serif";

const W = 1080; const H = 1350; const M = 72;
const EPOCH = '2026-09-16';
const TOTAL = 10;

/** 업종명 → 개념. 미국 어휘와 코스피 어휘가 달라서, 양끝이 같은 산업인지 판정하려면
 *  사람이 관리하는 표가 필요하다. 정본은 config/market-map.json 의 cross_market_concepts. */
const CONCEPT = (() => {
  const m = {};
  for (const [c, names] of Object.entries(CFG.cross_market_concepts ?? {})) {
    if (c.startsWith('_')) continue;
    for (const n of names) m[n] = c;
  }
  return m;
})();

/* ── 유틸 ──────────────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fpct = (p) => (Number.isFinite(p) ? `${p >= 0 ? '+' : ''}${p.toFixed(2)}%` : '—');
const fnum = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '—');
const upc = (p) => (p >= 0 ? T.up : T.down);
const DAY = '일월화수목금토';
const fdate = (iso) => `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}(${DAY[new Date(`${iso}T12:00:00+09:00`).getUTCDay()]})`;
const short = (name) => String(name).replace(/\(.*\)/, '').trim();
const issueNo = (iso) => Math.floor((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / 86400_000) + 1;

/** 밝은 지면용 히트맵 색. lib 의 pctColor 는 어두운 판(중성 #3A4560)에서 출발해
 *  흰 종이 위에서는 탁하다. 여기선 옅은 회색에서 출발하고, 채도 최대에서도
 *  어두운 글자(#0B1118)가 8:1 이상으로 읽히는 선에서 멈춘다. */
function pctColorLight(pct, clamp = 3) {
  if (pct === null || !Number.isFinite(pct)) return '#E7EAEE';
  const t = Math.max(-1, Math.min(1, pct / clamp));
  const g = Math.pow(Math.abs(t), 0.6);
  const mix = (from, to) => Math.round(from + (to - from) * g);
  if (t >= 0) return `rgb(${mix(231, 46)},${mix(234, 178)},${mix(238, 112)})`;
  return `rgb(${mix(231, 228)},${mix(234, 100)},${mix(238, 96)})`;
}

/** 미국 세션 라벨 — 수집 시각 기준. 렌더 시각으로 재면 장중 수치에 '마감'이 붙는다. */
function usSessionLabel(sessionDate, collectedAt) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(collectedAt).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  const etDate = `${p.year}-${p.month}-${p.day}`;
  const mins = Number(p.hour) * 60 + Number(p.minute);
  if (sessionDate === etDate && mins >= 570 && mins < 960) return `장중 ${p.hour}:${p.minute} ET`;
  if (sessionDate === etDate && mins < 570) return '프리마켓';
  return '마감';
}

/* ── 사실 추출 ─────────────────────────────────────────────────────────── */
function facts(d, collectedAt, edition) {
  const krGroupOf = {};
  for (const [g, m] of Object.entries(CFG.kr.groups ?? {})) {
    if (g.startsWith('_')) continue;
    for (const c of Object.keys(m)) krGroupOf[c] = g;
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ladder = (rows, keyOf) => {
    const by = {};
    for (const r of rows) (by[keyOf(r)] ??= []).push(r.pct);
    return Object.entries(by).map(([name, ps]) => ({ name, pct: avg(ps), n: ps.length }))
      .sort((a, b) => b.pct - a.pct);
  };
  // 대표 묶음은 3종목 이상인 것만. 하드웨어(AAPL·DELL 2종목) 평균을 12종목 반도체와
  // 같은 자로 세우면 「맨 위가 무엇인가」가 표본 크기로 뒤집힌다.
  const MIN_N = 3;
  const repLead = (rows) => rows.find((r) => r.n >= MIN_N) ?? rows[0];
  const repTail = (rows) => [...rows].reverse().find((r) => r.n >= MIN_N) ?? rows[rows.length - 1];

  const us = [...d.us].sort((a, b) => b.pct - a.pct);
  const kr = [...d.kr].sort((a, b) => b.pct - a.pct);
  const usLadder = ladder(d.us, (u) => u.sec);
  const krLadder = ladder(d.kr, (k) => krGroupOf[k.key] ?? '기타');

  // 상위 테마들이 공유하는 종목 — 이번 호의 핵심을 만드는 계산
  const seen = new Map();
  for (const t of d.themes) for (const s of t.stocks) {
    if (!seen.has(s.name)) seen.set(s.name, { name: s.name, pct: s.pct, themes: [] });
    seen.get(s.name).themes.push(short(t.name));
  }
  const shared = [...seen.values()].filter((s) => s.themes.length >= 2)
    .sort((a, b) => b.themes.length - a.themes.length || b.pct - a.pct);

  const krLabel = krSessionLabel(d.krSession, d.date);
  const usLead = repLead(usLadder); const usTail = repTail(usLadder);
  const krLead = repLead(krLadder); const krTail = repTail(krLadder);
  // 「두 시장이 같은 순서」는 양끝이 같은 개념으로 떨어질 때만 말한다.
  // 문자열이 달라도(에너지 / 정유·해운) 같은 산업일 수 있어 표를 거친다.
  const cLeadUs = CONCEPT[usLead.name]; const cLeadKr = CONCEPT[krLead.name];
  const cTailUs = CONCEPT[usTail.name]; const cTailKr = CONCEPT[krTail.name];
  const sameOrder = Boolean(cLeadUs && cLeadUs === cLeadKr && cTailUs && cTailUs === cTailKr);

  return {
    date: d.date, idx: d.idx, themes: d.themes, MIN_N, krLabel,
    sameOrder, conceptLead: cLeadUs, conceptTail: cTailUs,
    usTop: us.slice(0, 4), usBot: us.slice(-4).reverse(),
    krTop: kr.slice(0, 4), krBot: kr.slice(-4).reverse(),
    usLadder, krLadder, krGroupOf, shared,
    sharedNames: new Set(shared.map((s) => s.name)),
    usLead, usTail, krLead, krTail,
    thinGroups: [...usLadder, ...krLadder].filter((r) => r.n < MIN_N),
    usSpread: us[0].pct - us[us.length - 1].pct,
    usLabel: usSessionLabel(d.usSession ?? d.date, collectedAt),
    usSession: d.usSession ?? d.date,
    collectedAt, no: issueNo(d.date),
    edition, ed: EDITIONS[edition],
  };
}

/* ── 카드 공통 틀 ──────────────────────────────────────────────────────── */

/** 위 띠: 브랜드 + 날짜. 열 장 내내 같은 자리다. */
function topbar(f) {
  return `<div style="padding:52px ${M}px 0">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid ${T.hair};padding-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="width:10px;height:10px;background:${T.gold};border-radius:50%"></span>
        <span style="color:${T.ink};font-size:21px;font-weight:600;letter-spacing:-.01em">바로경제 마켓맵</span>
        <span style="color:${T.goldInk};font-size:18px;font-weight:700;border:1px solid ${T.hair};padding:2px 9px">${esc(f.ed.label)}</span>
      </div>
      <span style="color:${T.muted};font-size:20px;font-variant-numeric:tabular-nums">${fdate(f.date)}</span>
    </div>
  </div>`;
}

/** 아래 띠: 진행 막대 + 몇 번째 장인지. 스와이프 덱이라는 신호. */
function bottombar(n) {
  const segs = Array.from({ length: TOTAL }, (_, i) => `<span style="flex:1;height:5px;background:${i === n - 1 ? T.gold : T.hair}"></span>`).join('');
  return `<div style="padding:0 ${M}px 52px">
    <div style="display:flex;gap:5px;margin-bottom:16px">${segs}</div>
    <div style="display:flex;align-items:baseline;justify-content:space-between">
      <span style="color:${T.faint};font-size:19px">@바로경제 · 매일 08 · 12 · 18시</span>
      <span style="color:${T.muted};font-size:20px;font-weight:600;font-variant-numeric:tabular-nums">${String(n).padStart(2, '0')} / ${TOTAL}</span>
    </div>
  </div>`;
}

const kicker = (s) => `<div style="color:${T.goldInk};font-size:21px;font-weight:700;letter-spacing:.2em">${esc(s)}</div>`;
const h1 = (s, px = 66) => `<h1 style="font-family:${FD};color:${T.ink};font-size:${px}px;font-weight:800;line-height:1.18;letter-spacing:-.035em;margin:18px 0 0;text-wrap:balance">${s}</h1>`;
const lede = (s) => `<p style="color:${T.body};font-size:27px;line-height:1.62;margin:22px 0 0;text-wrap:pretty">${s}</p>`;
const strong = (s) => `<b style="color:${T.ink};font-weight:600">${esc(s)}</b>`;
const spacer = '<div style="flex:1 1 auto"></div>';
/** 위·아래 띠 사이를 채우고 내용을 세로 가운데로. 장마다 분량이 달라도 균형이 잡힌다. */
const mid = (s) => `<div style="flex:1 1 auto;display:flex;flex-direction:column;justify-content:center;min-height:0">${s}</div>`;

const doc = (bodyHTML) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hahmlet:wght@400;600;700;800;900&family=IBM+Plex+Sans+KR:wght@300;400;500;600;700&display=swap">
  <style>
    body { margin: 0; background: ${T.paperAlt}; font-family: ${FB}; }
    h1, h2, p { margin: 0; }
    a { color: ${T.goldInk}; text-decoration: none; }
    a:hover { color: ${T.gold}; }
  </style>
</helmet>
<div style="width:${W}px;height:${H}px;background:${T.paper};color:${T.body};font-family:${FB};display:flex;flex-direction:column;overflow:hidden">
${bodyHTML}
</div>
</x-dc>
</body>
</html>
`;

/** 큰 수치 한 줄 — 이름 / 값 / 등락. 카드뉴스의 기본 단위. */
function bigRow(name, value, pct, { sub = '' } = {}) {
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:20px;padding:25px 0;border-top:1px solid ${T.hair};font-variant-numeric:tabular-nums">
    <span style="display:flex;align-items:baseline;gap:12px;min-width:0">
      <span style="color:${T.ink};font-size:34px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span>
      ${sub ? `<span style="color:${T.faint};font-size:19px;white-space:nowrap">${esc(sub)}</span>` : ''}
    </span>
    <span style="display:flex;align-items:baseline;gap:20px;flex:0 0 auto">
      ${value ? `<span style="color:${T.ink};font-size:37px;font-weight:500">${esc(value)}</span>` : ''}
      <span style="color:${upc(pct)};font-size:37px;font-weight:700;width:172px;text-align:right">${fpct(pct)}</span>
    </span>
  </div>`;
}

/** 오른 쪽 / 내린 쪽 두 칸. */
function twoLists(a, b) {
  const col = (title, color, rows) => `<div>
      <div style="display:flex;align-items:center;gap:9px;padding-bottom:12px;border-bottom:2px solid ${color}">
        <span style="color:${color};font-size:22px;font-weight:700;letter-spacing:.06em">${esc(title)}</span>
      </div>
      <div>${rows}</div>
    </div>`;
  const rows = (list, key) => list.map((x) => `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:22px 0;border-bottom:1px solid ${T.hair};font-variant-numeric:tabular-nums">
      <span style="color:${T.ink};font-size:30px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x[key] ?? x.t)}</span>
      <b style="color:${upc(x.pct)};font-size:30px;font-weight:700;flex:0 0 auto">${fpct(x.pct)}</b>
    </div>`).join('');
  return `<div style="padding:34px ${M}px 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:34px">
    ${col('올랐다', T.up, rows(a.list, a.key))}
    ${col('내렸다', T.down, rows(b.list, b.key))}
  </div>`;
}

/** 히트맵 판 — 전면 재단, 밝은 지면용 색. */
function plate(groups, { h, clamp, compact }) {
  const headerPx = compact ? 28 : 26;
  const map = groupedTreemap(groups, { x: 0, y: 0, w: W, h }, { headerPx });
  const sectors = map.sectors.map((s) => `<div style="position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;border:1px solid ${T.paper}"><div style="position:absolute;top:0;left:0;right:0;height:${headerPx}px;background:#DDE2E9;color:#55637A;font-size:16px;font-weight:600;letter-spacing:.02em;padding:${compact ? 5 : 4}px 10px;white-space:nowrap;overflow:hidden">${esc(s.name)}</div></div>`).join('\n      ');
  const cells = map.cells.map((c) => {
    const box = `position:absolute;left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;background:${pctColorLight(c.pct, clamp)};border:1px solid ${T.paper}`;
    if (c.w < 32 || c.h < 18) return `<div style="${box}"></div>`;
    const lbl = String(c.label ?? c.key);
    // 한글은 글자폭이 거의 1em, 라틴 티커는 0.62em 쯤이다.
    const em = /[가-힣]/.test(lbl) ? 1.0 : 0.62;
    const byWidth = (c.w - 10) / Math.max(1, lbl.length * em);
    const fs = Math.max(11, Math.min(32, Math.sqrt(c.w * c.h) / (compact ? 5.2 : 6.0), byWidth));
    const showPct = c.h >= 40 && c.w >= 50;
    return `<div style="${box};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;overflow:hidden;padding:0 3px">`
      + `<span style="color:#0B1118;font-weight:700;font-size:${fs.toFixed(0)}px;line-height:1.02;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:clip">${esc(lbl)}</span>`
      + (showPct ? `<span style="color:#233041;font-weight:600;font-size:${Math.max(12, fs * 0.58).toFixed(0)}px;font-variant-numeric:tabular-nums">${fpct(c.pct)}</span>` : '')
      + '</div>';
  }).join('\n      ');
  return `<div style="position:relative;width:${W}px;height:${h}px;background:${T.paperAlt};overflow:hidden">
      ${sectors}
      ${cells}
    </div>`;
}

function legend(text, clamp) {
  const sw = [-clamp, -clamp / 2, 0, clamp / 2, clamp]
    .map((p) => `<span style="width:34px;height:13px;background:${pctColorLight(p, clamp)}"></span>`).join('');
  return `<div style="padding:22px ${M}px 0;display:flex;align-items:center;justify-content:space-between;gap:22px">
    <span style="color:${T.muted};font-size:20px">${esc(text)}</span>
    <span style="display:flex;align-items:center;gap:9px;color:${T.faint};font-size:17px;font-variant-numeric:tabular-nums">
      <span>−${clamp.toFixed(0)}%</span><span style="display:flex;gap:1px;border:1px solid ${T.hair}">${sw}</span><span>+${clamp.toFixed(0)}%</span>
    </span>
  </div>`;
}

/* ── 열 장 ─────────────────────────────────────────────────────────────── */

function cardCover(f, n) {
  // 조간은 미국 마감, 석간은 코스피 마감이 기준이다 — 표지는 그 시장의 결과로 연다.
  const us = f.ed.leads === 'us';
  const lead = us ? f.usLead : f.krLead;
  const tail = us ? f.usTail : f.krTail;
  const longest = Math.max(lead.name.length, tail.name.length) + 3;
  const px = longest <= 8 ? 100 : longest <= 10 ? 88 : 76;
  const cover = {
    kicker: us ? `미국 증시 ${f.usLabel.split(' ')[0]}` : `코스피 ${f.krLabel.text.replace('15:30 ', '')}`,
    lead, tail, px,
    deck: us
      ? `나스닥 ${strong(fpct(f.idx.nasdaq?.pct))} · S&amp;P500 ${strong(fpct(f.idx.sp500?.pct))}.<br>`
        + `지수 안에서 위아래가 ${strong(`${f.usSpread.toFixed(1)}%p`)} 벌어졌습니다.`
      : `코스피 ${strong(fnum(f.idx.kospi?.price))} ${strong(fpct(f.idx.kospi?.pct))} · 코스닥 ${strong(fpct(f.idx.kosdaq?.pct))}.<br>`
        + `오늘 1위 테마는 ${strong(`${short(f.themes[0].name)} ${fpct(f.themes[0].pct)}`)}입니다.`,
  };
  return doc(`
  <div style="padding:64px ${M}px 0">
    <div style="display:flex;align-items:center;gap:14px">
      <span style="background:${T.gold};color:#241300;font-size:20px;font-weight:700;padding:8px 16px;letter-spacing:.06em">마켓맵 제${f.no}호 ${esc(f.ed.label)}</span>
      <span style="color:${T.muted};font-size:21px;font-variant-numeric:tabular-nums">${fdate(f.date)}</span>
    </div>
  </div>
  ${mid(`
  <div style="padding:0 ${M}px">
    ${kicker(cover.kicker)}
    <h1 style="font-family:${FD};color:${T.ink};font-size:${cover.px}px;font-weight:900;line-height:1.1;letter-spacing:-.05em;margin:24px 0 0">위는 ${esc(cover.lead.name)}<br>아래는 ${esc(cover.tail.name)}</h1>
    <div style="width:130px;height:8px;background:${T.gold};margin-top:34px"></div>
    <p style="color:${T.body};font-size:30px;line-height:1.6;margin:34px 0 0;text-wrap:pretty">
      ${cover.deck}
    </p>
  </div>
  `)}
  <div style="padding:0 ${M}px 30px">
    <div style="border-top:1px solid ${T.hair};padding-top:26px;display:flex;align-items:baseline;justify-content:space-between">
      <span style="color:${T.goldInk};font-size:25px;font-weight:600">10장으로 정리했습니다</span>
      <span style="color:${T.faint};font-size:25px">→</span>
    </div>
  </div>
  ${bottombar(n)}`);
}

function cardIndices(f, n) {
  // 어느 쪽이 아직 거래 중인지는 라벨에서 읽는다 — 문장을 고정해두면 반대 상황에서 거짓이 된다.
  const usLive = /장중|프리마켓/.test(f.usLabel);
  const krLive = f.krLabel.text === '장중';
  const sessionNote = usLive ? '미국은 아직 거래 중이라 마감치가 아닙니다.'
    : krLive ? '코스피는 아직 거래 중이라 마감치가 아닙니다.'
      : '둘 다 마감 수치입니다.';
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:34px ${M}px 0">
    ${kicker('오늘의 숫자')}
    ${h1('지수는 넷 다 올랐습니다', 62)}
  </div>
  <div style="padding:34px ${M}px 0">
    ${bigRow('코스피', fnum(f.idx.kospi?.price), f.idx.kospi?.pct)}
    ${bigRow('코스닥', fnum(f.idx.kosdaq?.price), f.idx.kosdaq?.pct)}
    ${bigRow('나스닥', fnum(f.idx.nasdaq?.price), f.idx.nasdaq?.pct)}
    ${bigRow('S&P500', fnum(f.idx.sp500?.price), f.idx.sp500?.pct)}
    <div style="border-top:1px solid ${T.hair}"></div>
  </div>
  <div style="padding:34px ${M}px 0">
    <div style="background:${T.goldSoft};border-left:5px solid ${T.gold};padding:22px 26px">
      <p style="color:${T.body};font-size:24px;line-height:1.56">
        미국 <b style="color:${T.ink};font-weight:600">${esc(f.usSession)} ${esc(f.usLabel)}</b> ·
        코스피 <b style="color:${T.ink};font-weight:600">${esc(f.krLabel.date)} ${esc(f.krLabel.text)}</b> 기준입니다.
        ${esc(sessionNote)}
      </p>
    </div>
  </div>
  `)}
  ${bottombar(n)}`);
}

function cardUsMovers(f, n) {
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:34px ${M}px 0">
    ${kicker('미국')}
    ${h1(`위는 ${esc(f.usLead.name)},<br>아래는 ${esc(f.usTail.name)}`, 64)}
  </div>
  ${twoLists({ list: f.usTop, key: 't' }, { list: f.usBot, key: 't' })}
  <div style="padding:34px ${M}px 0">
    ${lede(`나스닥은 ${strong(fpct(f.idx.nasdaq?.pct))}. 지수만 보면 조용한 날이지만, 그 안의 위아래 폭은 ${strong(`${f.usSpread.toFixed(1)}%p`)}였습니다.`)}
  </div>
  `)}
  ${bottombar(n)}`);
}

function cardUsMap(f, d, n) {
  const groups = Object.entries(CFG.us.sectors).map(([name, m]) => ({
    name, items: d.us.filter((u) => u.sec === name).map((u) => ({ key: u.t, label: u.t, size: m[u.t] ?? 0, pct: u.pct })),
  }));
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:30px ${M}px 0">
    ${kicker('미국 마켓맵')}
    ${h1('대형주 84종목을 한 판에', 54)}
  </div>
  <div style="padding:30px 0 0">${plate(groups, { h: 700, clamp: CFG.us.clamp_pct, compact: false })}</div>
  ${legend(`칸 크기 = 시가총액 · 색 = 등락률 · ${f.usSession} ${f.usLabel}`, CFG.us.clamp_pct)}
  `)}
  ${bottombar(n)}`);
}

function cardKrMovers(f, n) {
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:34px ${M}px 0">
    ${kicker('코스피')}
    ${h1(`위는 ${esc(f.krLead.name)},<br>아래는 ${esc(f.krTail.name)}`, 64)}
  </div>
  ${twoLists({ list: f.krTop, key: 'label' }, { list: f.krBot, key: 'label' })}
  <div style="padding:34px ${M}px 0">
    ${lede(`${esc(f.krLabel.date)} ${esc(f.krLabel.text)} 기준입니다. `
      + (f.sameOrder
        ? `뉴욕에서 본 배열, 즉 ${strong(`${f.conceptLead}가 위 · ${f.conceptTail}가 아래`)}가 그대로 반복됐습니다.`
        : `같은 시각 미국은 ${strong(`${f.usLead.name} 위 · ${f.usTail.name} 아래`)}였습니다.`))}
  </div>
  `)}
  ${bottombar(n)}`);
}

function cardKrMap(f, d, n) {
  const byG = {};
  for (const k of d.kr) {
    const g = f.krGroupOf[k.key] ?? '기타';
    (byG[g] ??= []).push({ ...k, size: Math.pow(k.size, 0.6) });
  }
  const groups = Object.entries(byG).map(([name, items]) => ({ name, items }));
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:30px ${M}px 0">
    ${kicker('코스피 마켓맵')}
    ${h1(`시총 상위 ${d.kr.length}종목, 테마별로`, 54)}
  </div>
  <div style="padding:30px 0 0">${plate(groups, { h: 700, clamp: CFG.kr.clamp_pct, compact: true })}</div>
  ${legend(`칸 크기 ∝ 시가총액 · 색 = 등락률 · ${f.krLabel.date} ${f.krLabel.text}`, CFG.kr.clamp_pct)}
  `)}
  ${bottombar(n)}`);
}

function cardThemes(f, n) {
  const top = f.themes[0];
  const rows = f.themes.map((t) => bigRow(short(t.name), '', t.pct, { sub: `${t.total}중 ${t.rise}↑` })).join('');
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:34px ${M}px 0">
    ${kicker('오늘의 테마')}
    <div style="display:flex;align-items:baseline;gap:22px;margin-top:18px;flex-wrap:wrap">
      <h1 style="font-family:${FD};color:${T.ink};font-size:66px;font-weight:800;line-height:1.1;letter-spacing:-.035em">${esc(short(top.name))}</h1>
      <span style="color:${T.up};font-size:66px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.02em">${fpct(top.pct)}</span>
    </div>
  </div>
  <div style="padding:30px ${M}px 0">
    <div style="color:${T.muted};font-size:20px;font-weight:600;letter-spacing:.14em;padding-bottom:6px">상승률 상위 6개 테마</div>
    ${rows}
    <div style="border-top:1px solid ${T.hair}"></div>
  </div>
  `)}
  ${bottombar(n)}`);
}

function cardShared(f, n) {
  const rows = f.shared.slice(0, 6).map((s) => `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:23px 0;border-top:1px solid ${T.hair};font-variant-numeric:tabular-nums">
      <span style="display:flex;align-items:baseline;gap:13px;min-width:0">
        <span style="background:${T.gold};color:#241300;font-size:18px;font-weight:700;padding:3px 10px;flex:0 0 auto">${s.themes.length}개</span>
        <span style="color:${T.ink};font-size:33px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span>
      </span>
      <b style="color:${upc(s.pct)};font-size:33px;font-weight:700;flex:0 0 auto">${fpct(s.pct)}</b>
    </div>`).join('');
  const names = f.themes.filter((t) => t.stocks.some((s) => f.sharedNames.has(s.name)))
    .slice(0, 3).map((t) => short(t.name));
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:34px ${M}px 0">
    ${kicker('이게 오늘의 핵심')}
    ${h1(`${f.shared.length}종목이<br>상위 테마를 함께 올렸습니다`, 62)}
  </div>
  <div style="padding:30px ${M}px 0">${rows}<div style="border-top:1px solid ${T.hair}"></div></div>
  <div style="padding:30px ${M}px 0">
    ${lede(`${strong(names.join(' · '))} — 이름은 다르지만 구성종목이 겹칩니다. 테마 여러 개가 오른 게 아니라, ${strong('한 거래가 여러 이름으로 집계된 것')}에 가깝습니다.`)}
  </div>
  `)}
  ${bottombar(n)}`);
}

function cardSameOrder(f, n) {
  const cell = (label, row, color) => `<div style="padding:34px 32px;background:${T.card};border:1px solid ${T.hair}">
      <div style="color:${T.muted};font-size:19px;font-weight:600;letter-spacing:.1em">${esc(label)}</div>
      <div style="color:${T.ink};font-family:${FD};font-size:44px;font-weight:800;letter-spacing:-.03em;margin-top:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(row.name)}</div>
      <div style="color:${color};font-size:38px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:8px">${fpct(row.pct)}</div>
    </div>`;
  return doc(`
  ${topbar(f)}
  ${mid(`
  <div style="padding:34px ${M}px 0">
    ${kicker('정리하면')}
    ${h1('두 시장을 같은 자로<br>세워봤습니다', 62)}
  </div>
  <div style="padding:34px ${M}px 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px">
    <div style="color:${T.goldInk};font-size:23px;font-weight:700;letter-spacing:.1em">미국 · 업종 평균</div>
    <div style="color:${T.goldInk};font-size:23px;font-weight:700;letter-spacing:.1em">코스피 · 묶음 평균</div>
    ${cell('맨 위', f.usLead, T.up)}
    ${cell('맨 위', f.krLead, T.up)}
    ${cell('맨 아래', f.usTail, T.down)}
    ${cell('맨 아래', f.krTail, T.down)}
  </div>
  <div style="padding:30px ${M}px 0">
    ${lede(`미국 ${strong(`${f.usLadder.length}개 업종`)}, 코스피 ${strong(`${f.krLadder.length}개 묶음`)}의 평균 등락률입니다. 3종목 미만 묶음(${esc(f.thinGroups.map((r) => `${r.name} ${r.n}`).join(' · '))})은 평균이 흔들려 대표에서 뺐습니다.`)}
  </div>
  `)}
  ${bottombar(n)}`);
}

function cardOutro(f, n) {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit' }).format(f.collectedAt);
  const stamp = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(f.collectedAt)} ${hm} KST`;
  const line = (n, s) => `<div style="display:flex;align-items:baseline;gap:18px;padding:26px 0;border-top:1px solid ${T.hair}">
      <span style="color:${T.gold};font-family:${FD};font-size:34px;font-weight:800;flex:0 0 auto;font-variant-numeric:tabular-nums">${n}</span>
      <span style="color:${T.ink};font-size:29px;line-height:1.52">${s}</span>
    </div>`;
  return doc(`
  ${topbar(f)}
  <div style="padding:34px ${M}px 0">
    ${kicker('세 줄 요약')}
    ${h1('오늘 장, 이렇게 읽으면 됩니다', 58)}
  </div>
  <div style="padding:26px ${M}px 0">
    ${line(1, `지수는 넷 다 올랐지만, 오른 곳과 내린 곳의 차이가 ${strong(`${f.usSpread.toFixed(1)}%p`)}로 컸습니다.`)}
    ${line(2, f.sameOrder
      ? `${strong(`${f.conceptLead}가 위, ${f.conceptTail}가 아래`)} — 뉴욕과 서울이 같은 순서였습니다.`
      : `미국은 ${strong(`${f.usLead.name} 위 · ${f.usTail.name} 아래`)}, 코스피는 ${strong(`${f.krLead.name} 위 · ${f.krTail.name} 아래`)}였습니다.`)}
    ${line(3, `상위 테마 6개 중 여럿이 ${strong(`같은 ${f.shared.length}종목`)}으로 올랐습니다.`)}
    <div style="border-top:1px solid ${T.hair}"></div>
  </div>
  ${spacer}
  <div style="padding:0 ${M}px 0">
    <div style="background:${T.ink};padding:30px 32px;display:flex;align-items:center;justify-content:space-between;gap:20px">
      <div>
        <div style="font-family:${FD};color:#FFFFFF;font-size:34px;font-weight:800;letter-spacing:-.025em">내일도 이 자리에서</div>
        <div style="color:#AEBAC9;font-size:22px;margin-top:8px;line-height:1.5">궁금한 종목은 댓글에 남겨주세요<br>— 다음 호 판에 넣습니다</div>
      </div>
      <span style="background:${T.gold};color:#241300;font-size:24px;font-weight:700;padding:14px 22px;flex:0 0 auto">구독</span>
    </div>
    <div style="color:${T.faint};font-size:17px;line-height:1.6;margin-top:18px">
      출처 · 미국 Yahoo Finance, 국내 네이버증권 집계 &nbsp;|&nbsp; 수집 · ${esc(stamp)}<br>
      미국 ${esc(f.usSession)} ${esc(f.usLabel)} · 코스피 ${esc(f.krLabel.date)} ${esc(f.krLabel.text)} &nbsp;|&nbsp; 투자 판단의 책임은 투자자 본인에게 있습니다.
    </div>
  </div>
  ${bottombar(n)}`);
}

/* ── PNG 렌더 ──────────────────────────────────────────────────────────── */

/** 카드 열 장을 한 문서에 깔고 한 장씩 캡처한다. 폰트가 다 뜬 뒤에 찍어야
 *  Hahmlet 대신 폴백이 박힌 이미지가 나가지 않는다. */
async function renderPNGs(cards, outDir) {
  const { chromium } = await import('playwright-core');
  const first = cards[0][1];
  const helmet = first.split('<helmet>')[1].split('</helmet>')[0];
  const bodies = cards.map(([, html], i) => {
    const inner = html.split('<x-dc>')[1].split('</x-dc>')[0];
    return `<div id="c${i + 1}">${inner.split('</helmet>')[1]}</div>`;
  }).join('\n');
  const htmlPath = join(outDir, '_cards.html');
  writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">${helmet}`
    + `<body style="margin:0;background:${T.paperAlt};display:flex;flex-direction:column;align-items:flex-start;width:max-content">${bodies}</body>`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1200, height: 1400 } });
    const page = await ctx.newPage();
    await page.goto(`file://${htmlPath}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    const out = [];
    for (let i = 0; i < cards.length; i += 1) {
      const name = String(i + 1).padStart(2, '0');
      const file = join(outDir, `card-${name}.png`);
      await page.locator(`#c${i + 1} > div`).screenshot({ path: file });
      out.push(file);
    }
    return out;
  } finally { await browser.close().catch(() => {}); }
}

/* ── 공개 페이지 ────────────────────────────────────────────────────────
   claude.ai 아티팩트 링크는 사람이 세션에서 발행해야만 갱신된다 — 헤드리스 CLI,
   세션 크론, claude.ai 클라우드 루틴 모두 Artifact 도구가 없다(2026-09-17 실측).
   무인으로 「항상 최신인 링크」를 주려면 크론이 인증을 들고 쓸 수 있는 호스트라야 하고,
   이 환경에서 그건 gh(GitHub Pages) 뿐이다. 카드 PNG 를 그대로 얹은 정적 페이지다. */
function siteHTML(f, pngs) {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit' }).format(f.collectedAt);
  const stamp = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(f.collectedAt)} ${hm} KST`;
  const lead = f.ed.leads === 'us' ? f.usLead : f.krLead;
  const tail = f.ed.leads === 'us' ? f.usTail : f.krTail;
  const basis = f.ed.leads === 'us' ? `미국 ${f.usSession} ${f.usLabel}` : `코스피 ${f.krLabel.date} ${f.krLabel.text}`;
  const desc = `${f.ed.label} · ${basis} 기준 — 위는 ${lead.name} ${fpct(lead.pct)}, 아래는 ${tail.name} ${fpct(tail.pct)}`;
  const cards = pngs.map((p, i) => `    <figure style="margin:0">
      <img src="${p.split('/').pop()}" alt="마켓맵 카드 ${i + 1}" width="1080" height="1350" loading="${i < 2 ? 'eager' : 'lazy'}">
    </figure>`).join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>바로경제 마켓맵 · 제${f.no}호 ${esc(f.ed.label)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="바로경제 마켓맵 · 제${f.no}호 ${esc(f.ed.label)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="card-01.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hahmlet:wght@700;800&family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; background:${T.paperAlt}; color:${T.body};
         font-family:${FB}; -webkit-text-size-adjust:100%; }
  .wrap { max-width:560px; margin:0 auto; background:${T.paper}; }
  header { padding:28px 22px 22px; border-bottom:2px solid ${T.gold}; }
  .brand { display:flex; align-items:center; gap:9px; }
  .dot { width:9px; height:9px; background:${T.gold}; border-radius:50%; }
  .brand b { color:${T.ink}; font-size:17px; font-weight:600; }
  .ed { color:${T.goldInk}; font-size:14px; font-weight:700; border:1px solid ${T.hair}; padding:1px 8px; }
  h1 { font-family:${FD}; color:${T.ink}; font-size:30px; font-weight:800;
       letter-spacing:-.03em; line-height:1.25; margin:16px 0 0; }
  .meta { color:${T.muted}; font-size:14px; margin-top:10px; line-height:1.6;
          font-variant-numeric:tabular-nums; }
  main { display:flex; flex-direction:column; }
  img { display:block; width:100%; height:auto; }
  footer { padding:24px 22px 36px; border-top:1px solid ${T.hair};
           color:${T.faint}; font-size:13px; line-height:1.7; }
  footer a { color:${T.goldInk}; }
  @media (min-width:600px) { .wrap { box-shadow:0 0 0 1px ${T.hair}; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="dot"></span><b>바로경제 마켓맵</b><span class="ed">${esc(f.ed.label)}</span></div>
    <h1>위는 ${esc(lead.name)}, 아래는 ${esc(tail.name)}</h1>
    <div class="meta">제${f.no}호 · ${fdate(f.date)} · ${esc(basis)} 기준<br>
      미국 ${esc(f.usSession)} ${esc(f.usLabel)} · 코스피 ${esc(f.krLabel.date)} ${esc(f.krLabel.text)}</div>
  </header>
  <main>
${cards}
  </main>
  <footer>
    갱신 ${esc(stamp)} · 매일 08시(미국 기준) · 20시(국장 기준) 자동 갱신<br>
    출처 · 미국 Yahoo Finance, 국내 네이버증권 집계<br>
    투자 판단의 책임은 투자자 본인에게 있습니다.
  </footer>
</div>
</body>
</html>
`;
}

/* ── 텔레그램 ──────────────────────────────────────────────────────────── */

/** sendMediaGroup 은 한 묶음에 10장까지다 — 카드가 정확히 10장이라 한 번에 나간다. */
async function sendTelegram(files, caption) {
  const token = getSecret('TELEGRAM_BOT_TOKEN'); const chat = getSecret('TELEGRAM_CHAT_ID');
  if (!token || !chat) { console.warn('⚠ 텔레그램 시크릿 없음 — 발송 생략'); return false; }
  if (files.length > 10) throw new Error(`sendMediaGroup 은 10장까지다 (받은 ${files.length}장)`);
  // node fetch 가 아니라 curl -4 다: 이 네트워크는 api.telegram.org 의 IPv6 경로가
  // 타임아웃이라 fetch(IPv6 우선)가 ETIMEDOUT 으로 죽는다 (market-map.js 와 같은 처방).
  const { execFileSync } = await import('node:child_process');
  const media = JSON.stringify(files.map((f, i) => ({
    type: 'photo', media: `attach://p${i}`, ...(i === 0 ? { caption } : {}),
  })));
  const args = ['-sS', '-4', '-m', '120',
    `https://api.telegram.org/bot${token}/sendMediaGroup`,
    '--form-string', `chat_id=${chat}`, '--form-string', `media=${media}`,
    ...files.flatMap((f, i) => ['-F', `p${i}=@${f};type=image/png`])];
  try {
    const j = JSON.parse(execFileSync('curl', args, { encoding: 'utf-8', maxBuffer: 8 << 20 }));
    if (!j.ok) { console.error('❌ 텔레그램 발송 실패:', JSON.stringify(j).slice(0, 200)); return false; }
    console.log(`📨 텔레그램 카드 ${files.length}장 발송 완료`);
    return true;
  } catch (e) {
    console.error('❌ 텔레그램 발송 실패:', e.message.slice(0, 200));
    return false;
  }
}

/* ── 실행 ──────────────────────────────────────────────────────────────── */
async function main() {
  const { values } = parseArgs({ options: {
    date: { type: 'string' },
    edition: { type: 'string' },
    out: { type: 'string' },
    render: { type: 'boolean', default: false },
    site: { type: 'boolean', default: false },
    telegram: { type: 'boolean', default: false },
  } });
  const date = values.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const edition = values.edition || resolveEdition();
  if (!EDITIONS[edition]) throw new Error(`알 수 없는 판: ${edition} (morning | evening)`);

  const dir = join(ROOT, CFG.output_dir, date, edition);
  const dataPath = join(dir, 'data.json');
  const d = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const f = facts(d, statSync(dataPath).mtime, edition);

  const outDir = values.out ? resolve(values.out) : join(dir, 'cards');
  mkdirSync(outDir, { recursive: true });

  // 카드 순서는 판을 따른다 — 막 마감한 시장이 앞에 온다.
  // 테마는 코스피 테마라 코스피 카드 옆에 붙인다.
  const US = [['UsMovers.dc.html', cardUsMovers], ['UsMap.dc.html', (x, n) => cardUsMap(x, d, n)]];
  const KR = [['KrMovers.dc.html', cardKrMovers], ['KrMap.dc.html', (x, n) => cardKrMap(x, d, n)],
    ['Themes.dc.html', cardThemes], ['SharedNames.dc.html', cardShared]];
  const order = [
    ['Main.dc.html', cardCover], ['Indices.dc.html', cardIndices],
    ...(f.ed.leads === 'us' ? [...US, ...KR] : [...KR, ...US]),
    ['SameOrder.dc.html', cardSameOrder], ['Outro.dc.html', cardOutro],
  ];
  if (order.length !== TOTAL) throw new Error(`카드 수가 ${TOTAL} 이 아니다: ${order.length}`);
  const cards = order.map(([name, fn], i) => [name, fn(f, i + 1)]);
  for (const [name, html] of cards) writeFileSync(join(outDir, name), html);

  const flow = order.map(([n]) => n.replace('.dc.html', '')).join(' → ');
  const canvas = {
    artboards: order.map(([file], i) => ({
      file, x: (i % 5) * (W + 110), y: Math.floor(i / 5) * (H + 170), w: W, h: H, print: 'fixed',
    })),
    annotations: [
      {
        id: 'deck-thesis',
        x: 0, y: -300, w: 660,
        text: `마켓맵 제${f.no}호 ${f.ed.label} · ${fdate(f.date)} · 카드 ${TOTAL}장\n\n`
          + `${f.ed.label}은 ${f.ed.leads === 'us' ? '미국 증시' : '코스피'} 마감 기준이다. 막 닫힌 시장이 앞에 온다.\n${flow}\n\n`
          + `미국 ${f.usSession} ${f.usLabel} — 맨 위 ${f.usLead.name} ${fpct(f.usLead.pct)} / 맨 아래 ${f.usTail.name} ${fpct(f.usTail.pct)}\n`
          + `코스피 ${f.krLabel.date} ${f.krLabel.text} — 맨 위 ${f.krLead.name} ${fpct(f.krLead.pct)} / 맨 아래 ${f.krTail.name} ${fpct(f.krTail.pct)}\n`
          + `양끝 개념 일치: ${f.sameOrder ? `예 (${f.conceptLead} / ${f.conceptTail})` : '아니오'}\n`
          + `(3종목 미만 묶음은 대표에서 제외)`,
      },
      {
        id: 'regenerate',
        x: 740, y: -300, w: 520,
        text: '하루 두 판 · 08:00 조간(미국 기준) / 20:00 석간(국장 기준)\n\n'
          + 'lib/market-map-cron.sh 가 판을 시각으로 정해서:\n'
          + '  market-map.js   --edition <판>            (수집)\n'
          + '  market-magazine.js --edition <판> --render --telegram\n\n'
          + '판형 1080×1350 · 인스타 · 유튜브 커뮤니티 규격.',
      },
    ],
    launch: { view: 'canvas' },
  };
  writeFileSync(join(outDir, 'canvas.json'), `${JSON.stringify(canvas, null, 2)}\n`);

  console.log(`🃏 제${f.no}호 ${f.ed.label} · ${fdate(f.date)} — 카드 ${cards.length}장 (${f.ed.leads === 'us' ? '미국' : '국장'} 기준)`);
  console.log(`   미국 ${f.usSession} ${f.usLabel}: 위 ${f.usLead.name} ${fpct(f.usLead.pct)}(n=${f.usLead.n}) / 아래 ${f.usTail.name} ${fpct(f.usTail.pct)}(n=${f.usTail.n})`);
  console.log(`   코스피 ${f.krLabel.date} ${f.krLabel.text}: 위 ${f.krLead.name} ${fpct(f.krLead.pct)}(n=${f.krLead.n}) / 아래 ${f.krTail.name} ${fpct(f.krTail.pct)}(n=${f.krTail.n})`);
  console.log(`   양끝 개념 일치: ${f.sameOrder ? `예 (${f.conceptLead}/${f.conceptTail})` : '아니오'} · 겹친 종목 ${f.shared.length}개`);
  console.log(`   → ${outDir}`);

  if (!values.render) return;
  const pngs = await renderPNGs(cards, outDir);
  console.log(`🖼  PNG ${pngs.length}장`);

  if (values.site) {
    writeFileSync(join(outDir, 'index.html'), siteHTML(f, pngs));
    writeFileSync(join(outDir, '.nojekyll'), '');
    console.log(`🌐 index.html`);
  }

  if (!values.telegram) return;
  const lead = f.ed.leads === 'us' ? f.usLead : f.krLead;
  const tail = f.ed.leads === 'us' ? f.usTail : f.krTail;
  await sendTelegram(pngs,
    `📰 바로경제 마켓맵 제${f.no}호 ${f.ed.label} · ${fdate(f.date)}\n`
    + `${f.ed.leads === 'us' ? `미국 ${f.usSession} ${f.usLabel}` : `코스피 ${f.krLabel.date} ${f.krLabel.text}`} 기준\n`
    + `위는 ${lead.name} ${fpct(lead.pct)} · 아래는 ${tail.name} ${fpct(tail.pct)}\n\n`
    + `카드 ${pngs.length}장 — 커뮤니티/인스타에 그대로 올리면 됩니다.\n`
    + `${CFG.site_url ?? 'https://82beye.github.io/BarroSkills/'}`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
