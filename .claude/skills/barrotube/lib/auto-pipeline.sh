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
MEDIA_RENDER_TIMEOUT="${MEDIA_RENDER_TIMEOUT:-3600}"  # ChatGPT 7장 + Grok 5개 생성 상한
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

# $2 = full(기본) | stills
#   full   — 인트로 카드·썸네일까지 있어야 "브라우저 단계 통째로 건너뛰기" 가 성립한다.
#   stills — 브라우저가 **실제로 필요한** 것만 본다. 인트로 카드는 generate-cards.js 가,
#            썸네일은 generate-thumbnail.js 가 Phase 8 에서 씬 이미지로부터 만든다.
#            그 둘이 없다고 파이프라인을 세울 이유가 없다.
media_assets_ready() {
  local base="$1" mode="${2:-full}" id path hash hashes="" missing=""
  # 모션은 Grok 이 정본이라 여기서 클립까지 요구한다. BT_MOTION_ENGINE=local-only 일 때만
  # 스틸만 보고, 클립은 produce-episode 의 S6c(로컬 HyperFrames)가 만든다.
  local motion_engine="${BT_MOTION_ENGINE:-grok}"
  for id in 001 002 003 004 005; do
    path="${base}/40_assets/images/scene_${id}.png"
    [ -s "$path" ] || missing="${missing}${missing:+, }images/scene_${id}.png"

    # stills 모드는 이름 그대로 스틸만 본다 — 브라우저가 정말 필요한 건 시트를 붙이는
    # 스틸뿐이고, 클립은 Phase 8 의 ensureMotion()(로컬 HyperFrames)이 스틸을 누가
    # 구웠든 채운다. 여기서 Grok 클립까지 요구하면 API 폴백으로 스틸을 살려도 그 다음
    # 게이트에서 다시 선다.
    if [ "$mode" = "stills" ] || [ "$motion_engine" = "local-only" ]; then
      continue
    fi

    path="${base}/40_assets/videos/scene_${id}.mp4"
    if [ ! -s "$path" ] || ! ffprobe -v error "$path" >/dev/null 2>&1; then
      missing="${missing}${missing:+, }videos/scene_${id}.mp4"
    elif [ "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
        -of csv=p=0 "$path" 2>/dev/null | head -1)" != "aac" ]; then
      # Grok 은 'Video audio' 를 켜야 오디오가 실린다 — 매번 빠뜨리던 항목이라 여기서 막는다.
      # (HyperFrames 클립은 설계상 무음이고 render-direct 가 TTS 만 믹스한다.)
      missing="${missing}${missing:+, }videos/scene_${id}.mp4(AAC audio)"
    else
      hash=$(shasum -a 256 "$path" | awk '{print $1}')
      if printf '%s\n' "$hashes" | grep -qx "$hash"; then
        missing="${missing}${missing:+, }videos/scene_${id}.mp4(duplicate bytes)"
      fi
      hashes="${hashes}${hashes:+$'\n'}${hash}"
    fi
  done
  if [ "$mode" = "full" ]; then
    for path in 45_intro.png 47_thumbnail.png; do
      [ -s "${base}/${path}" ] || missing="${missing}${missing:+, }${path}"
    done
  fi
  MEDIA_ASSETS_MISSING="$missing"
  [ -z "$missing" ]
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
    # 정기 루틴은 competitor-scan(05:20) 이 담당한다. 여기서는 그 산출물이
    # 없을 때만 만회 실행해 쿼터 이중 지출을 막는다.
    ANALYSIS_FILE="${BARROTUBE_HOME}/workspace/intel/competitors/analysis-${TODAY}.json"
    if [ -s "$ANALYSIS_FILE" ]; then
      echo "  ⏭  경쟁 인텔 재사용: analysis-${TODAY}.json"
    else
      run_or_echo node scripts/automation/fetch-competitor-stats.js --date "$TODAY" \
        || echo "⚠️  경쟁 채널 수집 실패 (OAuth 만료 가능) — 없이 진행"
      run_or_echo node scripts/automation/analyze-competitors.js --date "$TODAY" \
        || echo "⚠️  경쟁 인텔 분석 실패 — 없이 진행"
    fi
  fi
fi

# ─────────────────────────────────────────────────
# Stage A — Phase 2: 토픽 결정
# ─────────────────────────────────────────────────
TOPIC=""
RESEARCH_MD=""
STRATEGY_MD=""

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
  log_stage "🔎 Phase 2 — 시장 리서치 + 콘텐츠 전략 + 토픽 선정"
  TOPIC_JSON="${NEWS_DIR}/topic-${SLOT}.json"
  RESEARCH_MD="${NEWS_DIR}/research-${SLOT}.md"
  STRATEGY_MD="${NEWS_DIR}/strategy-${SLOT}.md"

  if [ "$DRY_RUN" = "1" ]; then
    run_or_echo node scripts/automation/research-brief.js --slot "$SLOT" --date "$TODAY" --dry-run
    TOPIC="[DRY_RUN] 샘플 토픽"
  else
    node scripts/automation/research-brief.js --slot "$SLOT" --date "$TODAY" --timeout "$RESEARCH_TIMEOUT"
    RC=$?
    if [ $RC -eq 0 ] && [ -s "$TOPIC_JSON" ] && [ -s "$RESEARCH_MD" ] && [ -s "$STRATEGY_MD" ]; then
      TOPIC=$(json_get "$TOPIC_JSON" "d['topic']")
    else
      # 모델 한도·오류 시에도 수집 원문으로 S2/S3를 만든다. 분석 파일 없이 대본부터
      # 생성하면 이후 팩트체크가 대본의 사실 근거를 복구할 수 없다.
      echo "⚠️  자동 리서치 실패(exit $RC) — 시세·뉴스 기반 결정론적 폴백"
      if node scripts/automation/research-brief.js --slot "$SLOT" --date "$TODAY" --fallback; then
        TOPIC=$(json_get "$TOPIC_JSON" "d['topic']")
      else
        audit "auto_pipeline_idle" "INFO" "slot=$SLOT no topic — exit clean"
        notify_telegram "💤 <b>${SLOT_LABEL} idle</b>\n$TODAY 분석 자료를 만들지 못했습니다 (리서치 실패 + 시세·뉴스 빈약)"
        exit 0
      fi
      notify_telegram "⚠️ <b>${SLOT_LABEL}</b> 자동 리서치 실패 — 시세·뉴스 폴백 분석으로 진행\n토픽: $TOPIC"
    fi
  fi
fi

# 리서치 성공/헤드라인 폴백 모두 같은 휴장 모드를 따른다. FORCE_TOPIC은 운영자 입력이므로 보존한다.
if [ -z "$RESUME_EP" ] && [ -z "$FORCE_TOPIC" ]; then
  CONTENT_MODE=""
  MODE_FILE="${NEWS_DIR}/topic-${SLOT}.json"
  [ -f "$MODE_FILE" ] && CONTENT_MODE=$(json_get "$MODE_FILE" "d.get('content_mode','')")
  if [ -z "$CONTENT_MODE" ]; then
    MODE_FILE="${NEWS_DIR}/market-${SLOT}.json"
    [ -f "$MODE_FILE" ] && CONTENT_MODE=$(json_get "$MODE_FILE" "d.get('content_mode','')")
  fi
  if [ -z "$CONTENT_MODE" ]; then
    case "$(date +%u)" in
      6) CONTENT_MODE="closed_market_issue" ;;
      7) CONTENT_MODE="sunday_preopen" ;;
    esac
  fi

  case "$CONTENT_MODE" in
    closed_market_issue)
      case "$TOPIC" in "최신 주식·경제 이슈:"*) ;; *) TOPIC="최신 주식·경제 이슈: $TOPIC" ;; esac
      ;;
    sunday_preopen)
      case "$TOPIC" in "다음 장 전 이슈 정리:"*) ;; *) TOPIC="다음 장 전 이슈 정리: $TOPIC" ;; esac
      ;;
  esac
  if [ -n "$CONTENT_MODE" ] && [ "$CONTENT_MODE" != "market_close" ]; then
    echo "🔁 휴장 대체 모드: $CONTENT_MODE"
    audit "auto_pipeline_content_mode" "INFO" "slot=$SLOT mode=$CONTENT_MODE topic=$TOPIC"
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

    if [ -n "$STRATEGY_MD" ]; then
      [ -s "$RESEARCH_MD" ] && [ -s "$STRATEGY_MD" ] \
        || fail_with_alert "Phase 3 analysis" "S2/S3 분석 산출물이 없습니다. 대본 생성을 시작하지 않습니다."
      cp "$RESEARCH_MD" "${EP_DIR}/10_market_research.md" \
        || fail_with_alert "Phase 3 analysis" "10_market_research.md 설치 실패"
      cp "$STRATEGY_MD" "${EP_DIR}/20_strategy.md" \
        || fail_with_alert "Phase 3 analysis" "20_strategy.md 설치 실패"
      echo "  ✓ 10_market_research.md 설치"
      echo "  ✓ 20_strategy.md 설치"
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

