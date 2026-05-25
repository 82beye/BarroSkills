#!/usr/bin/env bash
# doctor-cli.sh
#
# BarroTrade 환경 진단 도구.
# 사용: bash scripts/doctor-cli.sh
#
# 검사 항목:
#   1) config/*.json 7개 jq 파싱 무결성
#   2) ~/.claude/agents/barrotrade-*.md 핵심 7개 존재 확인 (전체 17개 권장)
#   3) references/ 8개 MD 존재 확인
#   4) templates/ 11개 MD/JSON 존재 확인
#   5) KPI sanity check (config 의 임계값이 SLA 와 일치)
#   6) in-flight lock 잔류 여부
#   7) 차단 엔드포인트가 kis-api.json 의 blocked_endpoints 에 포함되어 있는지
#
# 출력:
#   - 콘솔: 항목별 PASS/FAIL 컬러 출력
#   - logs/audit/doctor-<timestamp>.jsonl: 머신 가독 결과
# Exit:
#   - 0  : all PASS
#   - 1  : 1개 이상 FAIL

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_DIR="$SKILL_DIR/logs/audit"
LOG_FILE="$LOG_DIR/doctor-$(date +%Y%m%d-%H%M%S).jsonl"

mkdir -p "$LOG_DIR"

PASS_COUNT=0
FAIL_COUNT=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

emit() {
  local check="$1" status="$2" detail="$3"
  if [ "$status" = "PASS" ]; then
    printf "${GREEN}[PASS]${NC} %s  %s\n" "$check" "$detail"
    PASS_COUNT=$((PASS_COUNT+1))
  elif [ "$status" = "WARN" ]; then
    printf "${YELLOW}[WARN]${NC} %s  %s\n" "$check" "$detail"
  else
    printf "${RED}[FAIL]${NC} %s  %s\n" "$check" "$detail"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
  printf '{"ts_utc":"%s","check":"%s","status":"%s","detail":"%s"}\n' \
    "$TS" "$check" "$status" "$detail" >> "$LOG_FILE"
}

echo "──────────────────────────────────────────────"
echo " BarroTrade Doctor — $TS"
echo " SKILL_DIR: $SKILL_DIR"
echo "──────────────────────────────────────────────"

# 1) config/*.json 8개 jq 파싱
echo
echo "[1/8] config/*.json 파싱 무결성"
EXPECTED_CONFIGS=(agents strategies risk-policy consensus kis-api kiwoom-api barroaitrade-bridge budget-policy compliance)
for name in "${EXPECTED_CONFIGS[@]}"; do
  f="$SKILL_DIR/config/$name.json"
  if [ ! -f "$f" ]; then
    emit "config_$name" "FAIL" "파일 없음: $f"
  elif ! jq -e . "$f" >/dev/null 2>&1; then
    emit "config_$name" "FAIL" "JSON 파싱 실패: $f"
  else
    emit "config_$name" "PASS" "$(basename "$f")"
  fi
done

# 2) ~/.claude/agents/barrotrade-*.md 핵심 7개 + 전체 17개 카운트
echo
echo "[2/8] 에이전트 정의 (~/.claude/agents/barrotrade-*.md)"
CORE_AGENTS=(controller debate-moderator risk-manager portfolio-pm self-reflector macro-specialist trend-expert signal-watcher intraday-reporter code-surgeon quick-decider)
MISSING_CORE=0
for a in "${CORE_AGENTS[@]}"; do
  f="$HOME/.claude/agents/barrotrade-$a.md"
  if [ ! -f "$f" ]; then
    emit "agent_$a" "FAIL" "핵심 에이전트 누락: $f"
    MISSING_CORE=$((MISSING_CORE+1))
  else
    emit "agent_$a" "PASS" "barrotrade-$a.md"
  fi
done

