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
# guards.sh — notify_telegram 과 ensure_node_on_path 를 쓴다
# shellcheck source=./guards.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guards.sh"

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

# 3. 파이프라인 필수 에이전트
#
# 개수를 정확히 세던 검사("17이면 GREEN")는 두 방향으로 틀렸다:
# 에이전트가 하나 늘면 멀쩡한데 RED 가 되고(2026-08-13 실측 18/17),
# 반대로 엉뚱한 17개여도 통과했다. 이름으로 필수 항목을 확인한다.
# 선택 에이전트(reel-director, producer-shorts 등)는 개수에만 잡힌다.
REQUIRED_AGENTS="ceo cmo marketing-analyst content-manager producer researcher strategist \
writer fact-checker asset-pm voice-engineer image-generator capcut-composer qa-reviewer \
metadata-writer publisher"

AGENT_COUNT=$(ls ~/.claude/agents/barrotube-*.md 2>/dev/null | wc -l | tr -d ' ')
MISSING_AGENTS=""
for _a in $REQUIRED_AGENTS; do
  [ -f "$HOME/.claude/agents/barrotube-${_a}.md" ] || MISSING_AGENTS="${MISSING_AGENTS}${MISSING_AGENTS:+, }${_a}"
done

if [ -n "$MISSING_AGENTS" ]; then
  add_result "agents" "RED" "missing: ${MISSING_AGENTS} (installed ${AGENT_COUNT})"
else
  add_result "agents" "GREEN" "${AGENT_COUNT} installed, all required present"
fi

# 4. In-flight lock
#
# stale 락은 보고만 하면 안 된다. 락은 다음 회차 전체를 막는데 해제가 사람 손을
# 기다리면 그동안 슬롯이 통째로 빈다(EP-2026-0134·0138 등 반복). 감시자가 이미
# "pid 죽음" 을 확인했으니 여기서 정리한다 — 죽은 프로세스의 락은 정의상 아무도
# 쓰고 있지 않다.
#
# forceRelease 를 직접 부르지 않는 이유: 판정과 삭제 사이에 새 프로세스가 락을
# 잡을 수 있고, 그때 무조건 지우면 **살아 있는 작업의 락**을 뺏어 두 에피소드가
# 동시에 돈다. release-stale 은 지우기 직전에 pid·started_at 을 다시 확인한다.
if [ -f workspace/.in-flight.json ]; then
  LOCK_PID=$(python3 -c "import json; print(json.load(open('workspace/.in-flight.json')).get('pid', ''))" 2>/dev/null)
  LOCK_EP=$(python3 -c "import json; print(json.load(open('workspace/.in-flight.json')).get('episode_id', '?'))" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && ps -p "$LOCK_PID" > /dev/null 2>&1; then
    add_result "in_flight_lock" "YELLOW" "active ${LOCK_EP}, PID=$LOCK_PID alive"
  else
    RS=$(node scripts/automation/in-flight-lock.js release-stale 2>&1 | tr -d '\n"' | cut -c1-120)
    if printf '%s' "$RS" | grep -q "Released stale lock"; then
      add_result "in_flight_lock" "YELLOW" "STALE ${LOCK_EP} (PID=${LOCK_PID:-?} dead) — 자동 해제함"
    elif printf '%s' "$RS" | grep -qE "No lock|Lock is live"; then
      add_result "in_flight_lock" "GREEN" "clear (${RS})"
    else
      add_result "in_flight_lock" "RED" "STALE ${LOCK_EP} 해제 실패 — ${RS}"
    fi
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

# 7. YouTube OAuth 만료 임박
# 동의 화면이 "테스트" 상태면 refresh token 이 7일 뒤 만료된다. 무비용 경과일 검사만 한다
# (실검증은 1 unit 이라 doctor 에 넣지 않는다 — check-oauth-expiry.js --verify 로 따로).
OAUTH_LEVEL=$(node scripts/automation/check-oauth-expiry.js --json 2>/dev/null \
  | grep -o '"level": "[^"]*"' | head -1 | cut -d'"' -f4)
case "${OAUTH_LEVEL:-UNKNOWN}" in
  OK)       add_result "youtube_oauth" "GREEN"  "refresh token 유효 범위" ;;
  WARN)     add_result "youtube_oauth" "YELLOW" "만료 임박 — setup-youtube-oauth.js 실행 권장" ;;
  CRITICAL) add_result "youtube_oauth" "YELLOW" "만료 직전 — 오늘 갱신 필요" ;;
  EXPIRED)  add_result "youtube_oauth" "RED"    "만료됨 — setup-youtube-oauth.js 실행 필요" ;;
  *)        add_result "youtube_oauth" "INFO"   "발급 시각 미기록 — 다음 갱신 시 기록된다" ;;
esac

# 8. codex CLI 실행 가능성
#
# command -v 만으로는 이 고장을 못 잡는다. 2026-09-06 npm 자동 업데이트가 플랫폼
# 패키지(@openai/codex-darwin-arm64)를 vendor/ 만 남기고 package.json 없이 풀어서,
# 런처의 require.resolve 가 실패했다 — bin 심볼릭도 함께 빠져 PATH 에서도 사라졌다.
# 같은 고장이 2026-09-04 에도 났고, 두 번 다 새벽 파이프라인이 Phase 7 에서 멈춘 뒤에야
# 발견됐다(EP-2026-0140). S6c 씬 이미지가 전부 codex 라 이게 죽으면 그날 편이 안 나간다.
# 그래서 실제로 --version 을 돌려 본다. 실행 비용은 수십 ms 다.
CODEX_FIX="npm install -g @openai/codex@latest"
if ! command -v codex >/dev/null 2>&1; then
  add_result "codex_cli" "RED" "PATH 에 codex 없음 — ${CODEX_FIX}"
else
  CODEX_VER=$(codex --version 2>&1 | head -1 | tr -d '"' | tr -d '\n')
  if printf '%s' "$CODEX_VER" | grep -qi "codex"; then
    add_result "codex_cli" "GREEN" "$CODEX_VER"
  else
    add_result "codex_cli" "RED" "설치는 있으나 실행 실패(${CODEX_VER:0:60}) — ${CODEX_FIX}"
  fi
fi

# 9. 최근 24h audit 활동
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

# RED 는 조용히 지나가면 안 된다.
# doctor 의 존재 이유가 "silent failure 탐지" 인데, 결과가 로그 파일에만 남으면
# 아무도 안 본다 — 2026-08-13 까지 알림 경로가 아예 없었다.
if echo "$RESULT_JSON" | grep -q '"status": "RED"'; then
  RED_LIST=$(printf '%s' "$RESULT_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)['checks']
print('\n'.join(f'• {k}: {v[\"detail\"]}' for k,v in d.items() if v['status']=='RED'))
" 2>/dev/null)
  notify_telegram "🩺 <b>doctor RED</b>
${RED_LIST}

<code>bash ${BARROTUBE_HOME}/lib/doctor-cli.sh</code>"
  exit 1
fi
exit 0