SCRIPT_PATH="${EP_DIR}/platforms/${PLATFORM}/30_script.md"
if [ -n "$RESUME_EP" ] && [ -s "$SCRIPT_PATH" ]; then
  echo "⏭  RESUME: 기존 대본 유지 — $SCRIPT_PATH"
else
  run_or_echo node scripts/automation/generate-script.js \
    --episode "$EP_DIR" --platform "$PLATFORM" \
    || fail_with_alert "Phase 4 script" "generate-script.js 실패"
fi

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
log_stage "🔬 Phase 6 — S5 팩트체크 (claude WebSearch → Gemini, 인용 URL 실존 검증)"

FACTCHECK_PATH="${EP_DIR}/platforms/${PLATFORM}/35_factcheck.md"
if [ -n "$RESUME_EP" ] && [ -s "$FACTCHECK_PATH" ] && grep -q '^pass: true$' "$FACTCHECK_PATH"; then
  echo "⏭  RESUME: 기존 PASS 팩트체크 유지 — $FACTCHECK_PATH"
else
  run_or_echo node scripts/automation/run-factcheck.js \
    --episode "$EP_ID" --platform "$PLATFORM" \
    || fail_with_alert "Phase 6 factcheck" "run-factcheck.js 실패"
fi

# 게이트가 걸리면 곧장 사람을 부르지 않는다 — 리포트가 claim 마다 `수정 제안` 을 써 주므로
# 그걸 적용하고 다시 검증한다. guards.factcheck_max_rewrites 만큼 시도하고 그래도 남으면 halt.
# (2026-08-17: 이 루프가 없어서 8/16·8/17 이틀 연속 EP 가 여기서 멈추고 게시가 0건이 됐다.)
factcheck_gate_blocks() {
  [ -s "$FACTCHECK_PATH" ] || return 1
  local high med grounded
  high=$(sed -n 's/^high_risk_count:[[:space:]]*//p' "$FACTCHECK_PATH" | head -1)
  med=$(sed -n 's/^med_risk_count:[[:space:]]*//p' "$FACTCHECK_PATH" | head -1)
  grounded=$(sed -n 's/^grounded:[[:space:]]*//p' "$FACTCHECK_PATH" | head -1)
  case "${high:-0}" in ''|*[!0-9]*) high=0 ;; esac
  case "${med:-0}" in ''|*[!0-9]*) med=0 ;; esac
  # HIGH 는 근거가 없는 주장이다 — 이 줄이 없어서 run-factcheck 의 pass:false 가
  # 파이프라인 어디에서도 막히지 않았다 (파일 머리의 "5. Fact-check HIGH 자동 회귀" 는 문서만 있었다).
  if [ "$high" -gt 0 ]; then return 0; fi
  { [ "$med" -gt 0 ] && [ "$grounded" != "true" ]; } || \
    { grep -q '^### \[MED\]' "$FACTCHECK_PATH" && grep -q '\*\*검증 결과\*\*: 부정확' "$FACTCHECK_PATH"; }
}

