#!/bin/bash
#
# auto-pipeline.sh — BarroSkills 자율 EP 발행 파이프라인 (슬롯 대응)
#
# 슬롯: config/routines.json 에 선언된 정기 브리핑 구성
#   us-close  06:00 KST 시작 → 08:00 예약 공개 (전날 미국 증시 마감)
#   kr-close  16:00 KST 시작 → 18:00 예약 공개 (국내 마감 + 오늘 밤 미장)
#
# 3단 구조:
#   Stage A (무인)      데이터 수집 → 리서치 → 대본 → [계약 게이트] → 팩트체크
#   Stage B (하이브리드) media-render 브라우저 단계 — 실패 시 텔레그램 호출 후 정지
#   Stage C (무인+창구)  자산·렌더·QA → 승인 → 30분 거부창구 → private+publishAt 업로드
#
# 안전 가드:
#   1. autonomy-pause status=paused 즉시 종료      6. QA score < 60 / blocker > 0 → publish 차단
#   2. 일일 EP 상한 (max_episodes_per_day)          7. Telegram reject window 30분
#   3. 월 예산 한도 (90% 초과 차단)                  8. 각 단계 audit log
#   4. In-flight 락 (직렬)                          9. Telegram 실패 알람
#   5. Fact-check HIGH 자동 회귀                    10. RESUME_EP 재개
#   11. image_prompt 계약 게이트 — 이미지 굽기 전 차단 (비용·재작업 방지)
#
# Usage:
#   bash auto-pipeline.sh --slot us-close
#   DRY_RUN=1 bash auto-pipeline.sh --slot kr-close      # 명령 echo only, 비용 0
#   FORCE_TOPIC="..." bash auto-pipeline.sh --slot us-close
#   RESUME_EP=EP-2026-NNNN bash auto-pipeline.sh --slot us-close
#   BT_SKIP_MEDIA_RENDER=1 ...                          # Stage B 건너뛰기 (이미 자산 있을 때)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
export PAPERCLIP_DISABLED=1
cd "$BARROTUBE_HOME"

DRY_RUN="${DRY_RUN:-0}"
FORCE_TOPIC="${FORCE_TOPIC:-}"
RESUME_EP="${RESUME_EP:-}"
SLOT="${SLOT:-}"
BT_SKIP_MEDIA_RENDER="${BT_SKIP_MEDIA_RENDER:-0}"
MEDIA_RENDER_TIMEOUT="${MEDIA_RENDER_TIMEOUT:-2400}"   # 40분
RESEARCH_TIMEOUT="${RESEARCH_TIMEOUT:-600}"            # 10분

while [ $# -gt 0 ]; do
  case "$1" in
    --slot) SLOT="${2:-}"; shift 2 ;;
    --slot=*) SLOT="${1#*=}"; shift ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done

source "${SCRIPT_DIR}/guards.sh"

ROUTINES="${BARROTUBE_HOME}/config/routines.json"

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
  audit "auto_pipeline_fail" "ERROR" "slot=$SLOT stage=$stage detail=$detail"
  notify_telegram "❌ <b>auto-pipeline 실패</b>\nslot: ${SLOT:-adhoc}\nstage: $stage\n$detail\n\n로그: <code>tail -50 ${BARROTUBE_HOME}/logs/cron/${CRON_LOG_NAME}.log</code>"
  exit 1
}

# 브라우저 단계가 필요해 멈춘 것은 '실패'가 아니라 '대기'다. 자산을 보존하고 정상 종료해
# 다음 스케줄이 막히지 않게 한다 — 사람은 RESUME_EP 로 이어서 돌린다.
halt_for_human() {
  local stage="$1"; local detail="$2"
  echo "🖐  $stage: $detail" >&2
  audit "auto_pipeline_halt" "WARN" "slot=$SLOT stage=$stage detail=$detail ep=${EP_ID:-}"
  notify_telegram "🖐 <b>사람이 필요합니다</b>\nslot: ${SLOT:-adhoc}\nEP: ${EP_ID:-?}\nstage: $stage\n$detail\n\n이어서 진행:\n<code>RESUME_EP=${EP_ID:-EP-...} bash ${BARROTUBE_HOME}/lib/auto-pipeline.sh --slot ${SLOT:-us-close}</code>"
  exit 0
}

