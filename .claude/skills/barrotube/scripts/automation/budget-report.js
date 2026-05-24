#!/usr/bin/env node

/**
 * BarroTube — 예산 보고서 출력
 * Usage: node budget-report.js [--month YYYY-MM]
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

// Direct inline budget report since we can't import ESM with top-level resolution easily
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = resolve(import.meta.dirname, '../../paperclip/config/budget-policy.json');
const DATA_DIR = resolve(import.meta.dirname, '../../logs/budget');

function main() {
  const { values } = parseArgs({
    options: {
      month: { type: 'string', short: 'm' },
    },
  });

  const month = values.month || new Date().toISOString().slice(0, 7);
  const usagePath = join(DATA_DIR, `usage-${month}.json`);

  console.log(`\n💰 BarroTube Budget Report — ${month}`);
  console.log('═'.repeat(60));

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const usage = existsSync(usagePath)
    ? JSON.parse(readFileSync(usagePath, 'utf-8'))
    : {};

  let totalUsed = 0;
  let totalLimit = 0;

  console.log(`${'Role'.padEnd(20)} ${'Used'.padStart(10)} ${'Limit'.padStart(10)} ${'%'.padStart(8)} ${'Status'.padStart(12)}`);
  console.log('─'.repeat(60));

  for (const [roleId, roleConfig] of Object.entries(config.budget_policy.roles)) {
    const used = usage[roleId]?.total_usd || 0;
    const limit = roleConfig.monthly_limit;
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    const calls = usage[roleId]?.calls || 0;

    let status;
    if (pct >= 100) status = '❌ OVER';
    else if (pct >= 80) status = '⚠️ WARNING';
    else status = '✅ OK';

    console.log(
      `${roleId.padEnd(20)} ${'$' + used.toFixed(2).padStart(9)} ${'$' + String(limit).padStart(9)} ${pct.toFixed(1).padStart(7)}% ${status.padStart(12)}`
    );

    totalUsed += used;
    totalLimit += limit;
  }

  console.log('─'.repeat(60));
  const totalPct = totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0;
  console.log(
    `${'TOTAL'.padEnd(20)} ${'$' + totalUsed.toFixed(2).padStart(9)} ${'$' + String(totalLimit).padStart(9)} ${totalPct.toFixed(1).padStart(7)}%`
  );
  console.log('═'.repeat(60));

  if (Object.keys(usage).length === 0) {
    console.log('\nℹ No usage data yet for this month.');
  }
}

main();