if [ "$DRY_RUN" = "0" ] && [ -s "$FACTCHECK_PATH" ]; then
  FC_MAX_REWRITES=$(json_get "$AUTONOMY_FILE" "d.get('guards',{}).get('factcheck_max_rewrites',2)")
  case "${FC_MAX_REWRITES:-}" in ''|*[!0-9]*) FC_MAX_REWRITES=2 ;; esac
  FC_REWRITES=0

  while factcheck_gate_blocks; do
    if [ "$FC_REWRITES" -ge "$FC_MAX_REWRITES" ]; then
      halt_for_human "Phase 6 factcheck" \
        "MED 부정확 또는 미접지(grounded=false) 주장이 ${FC_MAX_REWRITES}회 재작성 후에도 남았습니다. 수치·최상급 표현을 중립 문구로 고치고 팩트체크를 다시 실행하세요."
    fi
    # 게이트는 걸리는데 고칠 주장이 없으면(모든 판정이 '사실') 재작성은 헛돈다.
    # --check 는 파일만 읽으므로 비용이 없다. exit 10 = 고칠 게 있다.
    if node scripts/automation/revise-script-factcheck.js \
         --episode "$EP_DIR" --platform "$PLATFORM" --check; then
      halt_for_human "Phase 6 factcheck" \
        "MED 부정확 또는 미접지(grounded=false) 로 게이트가 걸렸는데 자동 수정 대상(부정확·미확인)이 없습니다. 리포트를 직접 보고 대본을 손보세요."
    fi

    FC_REWRITES=$((FC_REWRITES + 1))
    echo "   ↻ 팩트체크 지적 반영 재작성 ${FC_REWRITES}/${FC_MAX_REWRITES}"
    audit "auto_pipeline_factcheck_rewrite" "WARN" "slot=$SLOT ep=$EP_ID attempt=$FC_REWRITES"

    node scripts/automation/revise-script-factcheck.js \
      --episode "$EP_DIR" --platform "$PLATFORM" \
      || halt_for_human "Phase 6 재작성" \
           "MED 부정확 또는 미접지(grounded=false) 주장을 대본에 반영하지 못했습니다. 대본을 손보고 재개하세요."

    node scripts/automation/run-factcheck.js \
      --episode "$EP_ID" --platform "$PLATFORM" --force \
      || fail_with_alert "Phase 6 factcheck" "재작성 후 run-factcheck.js 실패"
  done

  if [ "$FC_REWRITES" -gt 0 ]; then
    echo "   ✅ 재작성 ${FC_REWRITES}회로 팩트체크 게이트 통과"
    audit "auto_pipeline_factcheck_recovered" "INFO" "slot=$SLOT ep=$EP_ID rewrites=$FC_REWRITES"
  fi
fi

# ─────────────────────────────────────────────────
# Stage B — Phase 7: media-render (브라우저, 하이브리드)
# ─────────────────────────────────────────────────
# 모션은 Grok 이 정본이다 — 피사체가 실제로 움직이므로 화면이 산다. 로컬 HyperFrames 는
# 브라우저가 막혔을 때(로그인·쿼터·유료 모달) 파이프라인이 멈추지 않게 하는 폴백이고,
# produce-episode 의 S6c 가 클립이 비어 있을 때만 돌린다.
# BT_MOTION_ENGINE=local-only 로 두면 브라우저에 Grok 을 아예 요구하지 않는다.
MOTION_ENGINE="${BT_MOTION_ENGINE:-grok}"
if [ "$MOTION_ENGINE" = "local-only" ]; then
  log_stage "🎨 Phase 7 — ChatGPT 이미지 (브라우저) · 모션 클립은 로컬 HyperFrames"
else
  log_stage "🎨 Phase 7 — ChatGPT 이미지 → Grok 모션 클립 (브라우저)"
fi

MEDIA_BASE="${EP_DIR}/platforms/${PLATFORM}"

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] codex exec → ChatGPT 이미지 5장·인트로·썸네일 → Grok 영상 5개"
elif media_assets_ready "$MEDIA_BASE"; then
  echo "⏭  media-render 자산 12/12 검증 완료 — 건너뜀"
elif [ "$BT_SKIP_MEDIA_RENDER" = "1" ]; then
  halt_for_human "Phase 7 media-render" "BT_SKIP_MEDIA_RENDER=1 이지만 필수 자산이 불완전합니다: ${MEDIA_ASSETS_MISSING}"
