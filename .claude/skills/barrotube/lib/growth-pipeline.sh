#!/usr/bin/env bash
#
# growth-pipeline.sh — 채널 성장 루프 일일 루틴
#
#   [측정] 자체 채널 수집 → [판정] KPI 스코어카드 → [처방] 성장 지시
#   → (월요일 아침) [회고] 주간 리포트 + 실험 로테이션
#
# 실패는 launchd에 exit 1로 보고한다. 별도 등록된 EP 생산 작업에는 영향이 없다.
#
# LLM 0회. YouTube Data API는 알려진 영상 50개당 1조회 + 채널/목록 조회. 기존 봇 재사용.
#
# 스케줄: 브리핑 슬롯 20분 전 완료 목표로 하루 2회.
#   bash lib/install-cron.sh install growth "05:40,15:40"
#
# 수동 실행:
#   bash lib/growth-pipeline.sh
#   DRY_RUN=1 bash lib/growth-pipeline.sh    # 각 단계를 echo 만

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BARROTUBE_HOME="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$BARROTUBE_HOME" || exit 1

# shellcheck source=./guards.sh
source "${SCRIPT_DIR}/guards.sh"

DATE="${GROWTH_DATE:-$(date +%Y-%m-%d)}"
HOUR="$(date +%H)"

# 텔레그램은 parse_mode=HTML 이라 <·& 가 섞이면 메시지가 조용히 소실된다.
tg_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g'; }

run_step() {
  local label="$1"; shift
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "  [DRY_RUN] $*"
    return 0
  fi
  if "$@"; then
    return 0
  fi
  echo "  ⚠️  ${label} 실패 — 성장 루프 중단"
  audit "growth_${label}_fail" "WARN" "date=${DATE}"
  return 1
}

echo "🌱 성장 루프 — ${DATE} (${HOUR}시 회차)"

# autonomy-pause 게이트를 두지 않는다 — competitor-pipeline 과 같은 이유.
# 관측·판정·처방 파일 생성은 읽기 전용 성격이고 아무것도 발행하지 않는다.
# 처방을 실제로 소비하는 것은 auto-pipeline 이며 그쪽 게이트가 살아 있다.

# 덮개가 닫힌 채 DarkWake(몇 초~45초) 틈에 뜨면 네트워크가 아직 없거나, 요청 도중 다시
# 잠들어 연결이 끊긴다 — 2026-09-29 15:40 회차가 15:55 DarkWake 에서 fetch timeout 으로
# 빠져 doctor 가 RED 를 띄웠다. 네트워크를 기다렸다가 수집하고, 실패하면 한 번 더 기다렸다 재시도한다.
fetch_stats() {
  node scripts/automation/fetch-channel-stats.js && return 0
  echo "  ↻ fetch 실패 — 네트워크를 다시 기다렸다가 한 번 더 시도합니다"
  wait_for_network 20
  node scripts/automation/fetch-channel-stats.js
}
if [ "${DRY_RUN:-0}" != "1" ]; then
  wait_for_network 20 || echo "  ⚠️  네트워크 응답 없음 — 그대로 시도합니다"
fi
run_step "fetch" fetch_stats || exit 1

KPI_OUT=""
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "  [DRY_RUN] node scripts/automation/growth-kpi.js --date ${DATE}"
else
  KPI_OUT="$(node scripts/automation/growth-kpi.js --date "$DATE" 2>&1)" \
    || { echo "$KPI_OUT"; audit "growth_kpi_fail" "ERROR" "date=${DATE}"; exit 1; }
  echo "$KPI_OUT" | grep -v '^OVERALL=' || true
fi

