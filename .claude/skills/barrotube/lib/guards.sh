#!/bin/bash
#
# guards.sh — BarroSkills 공통 안전 가드 라이브러리
#
# 다른 스크립트에서 source 해서 사용:
#   source "$(dirname "${BASH_SOURCE[0]}")/guards.sh"
#   guard_master_switch || exit 0
#   guard_in_flight || exit 1
#   guard_daily_quota || exit 0
#   guard_budget || exit 1
#
# 각 함수: 통과 = exit 0, 위반 = exit 1 + 표준 출력에 사유

# BARROTUBE_HOME 자동 감지
if [ -z "${BARROTUBE_HOME:-}" ]; then
  GUARDS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  export BARROTUBE_HOME="$(dirname "$GUARDS_DIR")"
fi
AUTONOMY_FILE="${BARROTUBE_HOME}/config/autonomy-pause.json"
BUDGET_FILE="${BARROTUBE_HOME}/config/budget-policy.json"
USAGE_FILE="${BARROTUBE_HOME}/logs/budget/usage-$(date +%Y-%m).json"
AUDIT_LOG="${BARROTUBE_HOME}/logs/audit/$(date +%Y-%m-%d).jsonl"
INFLIGHT_FILE="${BARROTUBE_HOME}/workspace/.in-flight.json"

mkdir -p "$(dirname "$AUDIT_LOG")" "$(dirname "$USAGE_FILE")"

# ─────────────────────────────────────────────────
# Audit helper
# ─────────────────────────────────────────────────
audit() {
  local event="$1"; local status="$2"; local detail="${3:-}"
  local ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "{\"at\":\"$ts\",\"event\":\"$event\",\"status\":\"$status\",\"detail\":$(printf '%s' "$detail" | python3 -c "import sys,json;print(json.dumps(sys.stdin.read()))")}" >> "$AUDIT_LOG"
}

# ─────────────────────────────────────────────────
# Guard 1: Master kill switch
# ─────────────────────────────────────────────────
guard_master_switch() {
  if [ ! -f "$AUTONOMY_FILE" ]; then
    echo "⚠️  autonomy-pause.json 없음 — 안전상 차단"
    audit "guard_master_switch" "BLOCKED" "autonomy-pause.json missing"
    return 1
  fi
  local status=$(python3 -c "import json;print(json.load(open('$AUTONOMY_FILE')).get('status','unknown'))")
  if [ "$status" != "active" ]; then
    echo "🛑 Autonomy paused (status=$status) — 자율 작업 중단"
    audit "guard_master_switch" "BLOCKED" "status=$status"
    return 1
  fi
  local enabled=$(python3 -c "import json;d=json.load(open('$AUTONOMY_FILE'));print(d.get('guards',{}).get('auto_pipeline_enabled',False))")
  if [ "$enabled" != "True" ]; then
    echo "🛑 auto_pipeline_enabled=false — 비활성화됨"
    audit "guard_master_switch" "BLOCKED" "auto_pipeline_enabled=false"
    return 1
  fi
  return 0
}

