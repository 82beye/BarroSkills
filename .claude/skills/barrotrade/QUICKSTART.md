# BarroTrade QUICKSTART (5분 인계)

## 0. 사전 점검

```bash
/barrotrade doctor
```

체크 항목:
- `config/*.json` 7개 jq 파싱
- `~/.claude/agents/barrotrade-*.md` 17개 존재
- KPI 기본값 sanity (Sharpe 2.2 / MDD 4.5%)
- in-flight lock 잔류 X

RED 발견 시 `logs/audit/doctor-<ts>.jsonl` 의 fail 라인을 보고 수정.

## 1. 환경 변수

### Broker 선택
| Key | 값 |
|-----|-----|
| `BARROTRADE_BROKER` | `kis` (기본) / `kiwoom` |

### KIS (한국투자증권)
| Key | 설정 위치 (우선순위) |
|-----|----------------------|
| `KIS_APP_KEY` | `.env` → Keychain `BarroTrade/KIS_APP_KEY` |
| `KIS_APP_SECRET` | `.env` → Keychain `BarroTrade/KIS_APP_SECRET` |
| `KIS_ACCOUNT_NO` | `.env` → Keychain `BarroTrade/KIS_ACCOUNT_NO` |
| `KIS_ENV` | `paper` (기본) / `live` |

### Kiwoom (키움증권)
| Key | 설정 위치 (우선순위) |
|-----|----------------------|
| `KIWOOM_APP_KEY` | `.env` → Keychain `BarroTrade/KIWOOM_APP_KEY` |
| `KIWOOM_SECRET_KEY` | `.env` → Keychain `BarroTrade/KIWOOM_SECRET_KEY` |
| `KIWOOM_ENV` | `paper` (기본, KRX only) / `live` |

```bash
# KIS
security add-generic-password -s "BarroTrade/KIS_APP_KEY" -a "$USER" -w "<APP_KEY>"

# Kiwoom
security add-generic-password -s "BarroTrade/KIWOOM_APP_KEY" -a "$USER" -w "<APP_KEY>"
security add-generic-password -s "BarroTrade/KIWOOM_SECRET_KEY" -a "$USER" -w "<SECRET_KEY>"
```

## 2. 첫 사이클 (시뮬)

```bash
/barrotrade cycle 005930   # 삼성전자
```

진행 흐름:

```
[Stage I] data-preprocessor + rag-analyst (병렬)
   ↓ 10_market_snapshot.md, 15_news_rag.json
[Stage II] macro + sector + fundamental (병렬)
   ↓ 20_macro_report.md, 21_sector_brief.md, 22_fundamental.md
[Stage III] trend + meanrev + event + pattern (병렬)
   ↓ 30~33_*_signal.md
[Stage IV] bull-researcher → bear-researcher → debate-moderator
   ↓ 40_bull, 41_bear, 50_debate_log
[Stage V] risk-manager (ATR · 트레일링 · 회로 차단기)
   ↓ 60_risk_check.md  (FAIL → 즉시 reflect 트리거)
[Stage VI] portfolio-pm
   ↓ 70_order.simulated.json  (HITL 임계 초과 시 pending_hitl)
[Stage VII] compliance-officer
   ↓ 80_compliance.md + logs/audit/...jsonl
```

산출물은 `workspace/2026-05-25-005930/` 아래 모두 저장됩니다.

## 3. 결과 읽기

사이클이 끝나면 Controller 가 다음을 보고합니다:

```
사이클 ID:  2026-05-25-005930
ticker:    005930 (삼성전자)
합의 점수:  78 / 100   (Bull 가중 0.55, Bear 가중 0.45)
  Bull 핵심: 1분기 메모리 가격 반등 + 외국인 5일 순매수
  Bear 핵심: HBM 경쟁 심화 + 인플레이션 감성지수 상승
리스크:    PASS  (포지션 23주, 트레일링 -2.0×ATR=-1,840원)
주문 시뮬:  매수 23주 @ 시장가, 예상 슬리피지 0.08%
HITL:      불필요 (1,587,400 < 50,000,000)
다음:      /barrotrade reflect 2026-05-25-005930  (D+5 자가 점검 예약)
```

## 4. 손실 사이클 자가 성찰

손절이 발생했거나 사이클이 risk FAIL 로 멈춘 경우:

```bash
/barrotrade reflect 2026-05-25-005930
```

`barrotrade-self-reflector` 가:
- `40_bull_brief.md` ↔ `41_bear_brief.md` 대조
- 중재자가 묵살한 Bear 경고 항목 추출
- "하지 말아야 할 오판 패턴"을 `workspace/_memory/semantic/<pattern_id>.md` 로 저장
- 다음 사이클 호출 시 자동으로 RAG 컨텍스트에 주입

## 5. 백테스트

```bash
/barrotrade backtest trend-following 2025-01-01..2025-12-31
```

- `config/strategies.json` 의 전략 정의 사용
- `T_virtual` 강제 적용으로 Look-Ahead Bias 차단
- KPI 산출: Sharpe, MDD, hit rate, turnover, max consecutive loss
- 결과: `workspace/_backtest/<strategy>-<range>/report.md`

## 6. 위험 종료 (회로 차단기)

일일 누적 평가 손실이 `risk-policy.json.daily_loss_circuit_breaker` (기본 1.5%) 도달 시:
- 모든 신규 사이클 거부
- 보유 포지션은 시장가 매도 시뮬레이션 기록
- 에이전트 가동 상태 `LOCKED_DOWN`
- 사용자가 `/barrotrade init --unlock` 로만 해제 가능

## 7. 자주 보는 파일

| 경로 | 언제 보나 |
|------|----------|
| `workspace/<cycle_id>/50_debate_log.md` | 합의 점수가 의외일 때 |
| `workspace/<cycle_id>/60_risk_check.md` | 사이클이 멈춘 사유 |
| `logs/audit/YYYY-MM-DD.jsonl` | 일일 사이클 감사 |
| `logs/risk/<cycle_id>.jsonl` | 리스크 라인별 평가 |
| `workspace/_memory/semantic/` | 누적된 오판 패턴 |

## 8. 알아두면 유리

- **Mode 미지정**: `/barrotrade` 만 입력하면 AskUserQuestion 으로 mode 선택.
- **Force**: 같은 ticker 사이클이 진행 중이어도 `/barrotrade cycle 005930 --force` 로 강제 실행 가능 (감사 로그에 force 사유 기록 필수).
- **HITL 대기 만료**: 24h 무응답 시 `expired`, 사이클 종료. `compliance.json.hitl_timeout_hours` 로 변경.
- **Look-Ahead Bias**: `BARROTRADE_T_VIRTUAL=2024-12-31T15:30:00+09:00` 처럼 환경변수로 가상 현재 시점 고정.
- **실거래 절대 금지**: `BARROTRADE_ALLOW_LIVE_ORDER=true` 를 두어도 본 스킬은 무시. 실거래는 별도 OMS 책임.