# 주간 회고 + 실험 로테이션 — directives *앞*에 돈다. 뒤에 두면 월요일에 방금 종료
# 판정된 실험 지시가 그날 EP 에 주입된다. --if-due 라 이번 주 회고가 이미 있으면
# 조용히 건너뛰고, 월요일 회차가 절전으로 빠져도 화~일 아침에 만회한다.
WEEKLY_LINE=""
if [ "$HOUR" -lt 12 ]; then
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "  [DRY_RUN] node scripts/automation/growth-weekly.js --date ${DATE} --if-due"
  else
    WEEKLY_OUT="$(node scripts/automation/growth-weekly.js --date "$DATE" --if-due 2>&1)" \
      || { echo "$WEEKLY_OUT"; audit "growth_weekly_fail" "ERROR" "date=${DATE}"; exit 1; }
    echo "$WEEKLY_OUT" | grep -v '^WEEKLY=' || true
    WEEKLY_LINE="$(echo "$WEEKLY_OUT" | grep '^WEEKLY=' | head -1 | cut -d= -f2-)"
  fi
fi

# [진단·처방] KPI 가 RED·YELLOW 면 최근 발행분에서 원인을 찾아 처방을 켜고, 켜 둔 처방의 효과를
# 판정한다(유지·되돌림). directives *앞*에 돌아야 오늘 켠 처방이 오늘 지시문 맨 위에 실린다.
# 진단이 실패해도 처방 생성은 계속한다 — 원인 분석이 빠져도 기존 지시는 나가야 한다.
DIAG_LINE=""
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "  [DRY_RUN] node scripts/automation/growth-diagnose.js --date ${DATE}"
else
  DIAG_OUT="$(node scripts/automation/growth-diagnose.js --date "$DATE" 2>&1)" \
    || { echo "$DIAG_OUT"; audit "growth_diagnose_fail" "WARN" "date=${DATE}"; }
  echo "$DIAG_OUT" | grep -v '^DIAG=' || true
  DIAG_LINE="$(echo "$DIAG_OUT" | grep '^DIAG=' | head -1 | cut -d= -f2-)"
fi

run_step "directives" node scripts/automation/growth-directives.js --date "$DATE" || exit 1

# 알림 정책: 아침 회차는 요약 1건, 오후 회차는 RED 일 때만. 월요일엔 주간 요약 추가.
OVERALL_LINE="$(echo "$KPI_OUT" | grep '^OVERALL=' | head -1 | cut -d= -f2-)"
if [ "${DRY_RUN:-0}" != "1" ] && [ -n "$OVERALL_LINE" ]; then
  OVERALL_GRADE="${OVERALL_LINE%%|*}"
  OVERALL_BRIEF="${OVERALL_LINE#*|}"
  if [ "$HOUR" -lt 12 ] || [ "$OVERALL_GRADE" = "RED" ]; then
    KPI_SENT=1
    notify_telegram "🌱 <b>성장 KPI $(tg_escape "$OVERALL_GRADE")</b> — ${DATE}
$(tg_escape "$OVERALL_BRIEF")${DIAG_LINE:+

$(tg_escape "$DIAG_LINE")}"
  fi
  audit "growth_kpi" "INFO" "date=${DATE} overall=${OVERALL_GRADE}"
fi
# 진단이 새로 켜거나 판정한 처방, 새 설계서는 등급과 상관없이 알린다. 오후 회차는 RED 일 때만
# KPI 를 보내서, YELLOW 인 날 처방이 유지·되돌림으로 바뀌어도 알림이 없었다. DIAG 줄은 새 소식이
# 있을 때만 채워진다(growth-diagnose.js 가 같은 진단을 resend_days 안에 다시 내지 않는다).
if [ "${DRY_RUN:-0}" != "1" ] && [ -n "$DIAG_LINE" ] && [ "${KPI_SENT:-0}" != "1" ]; then
  notify_telegram "$(tg_escape "$DIAG_LINE")"
fi
if [ -n "$WEEKLY_LINE" ]; then
  notify_telegram "📒 <b>주간 성장 회고</b>
$(tg_escape "$WEEKLY_LINE")"
fi

echo "✓ 성장 루프 완료"
exit 0