log_stage() {
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════"
  audit "auto_pipeline_stage" "INFO" "slot=$SLOT $1"
}

json_get() {  # json_get <file> <python-expr on d>
  python3 -c "import json,sys;d=json.load(open('$1'));print($2)" 2>/dev/null
}

# macOS 에는 GNU coreutils 의 timeout 이 없다 (이 머신에 timeout·gtimeout 둘 다 부재 — 실측).
# 있으면 쓰고, 없으면 백그라운드 + 감시 프로세스로 대체한다.
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi

  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) &
  local watcher=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill -TERM "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return $rc
}

# ─────────────────────────────────────────────────
# 슬롯 로드
# ─────────────────────────────────────────────────
CRON_LOG_NAME="auto-pipeline"
NEWS_SOURCES=""
PUBLISH_AT=""
COMPETITOR_SCAN="False"
SLOT_LABEL="adhoc"
PLATFORM="shorts"

if [ -n "$SLOT" ]; then
  [ -f "$ROUTINES" ] || { echo "❌ config/routines.json 없음" >&2; exit 2; }
  python3 -c "import json;d=json.load(open('$ROUTINES'));exit(0 if '$SLOT' in d.get('slots',{}) else 1)" \
    || { echo "❌ 알 수 없는 슬롯: $SLOT" >&2; exit 2; }
  CRON_LOG_NAME="routine-${SLOT}"
  SLOT_LABEL=$(json_get "$ROUTINES" "d['slots']['$SLOT']['label']")
  NEWS_SOURCES=$(json_get "$ROUTINES" "','.join(d['slots']['$SLOT']['news_sources'])")
  PUBLISH_AT=$(json_get "$ROUTINES" "d['slots']['$SLOT']['publish_at']")
  COMPETITOR_SCAN=$(json_get "$ROUTINES" "d['slots']['$SLOT'].get('competitor_scan',False)")
  PLATFORM=$(json_get "$ROUTINES" "d.get('defaults',{}).get('platform','shorts')")
elif [ -z "$FORCE_TOPIC" ] && [ -z "$RESUME_EP" ]; then
  echo "❌ --slot 이 필요합니다 (또는 FORCE_TOPIC / RESUME_EP)." >&2
  echo "   가능한 슬롯: $(python3 -c "import json;print(', '.join(json.load(open('$ROUTINES'))['slots']))" 2>/dev/null)" >&2
  exit 2
fi

# ─────────────────────────────────────────────────
# Phase 0 — 환경 가드
# ─────────────────────────────────────────────────
log_stage "🚦 Phase 0 — 환경 가드 검증 (slot=${SLOT:-adhoc})"

guard_master_switch || exit 0
guard_in_flight || exit 0
guard_daily_quota || exit 0
guard_budget || exit 0

TODAY=$(date +%Y-%m-%d)
NEWS_DIR="${BARROTUBE_HOME}/workspace/daily-news/${TODAY}"

audit "auto_pipeline_start" "INFO" "slot=$SLOT dry_run=$DRY_RUN force_topic=$FORCE_TOPIC resume=$RESUME_EP"
notify_telegram "🤖 <b>${SLOT_LABEL} 시작</b>$([ "$DRY_RUN" = "1" ] && echo " (DRY_RUN)")"

