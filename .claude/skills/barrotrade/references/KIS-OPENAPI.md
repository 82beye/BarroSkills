# KIS OpenAPI 통합 사양

본 문서는 한국투자증권 OpenAPI(KIS Developers) 연동 규약입니다. 정책은 [`../config/kis-api.json`](../config/kis-api.json) 에 선언됩니다.

> ⚠️ **본 스킬은 KIS API 를 read-only 로만 사용합니다.** 시세·잔고·계좌 조회만 허용, 모든 주문 엔드포인트는 차단됩니다. 실주문은 외부 OMS + HITL 결재로만 가능.

---

## 1. 환경

| 환경 | base_url | websocket | rate_limit (rps) | 비고 |
|------|----------|-----------|------------------|------|
| paper (모의) | `openapivts.koreainvestment.com:29443` | `ws://ops.koreainvestment.com:31000` | 3 | 기본 |
| live (실거래) | `openapi.koreainvestment.com:9443` | `ws://ops.koreainvestment.com:21000` | 10 | **read-only 강제** |

`KIS_ENV` 환경변수로 선택. 기본 `paper`.

---

## 2. 인증 (OAuth 2.0)

### 토큰 발급

```
POST /oauth2/tokenP
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "appkey": "<KIS_APP_KEY>",
  "appsecret": "<KIS_APP_SECRET>"
}
```

- 응답: `access_token`, `access_token_token_expired` (만료 시각)
- TTL: 24시간
- 갱신 버퍼: 만료 10분 전 자동 재발급

### 자격 증명 해석 우선순위

1. `process.env.KIS_APP_KEY`
2. macOS Keychain: `BarroTrade/KIS_APP_KEY`
3. `.env` 파일

비밀은 로그에 절대 노출하지 않음 (`redact_secrets: true`).

---

## 3. 허용 엔드포인트 (Read-Only)

### 시세 조회

| 엔드포인트 | 용도 |
|-----------|------|
| `/uapi/domestic-stock/v1/quotations/inquire-price` | 현재가 |
| `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` | 일봉 차트 |
| `/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn` | 호가 잔량 |
| `/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion` | 분봉 체결 |
| `/uapi/overseas-price/v1/quotations/price` | 해외 시세 |

### 계좌 조회

| 엔드포인트 | 용도 |
|-----------|------|
| `/uapi/domestic-stock/v1/trading/inquire-balance` | 잔고 |
| `/uapi/domestic-stock/v1/trading/inquire-account-balance` | 계좌 평가 |
| `/uapi/domestic-stock/v1/trading/inquire-deposit` | 예수금 |

---

## 4. 차단 엔드포인트 (절대 호출 X)

```
/uapi/domestic-stock/v1/trading/order-cash
/uapi/domestic-stock/v1/trading/order-credit
/uapi/domestic-stock/v1/trading/order-rvsecncl
/uapi/overseas-stock/v1/trading/order
/uapi/overseas-stock/v1/trading/order-rvsecncl
```

스킬 게이트웨이가 위 경로 매칭 시 즉시 reject + 감사 로그 ERROR 라인.

---

## 5. 웹소켓 실시간 수신

### 구독 키

| 키 | 데이터 |
|----|--------|
| `H0STCNT0` | 국내 주식 실시간 체결가 |
| `H0STASP0` | 국내 주식 실시간 호가 |
| `HDFSCNT0` | 해외 주식 실시간 체결가 |

### 세션 관리

- **Heartbeat**: 30초 간격
- **재접속**: 무한 재시도, exponential backoff [1, 2, 5, 10, 30] 초
- **Failover**: 5초 내 응답 없으면 REST 폴링으로 자동 대피 (1초 간격)
- **백그라운드 재접속**: 매 5초 시도, 성공 시 폴링 종료 후 ws 복귀

### Failover 흐름

```
[websocket alive]
     │ (단절 감지)
     ▼
[5초 grace period, backoff 1초]
     │ (실패)
     ▼
[REST 폴링 활성, 1초 간격]
     │ 동시에 백그라운드 ws 재시도
     ▼
[ws 재접속 성공]
     │
     ▼
[REST 폴링 종료, ws 우선 복귀]
```