else
  # workspace/ 가 ~/BarroTubeData 로 가는 심볼릭이라 실경로가 프로젝트 밖이다.
  # --add-dir 와 프롬프트 경로를 심볼릭으로 주면 쓰기가 "민감 파일"로 차단된다 (실측).
  EP_REAL=$(cd "$EP_DIR" && pwd -P)
  DATA_REAL="${EP_REAL%/workspace/episodes/*}"
  MEDIA_BASE_REAL="${EP_REAL}/platforms/${PLATFORM}"
  CHARACTER_SHEET_REAL="${DATA_REAL}/workspace/docs/바로경제_캐릭터시트.png"
  [ -s "$CHARACTER_SHEET_REAL" ] \
    || halt_for_human "Phase 7 media-render" "캐릭터 시트를 찾지 못했습니다: ${CHARACTER_SHEET_REAL}"
  PROJECT_ROOT=$(git -C "$BARROTUBE_HOME" rev-parse --show-toplevel 2>/dev/null) \
    || halt_for_human "Phase 7 media-render" "BarroSkills 프로젝트 루트를 찾지 못했습니다."

  # 캐릭터 시트를 클립보드에 미리 올린다.
  # codex 샌드박스 안에서는 osascript 실행이 거부돼(2026-08-14 실측 "Failed to create
  # unified exec process") 에이전트가 스스로 클립보드를 채우지 못한다. 그러면 시트 없이
  # 텍스트만으로 그리게 되고 마시가 드리프트한다(EP-0092: 정장·팔 소실·회화풍).
  # 붙여넣기는 에이전트가 할 수 있으므로, 채우는 일만 여기서 대신한다.
  if osascript -e "set the clipboard to (read (POSIX file \"${CHARACTER_SHEET_REAL}\") as «class PNGf»)" 2>/dev/null; then
    echo "  📋 캐릭터 시트를 클립보드에 적재 (Cmd+V 첨부용)"
  else
    echo "  ⚠ 클립보드 적재 실패 — 시트 첨부가 안 되면 마시가 드리프트한다"
  fi

  # 모션 클립을 로컬에서 만들면 브라우저는 스틸만 담당한다 — Grok 은 열지도 않는다.
  # 로그인·유료 모달·일일 쿼터가 걸리던 절반이 여기서 사라진다.
  if [ "$MOTION_ENGINE" != "local-only" ]; then
    MOTION_PATH_LINE="  모션 클립  ${MEDIA_BASE_REAL}/40_assets/videos/scene_NNN.mp4"
    MOTION_STEP_LINE="2. 위 이미지가 모두 저장된 뒤에만 Chrome의 Grok Imagine에서 각 scene_NNN.png를 첨부해 영상 5개를 한 번에 하나씩 생성·저장하고 ffprobe한다."
    MOTION_RULES="Grok은 image-to-video 9:16/720p/10s만 사용한다. 매 컷 전 Video audio 버튼이 aria-pressed=true인지 확인한다.
Grok 로컬 이미지 선택이 확장 파일 접근 제한으로 막히면 해당 PNG를 macOS 클립보드에 넣어 Cmd+V로 첨부하고 계속한다. 파일 URL 권한 때문에 중단하거나 운영자에게 다시 묻지 마라.
첨부 완료는 filename이 아니라 Remove image/thumbnail로 판정하고, 다운로드 뒤 H.264 세로 영상+AAC 오디오를 ffprobe한다.
AAC가 없으면 완료로 세지 말고 Video audio를 켠 뒤 같은 컷을 재생성한다. 결제·구독은 절대 하지 마라.
영상 5개 저장 후 SHA-256을 비교해 중복 바이트가 있으면 해당 뒤쪽 컷을 재생성한다."
  else
    MOTION_PATH_LINE=""
    MOTION_STEP_LINE="2. 모션 클립은 만들지 마라. Grok Imagine 을 열 필요가 없다 — 저장된 스틸로 로컬 HyperFrames 가 만든다."
    MOTION_RULES=""
  fi

  # 로그인된 Chrome을 Codex 브라우저 플러그인으로 제어한다. 성공 판정은 에이전트 응답이
  # 아니라 아래의 파일/ffprobe 게이트만 신뢰한다.
  MEDIA_PROMPT="barrotube-media-render 스킬을 사용해 ${EP_ID} 브라우저 자산만 완성해라.

대본: ${EP_REAL}/platforms/${PLATFORM}/30_script.md 의 사실·중심 오브젝트·장면 동작을 유지하고,
아래 브라우저 이미지 수락 기준을 함께 적용한다.
캐릭터 시트: ${CHARACTER_SHEET_REAL} 를 ChatGPT 이미지 생성마다 첨부한다.
캐릭터 DNA: ${DATA_REAL}/workspace/channels/econ-daily/character-dna.md 의 첫 코드블록 규격을 지킨다.
시트 첨부는 이 작업의 필수 조건이다. 아래 순서를 그대로 지켜라.
1순위 — Playwright 의 숨은 file input 에 직접 주입한다. 확장 권한과 무관하게 동작하는 유일한 경로다.
  page.locator('#upload-photos, input[type=file]').first().setInputFiles(시트경로)
  setInputFiles 가 반환됐다는 것만으로 첨부로 치지 마라. Remove image 버튼이나 썸네일이 보여야 첨부다.
2순위 — 그래도 안 되면 컴포저의 파일 선택 UI 로 같은 경로를 첨부한다.
3순위 — 그래도 안 되면 macOS 클립보드 붙여넣기(Cmd+V). 이 환경에서는 브라우저 격리 클립보드로 막히는 것이 확인됐으니 기대하지 마라.
캐릭터 DNA 텍스트 폴백은 금지한다. 세 경로가 모두 막히면 그 씬을 만들지 말고 즉시 중단하고
「시트 첨부 실패」 라고 보고해라 — 시트 없이 그리면 몸통이 뚱뚱해지고 정장이 생기고 화풍이 이탈한다
(2026-08-14 EP-0092 실측). 조용히 품질을 떨어뜨리는 것보다 멈추는 편이 낫다.
운영자는 이 cron 작업의 ChatGPT/Grok 파일 첨부와 생성 실행을 이미 허용했다. 로그인·캡차·결제 차단이 아니면 같은 허용을 다시 묻지 말고 계속한다.