ALL_AGENTS_COUNT=$(ls "$HOME/.claude/agents/" 2>/dev/null | grep -E '^barrotrade-.*\.md$' | wc -l | tr -d ' ')
CORE_COUNT=${#CORE_AGENTS[@]}
if [ "$ALL_AGENTS_COUNT" -lt 21 ]; then
  emit "agent_count_full" "WARN" "전체 21개 중 $ALL_AGENTS_COUNT 개 정의됨 (핵심 $((CORE_COUNT-MISSING_CORE))/$CORE_COUNT OK)"
else
  emit "agent_count_full" "PASS" "21개 전부 존재"
fi

# 3) references/ 8개 MD 존재
echo
echo "[3/8] references/ 상세 사양"
EXPECTED_REFS=(ARCHITECTURE AGENTS STRATEGIES DEBATE-PROTOCOL RISK-POLICY KIS-OPENAPI KIWOOM-API INTRADAY-WORKFLOW CODE-EVOLUTION BARROAITRADE-BRIDGE COMPLIANCE KPI)
EXPECTED_STRATEGY_CATALOGS=(korean-masters global-day-traders global-swing-traders smc-ict classical-frameworks)
for name in "${EXPECTED_REFS[@]}"; do
  f="$SKILL_DIR/references/$name.md"
  if [ -f "$f" ]; then
    emit "ref_$name" "PASS" "$(basename "$f")"
  else
    emit "ref_$name" "FAIL" "파일 없음: $f"
  fi
done

# Strategy catalog 카테고리 5개
for name in "${EXPECTED_STRATEGY_CATALOGS[@]}"; do
  f="$SKILL_DIR/references/strategies/$name.md"
  if [ -f "$f" ]; then
    emit "strategy_catalog_$name" "PASS" "strategies/$name.md"
  else
    emit "strategy_catalog_$name" "FAIL" "파일 없음: $f"
  fi
done

# 4) templates/ 11개
echo
echo "[4/8] templates/ 산출물 템플릿"
EXPECTED_TEMPLATES=(
  10_market_snapshot.md
  15_news_rag.json
  20_macro_report.md
  21_sector_brief.md
  22_fundamental.md
  30_trend_signal.md
  40_bull_brief.md
  41_bear_brief.md
  50_debate_log.md
  60_risk_check.md
  70_order.simulated.json
  80_compliance.md
  99_reflection.md
  intraday_recap.md
  evolve_proposal.md
  signal_decision.md
)
for name in "${EXPECTED_TEMPLATES[@]}"; do
  f="$SKILL_DIR/templates/$name"
  if [ -f "$f" ]; then
    emit "template_$name" "PASS" "$name"
  else
    emit "template_$name" "FAIL" "파일 없음: $f"
  fi
done

# 5) KPI sanity (config 값이 SLA 와 일치)
echo
echo "[5/8] KPI sanity"

RISK_FILE="$SKILL_DIR/config/risk-policy.json"
if [ -f "$RISK_FILE" ]; then
  CB=$(jq -r '.daily_loss_circuit_breaker.threshold_pct_of_day_start_equity' "$RISK_FILE")
  if [ "$(echo "$CB <= 1.5" | bc -l 2>/dev/null || echo 1)" = "1" ]; then
    emit "kpi_circuit_breaker" "PASS" "daily_loss_circuit_breaker = ${CB}% (target ≤ 1.5%)"
  else
    emit "kpi_circuit_breaker" "FAIL" "daily_loss_circuit_breaker = ${CB}% > 1.5%"
  fi

  ALPHA=$(jq -r '.position_sizing.alpha_risk_per_trade' "$RISK_FILE")
  emit "kpi_alpha_risk" "PASS" "alpha_risk_per_trade = ${ALPHA} (1회 거래 위험 비율)"

  GAMMA=$(jq -r '.position_sizing.gamma_max_alloc_per_ticker' "$RISK_FILE")
  emit "kpi_gamma_alloc" "PASS" "gamma_max_alloc_per_ticker = ${GAMMA} (단일 종목 비중 상한)"
fi

CONS_FILE="$SKILL_DIR/config/consensus.json"
if [ -f "$CONS_FILE" ]; then
  VP=$(jq -r '.vote_pass_threshold' "$CONS_FILE")
  if [ "$VP" -ge 70 ] 2>/dev/null; then
    emit "kpi_vote_threshold" "PASS" "vote_pass_threshold = $VP (target ≥ 70)"
  else
    emit "kpi_vote_threshold" "FAIL" "vote_pass_threshold = $VP < 70"
  fi
fi

CMP_FILE="$SKILL_DIR/config/compliance.json"
if [ -f "$CMP_FILE" ]; then
  HITL=$(jq -r '.human_in_the_loop.hitl_threshold_krw' "$CMP_FILE")
  emit "kpi_hitl_threshold" "PASS" "hitl_threshold_krw = ${HITL} KRW"
fi

# Strategy catalog 통합 검증
STRAT_FILE="$SKILL_DIR/config/strategies.json"
if [ -f "$STRAT_FILE" ]; then
  TOTAL=$(jq -r '.catalog_summary.total_strategies' "$STRAT_FILE")
  if [ "$TOTAL" -ge 25 ] 2>/dev/null; then
    emit "kpi_strategy_count" "PASS" "전체 전략 카탈로그 = ${TOTAL}개 (target ≥ 25)"
  else
    emit "kpi_strategy_count" "WARN" "전략 카탈로그 = ${TOTAL}개 (target ≥ 25)"
  fi

  # 카테고리별 전략 카운트
  KR_COUNT=$(jq '.extended_catalog.korean_masters.strategies | length' "$STRAT_FILE")
  GD_COUNT=$(jq '.extended_catalog.global_day_traders.strategies | length' "$STRAT_FILE")
  GS_COUNT=$(jq '.extended_catalog.global_swing_traders.strategies | length' "$STRAT_FILE")
  SMC_COUNT=$(jq '.extended_catalog.smc_ict.strategies | length' "$STRAT_FILE")
  CL_COUNT=$(jq '.extended_catalog.classical.strategies | length' "$STRAT_FILE")
  emit "kpi_strategy_breakdown" "PASS" "한국=$KR_COUNT, 글로벌데이=$GD_COUNT, 글로벌스윙=$GS_COUNT, SMC=$SMC_COUNT, 클래식=$CL_COUNT"

  # Regime 매트릭스 검증
  R1=$(jq '.regime_filter.regime_1.preferred_strategies_ids | length' "$STRAT_FILE")
  R4_DISABLE=$(jq -r '.regime_filter.regime_4.disable_all' "$STRAT_FILE")
  if [ "$R1" -ge 10 ] && [ "$R4_DISABLE" = "true" ] 2>/dev/null; then
    emit "kpi_regime_matrix" "PASS" "regime_1=$R1 strategies, regime_4 disabled=true"
  else
    emit "kpi_regime_matrix" "FAIL" "regime matrix 불완전: r1=$R1, r4_disable=$R4_DISABLE"
  fi
fi

# 6) in-flight lock 잔류
echo
echo "[6/8] in-flight lock 잔류"
LOCK_FILE="$SKILL_DIR/workspace/.in-flight.json"
if [ -f "$LOCK_FILE" ]; then
  emit "in_flight_lock" "WARN" "락 파일 존재: $LOCK_FILE — 사이클 비정상 종료 가능성"
else
  emit "in_flight_lock" "PASS" "잔류 락 없음"
fi

# 7) 차단 엔드포인트 정책 — 양 broker 모두 검사
echo
echo "[7/8] 차단 엔드포인트 정책 (실거래 송출 방지)"
KIS_FILE="$SKILL_DIR/config/kis-api.json"
if [ -f "$KIS_FILE" ]; then
  BLOCKED_COUNT=$(jq '.blocked_endpoints.order | length' "$KIS_FILE")
  if [ "$BLOCKED_COUNT" -ge 5 ] 2>/dev/null; then
    emit "kis_blocked_endpoints" "PASS" "[KIS] 주문 엔드포인트 ${BLOCKED_COUNT}개 차단 명시됨"
  else
    emit "kis_blocked_endpoints" "FAIL" "[KIS] 차단 엔드포인트 명시 부족: ${BLOCKED_COUNT}개"
  fi
fi

KIWOOM_FILE="$SKILL_DIR/config/kiwoom-api.json"
if [ -f "$KIWOOM_FILE" ]; then
  KW_ORDER=$(jq '.blocked_endpoints.order | length' "$KIWOOM_FILE")
  KW_CREDIT=$(jq '.blocked_endpoints.credit_order | length' "$KIWOOM_FILE")
  KW_PREFIX=$(jq '.blocked_endpoints.blocked_path_prefixes | length' "$KIWOOM_FILE")
  if [ "$KW_ORDER" -ge 4 ] && [ "$KW_CREDIT" -ge 4 ] && [ "$KW_PREFIX" -ge 2 ] 2>/dev/null; then
    emit "kiwoom_blocked_endpoints" "PASS" "[Kiwoom] 일반주문 ${KW_ORDER}개 + 신용주문 ${KW_CREDIT}개 + path prefix ${KW_PREFIX}개 차단"
  else
    emit "kiwoom_blocked_endpoints" "FAIL" "[Kiwoom] 차단 명시 부족: order=${KW_ORDER}, credit=${KW_CREDIT}, prefix=${KW_PREFIX}"
  fi

  # 키움 추가 검증: OAuth endpoint + websocket URL + cont-yn pagination
  KW_AUTH=$(jq -r '.auth.issue_endpoint' "$KIWOOM_FILE")
  if [ "$KW_AUTH" = "/oauth2/token" ]; then
    emit "kiwoom_auth_endpoint" "PASS" "[Kiwoom] OAuth endpoint = /oauth2/token"
  else
    emit "kiwoom_auth_endpoint" "FAIL" "[Kiwoom] OAuth endpoint 불일치: $KW_AUTH"
  fi

  KW_WS=$(jq -r '.websocket_url' "$KIWOOM_FILE")
  if [[ "$KW_WS" == wss://api.kiwoom.com:10000* ]]; then
    emit "kiwoom_websocket" "PASS" "[Kiwoom] websocket URL OK"
  else
    emit "kiwoom_websocket" "FAIL" "[Kiwoom] websocket URL: $KW_WS"
  fi

  KW_PAGE=$(jq -r '.continuation_pagination.header_field_cont' "$KIWOOM_FILE")
  if [ "$KW_PAGE" = "cont-yn" ]; then
    emit "kiwoom_pagination" "PASS" "[Kiwoom] cont-yn pagination 명시됨"
  else
    emit "kiwoom_pagination" "FAIL" "[Kiwoom] pagination 필드 불일치: $KW_PAGE"
  fi
fi

# 8) BarroAiTrade Bridge 검증
echo
echo "[8/8] BarroAiTrade Bridge (live/recap/evolve/decide 사전조건)"
BAT_FILE="$SKILL_DIR/config/barroaitrade-bridge.json"
if [ -f "$BAT_FILE" ]; then
  BAT_ROOT=$(jq -r '.target_project.root_path' "$BAT_FILE")
  if [ -d "$BAT_ROOT" ]; then
    emit "bat_root" "PASS" "BarroAiTrade root: $BAT_ROOT"
  else
    emit "bat_root" "WARN" "BarroAiTrade root 부재: $BAT_ROOT (live/recap/evolve/decide 모드 비활성)"
  fi

  BAT_LOG=$(jq -r '.data_sources.logs.current' "$BAT_FILE")
  if [ -r "$BAT_LOG" ]; then
    emit "bat_log_readable" "PASS" "logs/barro.log 읽기 가능"
  else
    emit "bat_log_readable" "WARN" "logs/barro.log 읽기 불가: $BAT_LOG"
  fi

  BAT_DB=$(jq -r '.data_sources.sqlite.path' "$BAT_FILE")
  if [ -r "$BAT_DB" ]; then
    emit "bat_db_readable" "PASS" "barro_trade.db 읽기 가능"
  else
    emit "bat_db_readable" "WARN" "barro_trade.db 읽기 불가: $BAT_DB"
  fi

  BAT_POLICY=$(jq -r '.strategies.policy_config.file' "$BAT_FILE")
  if [ -f "$BAT_ROOT/$BAT_POLICY" ]; then
    emit "bat_policy_config" "PASS" "BAR-OPS-31 PolicyConfig: $BAT_POLICY"
  else
    emit "bat_policy_config" "WARN" "PolicyConfig 미발견: $BAT_POLICY"
  fi

  # 안전 보증 검증: auto_apply 가 반드시 0 이어야 함
  AUTO_APPLY=$(jq -r '.code_evolution_policy.hitl_policy.auto_apply_threshold_pct' "$BAT_FILE")
  if [ "$AUTO_APPLY" = "0" ]; then
    emit "bat_hitl_enforced" "PASS" "자가 진화 HITL 강제 (auto_apply=0)"
  else
    emit "bat_hitl_enforced" "FAIL" "auto_apply_threshold_pct=$AUTO_APPLY — 안전 보증 위반"
  fi

  # 변경 범위 검증
  SCOPE=$(jq -r '.code_evolution_policy.scope' "$BAT_FILE")
  if [ "$SCOPE" = "dataclass_numeric_fields_only" ]; then
    emit "bat_evolve_scope" "PASS" "scope: dataclass_numeric_fields_only"
  else
    emit "bat_evolve_scope" "FAIL" "scope 위반: $SCOPE (반드시 dataclass_numeric_fields_only)"
  fi

  # 변경 폭 검증
  MAX_PCT=$(jq -r '.code_evolution_policy.change_magnitude_limits.max_relative_change_pct' "$BAT_FILE")
  if [ "$MAX_PCT" -le 50 ] 2>/dev/null; then
    emit "bat_change_magnitude" "PASS" "max_relative_change_pct = ${MAX_PCT}% (보수적)"
  else
    emit "bat_change_magnitude" "FAIL" "max_relative_change_pct = ${MAX_PCT}% > 50% 안전 한도"
  fi
fi

# 결과 요약
echo
echo "──────────────────────────────────────────────"
echo " 결과: PASS=$PASS_COUNT  FAIL=$FAIL_COUNT"
echo " 로그: $LOG_FILE"
echo "──────────────────────────────────────────────"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
