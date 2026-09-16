#!/bin/bash
# market-map-cron.sh — 마켓맵 카드뉴스 10장 생성 + 텔레그램 발송 (무과금)
#
# 하루 두 판 (운영자 지시 2026-09-17):
#   08:00 조간 — 미국 증시 마감 기준. 이 시각 한국장은 아직 안 열렸다(직전 세션).
#   20:00 석간 — 국내장 마감 기준. 이 시각 미국장은 아직 안 열렸다(직전 마감).
# 막 닫힌 시장이 표지와 카드 앞머리에 온다. 판은 스크립트가 KST 시각으로 정한다
# (lib/market-map.js 의 resolveEdition) — 크론 plist 하나로 두 시각을 돌리기 위해서다.
#
#   bash install-cron.sh install market-map "08:00,20:00"
#
# 세션 라벨은 시계가 아니라 응답이 정본이다: 미국은 Yahoo 의 regularMarketTime,
# 코스피는 네이버의 localTradedAt/marketStatus 를 읽는다. 08시 회차에 KST 날짜로
# "오늘 15:30 마감"을 찍으면 오지 않은 마감을 적게 된다.
#
# 링크: https://82beye.github.io/BarroSkills/ 가 매 판마다 갱신된다 (lib/market-map-pages.sh).
# 게시(커뮤니티 업로드)는 사람 몫이다: 텔레그램으로 받은 10장을 올린다.
# 커뮤니티 게시는 공식 API 가 없어서(2026-09 기준) 무인 업로드는 브라우저 자동화뿐인데,
# 그 경로는 로그인·UI 변경에 취약해 상시 크론에 넣지 않는다.
set -euo pipefail
BARROTUBE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BARROTUBE_HOME"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ED="${1:-$(node -e "import('./scripts/automation/lib/market-map.js').then(m=>console.log(m.resolveEdition()))")}"
echo "🗞  마켓맵 ${ED}판 시작 $(date '+%F %H:%M')"

# 1) 수집 (+ 보관용 포스터 3장). 텔레그램으로는 안 보낸다 — 발송물은 카드뉴스다.
node scripts/automation/market-map.js --edition "$ED"

# 2) 카드뉴스 10장 조판 → PNG → 공개 페이지 → 텔레그램
node scripts/automation/market-magazine.js --edition "$ED" --render --site --telegram

# 3) GitHub Pages 갱신. 여기서 실패해도 카드는 이미 텔레그램으로 나갔으니 판 전체를
#    실패로 만들지 않는다 — 링크만 직전 판에 머문다.
DATE="$(TZ=Asia/Seoul date +%F)"
CARDS="workspace/growth/market-map/$DATE/$ED/cards"
bash lib/market-map-pages.sh "$CARDS" || echo "⚠ Pages 갱신 실패 — 링크는 직전 판 상태로 남는다" >&2
