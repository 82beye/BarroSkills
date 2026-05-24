#!/bin/bash
#
# auto-pipeline.sh — BarroSkills 완전 자율 EP 발행 파이프라인
#
# 흐름: 환경 검증 → RSS fetch → 토픽 선정 → S0 brief →
#       S4~S9 produce (TTS·Image·Render·QA·Meta) →
#       QA gate → S10 자율 승인 → Telegram reject window 30분 →
#       S11 publish → 완료 알람
#
# 안전 가드 10개:
#   1. autonomy-pause status=paused 시 즉시 종료
#   2. 일일 EP 발행 상한
#   3. 월 예산 한도 (90% 초과 시 차단)
#   4. In-flight 락 (직렬)
#   5. Fact-check HIGH 자동 회귀 (produce-episode 내부)
#   6. QA score < 60 / blocker > 0 → publish 차단
#   7. Telegram reject window 30분 (운영자 /reject로 차단)
#   8. 각 단계 audit log
#   9. Telegram 실패 알람
#   10. Idempotency (.episode_status.json에서 마지막 stage 재개)
#
# Usage:
#   bash auto-pipeline.sh                    # 정상 실행
#   DRY_RUN=1 bash auto-pipeline.sh          # 명령어 echo only, 비용 0
#   FORCE_TOPIC="..." bash auto-pipeline.sh  # 토픽 강제 지정 (RSS fetch skip)
#   RESUME_EP=EP-2026-NNNN bash auto-pipeline.sh  # 특정 EP 재개

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
export PAPERCLIP_DISABLED=1
cd "$BARROTUBE_HOME"

DRY_RUN="${DRY_RUN:-0}"
FORCE_TOPIC="${FORCE_TOPIC:-}"
RESUME_EP="${RESUME_EP:-}"

# Source guards
source "${SCRIPT_DIR}/guards.sh"

# ─────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────
run_or_echo() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] $*"
    return 0
  fi
  "$@"
}

fail_with_alert() {
  local stage="$1"; local detail="$2"
  echo "❌ FAIL at $stage: $detail" >&2
  audit "auto_pipeline_fail" "ERROR" "stage=$stage detail=$detail"
  notify_telegram "❌ <b>auto-pipeline 실패</b>\nstage: $stage\n$detail\n\n로그: <code>tail -50 ${BARROTUBE_HOME}/logs/cron/auto-pipeline.log</code>"
  exit 1
}

log_stage() {
  local msg="$1"
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  $msg"
  echo "═══════════════════════════════════════════════"
  audit "auto_pipeline_stage" "INFO" "$msg"
}

# ─────────────────────────────────────────────────
# Phase 0 — 환경 검증
# ─────────────────────────────────────────────────
log_stage "🚦 Phase 0 — 환경 가드 검증"

guard_master_switch || exit 0
guard_in_flight || exit 0
guard_daily_quota || exit 0
guard_budget || exit 0

audit "auto_pipeline_start" "INFO" "dry_run=$DRY_RUN force_topic=$FORCE_TOPIC resume=$RESUME_EP"
notify_telegram "🤖 <b>auto-pipeline 시작</b>$([ "$DRY_RUN" = "1" ] && echo " (DRY_RUN)")"

# ─────────────────────────────────────────────────
# Phase 1 — 토픽 결정 (RSS or FORCE_TOPIC or RESUME)
# ─────────────────────────────────────────────────
TODAY=$(date +%Y-%m-%d)

if [ -n "$RESUME_EP" ]; then
  log_stage "♻️  Phase 1 — RESUME 모드: $RESUME_EP"
  EP_ID="$RESUME_EP"
  EP_DIR="${BARROTUBE_HOME}/workspace/episodes/${EP_ID}"
  [ -d "$EP_DIR" ] || fail_with_alert "Phase 1" "RESUME_EP 디렉토리 없음: $EP_DIR"

