#!/usr/bin/env bash
#
# run-node.sh — node 스크립트를 환경 독립적으로 실행하는 launchd 래퍼
#
# launchd 는 로그인 셸을 거치지 않아 PATH 가 비어 있고, install-cron.sh 가
# 설치 시점에 박아 넣은 node 절대경로는 nvm 버전이 올라가면 죽는다.
# plist 가 이 래퍼를 부르게 하면 node 탐색이 실행 시점으로 미뤄져
# 버전이 바뀌어도 재설치 없이 계속 돈다.
#
# Usage: bash run-node.sh <script-relative-to-skill-root> [args...]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
cd "$BARROTUBE_HOME" || exit 0

# guards.sh 의 ensure_node_on_path 를 재사용한다
# shellcheck source=./guards.sh
source "${SCRIPT_DIR}/guards.sh"

[ $# -ge 1 ] || { echo "❌ 실행할 스크립트를 지정하세요" >&2; exit 2; }

# 덮개가 닫힌 채 DarkWake 틈에 뜨면 네트워크가 없다 — 이 래퍼로 도는 노드 루틴은 전부
# 네트워크를 쓴다 (2026-09-28 weekly-marketing 월 09:00: RSS 전부 fetch failed → 0건 → exit 5).
wait_for_network 20 || echo "⚠ 네트워크 응답 없음 — 그대로 실행합니다" >&2

exec node "$@"