저장 경로 (반드시 이 경로 그대로):
  씬 이미지  ${MEDIA_BASE_REAL}/40_assets/images/scene_NNN.png        (1080x1920 9:16)
${MOTION_PATH_LINE}
  인트로     ${MEDIA_BASE_REAL}/45_intro.png
  썸네일     ${MEDIA_BASE_REAL}/47_thumbnail.png

순서를 바꾸지 마라:
1. Chrome의 ChatGPT에서 씬 이미지 5장, 인트로, 썸네일을 한 번에 하나씩 생성·저장·검증한다.
   매 요청 전에 컴포저 도구 메뉴에서 【이미지 만들기】를 선택해 칩이 붙은 것을 스크린샷으로
   확인한 뒤에만 전송한다. 칩 없이 일반 프롬프트로 보내지 마라 — 일반 응답 경로로 라우팅돼
   생성이 멈추거나 규격 밖 이미지가 나온다(2026-08-14 실측). 도구 메뉴에 항목이 없으면
   임의로 진행하지 말고 【이미지 만들기 도구 없음】 이라고 보고하고 중단한다.
${MOTION_STEP_LINE}
3. 기존 정상 파일은 재생성하지 않는다. CapCut·FFmpeg·QA·메타데이터·게시 작업은 하지 않는다.

브라우저 이미지 수락 기준:
- 마시는 씬 동작의 주어이자 중앙 주인공이다. 구석 스티커·작은 워터마크 크기(화면 4분의 1 미만)면 재생성한다.
  발행본 EP-0091 기준으로 마시 키는 화면 세로의 대략 40~60% 다. 그 범위면 수락해라 —
  절반에 조금 못 미친다고 거부하지 마라(2026-08-14: 그 기준으로 무한 거부에 빠져 5씬 전부 못 만들었다).
- 재생성은 한 씬당 최대 2회다. 3번째 결과는 치명적 결함(마스코트 부재·글자 렌더·다른 캐릭터)이 아니면
  그대로 채택하고 다음 씬으로 넘어가라. 완벽한 0장보다 수락 가능한 5장이 낫다.
- 마시의 기본은 옷을 입지 않은 크림-화이트 맨몸이다. 머리·몸통·양팔·양다리가 모두 보여야 한다.
  정장은 정책·비즈니스 상황에만 쓰고, 그때도 팔다리 실루엣이 가려지면 재생성한다. 전 씬 정장 반복은 거부한다.
- 화풍은 굵은 아웃라인 + 평면 채색이다. 사실적 조명·질감·회화풍 렌더가 나오면 재생성한다.
- 배경은 프롬프트가 low contrast·faint·tiny 라고 적은 요소를 실제로 흐리고 작게 유지한다.
  배경이 마시보다 디테일이 많으면 재생성한다.
- 방향성을 다루는 씬·인트로·썸네일은 레버·다이얼·갈림길·스위치·화살표 중 하나의 방향 트리거를 중심 오브젝트로 둔다.
- 인트로·썸네일은 sibling EP 중 최근 완료본 최대 3개의 실제 이미지를 먼저 비교해 캐릭터 크기·헤드라인 위치·배경 톤을 맞춘다.

이미지는 브라우저로 만든다. 이미지 API(Gemini·gpt-image-1)는 네가 직접 호출하지 마라 — 필요하면 이 파이프라인이 뒤에서 알아서 폴백한다.
ChatGPT 가 일일 한도에 걸리면(「내일 AM HH:MM까지 기능이 제한됩니다」 배너 + 이미지 도구 사라짐) 결제하지 말고 남은 컷을 Grok Imagine 이미지 모드로 이어서 만들어라. 절차는 references/grok-image.md 다. 요약:
  grok.com/imagine → 옵션 바 【이미지】 확인 → 숨은 file input 에 시트 주입 → 종횡비가 Auto 로 리셋되므로 【9:16 수직】을 ref 클릭으로 다시 선택(좌표는 한 행씩 밀린다) → 프롬프트에서 @ 를 눌러 【Image 1】을 골라 시트를 명시 참조 → 생성 → 우상단 액션 패널의 ⬇ 로 저장(~/Downloads/grok-image-<postId>.jpg, postId 를 URL 과 대조) → PIL 로 PNG 변환해 저장 경로에 넣는다. 출력은 1008x1792 다.
  Grok 에서 programmatic blob 다운로드는 CORS 때문에 0 바이트가 나온다 — 반드시 ⬇ 버튼을 써라.
  SuperGrok 구독 모달이 뜨면 결제하지 말고 닫은 뒤 「Grok 쿼터 소진」 이라고 보고하고 중단해라.
ChatGPT 공유·다운로드 버튼이 미디어 뷰어에 없으면 중단하지 말고 references/chatgpt-image.md 의 programmatic download 폴백으로 현재 생성 이미지 Blob 다운로드를 실행해 저장·검증한 뒤 계속한다.
각 생성 요청 직전에 marker 파일을 만들고 Downloads 후보는 marker보다 새 파일만 수락한다. Chrome History의 이전 실행 파일을 최신 결과로 복사하지 마라.
${MOTION_RULES}