elif [ -n "$FORCE_TOPIC" ]; then
  log_stage "📌 Phase 1 — FORCE_TOPIC: $FORCE_TOPIC"
  TOPIC="$FORCE_TOPIC"

else
  log_stage "📰 Phase 1 — RSS fetch (마케팅 데이터 수집)"
  run_or_echo node scripts/automation/marketing-fetch-local.js \
    --source rss \
    --out "workspace/intel/marketing/auto-${TODAY}.json" \
    || fail_with_alert "Phase 1 RSS" "marketing-fetch-local.js 실패"

  log_stage "🎯 Phase 1b — 토픽 자동 선정 (휴리스틱)"
  if [ "$DRY_RUN" = "1" ]; then
    TOPIC="[DRY_RUN] 샘플 토픽"
  else
    if [ -f scripts/automation/ceo-select-topics.js ]; then
      node scripts/automation/ceo-select-topics.js \
        --date "$TODAY" --count 1 --channel econ-daily \
        > /dev/null 2>&1 || fail_with_alert "Phase 1b" "토픽 선정 실패"
      local_topics="${BARROTUBE_HOME}/workspace/daily-news/${TODAY}/topics.json"
      if [ ! -f "$local_topics" ]; then
        audit "auto_pipeline_idle" "INFO" "no topics selected — exit clean"
        notify_telegram "💤 <b>auto-pipeline idle</b>\n오늘 ($TODAY) 적합한 토픽 없음 (RSS 결과 빈약 또는 휴리스틱 score 미달)"
        exit 0
      fi
      TOPIC=$(python3 -c "import json;print(json.load(open('$local_topics'))['selected'][0]['title'])")
    else
      # fallback: RSS 첫 아이템 title
      TOPIC=$(python3 -c "import json;d=json.load(open('workspace/intel/marketing/auto-${TODAY}.json'));print(d['items'][0]['title'] if d.get('items') else '')")
      [ -n "$TOPIC" ] || fail_with_alert "Phase 1b" "RSS 결과 빈약 + ceo-select-topics.js 없음"
    fi
  fi
fi

# ─────────────────────────────────────────────────
# Phase 2 — S0 Brief 생성 (RESUME 아닐 때만)
# ─────────────────────────────────────────────────
if [ -z "$RESUME_EP" ]; then
  log_stage "📝 Phase 2 — S0 Brief 생성 (무비용)"
  echo "Topic: $TOPIC"
  if [ "$DRY_RUN" = "1" ]; then
    EP_ID="EP-2026-DRYRUN"
    EP_DIR="${BARROTUBE_HOME}/workspace/episodes/${EP_ID}"
  else
    # create-episode.js 출력 파싱 (EP-2026-XXXX 추출)
    CREATE_OUT=$(node scripts/automation/create-episode.js \
      --channel econ-daily --topic "$TOPIC" 2>&1)
    echo "$CREATE_OUT"
    EP_ID=$(echo "$CREATE_OUT" | grep -oE "EP-2026-[0-9]+" | head -1)
    [ -n "$EP_ID" ] || fail_with_alert "Phase 2" "create-episode.js 출력에서 EP ID 추출 실패"
    EP_DIR="${BARROTUBE_HOME}/workspace/episodes/${EP_ID}"
  fi
  audit "auto_pipeline_ep_created" "INFO" "ep=$EP_ID topic=$TOPIC"
fi

echo ""
echo "▶ EP: $EP_ID"
echo "▶ 디렉토리: $EP_DIR"

# ─────────────────────────────────────────────────
# Phase 3 — S2~S9 Produce (Script·Factcheck·TTS·Image·Render·QA·Meta)
# ─────────────────────────────────────────────────
log_stage "🎬 Phase 3 — S2~S9 콘텐츠 생성 (💰 비용 발생 ~\$0.5)"

