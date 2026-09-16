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

umask 077

# BARROTUBE_HOME 자동 감지
if [ -z "${BARROTUBE_HOME:-}" ]; then
  GUARDS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  export BARROTUBE_HOME="$(dirname "$GUARDS_DIR")"
fi

# ─────────────────────────────────────────────────
# .env 의 파이프라인 설정(BT_*)을 셸 환경으로 올린다.
#
# launchd plist 에는 BT_* 가 없다. node 스크립트들은 config-loader 가 .env 를
# 직접 읽어 API 키를 얻지만, BT_GROK_PROFILE·BT_MOTION_ENGINE 같은 **셸/프로세스
# 레벨 설정**은 아무도 안 읽어서 cron 에서만 기본값으로 떨어졌다.
# 그 탓에 cron 은 로그인 안 된 옛 프로필(~/.barrotube/grok-profile)을 보고
# Grok 을 건너뛰었다 — 대화형에서는 사람이 .env 를 source 해서 안 보이던 갭이다
# (2026-08-24 실측: env -i 로 재현 확인).
#
# API 키까지 통째로 export 하지는 않는다. 파이프라인 동작을 바꾸는 BT_* 만 올린다.
# 이미 환경에 있는 값이 우선한다 (일회성 override 를 .env 가 덮지 않도록).
# ─────────────────────────────────────────────────
load_bt_env() {
  local envfile="${BARROTUBE_HOME}/.env"
  [ -f "$envfile" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      BT_*=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    [[ "$key" =~ ^BT_[A-Z0-9_]+$ ]] || continue
    val="${line#*=}"
    # 앞뒤 따옴표 제거
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    # 이미 설정돼 있으면 건드리지 않는다
    [ -n "${!key:-}" ] && continue
    export "$key=$val"
  done < "$envfile"
}
load_bt_env

# ─────────────────────────────────────────────────
# 런타임 해석 — node 를 실행 시점에 찾는다
#
# launchd 는 로그인 셸을 거치지 않아 PATH 가 사실상 비어 있다.
# install-cron.sh 가 설치 시점의 경로를 plist 에 박아 넣지만, 그 값은
# nvm 버전이 올라가는 순간 죽은 경로가 된다 (v24.11.1 → v26 이면 끝).
# 여기서 한 번 더 찾아 두면 plist 가 낡아도 스크립트는 계속 돈다.
# ─────────────────────────────────────────────────
ensure_node_on_path() {
  command -v node >/dev/null 2>&1 && return 0

  local candidates=() nvm_default
  # nvm default alias 를 먼저 따라간다 (lts/* 같은 별칭은 한 단계 더 푼다)
  if [ -f "$HOME/.nvm/alias/default" ]; then
    nvm_default="$(cat "$HOME/.nvm/alias/default" 2>/dev/null)"
    if [ -n "$nvm_default" ] && [ -f "$HOME/.nvm/alias/$nvm_default" ]; then
      nvm_default="$(cat "$HOME/.nvm/alias/$nvm_default" 2>/dev/null)"
    fi
    [ -n "$nvm_default" ] && candidates+=("$HOME/.nvm/versions/node/${nvm_default}/bin")
  fi
  # 설치된 최신 nvm 버전 → homebrew → 시스템 순
  if [ -d "$HOME/.nvm/versions/node" ]; then
    candidates+=("$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin")
  fi
  candidates+=(/opt/homebrew/bin /usr/local/bin /usr/bin)

  local dir
  for dir in "${candidates[@]}"; do
    if [ -x "${dir}/node" ]; then
      export PATH="${dir}:${PATH}"
      return 0
    fi
  done

  echo "❌ node 를 찾을 수 없습니다. nvm/homebrew 설치를 확인하세요." >&2
  return 1
}

ensure_node_on_path || true
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
  local status=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('status','unknown'))" "$AUTONOMY_FILE")
  if [ "$status" != "active" ]; then
    echo "🛑 Autonomy paused (status=$status) — 자율 작업 중단"
    audit "guard_master_switch" "BLOCKED" "status=$status"
    return 1
  fi
  local enabled=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('guards',{}).get('auto_pipeline_enabled',False))" "$AUTONOMY_FILE")
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
  local quota max count
  quota=$(python3 - "$AUTONOMY_FILE" "${BARROTUBE_HOME}/workspace/episodes" <<'PY_CHECK'
import datetime, json, pathlib, sys
kst = datetime.timezone(datetime.timedelta(hours=9))
limit = json.load(open(sys.argv[1]))['guards']['max_episodes_per_day']
if type(limit) is not int or limit < 1:
    raise ValueError('invalid daily publish limit')
today = datetime.datetime.now(kst).date()
seen = set()
root = pathlib.Path(sys.argv[2])
for p in list(root.glob('EP-*/80_publish_result.json')) + list(root.glob('EP-*/platforms/*/80_publish_result.json')):
    d = json.loads(p.read_text())
    yt = d.get('targets', {}).get('youtube', d)
    if not yt.get('videoId'):
        continue
    if yt.get('privacyStatus') == 'private' and yt.get('status') != 'scheduled':
        continue
    # uploadedAt 은 같은 사건의 옛 필드명이다. 2026-07 이전 회차가 이 이름만 갖고 있다.
    raw = yt.get('publishedAt') or d.get('published_at') or yt.get('uploadedAt') or d.get('uploaded_at')
    if not raw:
        # 날짜를 못 읽는 기록 하나로 **모든 실행을 영구히 막아서는 안 된다.**
        # 2026-09-16 실측: EP-2026-0062(2026-07-12 게시)가 uploadedAt 만 갖고 있어
        # Phase 0 가드가 두 달째 raise 했고, 새 회차가 한 편도 시작되지 못했다.
        # 그렇다고 조용히 건너뛰면 오늘치 발행을 놓칠 수 있으므로, 파일 수정 시각을
        # 상한으로 쓴다 — 오늘 쓰인 파일이 아니면 오늘의 발행일 수 없다.
        mtime = datetime.datetime.fromtimestamp(p.stat().st_mtime, kst)
        if mtime.date() == today:
            raise ValueError('publish timestamp missing on a file written today: ' + str(p))
        continue
    at = datetime.datetime.fromisoformat(raw.replace('Z', '+00:00'))
    if at.tzinfo is None:
        raise ValueError('publish timestamp has no timezone')
    if at.astimezone(kst).date() == today:
        seen.add(yt['videoId'])
print(limit, len(seen))
PY_CHECK
  ) || { audit "guard_daily_quota" "BLOCKED" "invalid quota configuration or publish evidence"; return 1; }
  read -r max count <<< "$quota"
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
  local values used total_limit pct alert_pct block_pct
  values=$(python3 - "$AUTONOMY_FILE" "$BUDGET_FILE" "$USAGE_FILE" <<'PY_CHECK'
import json, math, pathlib, sys
policy = json.load(open(sys.argv[1]))['guards']
budget = json.load(open(sys.argv[2]))['budget_policy']['roles']
usage_path = pathlib.Path(sys.argv[3])
usage = json.loads(usage_path.read_text()) if usage_path.exists() else {}
def number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError('invalid budget number')
    return value
limit = sum(number(r.get('monthly_limit', 0)) for r in budget.values())
used = sum(number(r.get('total_usd', 0)) for r in usage.values() if isinstance(r, dict))
alert = number(policy.get('budget_alert_threshold_pct', 80))
block = number(policy.get('budget_block_threshold_pct', 90))
if not 0 <= alert <= block <= 100 or limit <= 0:
    raise ValueError('invalid budget policy')
print(used, limit, int(100 * used / limit), int(alert), int(block))
PY_CHECK
  ) || { audit "guard_budget" "BLOCKED" "invalid budget configuration or usage"; return 1; }
  read -r used total_limit pct alert_pct block_pct <<< "$values"
  if [ "$pct" -ge "$block_pct" ]; then
    echo "🛑 월 예산 $pct% / $block_pct% 도달 — 비용 발생 작업 차단"
    audit "guard_budget" "BLOCKED" "used_usd=$used limit_usd=$total_limit pct=$pct"
    return 1
  fi
  # 경고선. 이 값은 선언만 돼 있고 읽는 코드가 없어서, 무인 운영 중 예산이 90% 벽에
  # 부딪혀 생산이 서는 순간까지 아무 신호도 가지 않았다.
  if [ "$pct" -ge "$alert_pct" ]; then
    echo "⚠️  월 예산 $pct% / 경고선 $alert_pct% (차단선 $block_pct%)"
    audit "guard_budget" "WARN" "used_usd=$used limit_usd=$total_limit pct=$pct alert_at=$alert_pct"
    notify_telegram "⚠️ <b>월 예산 ${pct}%</b>\n사용 \$${used} / 한도 \$${total_limit}\n${block_pct}% 에서 비용 작업이 차단됩니다."
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
  # 공유 구현이 소유자를 재검사한다. 셸에서 무조건 rm 하면 재획득한 락을 지운다.
  node "${BARROTUBE_HOME}/scripts/automation/in-flight-lock.js" release-stale || return 1
  [ ! -f "$INFLIGHT_FILE" ]
}