# ─────────────────────────────────────────────────
# Guard 2: 일일 EP 발행 상한
# ─────────────────────────────────────────────────
guard_daily_quota() {
  local max=$(python3 -c "import json;print(json.load(open('$AUTONOMY_FILE')).get('guards',{}).get('max_episodes_per_day',1))")
  local today=$(date +%Y-%m-%d)
  # 오늘 publish된 EP 카운트 (workspace/episodes/EP-*/.episode_status.json의 status=published + updated_at today)
  local count=$(find "${BARROTUBE_HOME}/workspace/episodes" -name ".episode_status.json" -maxdepth 2 2>/dev/null | xargs -I{} python3 -c "
import json,sys
try:
  d=json.load(open(sys.argv[1]))
  if d.get('status')=='published' and (d.get('updated_at','').startswith('$today') or any(h.get('stage')=='S11' and h.get('timestamp','').startswith('$today') for h in d.get('stage_history',[]))):
    print(1)
except: pass
" {} 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -ge "$max" ]; then
    echo "🛑 일일 EP 상한 도달 ($count/$max) — 오늘 자동 발행 종료"
    audit "guard_daily_quota" "BLOCKED" "today_published=$count max=$max"
    return 1
  fi
  return 0
}

# ─────────────────────────────────────────────────
# Guard 3: 월 예산 한도
# ─────────────────────────────────────────────────
guard_budget() {
  local block_pct=$(python3 -c "import json;print(json.load(open('$AUTONOMY_FILE')).get('guards',{}).get('budget_block_threshold_pct',90))")
  local total_limit=$(python3 -c "import json;p=json.load(open('$BUDGET_FILE'));print(sum(r.get('monthly_limit',0) for r in p['budget_policy']['roles'].values()))")
  local used=0
  if [ -f "$USAGE_FILE" ]; then
    used=$(python3 -c "import json;d=json.load(open('$USAGE_FILE'));print(sum(v.get('total_usd',0) for v in d.values() if isinstance(v,dict)))")
  fi
  local pct=$(python3 -c "print(int(($used/$total_limit)*100) if $total_limit>0 else 0)")
  if [ "$pct" -ge "$block_pct" ]; then
    echo "🛑 월 예산 $pct% / $block_pct% 도달 — 비용 발생 작업 차단"
    audit "guard_budget" "BLOCKED" "used_usd=$used limit_usd=$total_limit pct=$pct"
    return 1
  fi
  return 0
}

# ─────────────────────────────────────────────────
# Guard 4: In-flight 락 (직렬 처리 보장)
# ─────────────────────────────────────────────────
guard_in_flight() {
  if [ ! -f "$INFLIGHT_FILE" ]; then
    return 0
  fi
  local pid=$(python3 -c "import json;print(json.load(open('$INFLIGHT_FILE')).get('pid',''))" 2>/dev/null)
  if [ -n "$pid" ] && ps -p "$pid" > /dev/null 2>&1; then
    local ep=$(python3 -c "import json;print(json.load(open('$INFLIGHT_FILE')).get('episode_id',''))")
    echo "🛑 In-flight lock active: $ep (PID $pid) — 다음 사이클 대기"
    audit "guard_in_flight" "BLOCKED" "active_ep=$ep pid=$pid"
    return 1
  fi
  # Stale lock — 자동 정리
  echo "⚠️  Stale lock 정리 (PID $pid 없음)"
  rm -f "$INFLIGHT_FILE"
  audit "guard_in_flight" "STALE_CLEANED" "removed pid=$pid"
  return 0
}

# ─────────────────────────────────────────────────
# Guard 5: Telegram 알람 전송 (실패 시 silent)
# ─────────────────────────────────────────────────
notify_telegram() {
  local text="$1"
  if [ ! -f "${BARROTUBE_HOME}/.env" ]; then return 0; fi
  local token=$(grep "^TELEGRAM_BOT_TOKEN=" "${BARROTUBE_HOME}/.env" | cut -d= -f2-)
  local chat=$(grep "^TELEGRAM_CHAT_ID=" "${BARROTUBE_HOME}/.env" | cut -d= -f2-)
  if [ -z "$token" ] || [ -z "$chat" ]; then return 0; fi
  curl -sS -m 10 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"$chat\",\"text\":$(printf '%s' "$text" | python3 -c "import sys,json;print(json.dumps(sys.stdin.read()))"),\"parse_mode\":\"HTML\"}" \
    > /dev/null 2>&1 || true
}

# ─────────────────────────────────────────────────
# Guard 6: Telegram reject window 대기 + 검증
# ─────────────────────────────────────────────────
wait_telegram_reject_window() {
  local ep="$1"
  local minutes=$(python3 -c "import json;print(json.load(open('$AUTONOMY_FILE')).get('guards',{}).get('publish_reject_window_minutes',30))")
  local reject_file="${BARROTUBE_HOME}/workspace/.reject-window/${ep}.flag"
  mkdir -p "$(dirname "$reject_file")"
  rm -f "$reject_file"   # 시작 시 클리어

  notify_telegram "🟡 <b>${ep}</b> reject window 시작 (${minutes}분)\n취소하려면 <code>/reject ${ep}</code>"
  audit "telegram_reject_window_start" "INFO" "ep=$ep minutes=$minutes"

  local i=0
  while [ "$i" -lt "$minutes" ]; do
    sleep 60
    if [ -f "$reject_file" ]; then
      echo "🛑 운영자 reject 수신 — publish 중단"
      audit "telegram_reject_window" "REJECTED" "ep=$ep at_minute=$i"
      notify_telegram "🛑 <b>${ep}</b> publish 취소됨 (운영자 reject)"
      return 1
    fi
    i=$((i+1))
  done
  audit "telegram_reject_window_passed" "INFO" "ep=$ep waited=${minutes}min"
  return 0
}

# ─────────────────────────────────────────────────
# Guard 7: QA verdict 검증
# ─────────────────────────────────────────────────
guard_qa_pass() {
  local ep_dir="$1"
  local qa_report="${ep_dir}/60_qa_report.md"
  if [ ! -f "$qa_report" ]; then
    # platforms/long 또는 platforms/shorts 시도
    qa_report=$(find "$ep_dir" -name "60_qa_report.md" | head -1)
  fi
  if [ ! -f "$qa_report" ]; then
    echo "🛑 QA report 없음 — publish 차단"
    audit "guard_qa_pass" "BLOCKED" "no_qa_report"
    return 1
  fi
  # PASS|FAIL 검색 (단순)
  if grep -qi "verdict: *FAIL\|status: *FAIL\|❌ FAIL" "$qa_report"; then
    echo "🛑 QA FAIL — publish 차단"
    audit "guard_qa_pass" "BLOCKED" "verdict=FAIL"
    return 1
  fi
  # score 추출 (Score: 75 형식 가정)
  local score=$(grep -oE "Score: *[0-9]+" "$qa_report" | head -1 | grep -oE "[0-9]+" || echo "100")
  local min_score=$(python3 -c "import json;print(json.load(open('$AUTONOMY_FILE')).get('guards',{}).get('qa_min_score',60))")
  if [ "$score" -lt "$min_score" ]; then
    echo "🛑 QA score $score < $min_score — publish 차단"
    audit "guard_qa_pass" "BLOCKED" "score=$score min=$min_score"
    return 1
  fi
  return 0
}

# ─────────────────────────────────────────────────
# 호출 안 됨 — sourcing test
# ─────────────────────────────────────────────────
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "guards.sh — source로 import하세요"
  echo "사용 가능 함수: guard_master_switch, guard_daily_quota, guard_budget, guard_in_flight, notify_telegram, wait_telegram_reject_window, guard_qa_pass, audit"
fi