# ─────────────────────────────────────────────────
# Stage A — Phase 1: 데이터 수집
# ─────────────────────────────────────────────────
if [ -z "$RESUME_EP" ] && [ -z "$FORCE_TOPIC" ] && [ -n "$SLOT" ]; then
  log_stage "📊 Phase 1 — 데이터 수집 (시세·뉴스$([ "$COMPETITOR_SCAN" = "True" ] && echo "·경쟁채널"))"

  # 시세는 비공식 엔드포인트라 실패해도 세우지 않는다 — 헤드라인 전용으로 강등된다.
  run_or_echo node scripts/automation/fetch-market-snapshot.js --slot "$SLOT" --date "$TODAY" \
    || echo "⚠️  시세 스냅샷 실패 — 헤드라인 전용으로 진행"

  run_or_echo node scripts/automation/fetch-daily-news.js --date "$TODAY" --sources "$NEWS_SOURCES" \
    || fail_with_alert "Phase 1 news" "fetch-daily-news.js 실패"

  if [ "$COMPETITOR_SCAN" = "True" ]; then
    run_or_echo node scripts/automation/fetch-competitor-stats.js --date "$TODAY" --window-days 1 \
      || echo "⚠️  경쟁 채널 수집 실패 (OAuth 만료 가능) — 없이 진행"
  fi
fi

# ─────────────────────────────────────────────────
# Stage A — Phase 2: 토픽 결정
# ─────────────────────────────────────────────────
TOPIC=""
RESEARCH_MD=""

if [ -n "$RESUME_EP" ]; then
  log_stage "♻️  Phase 2 — RESUME 모드: $RESUME_EP"
  EP_ID="$RESUME_EP"
  EP_DIR="${BARROTUBE_HOME}/workspace/episodes/${EP_ID}"
  [ -d "$EP_DIR" ] || fail_with_alert "Phase 2" "RESUME_EP 디렉토리 없음: $EP_DIR"
  TOPIC=$(grep -m1 '^topic:' "${EP_DIR}/00_brief.md" 2>/dev/null | sed 's/^topic:[[:space:]]*//; s/^"//; s/"$//')

elif [ -n "$FORCE_TOPIC" ]; then
  log_stage "📌 Phase 2 — FORCE_TOPIC"
  TOPIC="$FORCE_TOPIC"