# ─────────────────────────────────────────────────
# Guard 5: Telegram 알람 전송 (required=1이면 실패를 호출자에 전달)
# ─────────────────────────────────────────────────
notify_telegram() {
  local text="$1" required="${2:-0}"
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  if printf '%s' "$text" | node --input-type=module -e '
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { sendTelegramText } = await import(pathToFileURL(process.argv[2]));
try { if (!await sendTelegramText(readFileSync(0, "utf8"))) process.exitCode = 1; }
catch (e) { console.error(e.message); process.exitCode = 1; }
' barrotube-notify-helper "${BARROTUBE_HOME}/scripts/automation/notify.js"; then
    return 0
  fi
  audit "telegram_delivery" "ERROR" "message delivery failed"
  [ "$required" != "1" ]
}

# ─────────────────────────────────────────────────
# Guard 6: Telegram reject window 대기 + 검증
# ─────────────────────────────────────────────────
wait_telegram_reject_window() {
  local ep="$1"
  [[ "$ep" =~ ^EP-[0-9]{4}-[0-9]{4}$ ]] || return 1
  local minutes
  minutes=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])).get("guards",{}).get("publish_reject_window_minutes",30); assert type(m) is int and 1 <= m <= 1440, "invalid reject window"; print(m)' "$AUTONOMY_FILE") || return 1
  local reject_file="${BARROTUBE_HOME}/workspace/.reject-window/${ep}.flag"
  local open_file="${BARROTUBE_HOME}/workspace/.reject-window/${ep}.open"
  mkdir -p "$(dirname "$reject_file")"
  [ ! -f "$reject_file" ] || { echo "🛑 기존 reject 유지 — publish 중단"; return 1; }

  # 창이 열려 있다는 사실을 **파일로** 남긴다.
  #
  # 예전에는 아무 표식도 없어서 "이 EP 는 지금 취소 대기 중" 을 다른 프로세스가
  # 알 방법이 없었다. 그래서 publish-resume 크론(07:30·17:30)이 창 한가운데서
  # 같은 EP 를 먼저 올려 버렸다 — 2026-09-08 EP-2026-0143 실측: 창이
  # 17:20:54~17:50:59 인데 업로드가 17:32 에 끝났고, 그 18분 동안 운영자의
  # /reject 는 아무 효력이 없었다. 슬롯(16:00)과 크론(17:30)의 구조적 겹침이라
  # 우연이 아니다 — Phase 11 에 74~90분 만에 닿으면 항상 겹친다.
  #
  # 마감 시각을 적는 이유: 파이프라인이 창 도중 죽으면 표식이 남는데, 그게 영원히
  # 발행을 막으면 "승인됐는데 안 올라간 EP 를 되살린다" 는 publish-resume 의
  # 존재 이유가 사라진다. 지난 표식은 무시하고 지운다.
  local deadline
  deadline=$(python3 -c 'import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).isoformat())' "$minutes") || return 1
  printf '%s\n' "$deadline" > "$open_file"

  if ! notify_telegram "🟡 <b>${ep}</b> reject window 시작 (${minutes}분)\n취소하려면 <code>/reject ${ep}</code>" 1; then
    printf '%s\n' 'notification_failed' > "$open_file"
    return 1
  fi
  audit "telegram_reject_window_start" "INFO" "ep=$ep minutes=$minutes"

  local i=0
  while [ "$i" -lt "$minutes" ]; do
    sleep 60
    guard_master_switch || return 1
    if [ -f "$reject_file" ]; then
      echo "🛑 운영자 reject 수신 — publish 중단"
      audit "telegram_reject_window" "REJECTED" "ep=$ep at_minute=$i"
      notify_telegram "🛑 <b>${ep}</b> publish 취소됨 (운영자 reject)"
      rm -f "$open_file"
      return 1
    fi
    i=$((i+1))
  done
  rm -f "$open_file"
  audit "telegram_reject_window_passed" "INFO" "ep=$ep waited=${minutes}min"
  return 0
}

