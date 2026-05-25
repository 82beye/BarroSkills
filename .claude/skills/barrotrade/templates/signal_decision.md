---
template_id: signal_decision
owner_agent: barrotrade-quick-decider
signal_id: "{{signal_id}}"
ts_signal_utc: "{{signal_ts}}"
ts_decision_utc: "{{decision_ts}}"
latency_ms: 0
ticker: "{{ticker}}"
side: "buy|sell"
strategy_id: "{{strategy}}"
confidence: 0.0
price_krw: 0
decision: "GO|WAIT|NO-GO"
recommended_qty: 0
recommended_value_krw: 0
risk_status: "PASS|FAIL_*"
memory_match: "none|partial|critical"
broker: "kis|kiwoom"
---

# Signal Decision — {{signal_id}}

```
─────────────────────────────────────────────────────────
SIGNAL : {{ticker}} {{side}} @ {{price}} KRW
         strategy={{strategy}}  conf={{confidence}}
─────────────────────────────────────────────────────────
DECISION : {{GO|WAIT|NO-GO}}
SIZE     : {{qty}} shares  ({{value_krw}} KRW)
LATENCY  : {{latency_ms}} ms
─────────────────────────────────────────────────────────
```

## Bull (1 문단)

{{낙관 논거 1 문단, ≤ 200 토큰. 핵심 데이터·인용·예상 상승률 포함}}

## Bear (1 문단)

{{비관 논거 1 문단, ≤ 200 토큰. 핵심 위험·인용·예상 하락 시나리오 포함}}

## Risk Mini-Check

| 항목 | 값 | 통과 |
|------|----|----|
| ATR 사이징 (`Q_i`) | {{N}} 주 | {{✓|✗}} |
| 트레일링 스탑 라인 | {{price}} KRW | {{✓|✗}} |
| 회로 차단기 상태 | {{armed|tripped}} | {{✓|✗}} |
| 일일 누적 PnL | {{±X.XX}}% | {{✓|✗}} |
| 섹터 집중도 | {{X.XX}}% | {{✓|✗}} |
| 현금 버퍼 | {{X.XX}}% | {{✓|✗}} |
| HITL 임계 초과? | {{value_krw}} vs {{threshold}} | {{✓|✗}} |

## Memory Match

직전 90일 의미론적 메모리 검색 결과:

- 일치 패턴 ID: {{pattern_id}} (severity={{low|medium|high|critical}})
- 일치 사유: {{ticker 일치 / 섹터 일치 / regime 일치 / 시그널 조합 일치}}
- 권고 ({{pattern_id}} 의 §권장 대응): {{...}}

(일치 없으면: "유사 오판 패턴 없음")

## 결정 근거 (요약)

{{한 문장 요약: 왜 GO/WAIT/NO-GO 인지}}

## 다음 조치

- 인간 트레이더는 BarroAiTrade UI 또는 별도 도구로 실제 발주 수행 (본 스킬은 송출 X)
- 결정 후 {{N}}분 이내 체결되지 않으면 시그널 expire, 새 시그널 대기

## 로깅

- `logs/decisions/{{date}}.jsonl` 에 1줄 append:

```json
{
  "ts_decision_utc": "{{decision_ts}}",
  "signal_id": "{{signal_id}}",
  "ticker": "{{ticker}}",
  "side": "{{side}}",
  "decision": "{{GO|WAIT|NO-GO}}",
  "recommended_qty": {{qty}},
  "latency_ms": {{N}},
  "risk_status": "{{status}}",
  "memory_match": "{{none|partial|critical}}",
  "bull_argument_hash": "sha256:...",
  "bear_argument_hash": "sha256:...",
  "broker": "{{kis|kiwoom}}"
}
```
