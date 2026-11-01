#!/usr/bin/env node

/**
 * research-movers.js — 「오늘 움직인 종목」마다 이유와 출처를 찾는다 (claude WebSearch → codex --search).
 *
 * 벤치마크(오선 「증시 요약」)의 종목 코너는 「HPE 는 네트워킹 사업 장기 매출 전망을 상향해
 * 3.9% 상승」처럼 등락률 옆에 이유가 붙는다. 바로경제의 뉴스 수집(RSS 헤드라인)으로는 종목별
 * 이유가 거의 안 잡혀, 첫 요약 대본(EP-2026-0203)이 「네 종목 모두 뚜렷한 개별 재료는
 * 확인되지 않았습니다」로 끝났다. 그래서 등락 상위·시간외 상위만 골라 검색한다.
 *
 * 입력/산출: workspace/daily-news/<date>/summary-us.json 의 reasons 필드를 채운다.
 *   reasons: { "<티커>": { "why": "<26자 이내>", "detail": "<한 문장>", "url": "<출처>" } }
 * 찾지 못한 종목은 넣지 않는다 — 대본은 이유 있는 종목만 고른다.
 *
 * 실패해도 exit 0 (요약 대본은 이유 없이도 쓸 수 있다).
 *
 * Usage: node research-movers.js [--date 2026-10-01]
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { firstJsonObject } from './generate-summary-script.js';

const ROOT = resolve(import.meta.dirname, '../..');

/** 검색 대상: 정규장 등락 상위(±1.5% 이상) + 시간외 상위. */
export function candidates(data, n = 4) {
  const live = data.stocks.filter((s) => Number.isFinite(s.pct));
  const up = [...live].sort((a, b) => b.pct - a.pct).filter((s) => s.pct >= 1.5).slice(0, n);
  const down = [...live].sort((a, b) => a.pct - b.pct).filter((s) => s.pct <= -1.5).slice(0, n);
  const seen = new Set(); const out = [];
  for (const s of [...up, ...down, ...(data.after_hours || [])]) if (!seen.has(s.t)) { seen.add(s.t); out.push(s); }
  return out;
}

function prompt(data, list) {
  const lines = list.map((s) => `- ${s.t} (${s.name}): 정규장 ${s.pct > 0 ? '+' : ''}${s.pct?.toFixed(2)}%${Number.isFinite(s.ah_pct) && Math.abs(s.ah_pct) >= 2 ? ` · 시간외 ${s.ah_pct > 0 ? '+' : ''}${s.ah_pct}%` : ''}`).join('\n');
  return `미국 증시 ${data.us_session}(현지) 거래일에 아래 종목이 크게 움직였다. 종목마다 그날 움직인 이유를 웹에서 찾아라.

${lines}

규칙:
- 그날(또는 직전 장 마감 뒤) 나온 실적·가이던스·투자의견 변경·인수합병·규제·제품 발표 같은 **종목 고유 재료**를 찾는다.
- 출처 URL 은 실제로 연 기사여야 한다. 날짜가 ${data.us_session} 전후 2일을 벗어나면 쓰지 마라.
- 고유 재료를 못 찾으면 그 종목은 빼라(업종 흐름으로 지어내지 마라).
- why 는 한국어 26자 이내 명사형(예: "4분기 매출·가이던스 예상 상회"), detail 은 한국어 한 문장.

출력: JSON 하나만. {"items":[{"t":"<티커>","why":"...","detail":"...","url":"https://..."}]}
파일을 쓰지 마라. 표준출력에 JSON 만 낸다.`;
}

function callClaude(p) {
  const r = spawnSync('claude', ['-p', p, '--model', 'sonnet', '--permission-mode', 'default', '--allowed-tools', 'WebSearch,WebFetch'],
    { cwd: ROOT, encoding: 'utf-8', timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude 종료코드 ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
  return r.stdout;
}

function callCodex(p) {
  const dir = mkdtempSync(join(tmpdir(), 'bt-movers-'));
  const out = join(dir, 'out.txt');
  try {
    const r = spawnSync('codex', ['-a', 'never', '-s', 'read-only', '--search', 'exec', '--ephemeral', '-o', out, p],
      { cwd: ROOT, encoding: 'utf-8', timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`codex 종료코드 ${r.status}`);
    return readFileSync(out, 'utf-8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  const { values } = parseArgs({ options: { date: { type: 'string' } } });
  const date = values.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const path = join(ROOT, 'workspace', 'daily-news', date, 'summary-us.json');
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  const list = candidates(data);
  if (!list.length) { console.log('🔎 종목 이유: 크게 움직인 종목 없음'); return; }
  const tickers = new Set(list.map((s) => s.t));
  let items = null;
  for (const [name, call] of [['claude', callClaude], ['codex', callCodex]]) {
    try {
      const got = JSON.parse(firstJsonObject(call(prompt(data, list))));
      items = (got.items || []).filter((i) => tickers.has(i.t) && i.why && /^https?:\/\//.test(i.url || ''));
      console.log(`🔎 종목 이유 (${name}) ${items.length}/${list.length}`);
      break;
    } catch (e) { console.warn(`   ⚠ ${name}: ${e.message} → 다음 엔진`); }
  }
  if (!items) { console.warn('   ⚠ 종목 이유를 찾지 못했다 — 대본은 이유 없이 진행'); return; }
  data.reasons = Object.fromEntries(items.map((i) => [i.t, { why: String(i.why).slice(0, 30), detail: i.detail || '', url: i.url }]));
  writeFileSync(path, JSON.stringify(data, null, 2));
  for (const i of items) console.log(`   ${i.t}: ${i.why}  (${i.url})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.warn('⚠', e.message); process.exit(0); });
}
