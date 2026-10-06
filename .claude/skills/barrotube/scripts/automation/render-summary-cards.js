#!/usr/bin/env node

/**
 * render-summary-cards.js — 「미국 증시 요약」 씬 1 지수 요약 카드를 굽는다 (LLM 0회·생성 0회).
 *
 * 나머지 씬은 쇼츠와 같은 마시 컷이다 — summary-assets.js 가 라이브러리에서 먼저 고르고,
 * 비는 씬만 Phase 7 이 굽는다.
 *
 * 입력: <EP>/platforms/<platform>/30_script.md 의 card 지시 + daily-news/<date>/summary-us.json
 * 산출: 40_assets/images/scene_NNN.png (card 지시가 있는 씬만, 1080×1920)
 *
 * Usage: node render-summary-cards.js --episode EP-2026-NNNN [--platform shorts] [--force]
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';

import { indicesCard, W, H } from './lib/summary-cards.js';

const ROOT = resolve(import.meta.dirname, '../..');
const DOW = '일월화수목금토';

export function sessionLabel(iso) {
  const [y, m, d] = iso.split('-');
  return `미국 ${y}.${m}.${d} (${DOW[new Date(`${iso}T12:00:00Z`).getUTCDay()]}) 마감`;
}

/** card 지시 → HTML. 모르는 카드면 null. */
export function cardHTML(card, data) {
  if (card?.type === 'indices') return indicesCard({ items: data.indices, dateLabel: sessionLabel(data.us_session || data.date) });
  return null;
}

async function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string' }, platform: { type: 'string', default: 'shorts' }, force: { type: 'boolean', default: false },
  } });
  if (!values.episode) { console.error('Usage: render-summary-cards.js --episode EP-2026-NNNN [--platform shorts] [--force]'); process.exit(1); }
  const base = join(ROOT, 'workspace', 'episodes', values.episode, 'platforms', values.platform);
  const fm = parseYAML(readFileSync(join(base, '30_script.md'), 'utf-8').match(/^---\n([\s\S]*?)\n---/)[1]);
  const data = JSON.parse(readFileSync(join(ROOT, 'workspace', 'daily-news', fm.summary_date, 'summary-us.json'), 'utf-8'));

  const imgDir = join(base, '40_assets', 'images');
  mkdirSync(imgDir, { recursive: true });
  const jobs = fm.scenes.map((s, i) => ({ html: cardHTML(s.card, data), out: join(imgDir, `scene_${String(i + 1).padStart(3, '0')}.png`) }))
    .filter((j) => j.html && (values.force || !existsSync(j.out)));
  if (!jobs.length) { console.log('🃏 요약 카드: 구울 카드 없음'); return; }

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const { html, out } of jobs) {
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      const tmp = `${out}.html`;
      writeFileSync(tmp, html);
      await page.goto(`file://${tmp}`);
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#card').screenshot({ path: out });
      await page.close();
      unlinkSync(tmp);
    }
  } finally { await browser.close().catch(() => {}); }
  console.log(`🃏 요약 카드 ${jobs.length}장 → ${imgDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