인트로 타이틀은 저장 전 한글 철자를 확대 검수해라 (AI 렌더 오타 사례 있음).
로그인 판정은 URL이나 이전 worker 문장만으로 하지 마라. 기존 탭에서 프로필+composer를 직접 확인한다.
ChatGPT 탭이 여러 개면 하나의 로그아웃 탭만 보고 중단하지 말고 모든 기존 chatgpt.com 탭을 확인해 프로필+composer가 보이는 탭을 사용한다.
명시적 로그인 폼/캡차가 보이고 composer가 없을 때만 해당 탭을 Chrome 전면에 남긴 뒤 중단한다 — 우회하지 마라."

  command -v codex >/dev/null 2>&1 \
    || halt_for_human "Phase 7 media-render" "codex CLI를 PATH에서 찾지 못했습니다 (launchd plist PATH 확인)."

  run_with_timeout "$MEDIA_RENDER_TIMEOUT" codex \
      -a never -s workspace-write -m "${BT_MEDIA_RENDER_MODEL:-gpt-5.6-terra}" \
      -c model_reasoning_effort="${BT_MEDIA_RENDER_REASONING:-medium}" \
      -C "$PROJECT_ROOT" --add-dir "$EP_REAL" --add-dir "$DATA_REAL/workspace/docs" \
      --add-dir "$DATA_REAL/workspace/channels/econ-daily" --add-dir "$HOME/Downloads" \
      exec --ephemeral "$MEDIA_PROMPT" \
    || echo "  ⚠ 브라우저 작업 실패 또는 타임아웃(${MEDIA_RENDER_TIMEOUT}s) — Grok 패스로 넘어갑니다"

  # ── 한 장씩 이어 만들기 (top-up) ────────────────────────────────────────────
  # 위 패스는 codex 한 번의 호출로 7개 자산을 다 만들라고 요구한다. 에이전트가 컨텍스트를
  # 다 쓰면 남은 컷을 못 만든 채 "아직 생성하지 않았습니다" 로 턴을 끝낸다 — 실패가 아니라
  # 예산 소진이라 재시도할 여지가 있는데 그대로 Grok 으로 넘어가 버렸다.
  # (2026-08-17 EP-0096 실측: 170k 토큰 쓰고 1/5장. 그 뒤 Grok·API 가 다 막혀 정지.)
  # 남은 씬을 한 장씩, 매번 새 컨텍스트로 잇는다. 프롬프트에 image_prompt 를 인라인하지 않고
  # 씬 번호만 준다 — 739자 프롬프트를 셸로 따옴표 처리하다 깨지는 것보다 낫다.
  BT_CHATGPT_TOPUP_MAX="${BT_CHATGPT_TOPUP_MAX:-6}"
  TOPUP_TRIES=0
  TOPUP_STALLED=0
  while [ "$TOPUP_TRIES" -lt "$BT_CHATGPT_TOPUP_MAX" ] \
     && [ "$TOPUP_STALLED" -lt 2 ] \
     && ! media_assets_ready "$MEDIA_BASE" stills; do
    NEXT_SCENE=$(printf '%s' "$MEDIA_ASSETS_MISSING" | grep -o 'scene_[0-9]\{3\}\.png' | head -1 | sed 's/scene_\([0-9]*\)\.png/\1/')
    [ -n "$NEXT_SCENE" ] || break
    TOPUP_TRIES=$((TOPUP_TRIES + 1))
    echo "  ➕ ChatGPT 이어 만들기 ${TOPUP_TRIES}/${BT_CHATGPT_TOPUP_MAX} — 씬 ${NEXT_SCENE}"
    audit "media_render_chatgpt_topup" "INFO" "ep=$EP_ID scene=$NEXT_SCENE try=$TOPUP_TRIES"

    run_with_timeout 900 codex \
        -a never -s workspace-write -m "${BT_MEDIA_RENDER_MODEL:-gpt-5.6-terra}" \
        -c model_reasoning_effort="${BT_MEDIA_RENDER_REASONING:-medium}" \
        -C "$PROJECT_ROOT" --add-dir "$EP_REAL" --add-dir "$DATA_REAL/workspace/docs" \
        --add-dir "$DATA_REAL/workspace/channels/econ-daily" --add-dir "$HOME/Downloads" \
        exec --ephemeral "Chrome 의 로그인된 ChatGPT 로 씬 ${NEXT_SCENE} 이미지 한 장만 만들어 저장해라. 다른 씬·인트로·썸네일·영상은 건드리지 마라.

프롬프트: ${MEDIA_BASE_REAL}/30_script.md 에서 scene_id \"${NEXT_SCENE}\" 의 image_prompt 를 그대로 쓴다.
저장: ${MEDIA_BASE_REAL}/40_assets/images/scene_${NEXT_SCENE}.png (9:16 세로)
시트: ${CHARACTER_SHEET_REAL} 를 생성 요청에 첨부한다. 첨부 판정은 setInputFiles 반환이 아니라 Remove image/썸네일이 보이는지로 한다.
  1순위 Playwright 숨은 file input 주입 → 2순위 컴포저 파일 선택 UI → 3순위 Cmd+V.
  셋 다 막히면 그리지 말고 「시트 첨부 실패」 라고 보고하고 끝내라. 시트 없이 그리면 마시가 드리프트한다.
