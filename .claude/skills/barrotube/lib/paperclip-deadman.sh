#!/bin/bash
#
# paperclip-deadman.sh — 페이퍼클립이 회차를 못 띄웠을 때만 launchd 가 직접 돌린다 (2026-10-07)
#
# 2026-10-07 부터 정기 회차는 페이퍼클립 루틴이 띄운다(config/paperclip/company.json). 페이퍼클립 서버가
# 죽어 있거나 루틴이 멈춰 있으면 그날 발행이 통째로 사라지므로, 발행 경로(생산 슬롯·마켓맵)만 정시 + 20분에
# 이 스크립트가 한 번 더 본다. 판단은 dispatch.js 가 한다:
#   - 오늘 회차 마커가 있으면(페이퍼클립이 띄웠거나 이미 끝남) 아무것도 안 한다
#   - 페이퍼클립 큐에 그 회차 이슈가 대기 중이면 끼어들지 않는다
#   - 둘 다 아니면 텔레그램 경보 후 같은 마커로 직접 실행 → 늦게 깬 페이퍼클립은 마커를 보고 건너뛴다
#
# Usage: bash paperclip-deadman.sh <action>     예) slot:us-close · job:market-map

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
cd "$BARROTUBE_HOME" || exit 0

[ $# -eq 1 ] || { echo "Usage: bash paperclip-deadman.sh <action>" >&2; exit 2; }
[[ "$1" =~ ^(slot|job):[a-z][a-z0-9-]*$ ]] || { echo "허용되지 않는 액션 형식: $1" >&2; exit 2; }

bash "${SCRIPT_DIR}/run-node.sh" scripts/automation/paperclip/dispatch.js --direct "$1" --if-missing --via deadman
rc=$?

# 시작했지만 끝내지 못한 회차는 deadman-recover.js 가 공개 유예 안에서 다시 돌린다 — 평소에는 거버너 순회가 전 슬롯을
# 보고, 여기와 launchd rescue-kr-close 는 페이퍼클립이 멈췄을 때의 안전망이다.
if [ "$1" = "slot:kr-close" ]; then
  bash "${SCRIPT_DIR}/run-node.sh" scripts/automation/paperclip/deadman-recover.js --slot kr-close
  rescue_rc=$?
  [ "$rescue_rc" -eq 0 ] || exit "$rescue_rc"
fi
exit "$rc"