else
  log_stage "🔎 Phase 2 — 리서치 + 토픽 선정 (소셜 검색 포함)"
  TOPIC_JSON="${NEWS_DIR}/topic-${SLOT}.json"
  RESEARCH_MD="${NEWS_DIR}/research-${SLOT}.md"

  if [ "$DRY_RUN" = "1" ]; then
    run_or_echo node scripts/automation/research-brief.js --slot "$SLOT" --date "$TODAY" --dry-run
    TOPIC="[DRY_RUN] 샘플 토픽"
  else
    node scripts/automation/research-brief.js --slot "$SLOT" --date "$TODAY" --timeout "$RESEARCH_TIMEOUT"
    RC=$?
    if [ $RC -eq 0 ] && [ -f "$TOPIC_JSON" ]; then
      TOPIC=$(json_get "$TOPIC_JSON" "d['topic']")
    else
      # 폴백: 뉴스 첫 헤드라인. 리서치 실패로 그날 방송을 통째로 거르지는 않는다.
      echo "⚠️  리서치 실패(exit $RC) — 뉴스 헤드라인 폴백"
      RESEARCH_MD=""
      TOPIC=$(python3 -c "
import json,sys
try:
    d=json.load(open('${NEWS_DIR}/news.json'))
    for s in d.get('sources',[]):
        if s.get('items'): print(s['items'][0]['title']); break
except Exception: pass" 2>/dev/null)
      [ -n "$TOPIC" ] || {
        audit "auto_pipeline_idle" "INFO" "slot=$SLOT no topic — exit clean"
        notify_telegram "💤 <b>${SLOT_LABEL} idle</b>\n$TODAY 토픽을 만들지 못했습니다 (리서치 실패 + 뉴스 빈약)"
        exit 0
      }
      notify_telegram "⚠️ <b>${SLOT_LABEL}</b> 리서치 실패 — 헤드라인 폴백으로 진행\n토픽: $TOPIC"
    fi
  fi
fi

# ─────────────────────────────────────────────────
# Stage A — Phase 3: S0 Brief
# ─────────────────────────────────────────────────
if [ -z "$RESUME_EP" ]; then
  log_stage "📝 Phase 3 — S0 Brief 생성 (무비용)"
  echo "Topic: $TOPIC"
  if [ "$DRY_RUN" = "1" ]; then
    EP_ID="EP-2026-DRYRUN"
    EP_DIR="${BARROTUBE_HOME}/workspace/episodes/${EP_ID}"
  else
    CREATE_OUT=$(node scripts/automation/create-episode.js --channel econ-daily --topic "$TOPIC" 2>&1)
    echo "$CREATE_OUT"
    EP_ID=$(echo "$CREATE_OUT" | grep -oE "EP-[0-9]{4}-[0-9]+" | head -1)
    [ -n "$EP_ID" ] || fail_with_alert "Phase 3" "create-episode.js 출력에서 EP ID 추출 실패"
    EP_DIR="${BARROTUBE_HOME}/workspace/episodes/${EP_ID}"

    # 리서치 결과를 S2 산출물 자리에 설치 (있을 때만)
    if [ -n "$RESEARCH_MD" ] && [ -f "$RESEARCH_MD" ]; then
      cp "$RESEARCH_MD" "${EP_DIR}/10_market_research.md"
      echo "  ✓ 10_market_research.md 설치"
    fi
  fi
  audit "auto_pipeline_ep_created" "INFO" "slot=$SLOT ep=$EP_ID topic=$TOPIC"
fi

echo ""
echo "▶ EP: $EP_ID"
echo "▶ 디렉토리: $EP_DIR"

# ─────────────────────────────────────────────────
# Stage A — Phase 4: S4 대본
# ─────────────────────────────────────────────────
log_stage "✍️  Phase 4 — S4 대본 생성 (Gemini)"

run_or_echo node scripts/automation/generate-script.js \
  --episode "$EP_DIR" --platform "$PLATFORM" \
  || fail_with_alert "Phase 4 script" "generate-script.js 실패"

# ─────────────────────────────────────────────────
# Stage A — Phase 5: image_prompt 계약 게이트  ★이미지 굽기 전
# ─────────────────────────────────────────────────
log_stage "📐 Phase 5 — image_prompt 계약 검사 (무비용 게이트)"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] validate-image-prompts.js --episode $EP_ID"
else
  if ! node scripts/automation/validate-image-prompts.js --episode "$EP_DIR" --platform "$PLATFORM"; then
    echo "⚠️  계약 위반 — 대본 1회 재생성 후 재검사"
    audit "auto_pipeline_prompt_retry" "WARN" "slot=$SLOT ep=$EP_ID"
    node scripts/automation/generate-script.js --episode "$EP_DIR" --platform "$PLATFORM" --force \
      || fail_with_alert "Phase 5 rewrite" "대본 재생성 실패"
    node scripts/automation/validate-image-prompts.js --episode "$EP_DIR" --platform "$PLATFORM" \
      || halt_for_human "Phase 5 계약" "재생성 후에도 image_prompt 계약 위반 — 이미지를 굽지 않고 멈췄습니다. 대본을 손보고 재개하세요."
  fi
fi

# ─────────────────────────────────────────────────
# Stage A — Phase 6: S5 팩트체크
# ─────────────────────────────────────────────────
log_stage "🔬 Phase 6 — S5 팩트체크 (Gemini)"

run_or_echo node scripts/automation/run-factcheck.js \
  --episode "$EP_ID" --platform "$PLATFORM" \
  || fail_with_alert "Phase 6 factcheck" "run-factcheck.js 실패"

# ─────────────────────────────────────────────────
# Stage B — Phase 7: media-render (브라우저, 하이브리드)
# ─────────────────────────────────────────────────
log_stage "🎨 Phase 7 — media-render 씬 이미지·모션 클립 (브라우저)"

IMG_DIR="${EP_DIR}/platforms/${PLATFORM}/40_assets/images"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] media-render 단계 생략"
elif [ "$BT_SKIP_MEDIA_RENDER" = "1" ]; then
  echo "⏭  BT_SKIP_MEDIA_RENDER=1 — 건너뜀"
