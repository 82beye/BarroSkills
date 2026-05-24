#!/bin/bash
#
# install-cron.sh — BarroSkills launchd 데몬 설치·해제·조회
#
# Usage:
#   bash install-cron.sh install <routine> <time>
#   bash install-cron.sh uninstall <routine>
#   bash install-cron.sh list
#
# Routines:
#   daily-producer        — 매일 06:00 KST EP 큐 점검 + 토픽 선정
#   weekly-marketing      — 매주 월요일 09:00 마케팅 인텔리전스 fetch
#   doctor-daily          — 매일 07:00 자동 진단 (silent failure 탐지)
#
# Examples:
#   bash install-cron.sh install daily-producer "06:00"
#   bash install-cron.sh install weekly-marketing "Mon 09:00"
#   bash install-cron.sh install doctor-daily "07:00"
#   bash install-cron.sh list
#   bash install-cron.sh uninstall daily-producer

set -euo pipefail

# BARROTUBE_HOME: self-contained barrotube 스킬 폴더 (모든 자산 위치)
# 자동 감지: 본 스크립트 = .../barrotube/lib/install-cron.sh → BARROTUBE_HOME = .../barrotube/
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
BARROSKILLS_HOME="$BARROTUBE_HOME"   # 하위 호환 alias
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL_PREFIX="com.barroskills.barrotube"   # collection.skill 형식 — 다른 스킬과 충돌 회피
NODE_BIN="$(which node || echo /Users/beye/.nvm/versions/node/v24.11.1/bin/node)"

cmd_install() {
  local routine="$1"
  local time_spec="${2:-}"
  local label="${LABEL_PREFIX}.${routine}"
  local plist="${LAUNCH_AGENTS_DIR}/${label}.plist"

  # routine 별 ProgramArguments 결정
  local script_path
  local extra_args=""
  local daemon_mode=false
  case "$routine" in
    daily-producer)
      script_path="${BARROSKILLS_HOME}/scripts/automation/topic-to-episode.js"
      extra_args="--channel econ-daily --auto-bootstrap-only"
      ;;
    weekly-marketing)
      script_path="${BARROSKILLS_HOME}/scripts/automation/marketing-fetch-local.js"
      extra_args="--source rss"
      ;;
    doctor-daily)
      script_path="${BARROTUBE_HOME}/lib/doctor-cli.sh"
      extra_args=""
      ;;
    telegram-bot)
      # Long-polling daemon — RunAtLoad=true, KeepAlive=true, time_spec 불필요
      script_path="${BARROSKILLS_HOME}/scripts/automation/telegram-bot.js"
      extra_args=""
      daemon_mode=true
      time_spec="daemon"
      ;;
    auto-pipeline)
      # 완전 자율: RSS → 토픽 → S0~S9 → S10 자율 승인 → 30분 reject window → S11 publish
      script_path="${BARROTUBE_HOME}/lib/auto-pipeline.sh"
      extra_args=""
      ;;
    *)
      echo "❌ 알 수 없는 routine: $routine" >&2
      echo "사용 가능: daily-producer | weekly-marketing | doctor-daily | telegram-bot | auto-pipeline"
      exit 1
      ;;
  esac

  # ProgramArguments 명령어가 doctor-daily의 경우 bash 셸 스크립트라 다른 처리
  local prog_args_xml
  if [[ "$script_path" == *.sh ]]; then
    prog_args_xml="    <string>/bin/bash</string>
    <string>${script_path}</string>"
  else
    prog_args_xml="    <string>${NODE_BIN}</string>
    <string>${script_path}</string>"
  fi
  for arg in $extra_args; do
    prog_args_xml="${prog_args_xml}
    <string>${arg}</string>"
  done

  # 스케줄 XML 결정 (daemon 모드 vs cron)
  local schedule_xml run_at_load keep_alive
  if [ "$daemon_mode" = "true" ]; then
    # Long-polling daemon — 항상 실행, 죽으면 재시작
    schedule_xml=""
    run_at_load="true"
    keep_alive="<key>KeepAlive</key>
  <dict><key>Crashed</key><true/></dict>"
  else
    # Cron 형식: "HH:MM" 또는 "Mon HH:MM"
    local hour minute weekday_xml=""
    if [[ "$time_spec" =~ ^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\ ([0-9]{1,2}):([0-9]{2})$ ]]; then
      local day_name="${BASH_REMATCH[1]}"
      hour="${BASH_REMATCH[2]}"
      minute="${BASH_REMATCH[3]}"
      case "$day_name" in
        Sun) weekday_xml="<key>Weekday</key><integer>0</integer>" ;;
        Mon) weekday_xml="<key>Weekday</key><integer>1</integer>" ;;
        Tue) weekday_xml="<key>Weekday</key><integer>2</integer>" ;;
        Wed) weekday_xml="<key>Weekday</key><integer>3</integer>" ;;
        Thu) weekday_xml="<key>Weekday</key><integer>4</integer>" ;;
        Fri) weekday_xml="<key>Weekday</key><integer>5</integer>" ;;
        Sat) weekday_xml="<key>Weekday</key><integer>6</integer>" ;;
      esac
    elif [[ "$time_spec" =~ ^([0-9]{1,2}):([0-9]{2})$ ]]; then
      hour="${BASH_REMATCH[1]}"
      minute="${BASH_REMATCH[2]}"
    else
      echo "❌ 시간 형식 오류: $time_spec (예: '06:00' 또는 'Mon 09:00')" >&2
      exit 1
    fi
    schedule_xml="<key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
    ${weekday_xml}
  </dict>"
    run_at_load="false"
    keep_alive=""
  fi

  # plist 생성
  mkdir -p "$LAUNCH_AGENTS_DIR" "${BARROSKILLS_HOME}/logs/cron"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${prog_args_xml}
  </array>
  <key>WorkingDirectory</key>
  <string>${BARROSKILLS_HOME}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PAPERCLIP_DISABLED</key>
    <string>1</string>
    <key>BARROTUBE_HOME</key>
    <string>${BARROTUBE_HOME}</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  ${schedule_xml}
  <key>RunAtLoad</key>
  <${run_at_load}/>
  ${keep_alive}
  <key>StandardOutPath</key>
  <string>${BARROSKILLS_HOME}/logs/cron/${routine}.log</string>
  <key>StandardErrorPath</key>
  <string>${BARROSKILLS_HOME}/logs/cron/${routine}.err</string>
