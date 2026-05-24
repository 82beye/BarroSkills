#!/usr/bin/env node

/**
 * daily-episode-batch.js — 일일 자동 에피소드 생성 배치
 *
 * 실행 순서:
 *   1) fetch-daily-news.js (뉴스 수집)
 *   2) ceo-select-topics.js (2개 주제 선정)
 *   3) 각 주제별로 create-episode.js → Brief 생성
 *   4) (선택) S2~S9 자동 실행 — 현재는 manual/agent 경유이므로 Brief만 생성하고 알림
 *   5) Telegram으로 Board에 에피소드 2개 준비 안내
 *
 * Usage:
 *   node daily-episode-batch.js [--channel econ-daily] [--count 2] [--auto-assets]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { notify } from './notify.js';

const ROOT = resolve(import.meta.dirname, '../..');

function run(cmd, args = [], opts = {}) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string', short: 'c' },
      count: { type: 'string', short: 'n' },
      'auto-assets': { type: 'boolean', default: false },
      'auto-produce': { type: 'boolean', default: false },  // brief 후 produce-episode 자동 트리거
      date: { type: 'string', short: 'd' },
    },
  });

  const channel = values.channel || 'econ-daily';
  const count = parseInt(values.count || '2');
  const date = values.date || new Date().toISOString().slice(0, 10);

  console.log(`\n🌅 BarroTube Daily Batch — ${date}`);
  console.log(`   Channel: ${channel} | Topics: ${count}`);

  // 1. 뉴스 수집
  run('node', ['scripts/automation/fetch-daily-news.js', '--date', date]);

  // 2. CEO 주제 선정
  run('node', [
    'scripts/automation/ceo-select-topics.js',
    '--date', date,
    '--count', String(count),
    '--channel', channel,
  ]);

  // 3. topics.json 로드
  const topicsPath = join(ROOT, 'workspace/daily-news', date, 'topics.json');
  if (!existsSync(topicsPath)) throw new Error(`Missing topics.json: ${topicsPath}`);
  const { topics } = JSON.parse(readFileSync(topicsPath, 'utf-8'));

  // 4. 각 주제별 에피소드 초기화
  const created = [];
  for (const t of topics) {
    console.log(`\n📝 Creating episode for: ${t.topic}`);
    const topicText = `${t.topic} — ${t.title.slice(0, 60)}`;
    const notes = `레퍼런스: ${t.source} / ${t.link}\n요약: ${t.summary}`;

    const res = spawnSync('node', [
      'scripts/automation/create-episode.js',
      '--channel', channel,
      '--topic', topicText,
      '--length', '60',
      '--notes', notes,
    ], { cwd: ROOT, encoding: 'utf-8' });

    if (res.status !== 0) {
      console.error(`  ❌ create-episode failed for ${t.topic}`);
      continue;
    }

    // stdout에서 EP ID 추출
    const match = res.stdout.match(/EP-\d{4}-\d{4}/);
    if (match) {
      created.push({ id: match[0], topic: t.topic, title: t.title, link: t.link });
      console.log(`  ✅ ${match[0]}`);
    }

    // 표준출력 echo
    process.stdout.write(res.stdout);
  }

  // 5. 알림 발송
  const report = {
    date,
    channel_id: channel,
    episodes_created: created,
    next_steps: [
      '1. Claude Code에서 S2~S5 실행 (Research, Strategy, Script, Factcheck)',
      '2. S6 Assets: generate-tts.js + sync-durations.js + generate-image-gemini.js',
      '3. S7 Render: render-direct.js + build-capcut-from-episode.js',
      '4. S9 Metadata: Claude Code agent',
      '5. S10 Board 승인: approve-episode.js',
      '6. S11 Publish: run-episode.js (SEO 자동 보강 포함)',
    ],
  };

  console.log(`\n📊 Daily Batch Summary`);
  created.forEach(e => console.log(`  • ${e.id}: ${e.topic}`));

  try {
    const msg = [
      `🌅 <b>BarroTube Daily Batch (${date})</b>`,
      `채널: ${channel}`,
      ``,
      ...created.map(e => `• <code>${e.id}</code>: ${e.topic}`),
      ``,
      `다음 단계: Writer·Asset·Render·Metadata → Board 승인`,
    ].join('\n');
    await notify('daily_report', { date, text: msg, episodes: created });
    console.log(`\n✅ Telegram 알림 발송 완료`);
  } catch (e) {
    console.warn(`\n⚠ Telegram 발송 실패: ${e.message}`);
  }

  // 저장
  writeFileSync(
    join(ROOT, 'workspace/daily-news', date, 'batch-report.json'),
    JSON.stringify(report, null, 2),
    'utf-8'
  );

  if (values['auto-assets']) {
    console.log(`\n🤖 --auto-assets 모드: Writer·Asset 단계는 Claude Code agent 필요 (현재 미구현)`);
    console.log(`   수동 진행: Claude CLI에서 해당 에이전트 호출`);
  }

  // --auto-produce: brief 생성 직후 produce-episode 자동 트리거 (직렬, 1편씩)
  // 이전엔 brief만 만들고 운영자가 수동으로 produce-episode 호출했어야 했음 → IN REVIEW에서
  // 멈춰있는 케이스 다수 발생. 자동화 한 단계 더 진행.
  if (values['auto-produce']) {
    console.log(`\n🚀 --auto-produce 모드: 각 brief에 대해 produce-episode 직렬 실행`);
    for (const e of created) {
      console.log(`\n━━━ ${e.id}: ${e.topic} ━━━`);
      const r = spawnSync('node', [
        'scripts/automation/produce-episode.js',
        '--episode', e.id,
        '--skip-capcut',
      ], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`  ❌ produce-episode failed for ${e.id} (status ${r.status}). 다음 EP로 계속 진행.`);
      }
    }
    console.log(`\n✅ Auto-produce 완료. Board 승인 (S10) 대기 중.`);
  }
}

main().catch(e => { console.error('\n❌ Batch failed:', e.message); process.exit(1); });
