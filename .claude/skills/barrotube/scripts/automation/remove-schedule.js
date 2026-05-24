#!/usr/bin/env node

/**
 * BarroTube — 스케줄 제거 스크립트
 * Usage: node remove-schedule.js --channel <channel-id>
 */

import { parseArgs } from 'node:util';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string', short: 'c' },
    },
  });

  if (!values.channel) {
    console.error('Usage: node remove-schedule.js --channel <channel-id>');
    process.exit(1);
  }

  const label = `com.barrotube.daily.${values.channel}`;
  const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);

  console.log(`\n🗑 Removing schedule for: ${values.channel}`);

  // Unload from launchd
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
    console.log(`✅ Unloaded launchd agent: ${label}`);
  } catch {
    console.log(`ℹ Agent was not loaded: ${label}`);
  }

  // Remove plist file
  if (existsSync(plistPath)) {
    unlinkSync(plistPath);
    console.log(`✅ Removed plist: ${plistPath}`);
  } else {
    console.log(`ℹ Plist not found: ${plistPath}`);
  }

  console.log(`\n📋 Note: pmset schedule must be removed manually:`);
  console.log(`   sudo pmset repeat cancel`);
}

main();
