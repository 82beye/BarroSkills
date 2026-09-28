import assert from 'node:assert/strict';
import test from 'node:test';

import {
  num, pctColor, squarify, groupedTreemap, krStocksToItems, themeModel,
} from '../scripts/automation/lib/market-map.js';

/**
 * 마켓맵 레이아웃의 불변식. 이미지는 눈으로 검수하지만, "칸이 겹치거나 캔버스를
 * 벗어나는" 종류의 버그는 눈보다 수식이 빨리 잡는다.
 */
test('네이버 문자열 숫자를 그대로 읽는다', () => {
  assert.equal(num('253,500'), 253500);
  assert.equal(num('-1.23'), -1.23);
  assert.equal(num('2.01'), 2.01);
  assert.equal(num(null), null);
  assert.equal(num('—'), null);
});

test('squarify — 면적 보존·경계 준수·무겹침', () => {
  const rect = { x: 0, y: 0, w: 1000, h: 600 };
  const items = Array.from({ length: 24 }, (_, i) => ({ key: `s${i}`, size: (i + 1) * 7 }));
  const laid = squarify(items, rect);
  assert.equal(laid.length, 24);

  const total = items.reduce((s, i) => s + i.size, 0);
  for (const c of laid) {
    // 면적 비례 (부동소수 오차 허용)
    const expected = (c.size / total) * rect.w * rect.h;
    assert.ok(Math.abs(c.w * c.h - expected) < 1e-6 * rect.w * rect.h, `${c.key} 면적`);
    // 경계
    assert.ok(c.x >= -1e-9 && c.y >= -1e-9 && c.x + c.w <= rect.w + 1e-6 && c.y + c.h <= rect.h + 1e-6, `${c.key} 경계`);
  }
  // 무겹침: 쌍별 교차 면적 0
  for (let i = 0; i < laid.length; i++) for (let j = i + 1; j < laid.length; j++) {
    const a = laid[i]; const b = laid[j];
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    assert.ok(ox * oy < 1e-6, `${a.key}~${b.key} 겹침`);
  }
});

test('size<=0 은 조용히 빠지고, 전부 0 이면 빈 배열이다', () => {
  assert.equal(squarify([{ key: 'a', size: 0 }, { key: 'b', size: -3 }], { x: 0, y: 0, w: 10, h: 10 }).length, 0);
});

test('2단 트리맵 — 종목 칸은 자기 섹터 안에 있다', () => {
  const groups = [
    { name: 'A', items: [{ key: 'a1', size: 50 }, { key: 'a2', size: 30 }] },
    { name: 'B', items: [{ key: 'b1', size: 20 }] },
  ];
  const { sectors, cells } = groupedTreemap(groups, { x: 0, y: 0, w: 400, h: 300 }, { headerPx: 20 });
  assert.equal(sectors.length, 2);
  assert.equal(cells.length, 3);
  const secOf = Object.fromEntries(sectors.map((s) => [s.name, s]));
  for (const c of cells) {
    const s = secOf[c.key.startsWith('a') ? 'A' : 'B'];
    assert.ok(c.x >= s.x - 1e-6 && c.y >= s.y - 1e-6
      && c.x + c.w <= s.x + s.w + 1e-6 && c.y + c.h <= s.y + s.h + 1e-6, `${c.key} 가 섹터 밖`);
  }
});