전송 전 컴포저 도구 메뉴에서 【이미지 만들기】 칩이 붙은 것을 확인해라. 칩 없이 보내면 일반 응답으로 새어 생성이 안 된다.
수락 기준: 마시가 화면 세로 40~60% 의 중앙 주인공, 굵은 아웃라인+평면 채색, 배경은 흐리고 작게, 읽히는 글자 없음.
재생성은 최대 2회. 3번째는 치명적 결함이 아니면 채택해라 — 완벽한 0장보다 수락 가능한 1장이 낫다.
다운로드는 요청 직전 marker 파일보다 새 파일만 수락하고, alt 가 '생성된 이미지' 인 것을 고른다 (시트와 크기가 0.1% 차이라 면적으로 고르면 시트를 집는다).
이미지 API 를 직접 호출하지 마라. 결제·구독은 절대 하지 마라. 한도 배너가 뜨면 「ChatGPT 한도」 라고 보고하고 끝내라." \
      || echo "     ⚠ 씬 ${NEXT_SCENE} 이어 만들기 실패"

    if media_assets_ready "$MEDIA_BASE" stills || \
       ! printf '%s' "$MEDIA_ASSETS_MISSING" | grep -q "scene_${NEXT_SCENE}\.png"; then
      TOPUP_STALLED=0
    else
      TOPUP_STALLED=$((TOPUP_STALLED + 1))
      echo "     ↯ 씬 ${NEXT_SCENE} 이 아직 없다 (연속 무진전 ${TOPUP_STALLED}/2)"
    fi
  done

  # ── 2차 브라우저 패스 — Grok Imagine 이미지 ────────────────────────────────
  #
  # 1차는 ChatGPT 다. 그게 일일 한도(배치 **중간**에 걸린다)나 확장 파일첨부 권한으로
  # 죽으면 브라우저 팔이 통째로 끝나서, Grok 은 시도조차 못 하고 API 로 떨어졌다.
  # Grok 은 로그인만 돼 있으면 같은 시트를 붙여 같은 품질을 낸다 — 2026-08-15 실측:
  # 1008x1792(정확히 9:16), 마시 온모델, 유료 모달 없음, 프레이밍은 오히려 더 좋았다.
  #
  # 프롬프트를 1차처럼 길게 쓰지 않는다. 목적은 하나 — "빠진 스틸만 채워라". 길수록
  # 에이전트가 QA·렌더 같은 남의 일까지 하려다 시간을 태운다.
  if ! media_assets_ready "$MEDIA_BASE" stills && [ "${BT_SKIP_GROK_IMAGE:-0}" != "1" ]; then
    echo "  🎨 2차 브라우저 패스 — Grok Imagine: ${MEDIA_ASSETS_MISSING}"
    audit "media_render_grok_pass" "WARN" "ep=$EP_ID missing=${MEDIA_ASSETS_MISSING}"
    notify_telegram "🎨 <b>${EP_ID}</b> ChatGPT 이미지 실패 — Grok Imagine 으로 재시도\n누락: ${MEDIA_ASSETS_MISSING}"

    GROK_PROMPT="barrotube-media-render 스킬의 references/grok-image.md 절차 그대로, ${EP_ID} 의 **빠진 씬 스틸만** Grok Imagine 으로 채워라. 다른 일은 하지 마라.

빠진 것: ${MEDIA_ASSETS_MISSING}
대본(씬별 image_prompt): ${MEDIA_BASE_REAL}/30_script.md
캐릭터 시트: ${CHARACTER_SHEET_REAL}
저장 경로: ${MEDIA_BASE_REAL}/40_assets/images/scene_NNN.png   (이미 있는 정상 파일은 건드리지 마라)

컷마다 이 순서를 지켜라. 하나라도 빠지면 결과가 규격 밖으로 나온다.
1. grok.com/imagine 을 열고 옵션 바에서 【이미지】가 선택돼 있는지 확인한다.
2. 숨은 file input 에 캐릭터 시트를 주입한다 (input[type=file] 을 찾아 그 ref 로 업로드). 컴포저에 썸네일이 뜨고 플레이스홀더가 「…이미지를 참조하려면 @」로 바뀌어야 첨부된 것이다.
3. ★ 종횡비를 다시 【9:16 수직】으로 잡는다. 첨부하는 순간 Auto 로 리셋되고, Auto 는 시트 비율(2:3)을 따라가 세로 규격이 깨진다. 메뉴는 좌표 클릭이 한 행씩 밀리니 반드시 ref 로 클릭하고, 옵션 바 pill 이 9:16 인지 확대해 확인한다.
4. ★ 프롬프트에서 @ 를 눌러 【Image 1】을 골라 시트를 명시 참조한다. 첨부만 해서는 시트를 안 쓴다 — ChatGPT 와 다른 점이다. 그 뒤에 해당 씬의 image_prompt 를 붙인다.
5. 생성이 끝나면 우상단 액션 패널을 열고 맨 아랫줄 ⬇ 로 저장한다. 파일명은 ~/Downloads/grok-image-<postId>.jpg 이고 postId 가 지금 URL 의 것과 같은지 대조한다.
6. PIL 로 PNG 변환해 위 저장 경로에 넣는다: Image.open(jpg).convert('RGB').save(png)
7. file 로 크기를 확인한다. 1008x1792 가 정상이다.