elif [ -f "${IMG_DIR}/scene_001.png" ] && [ -f "${IMG_DIR}/scene_005.png" ]; then
  echo "⏭  씬 이미지 이미 존재 — 건너뜀"
else
  # 로그인된 Chrome 이 필요하다. 무인 시도 후 실패하면 사람을 부른다 (하이브리드).
  MEDIA_PROMPT="barrotube-media-render 스킬로 ${EP_ID} 의 씬 이미지와 모션 클립을 생성해라.

대본: ${EP_DIR}/platforms/${PLATFORM}/30_script.md 의 image_prompt 를 그대로 사용한다.
캐릭터 시트: workspace/channels/econ-daily/character-dna.md 의 첫 코드블록 규격을 지킨다.

저장 경로 (반드시 이 경로 그대로):
  씬 이미지  ${IMG_DIR}/scene_NNN.png        (1080x1920 9:16)
  모션 클립  ${EP_DIR}/platforms/${PLATFORM}/40_assets/videos/scene_NNN.mp4
  인트로     ${EP_DIR}/platforms/${PLATFORM}/45_intro.png

인트로 타이틀은 저장 전 한글 철자를 확대 검수해라 (AI 렌더 오타 사례 있음).
로그인 세션이 없거나 캡차가 뜨면 즉시 중단하고 그 사실을 보고해라 — 우회하지 마라."

  command -v claude >/dev/null 2>&1 \
    || halt_for_human "Phase 7 media-render" "claude CLI 를 PATH 에서 찾지 못했습니다 (launchd plist 의 PATH 확인)."

  run_with_timeout "$MEDIA_RENDER_TIMEOUT" claude -p "$MEDIA_PROMPT" \
      --permission-mode acceptEdits \
      --add-dir "$EP_DIR" \
    || halt_for_human "Phase 7 media-render" "브라우저 단계 실패 또는 타임아웃(${MEDIA_RENDER_TIMEOUT}s). Chrome 로그인(ChatGPT/Grok)을 확인하고 재개하세요."

  [ -f "${IMG_DIR}/scene_001.png" ] \
    || halt_for_human "Phase 7 media-render" "씬 이미지가 생성되지 않았습니다 (${IMG_DIR})."
fi

# ─────────────────────────────────────────────────
# Stage C — Phase 8: S6~S9 자산·렌더·QA·메타
# ─────────────────────────────────────────────────
log_stage "🎬 Phase 8 — S6~S9 자산·렌더·QA·메타 (💰 TTS 비용)"

# 예약 공개 시각을 S9 metadata 로 전달 (BT_IMAGE_ENGINE 과 같은 env 관례)
if [ -n "$PUBLISH_AT" ]; then
  export BT_PUBLISH_AT="$PUBLISH_AT"
  echo "  ⏰ 예약 공개 목표: ${PUBLISH_AT} KST"
fi

run_or_echo node scripts/automation/produce-episode.js \
  --episode "$EP_DIR" --platform "$PLATFORM" --execute
PRODUCE_RC=$?
if [ $PRODUCE_RC -eq 3 ]; then
  halt_for_human "Phase 8 produce" "씬 이미지 부재로 중단(exit 3) — media-render 를 먼저 수행하세요."
elif [ $PRODUCE_RC -eq 2 ]; then
  fail_with_alert "Phase 8 produce" "다른 EP 가 in-flight 락 보유 중 (exit 2)"
elif [ $PRODUCE_RC -ne 0 ]; then
  fail_with_alert "Phase 8 produce" "produce-episode.js 실패 (exit $PRODUCE_RC)"
fi

audit "auto_pipeline_produced" "INFO" "slot=$SLOT ep=$EP_ID"

# ─────────────────────────────────────────────────
# Stage C — Phase 9: QA 게이트
# ─────────────────────────────────────────────────
log_stage "🔍 Phase 9 — QA Gate (score ≥ 60, blocker = 0)"

if [ "$DRY_RUN" = "0" ]; then
  guard_qa_pass "$EP_DIR" || {
    notify_telegram "🛑 <b>${EP_ID}</b> QA FAIL — publish 차단\n수동 검토 후 <code>/approve ${EP_ID}</code> 또는 <code>/cancel ${EP_ID}</code>"
    exit 0
  }