# produce-episode.js 내부에서:
#   - S2~S3 skip (formats.json skip_stages) — shorts 한정
#   - S4 Writer (Gemini)
#   - S5 Fact Checker (HIGH 시 자동 회귀 최대 2회)
#   - S6a TTS (ElevenLabs)
#   - S6b sync
#   - S6c~e Images (Gemini)
#   - S7 Render (ffmpeg)
#   - S8 QA
#   - S9 Metadata
run_or_echo node scripts/automation/produce-episode.js \
  --episode "$EP_ID" \
  --execute \
  || fail_with_alert "Phase 3 produce" "produce-episode.js 실패 — 자산 생성 또는 QA"

audit "auto_pipeline_produced" "INFO" "ep=$EP_ID"

# ─────────────────────────────────────────────────
# Phase 4 — QA Gate (publish 직전 차단)
# ─────────────────────────────────────────────────
log_stage "🔍 Phase 4 — QA Gate (score ≥ 60, blocker = 0)"

if [ "$DRY_RUN" = "0" ]; then
  guard_qa_pass "$EP_DIR" || {
    notify_telegram "🛑 <b>${EP_ID}</b> QA FAIL — publish 차단\n수동 검토 후 <code>/approve ${EP_ID}</code> 또는 <code>/cancel ${EP_ID}</code>"
    exit 0
  }
fi

# ─────────────────────────────────────────────────
# Phase 5 — S10 자율 승인 (운영자 위임)
# ─────────────────────────────────────────────────
log_stage "📋 Phase 5 — S10 자율 승인 (auto-pipeline 위임)"

run_or_echo node scripts/automation/approve-episode.js \
  --episode "$EP_ID" \
  --by "auto-pipeline" \
  --note "scheduled-auto: topic=$TOPIC" \
  || fail_with_alert "Phase 5 approve" "approve-episode.js 실패"

audit "auto_pipeline_approved" "INFO" "ep=$EP_ID"

# ─────────────────────────────────────────────────
# Phase 6 — Telegram Reject Window 30분
# ─────────────────────────────────────────────────
log_stage "⏳ Phase 6 — Telegram reject window 30분"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] 30분 wait skip"
else
  notify_telegram "📺 <b>${EP_ID}</b> publish 예정\n토픽: $TOPIC\n\n취소: <code>/reject ${EP_ID}</code> (30분 내)\nQA 검토: <code>/status ${EP_ID}</code>"
  wait_telegram_reject_window "$EP_ID" || exit 0
fi

# ─────────────────────────────────────────────────
# Phase 7 — S11 Publish (YouTube)
# ─────────────────────────────────────────────────
log_stage "🚀 Phase 7 — S11 YouTube publish (💰📺 영상 공개)"

run_or_echo node scripts/automation/publish-youtube.js \
  --episode "$EP_ID" \
  --execute \
  || fail_with_alert "Phase 7 publish" "publish-youtube.js 실패"

audit "auto_pipeline_published" "INFO" "ep=$EP_ID"

# ─────────────────────────────────────────────────
# Phase 8 — 완료 보고
# ─────────────────────────────────────────────────
log_stage "✅ auto-pipeline 완료"

if [ "$DRY_RUN" = "0" ]; then
  RESULT_FILE="${EP_DIR}/80_publish_result.json"
  if [ -f "$RESULT_FILE" ]; then
    VIDEO_ID=$(python3 -c "import json;print(json.load(open('$RESULT_FILE')).get('video_id',''))")
    VIDEO_URL="https://youtu.be/${VIDEO_ID}"
    notify_telegram "✅ <b>${EP_ID} 발행 완료</b>\n토픽: $TOPIC\nURL: $VIDEO_URL"
    echo "  videoId: $VIDEO_ID"
    echo "  URL: $VIDEO_URL"
  fi
else
  echo "  [DRY_RUN] 실제 publish 안 함"
fi

audit "auto_pipeline_complete" "GREEN" "ep=$EP_ID topic=$TOPIC dry_run=$DRY_RUN"
exit 0
