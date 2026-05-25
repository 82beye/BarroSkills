# Compliance — HITL · XAI · 감사 추적 · 규제 매핑

본 문서는 BarroTrade 의 규제 준수 체계입니다. 정책은 [`../config/compliance.json`](../config/compliance.json) 에 선언됩니다.

---

## 1. 적용 법·가이드라인

| 출처 | 적용 영역 |
|------|----------|
| 자본시장법 (자본시장과 금융투자업에 관한 법률) | 매매·중개·자기매매 규제 |
| 금융분야 AI 개발·활용 안내서 (금융위원회, 2023) | AI 거버넌스 5대 원칙 |
| 금융회사 내부통제 가이드라인 | 알고리즘 거래 감사 |
| 전자금융거래법 | 인증·암호화·로그 보관 |

---

## 2. Human-In-The-Loop (HITL)

### 임계치

```json
{
  "hitl_threshold_krw": 50000000,
  "hitl_threshold_pct_of_equity": 5.0
}
```

**둘 중 하나만 초과해도** HITL 발동. 즉 5천만원 또는 잔고의 5% 이상 주문 시 자동으로 인간 승인 대기.

### 동작 흐름

```
[portfolio-pm 가 주문 시뮬 생성]
     │
     ▼
[금액 / 지분 임계치 체크]
     │
     ├─ 미달 → 70_order.simulated.json 즉시 발행
     │
     └─ 초과 → 70_order.pending_hitl.json 으로 변경
                      │
                      ▼
              [사용자 알림: telegram + email]
                      │
                      ▼
              [24h 타이머 시작]
                      │
                      ├─ 인간 승인 (생체/OTP/명시 확인)
                      │    → 70_order.simulated.json 변환, 사이클 계속
                      │
                      └─ 24h 무응답
                           → 상태 = expired, 사이클 종료, audit log
```

### 승인 방식

| 방식 | 비고 |
|------|------|
| `biometric_touchid` | macOS 환경 |
| `physical_token_otp` | 보안 토큰 6자리 |
| `explicit_text_confirmation` | "동의합니다 + 주문 ID" 명시 텍스트 |

### 승인자 ID 검증

- 승인자의 user_id_hash 가 `registered_account_holder` 와 일치해야 함
- 불일치 시 즉시 차단 + 감사 로그 ALERT

---

## 3. 설명 가능성 (XAI)

### 의무 보존 아티팩트 (주문 1건당)

```
workspace/<cycle_id>/
├── 10_market_snapshot.md
├── 15_news_rag.json
├── 20_macro_report.md
├── 21_sector_brief.md
├── 22_fundamental.md
├── 30_trend_signal.md
├── 31_meanrev_signal.md
├── 32_event_signal.md
├── 33_pattern_signal.md
├── 40_bull_brief.md
├── 41_bear_brief.md
├── 50_debate_log.md
├── 60_risk_check.md
├── 70_order.simulated.json (또는 pending_hitl)
└── 80_compliance.md
```

### 보존 기간

- **5년** (자본시장법 시행령 § 27 의 매매 기록 보존 의무 기준)
- 압축 후 `workspace/_archive/<YYYY-MM>/<cycle_id>.tar.zst` 로 이동
- 무결성 확인을 위한 SHA-256 hash 별도 보관

### 소명 리포트 SLA

- 규제당국 요청 시 **30분 이내** 추출 (`compliance.json.extraction_sla_minutes`)
- 출력 언어: **한국어**
- 포맷: PDF + JSONL 원본

### 추출 방법

```bash
scripts/extract-soso.sh <cycle_id> [--format pdf|jsonl|both]
```

---

## 4. 편향 방어 (Bias Deflectors)

| 편향 | 적용 지점 | 규칙 |
|------|----------|------|
| **Look-Ahead Bias** | rag_query, backtest | `published_at >= T_virtual` 데이터 필터 강제 |
| **Distraction Effect** | rag_analyst NER 단계 | target entity score < 0.75 은 컨텍스트 제외 |
| **Confirmation Bias** | debate moderator | bull/bear 둘 다 의무 호출 (만장일치 신호여도) |
| **Anchoring Bias** | portfolio_pm | 직전 사이클 결과를 현 사이클 프롬프트에 절대 prepend X |