fi

# ─────────────────────────────────────────────────
# Stage C — Phase 10: S10 승인
# ─────────────────────────────────────────────────
log_stage "📋 Phase 10 — S10 자율 승인"

run_or_echo node scripts/automation/approve-episode.js \
  --episode "$EP_ID" \
  --platform "$PLATFORM" \
  --by "routine-${SLOT:-adhoc}" \
  --note "scheduled-auto: slot=${SLOT:-adhoc} topic=$TOPIC" \
  || fail_with_alert "Phase 10 approve" "approve-episode.js 실패 (QA·정책 게이트 확인)"

audit "auto_pipeline_approved" "INFO" "slot=$SLOT ep=$EP_ID"

# ─────────────────────────────────────────────────
# Stage C — Phase 11: 거부 창구
# ─────────────────────────────────────────────────
log_stage "⏳ Phase 11 — Telegram reject window"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] reject window skip"
else
  notify_telegram "📺 <b>${EP_ID}</b> 업로드 예정\n슬롯: ${SLOT_LABEL}\n토픽: $TOPIC\n공개: ${PUBLISH_AT:-즉시} KST\n\n취소: <code>/reject ${EP_ID}</code>\n검토: <code>/status ${EP_ID}</code>"
  wait_telegram_reject_window "$EP_ID" || exit 0
fi

# ─────────────────────────────────────────────────
# Stage C — Phase 12: S11 발행
# ─────────────────────────────────────────────────
log_stage "🚀 Phase 12 — S11 YouTube 업로드 (private + publishAt)"

# run-episode.js 경유 — publish-youtube.js 를 직접 부르면 인자 8개를 조립해야 하고,
# 무엇보다 성공 시 in-flight 락 해제가 run-episode.js 안에만 있다.
run_or_echo node scripts/automation/run-episode.js \
  --episode "$EP_ID" --from S11 \
  || fail_with_alert "Phase 12 publish" "run-episode.js S11 실패"

audit "auto_pipeline_published" "INFO" "slot=$SLOT ep=$EP_ID"

# ─────────────────────────────────────────────────
# Phase 13 — 완료 보고
# ─────────────────────────────────────────────────
log_stage "✅ ${SLOT_LABEL} 완료"

if [ "$DRY_RUN" = "0" ]; then
  # v2 레이아웃: platforms/<platform>/80_publish_result.json → targets.youtube.videoId
  RESULT_FILE="${EP_DIR}/platforms/${PLATFORM}/80_publish_result.json"
  [ -f "$RESULT_FILE" ] || RESULT_FILE="${EP_DIR}/80_publish_result.json"
  if [ -f "$RESULT_FILE" ]; then
    VIDEO_ID=$(json_get "$RESULT_FILE" "d.get('targets',{}).get('youtube',{}).get('videoId') or d.get('video_id','')")
    PUB_STATUS=$(json_get "$RESULT_FILE" "d.get('targets',{}).get('youtube',{}).get('status','')")
    PUB_AT=$(json_get "$RESULT_FILE" "d.get('targets',{}).get('youtube',{}).get('publishedAt','')")
    notify_telegram "✅ <b>${EP_ID} ${PUB_STATUS}</b>\n슬롯: ${SLOT_LABEL}\n토픽: $TOPIC\n공개: ${PUB_AT}\nURL: https://youtu.be/${VIDEO_ID}"
    echo "  videoId: $VIDEO_ID"
    echo "  status:  $PUB_STATUS"
    echo "  공개:    $PUB_AT"
  else
    echo "  ⚠ 발행 결과 파일을 찾지 못했습니다: $RESULT_FILE"
  fi
else
  echo "  [DRY_RUN] 실제 업로드 안 함"
fi

audit "auto_pipeline_complete" "GREEN" "slot=$SLOT ep=$EP_ID topic=$TOPIC dry_run=$DRY_RUN"
exit 0