---

## 6. Rate Limiting

### Token Bucket

- **paper**: 3 rps × 0.8 safety = **2.4 effective rps**
- **live**: 10 rps × 0.8 safety = **8 effective rps**
- **알고리즘**: token bucket (1초마다 토큰 충전)
- **싱글톤 게이트웨이**: 17 에이전트의 모든 외부 호출이 단일 API Gateway 를 통과

### 429 응답 처리

```
on 429 Too Many Requests:
    exponential_backoff [1s, 2s, 4s]
    max_retries = 3
    after_max_retries:
        pause_cycle_and_alert_user
        emit logs/audit/<date>.jsonl line with code=KIS_RATE_LIMIT_EXHAUSTED
```

### 큐 오버플로

- 게이트웨이 큐 길이 임계 초과 시 호출자(에이전트)에 backpressure (대기)
- 에이전트는 5초 timeout, 그 이상 대기 시 사이클 일시 정지

---

## 7. 글로벌 마켓

### 지원 시장

`KRX`, `NYSE`, `NASDAQ`, `HKEX`, `TSE`, `SSE`, `SZSE`

### 세션 인지 라우팅

- 사이클 시작 시각의 시장 세션 자동 판별
- 비개장 시장은 큐에 보관하여 개장 직후 1회 사이클 실행
- FX 환율: `/uapi/etfetn/v1/quotations/inquire-exchange-rate` 매 사이클 시작 시 조회

---

## 8. 컴플라이언스 로깅

모든 KIS API 요청은 `logs/audit/kis-api-<YYYY-MM-DD>.jsonl` 에 1줄씩 기록:

```json
{
  "ts_utc": "2026-05-25T05:32:11Z",
  "endpoint": "/uapi/domestic-stock/v1/quotations/inquire-price",
  "method": "GET",
  "query_redacted": "?fid_cond_mrkt_div_code=J&fid_input_iscd=005930",
  "response_status": 200,
  "response_time_ms": 87,
  "cycle_id": "2026-05-25-005930",
  "agent_id": "barrotrade-data-preprocessor",
  "env": "paper"
}
```

- `redact_secrets: true` 강제 — appkey/secret/access_token 절대 기록 X
- `retention_days: 365`

---

## 9. 오프라인/장애 모드

| 시나리오 | 대응 |
|----------|------|
| KIS 정기 점검 (일 1회, 약 5분) | `ops_status` 사전 확인, 점검 시간대 사이클 자동 스킵 |
| 인증 토큰 만료 (24h) | 만료 10분 전 자동 갱신 |
| 시장 임시 휴장 (지진/블랙아웃) | 거시 분석가가 감지 시 모든 사이클 PAUSE |
| 종목 거래 정지 | RAG analyst veto → 해당 ticker 차단 풀에 추가 |

---

## 10. 외부 OMS 연결 권장 구조 (실거래 시)

> 본 스킬은 read-only 시뮬레이션. 실거래는 다음 외부 구조 권장:

```
[BarroTrade Skill (LLM agents)]
    │ writes
    ▼
[Redis strategy_map]
    │ reads (무한 루프, ms 단위)
    ▼
[Native OMS (C++/Rust)]
    │ HITL 통과 시 송출
    ▼
[KIS API order endpoint]
```

- LLM 에이전트는 절대 직접 송출 X
- OMS 가 strategy_map 의 조건 매칭을 1ms 내 평가
- 실집행 책임은 OMS + HITL 결재자

---

## 11. Tip: 자주 보는 오류

| 오류 | 원인 | 해결 |
|------|------|------|
| `EGW00121` | 토큰 만료 | 자동 재발급 대기 또는 `/barrotrade doctor` |
| `EGW00123` | rate limit | exponential backoff, 사이클 일시 정지 |
| `OPSP0007` | 시장 휴장 | macro_specialist regime 확인, 자동 스킵 |
| `40240000` | 종목 거래 정지 | RAG analyst veto, 차단 풀 추가 |