# 거부창이 지금 열려 있나. 0=열림(건드리지 마라) · 1=아님.
# 마감이 지난 표식은 파이프라인이 죽어 남긴 것이므로 지우고 1 을 돌린다.
reject_window_open() {
  local ep="$1"
  local open_file="${BARROTUBE_HOME}/workspace/.reject-window/${ep}.open"
  [ -s "$open_file" ] || return 1
  REJECT_WINDOW_DEADLINE=$(head -1 "$open_file")
  if BT_RW_DEADLINE="$REJECT_WINDOW_DEADLINE" python3 -c "
import sys, os, datetime
raw = os.environ.get('BT_RW_DEADLINE', '').strip()
try:
    d = datetime.datetime.fromisoformat(raw)
except Exception:
    sys.exit(0)  # 손상되거나 전송 실패한 표식은 게시를 차단한다.
sys.exit(0 if datetime.datetime.now(datetime.timezone.utc) < d else 1)
" 2>/dev/null; then
    return 0
  fi
  rm -f "$open_file"   # 지난 표식 — 창을 돌던 프로세스가 죽었다
  return 1
}

# ─────────────────────────────────────────────────
# Guard 7: QA verdict 검증
# ─────────────────────────────────────────────────
guard_qa_pass() {
  local ep_dir="$1"
  local qa_report="${ep_dir}/60_qa_report.md"
  if [ ! -f "$qa_report" ]; then
    echo "🛑 QA report 없음 — publish 차단"
    audit "guard_qa_pass" "BLOCKED" "no_qa_report"
    return 1
  fi
  node --input-type=module -e '
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { parseQaReport } = await import(pathToFileURL(process.argv[1]));
const source = readFileSync(process.argv[2], "utf8");
const qa = parseQaReport(source);
const score = /Score:\s*(\d+)/i.exec(source);
const min = JSON.parse(readFileSync(process.argv[3], "utf8")).guards?.qa_min_score ?? 60;
process.exit(qa.passed && qa.video_sha256 && (!score || Number(score[1]) >= min) ? 0 : 1);
' "${BARROTUBE_HOME}/scripts/automation/lib/publish-approval.js" "$qa_report" "$AUTONOMY_FILE" || {
    echo "🛑 QA 판정·해시가 없거나 FAIL — publish 차단"
    audit "guard_qa_pass" "BLOCKED" "invalid_or_failed_qa"
    return 1
  }
}

# ─────────────────────────────────────────────────
# 호출 안 됨 — sourcing test
# ─────────────────────────────────────────────────
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "guards.sh — source로 import하세요"
  echo "사용 가능 함수: guard_master_switch, guard_daily_quota, guard_budget, guard_in_flight, notify_telegram, wait_telegram_reject_window, guard_qa_pass, audit"
fi