</dict>
</plist>
EOF

  # launchctl 로드
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load -w "$plist"

  echo "✅ Installed: $label"
  echo "   schedule: $time_spec"
  echo "   script: $script_path"
  echo "   plist: $plist"
  echo "   logs: ${BARROSKILLS_HOME}/logs/cron/${routine}.{log,err}"
}

cmd_uninstall() {
  local routine="$1"
  local label="${LABEL_PREFIX}.${routine}"
  local plist="${LAUNCH_AGENTS_DIR}/${label}.plist"

  if [ ! -f "$plist" ]; then
    echo "⚠️  $label 미설치 — plist 없음" >&2
    exit 1
  fi

  launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"
  echo "✅ Uninstalled: $label"
}

cmd_list() {
  echo "=== BarroSkills cron 데몬 목록 ==="
  local found=0
  for plist in "$LAUNCH_AGENTS_DIR"/${LABEL_PREFIX}.*.plist; do
    [ -f "$plist" ] || continue
    found=$((found + 1))
    local label
    label=$(basename "$plist" .plist)
    echo ""
    echo "▸ $label"
    echo "   plist: $plist"
    launchctl print "gui/$(id -u)/${label}" 2>/dev/null | grep -E "state|last exit|runs|program " | head -5 | sed 's/^/   /'
  done
  if [ $found -eq 0 ]; then
    echo "(설치된 cron 없음 — on-demand 모드)"
  else
    echo ""
    echo "총 $found 개 설치됨"
  fi
}

# 메인
case "${1:-}" in
  install)
    # daemon mode (telegram-bot)는 time_spec 불필요
    if [ "${2:-}" = "telegram-bot" ]; then
      cmd_install "$2" ""
    else
      [ $# -eq 3 ] || { echo "Usage: bash install-cron.sh install <routine> <time>" >&2; exit 1; }
      cmd_install "$2" "$3"
    fi
    ;;
  uninstall)
    [ $# -eq 2 ] || { echo "Usage: bash install-cron.sh uninstall <routine>" >&2; exit 1; }
    cmd_uninstall "$2"
    ;;
  list)
    cmd_list
    ;;
  *)
    cat <<EOF
BarroSkills cron·daemon 관리 스크립트

Usage:
  bash install-cron.sh install <routine> <time>
  bash install-cron.sh install telegram-bot          # daemon 모드 (시간 불필요)
  bash install-cron.sh uninstall <routine>
  bash install-cron.sh list

Routines (cron — 정기 실행):
  daily-producer        매일 EP brief 큐 점검 (예: "06:00") — 무비용 S0만
  weekly-marketing      주간 마케팅 RSS fetch (예: "Mon 09:00") — 무비용
  doctor-daily          자동 진단 (예: "07:00") — 무비용
  auto-pipeline         완전 자율 EP 산출~publish 💰 (예: "06:30")
                        RSS → 토픽 → S0~S9 → S10 자율 → 30분 reject → S11 publish
                        안전 가드 10개 (autonomy-pause, daily quota, budget, QA gate 등)

Daemons (long-running, RunAtLoad=true + KeepAlive):
  telegram-bot          Telegram long-polling 봇 (시간 불필요)

Examples:
  bash install-cron.sh install daily-producer "06:00"
  bash install-cron.sh install weekly-marketing "Mon 09:00"
  bash install-cron.sh install doctor-daily "07:00"
  bash install-cron.sh install auto-pipeline "06:30"
  bash install-cron.sh install telegram-bot
  bash install-cron.sh list
  bash install-cron.sh uninstall auto-pipeline
EOF
    exit 1
    ;;
esac
