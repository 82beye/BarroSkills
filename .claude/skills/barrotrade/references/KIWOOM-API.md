# Kiwoom REST API 통합 사양

본 문서는 키움증권 REST API 연동 규약입니다. 정책은 [`../config/kiwoom-api.json`](../config/kiwoom-api.json) 에 선언됩니다. 원본은 사용자가 제공한 `키움 REST API 문서.pdf` (528 페이지) 기반.

> ⚠️ **본 스킬은 키움 API 도 read-only 로만 사용합니다.** 시세·잔고·계좌 조회만 허용, 모든 주문 경로(`/api/dostk/ordr`, `/api/dostk/crdordr`)는 차단됩니다. 실주문은 외부 OMS + HITL 결재로만 가능.

---

## 1. 환경

| 환경 | base_url | 시장 | rate_limit (rps) | 비고 |
|------|----------|------|------------------|------|
| paper (모의) | `https://mockapi.kiwoom.com` | KRX only | 5 | 기본 |
| live (실거래) | `https://api.kiwoom.com` | KRX + 해외 | 10 | **read-only 강제** |

`KIS_ENV` 와 동일한 `KIWOOM_ENV` 환경변수로 선택. 기본 `paper`.

---

## 2. 인증 (OAuth 2.0)

### 토큰 발급 (au10001)

```
POST /oauth2/token
Content-Type: application/json;charset=UTF-8
Header:
  api-id: au10001
Body:
{
  "grant_type": "client_credentials",
  "appkey": "<KIWOOM_APP_KEY>",
  "secretkey": "<KIWOOM_SECRET_KEY>"
}
```

응답:

```json
{
  "expires_dt": "20241107083713",
  "token_type": "bearer",
  "token": "WQJCwyqInphKnR3bSRtB9NE1lv...",
  "return_code": 0,
  "return_msg": "정상적으로 처리되었습니다"
}
```

### 토큰 폐기 (au10002)

```
POST /oauth2/revoke
Header:
  api-id: au10002
  authorization: Bearer <token>
Body:
{
  "appkey": "...",
  "secretkey": "...",
  "token": "..."
}
```

### 공통 Header 규약

| Header | 필수 | 설명 |
|--------|------|------|
| `api-id` | Y | 7자리 TR 코드 (예: `ka00001`, `au10001`) |
| `authorization` | Y | `Bearer <token>` |
| `cont-yn` | N | 연속 조회 여부 (응답 Header 의 값을 그대로 다음 요청에 세팅) |
| `next-key` | N | 연속 조회 키 (응답 Header 의 값) |

### 자격 증명 해석 우선순위

1. `process.env.KIWOOM_APP_KEY` / `KIWOOM_SECRET_KEY`
2. macOS Keychain: `BarroTrade/KIWOOM_APP_KEY` / `BarroTrade/KIWOOM_SECRET_KEY`
3. `.env` 파일

비밀은 로그에 절대 노출하지 않음 (`redact_secrets: true`).

---

## 3. 카테고리별 Base Path

키움 API 는 **path 가 카테고리 코드** 이고, 동일 path 내에서 **`api-id` Header 로 endpoint 가 식별**됩니다 (KIS 와 구조가 다름).

| 카테고리 | path | TR 코드 prefix |
|----------|------|---------------|
| OAuth | `/oauth2/...` | au* |
| 종목정보 | `/api/dostk/stkinfo` | ka10001 ~ ka10019 등 |
| 시장상황 | `/api/dostk/mrkcond` | ka10004 ~ ka10007 등 |
| 차트 | `/api/dostk/chart` | ka10080~ka10083 |
| 순위정보 | `/api/dostk/rkinfo` | ka10020 ~ ka10042 등 |
| 업종 | `/api/dostk/sect` | ka10010, ka10051 등 |
| 테마 | `/api/dostk/thme` | (테마군) |
| 외국인·기관 | `/api/dostk/frgnistt` | ka10008, ka10009, ka10036 |
| 공매도 | `/api/dostk/slb` | ka10014 |
| ETF | `/api/dostk/etf` | (ETF 군) |
| ELW | `/api/dostk/elw` | (ELW 군) |
| 계좌 | `/api/dostk/acnt` | kt00001 ~ kt00018 |
| **주문 (차단)** | `/api/dostk/ordr` | kt10000 ~ kt10003 |
| **신용주문 (차단)** | `/api/dostk/crdordr` | kt10006 ~ kt10009 |
| 웹소켓 | `/api/dostk/websocket` | (실시간 시세) |

---

## 4. 허용 엔드포인트 (Read-Only)