위반 감지 시 사이클 즉시 중단 + `logs/audit/bias-violation-<ts>.jsonl`.

---

## 5. 감사 추적 (Audit Trail)

### 경로

```
logs/audit/YYYY-MM-DD.jsonl   # 일별 사이클 요약
logs/audit/<date>.jsonl       # 동일
logs/risk/<cycle_id>.jsonl    # 리스크 라인별
logs/consensus/<cycle_id>.jsonl # 토론 라인별
logs/audit/kis-api-<date>.jsonl # API 호출 로그
```

### 필드 (logs/audit/<date>.jsonl)

```json
{
  "ts_utc": "2026-05-25T05:32:11Z",
  "cycle_id": "2026-05-25-005930",
  "ticker": "005930",
  "user_id_hash": "sha256:abcd...",
  "agents_invoked": ["controller", "data-preprocessor", "...","compliance-officer"],
  "consensus_score": 76.4,
  "risk_status": "PASS",
  "hitl_status": "not_required",
  "order_simulated": {
    "side": "buy",
    "qty": 219,
    "value_krw": 15_001_500
  },
  "circuit_breaker_state": "armed_normal",
  "prev_hash": "sha256:...",
  "hash": "sha256:..."
}
```

### Hash Chain

각 라인은 `prev_hash` 필드로 이전 라인의 `hash` 를 참조. 변조 감지를 위한 hash chain.

검증 스크립트:

```bash
scripts/verify-audit-chain.sh logs/audit/2026-05-25.jsonl
```

체인이 깨지면 `compliance-officer` 가 즉시 ALERT 발행 + 모든 신규 사이클 차단.

---

## 6. FSC AI 가이드라인 5대 원칙 매핑

| 원칙 | 본 스킬 구현 |
|------|-------------|
| 1. 인간 책임성 (Accountability) | HITL 임계 초과 시 인간 승인 + compliance-officer 사후 sign-off |
| 2. 안전성 (Safety) | 회로 차단기, 포트폴리오 제약, Monte Carlo VaR |
| 3. 투명성 (Transparency) | 전 토론 로그 + 추론 체인 + 80_compliance.md |
| 4. 공정성 (Fairness) | 종목 선정은 정량 기준만 사용. 차별 가능한 특성 (성별·국적 등) feature 화 금지 |
| 5. 개인정보 보호 (Privacy) | user_id 는 sha256 hash 로만 저장, PII 일체 미보관 |

---

## 7. AML / KYC

본 스킬은 read-only 시뮬레이션이라 AML/KYC 자체 통제는 외부 OMS 책임. 단, 다음을 보장:

- 사이클 로그는 AML 분석 도구가 읽을 수 있는 JSONL 표준
- 거래 패턴 (빈도·금액·종목) 시계열 export 기능 제공 (`scripts/export-trade-pattern.sh`)
- 의심 활동 감지 자체는 외부 RegTech 솔루션 위임

---

## 8. 데이터 거주 (Data Residency)

| 항목 | 정책 |
|------|------|
| 주 리전 | `ap-northeast-2` (Seoul) |
| 로그 저장 | `ap-northeast-2` 강제 |
| 국외 이전 | 금지 (`cross_border_transfer_allowed: false`) |
| 백업 | 동일 리전 멀티 AZ |

---

## 9. 컴플라이언스 알림 채널

| 사건 | 채널 |
|------|------|
| HITL pending | telegram |
| HITL expired | telegram + email |
| 회로 차단기 발동 | telegram + email + sms |
| Hash chain 위반 | telegram + email + sms + audit team |
| 편향 위반 감지 | telegram |
| Veto 조건 매칭 | telegram |

채널 설정은 `compliance.json.notification` 에서 변경.

---

## 10. 정기 자가 감사

매월 1일 0시 자동 실행:

1. 직전 30일 사이클 전체 hash chain 무결성 검증
2. Moderator 편향 점검 (Bull/Bear 합의 점수 분포)
3. HITL 응답 시간 통계
4. 회로 차단기 발동 빈도
5. 예산 정책 위반 사례

결과: `logs/audit/monthly-self-audit-<YYYY-MM>.md` (한국어, 규제 보고 표준)
