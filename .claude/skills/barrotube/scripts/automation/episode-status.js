#!/usr/bin/env node

/**
 * BarroTube — 에피소드 상태 조회
 * Usage: node episode-status.js [--episode <EP-YYYY-NNNN>] [--all]
 */

import { parseArgs } from 'node:util';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKSPACE = resolve(import.meta.dirname, '../../workspace');

function readEpisodeStatus(episodeId) {
  const statusFile = join(WORKSPACE, 'episodes', episodeId, '.episode_status.json');
  if (!existsSync(statusFile)) return null;
  return JSON.parse(readFileSync(statusFile, 'utf-8'));
}

function formatStatus(status) {
  const icons = {
    created: '📝',
    in_progress: '🔄',
    completed: '✅',
    failed: '❌',
    awaiting_approval: '⏳',
  };

  return icons[status] || '❓';
}

function printEpisodeStatus(episodeId) {
  const status = readEpisodeStatus(episodeId);
  if (!status) {
    console.log(`  ${episodeId}: No status file found`);
    return;
  }

  const icon = formatStatus(status.status);
  console.log(`\n${icon} ${status.episode_id}`);
  console.log(`   Channel: ${status.channel_id || 'unknown'}`);
  console.log(`   Stage: ${status.current_stage}`);
  console.log(`   Status: ${status.status}`);
  console.log(`   Updated: ${status.last_updated}`);

  if (status.stage_history && status.stage_history.length > 0) {
    console.log(`   History:`);
    for (const entry of status.stage_history.slice(-5)) {
      const ts = new Date(entry.timestamp).toLocaleTimeString('ko-KR');
      console.log(`     ${formatStatus(entry.status)} ${entry.stage} — ${ts}`);
    }
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      all: { type: 'boolean', short: 'a', default: false },
    },
  });

  console.log(`\n📊 BarroTube Episode Status`);
  console.log(`${'─'.repeat(50)}`);

  if (values.episode) {
    printEpisodeStatus(values.episode);
  } else {
    const episodesDir = join(WORKSPACE, 'episodes');
    if (!existsSync(episodesDir)) {
      console.log('No episodes found.');
      return;
    }

    const episodes = readdirSync(episodesDir)
      .filter(d => d.startsWith('EP-'))
      .sort()
      .reverse();

    if (episodes.length === 0) {
      console.log('No episodes found.');
      return;
    }

    const toShow = values.all ? episodes : episodes.slice(0, 10);
    for (const ep of toShow) {
      printEpisodeStatus(ep);
    }

    if (!values.all && episodes.length > 10) {
      console.log(`\n... and ${episodes.length - 10} more. Use --all to see all.`);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
}

main();