전체 ka* 150개 + kt0* 17개 = 약 167개 read-only 엔드포인트 중 BarroTrade 핵심 서브셋:

### 시세 조회

| TR | 이름 | 카테고리 |
|----|------|---------|
| ka10001 | 주식기본정보요청 | stkinfo |
| ka10002 | 주식거래원요청 | stkinfo |
| ka10003 | 체결정보요청 | stkinfo |
| ka10004 | 주식호가요청 | mrkcond |
| ka10005 | 주식일주월시분요청 | mrkcond |
| ka10006 | 주식시분요청 | mrkcond |
| ka10007 | 시세표성정보요청 | mrkcond |
| ka10015 | 일별거래상세요청 | stkinfo |

### 차트 (시계열)

| TR | 주기 | 비고 |
|----|------|------|
| ka10080 | 분봉 | 1/3/5/10/15/30/60 분 |
| ka10081 | 일봉 | OHLCV |
| ka10082 | 주봉 | OHLCV |
| ka10083 | 월봉 | OHLCV |

### 순위정보 (스크리닝)

ka10020 (호가잔량 상위), ka10023 (거래량 급증), ka10027 (등락률 상위), ka10030 (당일거래량 상위), ka10032 (거래대금 상위) 등.

### 외국인·기관 수급

ka10008 (외국인 매매동향), ka10009 (기관), ka10036 (외인한도 소진율).

### 계좌·잔고 (kt0*)

| TR | 이름 | 용도 |
|----|------|------|
| kt00001 | 예수금상세현황요청 | 현금 잔고 |
| kt00003 | 추정자산조회요청 | 평가액 |
| kt00004 | 계좌평가현황요청 | 종목별 평가 |
| kt00005 | 체결잔고요청 | 보유 종목 |
| kt00010 | 주문인출가능금액요청 | 가용 자금 |
| kt00016 | 일별계좌수익률상세현황요청 | PnL |
| kt00018 | 계좌평가잔고내역요청 | 잔고 상세 |

---

## 5. 차단 엔드포인트 (절대 호출 X)

```
# 일반 주문
/api/dostk/ordr  ← kt10000, kt10001, kt10002, kt10003

# 신용 주문
/api/dostk/crdordr  ← kt10006, kt10007, kt10008, kt10009
```

게이트웨이가 path prefix 매칭 시 즉시 reject + 감사 로그 ERROR 라인.

검증: `bash scripts/doctor-cli.sh` 가 `blocked_path_prefixes` 의 길이 ≥ 2 인지 자동 검사.

---

## 6. 웹소켓 실시간 수신

### URL

- 운영: `wss://api.kiwoom.com:10000/api/dostk/websocket`
- 모의: `wss://mockapi.kiwoom.com:10000/api/dostk/websocket`

### 인증

연결 시 `authorization: Bearer <token>` Header 필수.

### 구독 타입

| 타입 | 용도 |
|------|------|
| 주식기세 | 일반 시세 |
| 주식체결 | 실시간 체결가 |
| 주식우선호가 | 1호가 |
| 주식호가잔량 | 잔량 정보 |
| 주식시간외호가 | 시간외 호가 |
| 주식예상체결 | 동시호가 시간 예상 체결가 |

### Failover

KIS 와 동일 정책:
- Heartbeat 30초
- 단절 5초 내 REST 폴링(`/api/dostk/mrkcond`, tr_id=ka10004 호가)로 자동 대피
- 백그라운드 재접속, 성공 시 ws 우선 복귀

---

## 7. Rate Limiting

- paper: 5 rps × 0.8 = **4 effective rps**
- live: 10 rps × 0.8 = **8 effective rps**
- 알고리즘: token bucket, 싱글톤 게이트웨이

### 429 응답 처리

```
exponential_backoff [1s, 2s, 4s]
max_retries = 3
after_max_retries: pause_cycle_and_alert_user
```

### 키움 고유 오류

| 코드 | 의미 | 해결 |
|------|------|------|
| 1687 | 재귀 호출 제한 — 동일 API 연속 호출 차단 | 다른 TR 코드와 인터리브, 또는 대기 |

---

## 8. 연속 조회 (Pagination)

키움 고유 페이지네이션:

```
Response Header:
  cont-yn: "Y"        # 다음 페이지 있음
  next-key: "abc..."  # 다음 요청에 그대로 세팅

Next Request Header:
  cont-yn: "Y"
  next-key: "abc..."
```

BarroTrade 사이클 1회당 **최대 10 페이지**까지만 자동 연속 조회 (무한 루프 방지).

