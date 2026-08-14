#!/bin/bash
#
# publish-resume.sh — 승인은 났는데 아직 안 올라간 EP 를 찾아 게시까지 이어 붙인다.
#
# 왜 필요한가. auto-pipeline 은 QA 를 통과하면 승인 토큰을 확인하고, 없으면 텔레그램으로
# "승인 필요" 를 보낸 뒤 정상 종료한다. 사람이 폰에서 /approve 를 눌러 토큰이 생겨도
# 그 시점엔 크론이 이미 끝나 있어서, 다시 /publish 를 치거나 다음 슬롯을 기다려야 했다.
# 이 스크립트가 그 사이를 메운다 — 토큰이 있으면 올리고, 없으면 아무것도 하지 않는다.
#
# 사람의 확인은 그대로 남는다. 이 스크립트는 승인을 만들지 않고 **확인만** 한다.
#
# Usage:
#   bash publish-resume.sh                 # 오늘자 EP 중 승인됐고 미게시인 것을 처리
#   DRY_RUN=1 bash publish-resume.sh       # 대상만 출력

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
export PAPERCLIP_DISABLED=1
cd "$BARROTUBE_HOME"

DRY_RUN="${DRY_RUN:-0}"
source "${SCRIPT_DIR}/guards.sh"

guard_master_switch || exit 0

EPISODES="${BARROTUBE_HOME}/workspace/episodes"
[ -d "$EPISODES" ] || { echo "episodes 디렉토리 없음"; exit 0; }

found=0
# 최근 5개만 본다. 오래된 것을 되살려 올리는 사고를 막는다.
for ep_dir in $(ls -d "$EPISODES"/EP-* 2>/dev/null | sort | tail -5); do
  ep_id=$(basename "$ep_dir")
  for platform in shorts long; do
    base="${ep_dir}/platforms/${platform}"
    [ -d "$base" ] || continue
    approval="${base}/75_board_approval.json"
    result="${base}/80_publish_result.json"
    video="${base}/55_render/video.mp4"

    [ -s "$approval" ] || continue          # 승인 없으면 건드리지 않는다
    [ -s "$result" ] && continue            # 이미 올라갔다
    [ -s "$video" ] || continue             # 렌더가 없으면 올릴 것도 없다

    found=$((found + 1))
    echo "▶ ${ep_id} (${platform}) — 승인 완료·미게시"
    if [ "$DRY_RUN" = "1" ]; then
      echo "  [DRY_RUN] node scripts/automation/run-episode.js --episode ${ep_id} --platform ${platform} --from S11"
      continue
    fi

    audit "publish_resume_start" "INFO" "ep=$ep_id platform=$platform"
    if node scripts/automation/run-episode.js --episode "$ep_id" --platform "$platform" --from S11; then
      audit "publish_resume_done" "INFO" "ep=$ep_id platform=$platform"
      notify_telegram "📺 <b>${ep_id}</b> 예약 게시 완료 (승인 후 자동 재개)"
    else
      audit "publish_resume_fail" "ERROR" "ep=$ep_id platform=$platform"
      notify_telegram "❌ <b>${ep_id}</b> 게시 재개 실패 — 로그 확인 필요"
    fi
  done
done

[ "$found" -eq 0 ] && echo "승인 대기 중이거나 이미 게시된 EP 뿐 — 할 일 없음"
exit 0