test('색 스케일 — 방향과 클램프', () => {
  const up = pctColor(2, 3); const dn = pctColor(-2, 3);
  assert.match(up, /^rgb\(/); assert.match(dn, /^rgb\(/);
  const [ur, ug] = up.match(/\d+/g).map(Number);
  const [dr, dg] = dn.match(/\d+/g).map(Number);
  assert.ok(ug > ur, '상승은 초록이 우세');
  assert.ok(dr > dg, '하락은 빨강이 우세');
  assert.equal(pctColor(30, 3), pctColor(3, 3), '클램프를 넘으면 최댓값 색으로 고정');
  assert.equal(pctColor(null), '#2A3550', '값이 없으면 중립색');
});

test('테마 모델 — 등락률 상위 N, 구성종목은 각 테마의 상승 상위', () => {
  const groups = [
    { no: 1, name: '광통신', changeRate: '7.00', riseCount: 12, totalCount: 15 },
    { no: 2, name: '조선', changeRate: '1.10', riseCount: 5, totalCount: 9 },
    { no: 3, name: '면세', changeRate: '-2.00', riseCount: 0, totalCount: 4 },
  ];
  const byNo = { 1: [
    { stockName: '빛샘전자', fluctuationsRatio: '29.97' },
    { stockName: '티엠씨', fluctuationsRatio: '17.37' },
  ], 2: [], 3: [] };
  const m = themeModel(groups, byNo, { topN: 2, stocksPer: 5 });
  assert.equal(m.length, 2);
  assert.equal(m[0].name, '광통신');
  assert.equal(m[0].stocks[0].name, '빛샘전자');
  assert.equal(m[1].stocks.length, 0, '구성종목이 없으면 빈 배열 — 지어내지 않는다');
});

test('코스피 items — marketValue 없는 행은 버린다', () => {
  const items = krStocksToItems([
    { itemCode: '005930', stockName: '삼성전자', marketValue: '14,820,316', fluctuationsRatio: '2.01' },
    { itemCode: '000000', stockName: '이상한행', marketValue: null, fluctuationsRatio: '1.0' },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].size, 14820316);
});

/**
 * 첫 실전 산출(2026-09-16)에서 잡힌 세 결함의 회귀 방지.
 *   ① ETF 가 종목 맵에 섞임 (KODEX 200·TIGER 미국S&P500)
 *   ② ET 10:36 장중인데 "마감 (현지)" 라벨 — 시점 정직성 위반
 *   ③ 시총 원값 크기 → 삼전+하이닉스가 화면 55% 를 먹어 58종목 중 56개가 안 읽힘
 */
import { readFileSync } from 'node:fs';

test('ETF 는 종목 맵에서 빠진다', () => {
  const items = krStocksToItems([
    { itemCode: '005930', stockName: '삼성전자', stockEndType: 'stock', marketValue: '100', fluctuationsRatio: '1' },
    { itemCode: '069500', stockName: 'KODEX 200', stockEndType: 'etf', marketValue: '99', fluctuationsRatio: '1' },
  ]);
  assert.deepEqual(items.map((i) => i.label), ['삼성전자']);
});

test('미국 라벨은 장중을 마감이라 부르지 않는다 · 코스피 크기는 거듭제곱 스케일', () => {
  const src = readFileSync(new URL('../scripts/automation/market-map.js', import.meta.url), 'utf8');
  assert.match(src, /usSessionLabel/, '세션 상태 판별 함수가 있어야 한다');
  assert.match(src, /장중.*ET 기준/, '장중이면 장중이라고 쓴다');
  assert.match(src, /Math\.pow\(k\.size, 0\.6\)/, '코스피 크기 지배력 압축');
  assert.match(src, /크기 ∝ 시가총액/, '스케일을 왜곡했으면 정비례라고 쓰지 않는다');
});

/** 2026-09-16 운영자 지시: 코스피도 테마 그룹 + 그룹마다 종목 노출. */
test('코스피 테마 그룹 매핑이 있고, 미매핑 코드는 기타로 간다', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/market-map.json', import.meta.url), 'utf8'));
  const groups = Object.keys(cfg.kr.groups).filter((k) => !k.startsWith('_'));
  assert.ok(groups.length >= 8, `테마 그룹 ${groups.length}개 — 너무 적으면 그룹화 의미가 없다`);
  const src = readFileSync(new URL('../scripts/automation/market-map.js', import.meta.url), 'utf8');
  assert.match(src, /codeToGroup\[k\.key\] \?\? '기타'/, '매핑에 없는 신규 상위 종목은 기타로 들어가야 한다');
  assert.match(src, /krMap\.sectors/, '코스피도 그룹 헤더를 그려야 한다');
});