---

## 9. KIS vs Kiwoom 차이 매트릭스

| 항목 | KIS (한국투자증권) | Kiwoom (키움증권) |
|------|-------------------|------------------|
| URL 구조 | `/uapi/<market>/v1/<category>/<endpoint>` | `/api/dostk/<category-code>` |
| Endpoint 식별 | URL path | `api-id` Header (TR 코드) |
| 인증 endpoint | `/oauth2/tokenP` | `/oauth2/token` |
| 인증 body | `appkey`, `appsecret` | `appkey`, `secretkey` |
| 페이지네이션 | `tr_cont` (F/N/M) | `cont-yn` + `next-key` |
| 웹소켓 도메인 | `ops.koreainvestment.com:21000/31000` | `api.kiwoom.com:10000/api/dostk/websocket` |
| 시장 | KRX/NYSE/NASDAQ/HKEX/TSE/SSE/SZSE | KRX 주력, 해외 일부 |
| 차단 주문 경로 | `/uapi/.../trading/order-*` | `/api/dostk/ordr`, `/api/dostk/crdordr` |
| 모의투자 도메인 | `openapivts.koreainvestment.com:29443` | `mockapi.kiwoom.com` (KRX only) |

---

## 10. 컴플라이언스 로깅

모든 키움 API 요청은 `logs/audit/kiwoom-api-<YYYY-MM-DD>.jsonl` 에 1줄씩 기록:

```json
{
  "ts_utc": "2026-05-25T05:32:11Z",
  "endpoint": "/api/dostk/mrkcond",
  "tr_id": "ka10004",
  "method": "POST",
  "body_keys": ["stk_cd"],
  "response_status": 200,
  "response_time_ms": 92,
  "cont_yn": "N",
  "cycle_id": "2026-05-25-005930",
  "agent_id": "barrotrade-data-preprocessor",
  "env": "paper",
  "broker": "kiwoom"
}
```

- `redact_secrets: true` 강제 — appkey/secretkey/token 절대 기록 X
- `retention_days: 365`

---

## 11. Broker 추상화 (KIS + Kiwoom 통합)

BarroTrade 는 두 브로커를 **동일 인터페이스** 로 추상화합니다:

```
[barrotrade-data-preprocessor]
        │ broker = env('BARROTRADE_BROKER', 'kis')
        ▼
   ┌────┴────────────────────────────────┐
   ▼                                      ▼
[KIS Adapter]                       [Kiwoom Adapter]
 - config/kis-api.json              - config/kiwoom-api.json
 - URL path 식별                    - api-id header 식별
 - tr_cont 페이지네이션              - cont-yn/next-key 페이지네이션
   └────────────┬─────────────────────┘
                ▼
       [정규화된 OHLCV/호가 데이터]
                ▼
        [10_market_snapshot.md]
```

에이전트는 broker 차이를 모릅니다 — adapter 가 표준 스키마로 변환해 전달.

---

## 12. 환경 변수

| Key | 용도 | 폴백 |
|-----|------|------|
| `BARROTRADE_BROKER` | `kis` 또는 `kiwoom` | `kis` |
| `KIWOOM_APP_KEY` | 키움 앱 키 | Keychain `BarroTrade/KIWOOM_APP_KEY` |
| `KIWOOM_SECRET_KEY` | 키움 시크릿 | Keychain `BarroTrade/KIWOOM_SECRET_KEY` |
| `KIWOOM_ENV` | `paper`/`live` | `paper` |
| `BARROTRADE_ALLOW_LIVE_ORDER` | 절대 `true` 로 두지 말 것. 본 스킬은 무시함. | `false` 강제 |

키 등록 예:

```bash
security add-generic-password -s "BarroTrade/KIWOOM_APP_KEY" -a "$USER" -w "<APP_KEY>"
security add-generic-password -s "BarroTrade/KIWOOM_SECRET_KEY" -a "$USER" -w "<SECRET>"
```

---

## 13. 자주 보는 오류

| 코드 | 의미 | 해결 |
|------|------|------|
| 401 / token expired | 토큰 만료 | 자동 재발급 대기 또는 `/barrotrade doctor` |
| 429 / rate limit | 호출 빈도 초과 | exponential backoff, 사이클 일시 정지 |
| 1687 | 재귀 호출 제한 | 다른 TR 인터리브 |
| 1234 (예시) / 시장 휴장 | 시장 비개장 시간 | macro_specialist regime 확인, 자동 스킵 |
| return_code != 0 | 일반 응답 오류 | `return_msg` 확인, 에이전트 retry 1회 |
