#!/bin/bash
# market-map-cron.sh — 마켓맵 카드뉴스 10장 생성 + 텔레그램 발송 (무과금)
#
# 하루 두 판 (운영자 지시 2026-09-17):
#   08:00 조간 — 미국 증시 마감 기준. 이 시각 한국장은 아직 안 열렸다(직전 세션).
#   18:00 석간 — 국내장 마감 기준. 이 시각 미국장은 아직 안 열렸다(직전 마감).
#            (2026-09-28 운영자 지시로 20:00 → 18:00. 18시 종목 값엔 KRX 시간외 단일가가
#             섞여 있어, 코스피·테마는 평일 15:45 KRX 종가 스냅샷을 쓴다 — market-map-krclose.sh)
# 막 닫힌 시장이 표지와 카드 앞머리에 온다. 판은 스크립트가 KST 시각으로 정한다
# (lib/market-map.js 의 resolveEdition) — 크론 plist 하나로 두 시각을 돌리기 위해서다.
#
#   bash install-cron.sh install market-map "08:00,18:00"
#
# 세션 라벨은 시계가 아니라 응답이 정본이다: 미국은 Yahoo 의 regularMarketTime,
# 코스피는 네이버의 localTradedAt/marketStatus 를 읽는다. 08시 회차에 KST 날짜로
# "오늘 15:30 마감"을 찍으면 오지 않은 마감을 적게 된다.
#
# 링크: https://82beye.github.io/BarroSkills/ 가 매 판마다 갱신된다 (lib/market-map-pages.sh).
# 커뮤니티 게시까지 무인으로 간다 (운영자 지시 2026-09-18). 공식 API 는 없어서 로그인된
# Chrome 을 Apple Events 로 몬다 — scripts/automation/community-post.js. 로그인·UI 변경에
# 취약한 경로라 실패해도 판 전체를 죽이지 않는다: 카드는 이미 텔레그램으로 나가 있다.
set -euo pipefail
BARROTUBE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BARROTUBE_HOME"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 페이퍼클립이 띄우면 TMPDIR 이 그 실행의 임시 폴더다. 실행이 취소·타임아웃되면 폴더가 지워지는데
# 이 잡은 분리돼 계속 돈다 — 그 뒤 Chrome 이 지워진 폴더에 프로필을 만들다 죽었다
# (2026-10-20 조간: 실행 취소 23:03Z 와 launch 180초 타임아웃이 겹침, 10-22 조간: mkdtemp ENOENT).
# 이 잡의 임시 파일은 실행 수명과 무관한 시스템 임시 폴더에 둔다.
case "${TMPDIR:-}" in
  *paperclip-run-*|"") export TMPDIR="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp/)" ;;
esac
[ -d "$TMPDIR" ] || export TMPDIR=/tmp/

# 덮개가 닫힌 채 DarkWake 틈에 뜨면 네트워크가 없다 — 수집·게시 전에 올라올 때까지 기다린다.
source "${BARROTUBE_HOME}/lib/guards.sh"
wait_for_network 20 || echo "⚠ 네트워크 응답 없음 — 그대로 시도" >&2

ED="${1:-$(node -e "import('./scripts/automation/lib/market-map.js').then(m=>console.log(m.resolveEdition()))")}"
echo "🗞  마켓맵 ${ED}판 시작 $(date '+%F %H:%M')"

# 1) 수집 (+ 보관용 포스터 3장). 텔레그램으로는 안 보낸다 — 발송물은 카드뉴스다.
#    종료코드 10 = 「직전 판과 같은 마감」이라 거른 판. 주말·휴장일·월요일 조간이 여기 걸린다.
#    카드도 텔레그램도 게시도 하지 않는다 — 같은 숫자를 다시 내보내지 않는 게 요점이다.
set +e
node scripts/automation/market-map.js --edition "$ED"
RC=$?
set -e
if [ "$RC" -eq 10 ]; then exit 0; fi
if [ "$RC" -ne 0 ]; then exit "$RC"; fi

# 2) 카드뉴스 10장 조판 → PNG → 공개 페이지 → 텔레그램
node scripts/automation/market-magazine.js --edition "$ED" --render --site --telegram

# 3) GitHub Pages 갱신. 여기서 실패해도 카드는 이미 텔레그램으로 나갔으니 판 전체를
#    실패로 만들지 않는다 — 링크만 직전 판에 머문다.
DATE="$(TZ=Asia/Seoul date +%F)"
CARDS="workspace/growth/market-map/$DATE/$ED/cards"
if bash lib/market-map-pages.sh "$CARDS"; then
  # 4) 유튜브 커뮤니티 게시. 카드를 공개 링크에서 fetch 해 붙이므로 **Pages 다음이라야 한다**.
  #    공개본이 이번 판과 다르면 community-post.js 가 스스로 멈춘다 — 직전 판을 올리는 사고 방지.
  #    실패해도 판은 끝까지 간다(카드는 이미 나갔다). 다만 조용히 넘기지 않는다 — 「◐ PARTIAL」 줄을
  #    남기면 dispatch 가 마커를 partial 로 적는다. 예전 `|| echo` 는 평일 5회 중 4회 실패를 done 으로 묻었다.
  if ! node scripts/automation/community-post.js --edition "$ED"; then
    echo "◐ PARTIAL 커뮤니티 게시 실패 — 카드는 텔레그램에 있다 (사유는 .err 의 ❌ 줄)"
  fi
else
  echo "⚠ Pages 갱신 실패 — 링크는 직전 판에 머문다. 공개본이 낡았으니 커뮤니티 게시도 건너뛴다" >&2
  echo "◐ PARTIAL Pages 갱신 실패 — 커뮤니티 게시를 건너뛰었다"
fi