programmatic blob 다운로드는 쓰지 마라 — assets.grok.com 이 CORS 로 막아 0 바이트가 나온다(실측). 반드시 ⬇ 버튼이다.
SuperGrok 구독 모달이 뜨면 결제·무료 체험 절대 하지 말고 닫은 뒤 「Grok 쿼터 소진」 이라고 보고하고 멈춰라. 파이프라인이 이미지 API 로 이어받는다.
운영자는 이 cron 의 브라우저 파일 첨부·생성 실행을 이미 허용했다. 로그인·캡차·결제 차단이 아니면 다시 묻지 말고 계속한다.
컷당 재생성은 최대 2회다. 3번째 결과는 치명적 결함(마스코트 부재·글자 렌더·다른 캐릭터)이 아니면 채택하고 다음 컷으로 간다. 완벽한 0장보다 수락 가능한 5장이 낫다."

    run_with_timeout "${BT_GROK_IMAGE_TIMEOUT:-1800}" codex \
        -a never -s workspace-write -m "${BT_MEDIA_RENDER_MODEL:-gpt-5.6-terra}" \
        -c model_reasoning_effort="${BT_MEDIA_RENDER_REASONING:-medium}" \
        -C "$PROJECT_ROOT" --add-dir "$EP_REAL" --add-dir "$DATA_REAL/workspace/docs" \
        --add-dir "$DATA_REAL/workspace/channels/econ-daily" --add-dir "$HOME/Downloads" \
        exec --ephemeral "$GROK_PROMPT" \
      || echo "  ⚠ Grok 이미지 패스 실패 — API 폴백으로 넘어갑니다"
  fi

  # 브라우저(ChatGPT·Grok)가 둘 다 못 채운 씬 스틸을 이미지 API 로 메운다.
  #
  # 브라우저가 정본인 이유는 화질이 아니라 **캐릭터 시트를 첨부할 수 있어서** 인데,
  # gpt-image-1 의 /v1/images/edits 도 같은 시트를 첨부한다. 2026-08-15 EP-0094 실측:
  # ChatGPT 무료 한도(다음날 10:18까지 제한)에 걸려 2장에서 멈췄고, 나머지 3장을 이
  # 경로로 구웠더니 마시가 온모델로 나왔다(둥근 머리·검은 눈·주황 볼·미튼 손).
  # 무인 실행이 확장 권한이나 일일 한도에 걸려 통째로 서는 것보다 낫다.
  #
  # 인트로 카드·썸네일은 여기서 만들지 않는다 — Phase 8 의 generate-cards.js /
  # generate-thumbnail.js 가 씬 스틸로부터 결정론적으로 만든다.
  if ! media_assets_ready "$MEDIA_BASE" stills; then
    echo "  🛟 API 폴백 (gpt-image-1 + 캐릭터 시트): ${MEDIA_ASSETS_MISSING}"
    audit "media_render_api_fallback" "WARN" "ep=$EP_ID missing=${MEDIA_ASSETS_MISSING}"
    notify_telegram "🛟 <b>${EP_ID}</b> 브라우저 이미지 실패 — API 폴백으로 진행\n누락: ${MEDIA_ASSETS_MISSING}"
    # 서브셸 + export. `VAR=v func` 는 함수 호출이라 자식 node 로 export 되는지가
    # 셸 모드에 따라 갈린다 — 여기서 조용히 gemini 로 새면 폴백의 의미가 없다.
    (
      export BT_IMAGE_ENGINE=openai
      run_or_echo node scripts/automation/generate-image-gemini.js \
        --script "${MEDIA_BASE}/30_script.md" --out-dir "${MEDIA_BASE}/40_assets/images"
    ) || echo "  ⚠ 씬 이미지 API 폴백도 실패"
  fi

  media_assets_ready "$MEDIA_BASE" stills \
    || halt_for_human "Phase 7 media-render" "브라우저·API 폴백 후에도 씬 자산이 불완전합니다: ${MEDIA_ASSETS_MISSING}"
fi

# ─────────────────────────────────────────────────
# Stage C — Phase 8: S6~S9 자산·렌더·QA·메타
# ─────────────────────────────────────────────────
log_stage "🎬 Phase 8 — S6~S9 자산·렌더·QA·메타 (💰 TTS 비용)"

# 예약 공개 시각을 S9 metadata 로 전달 (BT_IMAGE_ENGINE 과 같은 env 관례)
# BT_NO_SCHEDULE=1 은 예약을 걸지 않고 private 로만 올린다 — 슬롯 시각을 놓친 수동
# 만회 실행에서 쓴다. 시각이 지나서 "우연히" 예약이 안 걸리는 것과 명시적으로 끄는 것은
# 다르다. 파이프라인이 빨리 끝나면 전자는 의도치 않게 공개된다.
if [ "${BT_NO_SCHEDULE:-0}" = "1" ]; then
  unset BT_PUBLISH_AT
  echo "  ⏸  BT_NO_SCHEDULE=1 — 예약 없이 private 업로드 (운영자가 수동 공개)"
elif [ -n "$PUBLISH_AT" ]; then
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
# Stage C — Phase 10: S10 사람 승인
# ─────────────────────────────────────────────────
log_stage "📋 Phase 10 — S10 사람 승인"

PUBLISH_HUMAN_ONLY=$(json_get "$AUTONOMY_FILE" "d.get('guards',{}).get('publish_remains_human_only',False)")
if [ "$DRY_RUN" = "0" ] && [ "$PUBLISH_HUMAN_ONLY" = "True" ]; then
  audit "auto_pipeline_publish_disabled" "INFO" "slot=$SLOT ep=$EP_ID"
  echo "⏸  발행 중지 상태 — 렌더·QA 검증까지만 완료"
  exit 0
fi

APPROVAL_PATH="${MEDIA_BASE}/75_board_approval.json"
if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY_RUN] 사람 승인 토큰 확인: $APPROVAL_PATH"
elif [ ! -s "$APPROVAL_PATH" ]; then
  notify_telegram "📋 <b>${EP_ID}</b> QA PASS — 게시 승인 필요\n승인: <code>/approve ${EP_ID}</code>\n취소: <code>/cancel ${EP_ID}</code>"
  audit "auto_pipeline_awaiting_approval" "INFO" "slot=$SLOT ep=$EP_ID"
  echo "⏸  S10 사람 승인 대기: /approve ${EP_ID}"
  exit 0
else
  echo "✅ S10 사람 승인 토큰 확인: $APPROVAL_PATH"
  audit "auto_pipeline_approved" "INFO" "slot=$SLOT ep=$EP_ID"
fi

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
  --episode "$EP_ID" --platform "$PLATFORM" --from S11 \
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
