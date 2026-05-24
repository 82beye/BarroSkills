#!/usr/bin/env node

/**
 * BarroTube — 무인 스케줄링 설치 스크립트
 * FR-S-001: macOS launchd 통합
 * FR-S-002: pmset 기상 + caffeinate
 *
 * Usage: node install-schedule.js --channel <channel-id> --time "06:00" [--daily]
 */

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const LAUNCHD_DIR = join(homedir(), 'Library/LaunchAgents');

function generatePlist(channelId, hour, minute) {
  const label = `com.barrotube.daily.${channelId}`;
  const scriptPath = join(PROJECT_ROOT, 'scripts', 'automation', 'daily-runner.sh');
  const logPath = join(PROJECT_ROOT, 'logs', `${channelId}-daily.log`);
  const errorLogPath = join(PROJECT_ROOT, 'logs', `${channelId}-daily-error.log`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${scriptPath}</string>
        <string>${channelId}</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${logPath}</string>

    <key>StandardErrorPath</key>
    <string>${errorLogPath}</string>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${homedir()}</string>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <false/>
</dict>
</plist>`;
}

function generateDailyRunner() {
  return `#!/bin/bash
# BarroTube Daily Runner
# FR-S-002: caffeinate로 슬립 방지

set -euo pipefail

CHANNEL_ID="\${1:?Channel ID required}"
PROJECT_ROOT="${PROJECT_ROOT}"
LOG_DIR="${PROJECT_ROOT}/logs"
NODE_BIN="$(which node)"

echo "──────────────────────────────────────"
echo "BarroTube Daily Runner"
echo "Channel: $CHANNEL_ID"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "──────────────────────────────────────"

# FR-S-002: caffeinate로 슬립 방지 (이 스크립트가 끝날 때까지)
caffeinate -i -w $$ &
CAFFEINATE_PID=$!

cleanup() {
    kill $CAFFEINATE_PID 2>/dev/null || true
    echo "Caffeinate stopped."
}
trap cleanup EXIT

# 에피소드 생성
TOPIC_DATE=$(date '+%Y년 %m월 %d일')
echo "Creating episode for: $TOPIC_DATE"

cd "$PROJECT_ROOT"

"$NODE_BIN" scripts/automation/create-episode.js \\
    --channel "$CHANNEL_ID" \\
    --topic "$TOPIC_DATE 경제 브리핑" \\
    --length 480

# 가장 최근 생성된 에피소드 찾기
LATEST_EP=$(ls -1d workspace/episodes/EP-* 2>/dev/null | sort | tail -1 | xargs basename)

if [ -z "$LATEST_EP" ]; then
    echo "❌ No episode found after creation"
    exit 1
fi

echo "Running episode: $LATEST_EP"

# 에피소드 워크플로우 실행
"$NODE_BIN" scripts/automation/run-episode.js \\
    --episode "$LATEST_EP"

echo ""
echo "✅ Daily run completed: $LATEST_EP"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
`;
}

function generatePmsetScript(hour, minute) {
  // 5분 전에 Mac을 깨우는 스크립트
  const wakeHour = minute >= 5 ? hour : (hour === 0 ? 23 : hour - 1);
  const wakeMinute = minute >= 5 ? minute - 5 : 60 + minute - 5;

  return `#!/bin/bash
# BarroTube — pmset 기상 스케줄 설정
# FR-S-002: 스케줄 시각 5분 전에 Mac을 깨운다
#
# ⚠️ sudo 권한 필요: sudo bash install-pmset.sh

set -euo pipefail

echo "Setting pmset wake schedule..."
echo "  Wake time: ${String(wakeHour).padStart(2, '0')}:${String(wakeMinute).padStart(2, '0')} (5분 전 기상)"
echo "  Target time: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}"

# 기존 스케줄 확인
pmset -g sched

# 매일 반복 기상 스케줄 설정
sudo pmset repeat wakeorpoweron MTWRFSU ${String(wakeHour).padStart(2, '0')}:${String(wakeMinute).padStart(2, '0')}:00

echo ""
echo "✅ pmset schedule installed."
echo "   Mac will wake at ${String(wakeHour).padStart(2, '0')}:${String(wakeMinute).padStart(2, '0')} daily."
pmset -g sched
`;
}

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string', short: 'c' },
      time: { type: 'string', short: 't', default: '06:00' },
      daily: { type: 'boolean', short: 'd', default: true },
    },
  });

  if (!values.channel) {
    console.error('Usage: node install-schedule.js --channel <channel-id> --time "06:00"');
    process.exit(1);
  }

  const [hourStr, minuteStr] = values.time.split(':');
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);

  console.log(`\n🕐 BarroTube Schedule Installer`);
  console.log(`   Channel: ${values.channel}`);
  console.log(`   Time: ${values.time} (daily)`);

  // 1. Generate daily runner script
  const runnerPath = join(PROJECT_ROOT, 'scripts', 'automation', 'daily-runner.sh');
  writeFileSync(runnerPath, generateDailyRunner(), { mode: 0o755 });
  console.log(`\n✅ Daily runner: ${runnerPath}`);

  // 2. Generate launchd plist
  mkdirSync(LAUNCHD_DIR, { recursive: true });
  const plistContent = generatePlist(values.channel, hour, minute);
  const plistPath = join(LAUNCHD_DIR, `com.barrotube.daily.${values.channel}.plist`);
  writeFileSync(plistPath, plistContent);
  console.log(`✅ Launchd plist: ${plistPath}`);

  // 3. Generate pmset script
  const pmsetPath = join(PROJECT_ROOT, 'scripts', 'launchd', 'install-pmset.sh');
  writeFileSync(pmsetPath, generatePmsetScript(hour, minute), { mode: 0o755 });
  console.log(`✅ pmset script: ${pmsetPath}`);

  // 4. Load launchd agent
  console.log(`\n📋 To activate:`);
  console.log(`   1. Load launchd agent:`);
  console.log(`      launchctl load ${plistPath}`);
  console.log(`   2. Install pmset wake (requires sudo):`);
  console.log(`      sudo bash ${pmsetPath}`);
  console.log(`   3. Verify:`);
  console.log(`      launchctl list | grep barrotube`);
  console.log(`      pmset -g sched`);
}

main();
