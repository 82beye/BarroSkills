#!/bin/bash
# market-map-krclose.sh — 석간 마켓맵이 쓸 KRX 공식 종가 스냅샷 (평일 15:45, 무과금)
#
# 석간은 18:00 인데, 그 시각 네이버 종목 시세(= KRX 거래소 시세)에는 시간외 단일가
# (16:00~18:00, 16:10 부터 10분마다 체결)가 반영돼 공식 종가와 다르다.
# 2026-09-28 18:09 석간 실측: 58종목 중 45종목이 달랐다 — 최대 1.16%p.
# 첫 시간외 체결 전인 15:35~16:09 에는 네이버 최상위 값이 곧 공식 종가라 이때 떠 둔다.
# 석간(market-map.js)이 오늘 세션의 스냅샷을 찾아 코스피·테마 카드에 쓴다.
#
#   bash install-cron.sh install market-map-krclose "Mon-Fri 15:45"
set -uo pipefail
BARROTUBE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BARROTUBE_HOME"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 덮개가 닫힌 채 DarkWake 틈에 뜨면 네트워크가 없다 — 올라올 때까지 기다린다.
# 너무 늦게 깨어 창(16:09)을 넘기면 market-map.js 가 스스로 저장하지 않는다.
source "${BARROTUBE_HOME}/lib/guards.sh"
wait_for_network 20 || echo "⚠ 네트워크 응답 없음 — 그대로 시도" >&2

node scripts/automation/market-map.js --kr-close-snapshot
