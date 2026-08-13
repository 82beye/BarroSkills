#!/usr/bin/env bash
#
# competitor-pipeline.sh — 경쟁 인텔 일일 루틴
#
#   수집 → 분석 → 핸드오프
#
# 설계 원칙: 이 스크립트는 **항상 exit 0** 이다.
#   인텔은 EP 생산의 보조 입력이지 선행 조건이 아니다. 여기서 실패해도
#   05:20 이후의 us-close(06:00) / kr-close(16:00) 파이프라인은 그대로 돌아야 한다.
#   각 단계 실패는 audit 에 WARN 으로만 남긴다.
#
# 설치:
#   bash lib/install-cron.sh install competitor-scan "05:20"
#
# 수동 실행:
#   bash lib/competitor-pipeline.sh
#   DRY_RUN=1 bash lib/competitor-pipeline.sh    # 각 단계를 echo 만

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BARROTUBE_HOME="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$BARROTUBE_HOME" || exit 0

# shellcheck source=./guards.sh
source "${SCRIPT_DIR}/guards.sh"

DATE="${COMPETITOR_DATE:-$(date +%Y-%m-%d)}"

run_step() {
  local label="$1"; shift
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "  [DRY_RUN] $*"
    return 0
  fi
  if "$@"; then
    return 0
  fi
  echo "  ⚠️  ${label} 실패 — 계속 진행"
  audit "competitor_${label}_fail" "WARN" "date=${DATE}"
  return 1
}

echo "📡 경쟁 인텔 루틴 — ${DATE}"

# guard_master_switch 를 여기 두지 않는다.
#
# autonomy-pause 는 "자동 발행"을 막는 스위치다. 수집·분석은 읽기 전용이고
# 무료 쿼터 안에서 돌며 아무것도 발행하지 않는다. 여기서 막으면 pause 기간 내내
# 인덱스가 비어 있다가, 재개하는 순간 90일 baseline 도 이상치 판정도 불가능해진다.
# 관측은 계속하고, 의사결정을 유발하는 핸드오프(Rule I1/I2)만 게이트를 지킨다
# — 그 가드는 intel-handoff.js 안에 있다.

# OAuth 만료를 먼저 알린다. 동의 화면이 "테스트" 상태면 refresh token 이 7일 뒤 죽는데,
# 만료돼야 알 수 있으면 그 사이 수집이 조용히 실패한다 (2026-08-13 실제 사례).
# 무비용 경과일 검사이며 WARN 이상일 때만 텔레그램을 보낸다. 실패해도 수집은 그대로 시도한다.
run_step "oauth_check" node scripts/automation/check-oauth-expiry.js --notify

run_step "fetch"    node scripts/automation/fetch-competitor-stats.js --date "$DATE"
run_step "analyze"  node scripts/automation/analyze-competitors.js  --date "$DATE"
run_step "handoff"  node scripts/automation/intel-handoff.js        --date "$DATE"

echo "✓ 경쟁 인텔 루틴 종료 (exit 0 고정)"
exit 0
