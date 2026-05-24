#!/bin/bash
#
# doctor-cli.sh — BarroSkills 자동 진단 (cron 일일 호출용)
#
# /barrotube doctor 서브커맨드의 핵심 체크를 셸 명령으로 자동 실행.
# 결과를 logs/audit/YYYY-MM-DD.jsonl + logs/cron/doctor-daily.log에 기록.
#
# Usage:
#   bash doctor-cli.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SCRIPT_DIR = .../barrotube/lib → BARROTUBE_HOME = .../barrotube (한 번 dirname)
BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
BARROSKILLS_HOME="$BARROTUBE_HOME"   # 하위 호환 alias
cd "$BARROSKILLS_HOME"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
AUDIT_LOG="${BARROSKILLS_HOME}/logs/audit/$(date +%Y-%m-%d).jsonl"
mkdir -p "${BARROSKILLS_HOME}/logs/audit"

# 결과 누적
RESULTS=()
add_result() {
  local key="$1"; local status="$2"; local detail="$3"
  RESULTS+=("\"${key}\": {\"status\": \"${status}\", \"detail\": \"${detail}\"}")
}

# 1. .env + 필수 키
if [ -f .env ]; then
  source .env 2>/dev/null
  MISSING=()
  for key in ELEVENLABS_API_KEY GOOGLE_AI_API_KEY YOUTUBE_DATA_API_KEY YOUTUBE_OAUTH_REFRESH_TOKEN; do
    [ -z "${!key:-}" ] && MISSING+=("$key")
  done
  if [ ${#MISSING[@]} -eq 0 ]; then
    add_result "secrets" "GREEN" "4/4 keys present"
  else
    add_result "secrets" "RED" "missing: ${MISSING[*]}"
  fi
else
  add_result "secrets" "RED" ".env file not found"
fi

# 2. PAPERCLIP_DISABLED
if [ "${PAPERCLIP_DISABLED:-}" = "1" ]; then
  add_result "paperclip_isolation" "GREEN" "PAPERCLIP_DISABLED=1"
else
  add_result "paperclip_isolation" "YELLOW" "PAPERCLIP_DISABLED 미설정 — BarroSkills 권장: =1"
fi

# 3. 17 agents
AGENT_COUNT=$(ls ~/.claude/agents/barrotube-*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$AGENT_COUNT" = "17" ]; then
  add_result "agents" "GREEN" "17/17"
else
  add_result "agents" "RED" "$AGENT_COUNT/17"
fi

# 4. In-flight lock
if [ -f workspace/.in-flight.json ]; then
  LOCK_PID=$(python3 -c "import json; print(json.load(open('workspace/.in-flight.json')).get('pid', ''))" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && ps -p "$LOCK_PID" > /dev/null 2>&1; then
    add_result "in_flight_lock" "YELLOW" "active EP, PID=$LOCK_PID alive"
  elif [ -n "$LOCK_PID" ]; then
    add_result "in_flight_lock" "RED" "STALE lock, PID=$LOCK_PID dead"
  else
    add_result "in_flight_lock" "GREEN" "clear"
  fi
else
  add_result "in_flight_lock" "GREEN" "no lock"
fi

# 5. _legacy_paperclip 격리
LEGACY_COUNT=$(ls scripts/automation/_legacy_paperclip/ 2>/dev/null | wc -l | tr -d ' ')
add_result "legacy_isolation" "GREEN" "$LEGACY_COUNT scripts isolated"

# 6. Active scripts에 Paperclip API 호출 잔재 검색 (-E로 ERE 사용, escape 명확)
PAPERCLIP_LEAK=$(grep -lE "(localhost|127\.0\.0\.1):3100" scripts/automation/*.js 2>/dev/null | wc -l | awk '{print $1}')
if [ "${PAPERCLIP_LEAK:-0}" = "0" ]; then
  add_result "paperclip_leak" "GREEN" "clean (0 active files reference Paperclip API URL)"
else
  add_result "paperclip_leak" "YELLOW" "$PAPERCLIP_LEAK files still reference Paperclip API URL"
fi

# 7. 최근 24h audit 활동
AUDIT_TODAY=$(wc -l < "$AUDIT_LOG" 2>/dev/null || echo 0)
add_result "audit_today" "INFO" "$AUDIT_TODAY entries"

# 결과 JSON 합성 + audit 기록
RESULT_JSON="{\"at\": \"$NOW\", \"event\": \"doctor_daily\", \"source\": \"doctor-cli.sh\", \"checks\": {$(IFS=','; echo "${RESULTS[*]}")}}"
echo "$RESULT_JSON" >> "$AUDIT_LOG"

# 콘솔 출력
echo "🩺 BarroSkills Doctor — $NOW"
echo ""
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "Audit logged: $AUDIT_LOG"

# RED가 하나라도 있으면 exit 1 (cron에서 알람 트리거 가능)
if echo "$RESULT_JSON" | grep -q '"status": "RED"'; then
  exit 1
fi
exit 0
