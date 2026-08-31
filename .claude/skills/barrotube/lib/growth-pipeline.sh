#!/usr/bin/env bash
#
# growth-pipeline.sh — 채널 성장 루프 일일 루틴
#
#   [측정] 자체 채널 수집 → [판정] KPI 스코어카드 → [처방] 성장 지시
#   → (월요일 아침) [회고] 주간 리포트 + 실험 로테이션
#
# 설계 원칙: competitor-pipeline.sh 와 동일하게 **항상 exit 0**.
#   성장 관측은 EP 생산의 보조 입력이지 선행 조건이 아니다. 여기서 실패해도
#   06:00 us-close / 16:00 kr-close 파이프라인은 그대로 돌아야 한다.
#
# 무과금 원칙: LLM 0회. YouTube Data API 3 units/run. 텔레그램은 기존 봇 재사용.
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
cd "$BARROTUBE_HOME" || exit 0

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
  echo "  ⚠️  ${label} 실패 — 계속 진행"
  audit "growth_${label}_fail" "WARN" "date=${DATE}"
  return 1
}

echo "🌱 성장 루프 — ${DATE} (${HOUR}시 회차)"

# autonomy-pause 게이트를 두지 않는다 — competitor-pipeline 과 같은 이유.
# 관측·판정·처방 파일 생성은 읽기 전용 성격이고 아무것도 발행하지 않는다.
# 처방을 실제로 소비하는 것은 auto-pipeline 이며 그쪽 게이트가 살아 있다.

run_step "fetch" node scripts/automation/fetch-channel-stats.js

KPI_OUT=""
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "  [DRY_RUN] node scripts/automation/growth-kpi.js --date ${DATE}"
else
  KPI_OUT="$(node scripts/automation/growth-kpi.js --date "$DATE" 2>&1)" \
    || { echo "  ⚠️  kpi 실패 — 계속 진행"; audit "growth_kpi_fail" "WARN" "date=${DATE}"; }
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
      || { echo "  ⚠️  weekly 실패 — 계속 진행"; audit "growth_weekly_fail" "WARN" "date=${DATE}"; }
    echo "$WEEKLY_OUT" | grep -v '^WEEKLY=' || true
    WEEKLY_LINE="$(echo "$WEEKLY_OUT" | grep '^WEEKLY=' | head -1 | cut -d= -f2-)"
  fi
fi

run_step "directives" node scripts/automation/growth-directives.js --date "$DATE"

# 알림 정책: 아침 회차는 요약 1건, 오후 회차는 RED 일 때만. 월요일엔 주간 요약 추가.
OVERALL_LINE="$(echo "$KPI_OUT" | grep '^OVERALL=' | head -1 | cut -d= -f2-)"
if [ "${DRY_RUN:-0}" != "1" ] && [ -n "$OVERALL_LINE" ]; then
  OVERALL_GRADE="${OVERALL_LINE%%|*}"
  OVERALL_BRIEF="${OVERALL_LINE#*|}"
  if [ "$HOUR" -lt 12 ] || [ "$OVERALL_GRADE" = "RED" ]; then
    notify_telegram "🌱 <b>성장 KPI $(tg_escape "$OVERALL_GRADE")</b> — ${DATE}
$(tg_escape "$OVERALL_BRIEF")"
  fi
  audit "growth_kpi" "INFO" "date=${DATE} overall=${OVERALL_GRADE}"
fi
if [ -n "$WEEKLY_LINE" ]; then
  notify_telegram "📒 <b>주간 성장 회고</b>
$(tg_escape "$WEEKLY_LINE")"
fi

echo "✓ 성장 루프 종료 (exit 0 고정)"
exit 0
