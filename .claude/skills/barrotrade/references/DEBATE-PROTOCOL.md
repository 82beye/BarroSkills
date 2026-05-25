# Debate Protocol — Bull vs Bear + Moderator

본 문서는 BarroTrade 의 Stage IV (Debate Layer) 진행 규약입니다. 정책은 [`../config/consensus.json`](../config/consensus.json) 에 선언됩니다.

---

## 토론 4 라운드

### Round 1 — 기초 진술

- **참여**: Bull, Bear (병렬)
- **형식**: 각자 핵심 논거 3개 + 근거 데이터 인용 + 가격 시나리오 (목표가 / 손절가)
- **분량**: 측당 최대 1,500 토큰
- **출력**: `40_bull_brief.md`, `41_bear_brief.md`

### Round 2 — 교차 논증

- **참여**: Bull, Bear (Moderator 가 진행)
- **형식**: 상대 진술 중 **가장 약한 논거 1개씩** 지목하고 반박. 반박은 원본 데이터 또는 동일 데이터의 다른 해석 제시.
- **분량**: 측당 최대 1,000 토큰

### Round 3 — 데이터 대조

- **참여**: Moderator (Bull/Bear 의견 인용만)
- **형식**: 동일 데이터 포인트에 대해 양측의 해석이 어떻게 다른지 표로 정리

  ```markdown
  | 데이터 포인트 | Bull 해석 | Bear 해석 | 객관적 가중치 |
  |--------------|-----------|-----------|--------------|
  | 1Q 매출 +12% YoY | 성장 가속 | 시장 컨센서스 미달 (+15% 예상) | Bear +0.15 |
  | ADX 28 | 추세 진입 확인 | 5일 평균 26 → 둔화 신호 | 중립 |
  ```

- **분량**: 최대 1,500 토큰

### Round 4 — 합의 시도

- **참여**: Moderator
- **형식**:
  1. **합의 가능 영역** 명시 (양측 모두 동의)
  2. **합의 불능 영역** 명시 (잔존 견해 차)
  3. **최종 점수 산정** (가중치 투표)
- **분량**: 최대 2,000 토큰
- **출력**: `50_debate_log.md`

---

## 가중치 투표 (Weighted Voting)

### 점수 디멘션 (총합 100)

```
score = 20 · macro_alignment        ∈ [-1, 1]
      + 20 · fundamental_safety     ∈ [-1, 1]
      + 20 · technical_signal_quality ∈ [-1, 1]
      + 10 · event_impact           ∈ [-1, 1]
      + 10 · sector_momentum        ∈ [-1, 1]
      + 10 · rag_sentiment_confidence ∈ [-1, 1]
      + 10 · historical_pattern_match ∈ [-1, 1]

vote_score = 50 + 50 * (sum of weighted dimensions / 100)
```

각 디멘션은 [-1, 1] 범위. `-1` = 매우 부정, `0` = 중립, `+1` = 매우 긍정.

### 게이트

| 점수 | 결정 |
|------|------|
| `vote_score ≥ 70` | 통과 → Stage V (Risk) 진입 |
| `60 ≤ vote_score < 70` | 사용자 프로파일이 `aggressive` 일 때만 통과 |
| `vote_score < 60` | 차단, 사이클 종료, reflect 자동 트리거 |

### Tie-Break

- 동점 시 `bear_priority`: Bear 측 가중치 +5%

### Veto 조건 (자동 차단)

다음 중 하나만 발견되어도 vote_score 와 무관하게 즉시 차단:

- `macro_specialist.regime == 'crisis'`
- `fundamental_specialist.audit_opinion ∈ {disclaimer, adverse, qualified}`
- `rag_analyst.detected_keywords` 에 다음 중 하나 매칭:
  - 감사의견 거절, 감사의견 비적정, 분식회계
  - 횡령, 배임, 상장폐지, 거래정지
  - 자본잠식, 신청자본금 부족

---

## 사용자 프로파일 통합

| 프로파일 | bear 가중치 배수 | 최소 합의 점수 | 포지션 한도 배수 |
|---------|----------------|---------------|----------------|
| `conservative` | 1.4 | 78 | 0.7 |
| `balanced` (기본) | 1.0 | 70 | 1.0 |
| `aggressive` | 0.8 | 60 | 1.3 |

설정 위치: `compliance.json` 또는 사용자가 `/barrotrade cycle <T> --profile aggressive` 로 임시 override.

---

## 합의 도출 실패 처리

```
if vote_score < threshold:
    write 50_debate_log.md (with reason="below_threshold")
    write logs/consensus/<cycle>.jsonl line
    auto_trigger /barrotrade reflect <cycle_id>
    end cycle with status="aborted_debate"
```

reflection 산출물은 다음 동일 ticker 사이클의 컨텍스트에 자동 prepend → 같은 함정 반복 방지.

---

## Moderator 의 편향 점검

Moderator 도 LLM 이므로 편향 가능. 다음 사후 검사가 매월 1회 자동 실행:

1. 최근 30일간 Moderator 의 합의 점수 분포 → bull/bear 편중 측정
2. 동일 데이터로 두 번째 Moderator 인스턴스 (다른 모델 백엔드) 가 재평가 시 점수 차 통계
3. Bear 가 경고했으나 묵살한 항목이 실제 손실로 이어진 비율

검사 결과는 `logs/audit/moderator-bias-<YYYY-MM>.md` 로 저장.

---

## 산출물 예시 (50_debate_log.md 발췌)

```markdown
---
cycle_id: 2026-05-25-005930
ticker: 005930
moderator_model: claude-opus-4-7
rounds_completed: 4
vote_score: 76.4
decision: PASS
user_profile: balanced
---

# 토론 합의 리포트 — 005930 (삼성전자)

## 합의 가능 영역
- 1Q 메모리 가격 반등은 확인된 사실 (양측 동의)
- 외국인 5일 순매수 (+1,240억) 수급 우위

## 합의 불능 영역
- HBM 시장 점유율 향방
  - Bull: 2026 하반기 신규 SKU 진입으로 회복
  - Bear: SK하이닉스 HBM3E 12H 양산 격차 6개월
  - 결론: 가중치 0.6/0.4 로 Bull 우세지만 Bear 의견 risk_check 에 반영

## 가중 점수 산정
| 디멘션 | 가중치 | Bull 점수 | Bear 점수 | 최종 |
|--------|--------|-----------|-----------|------|
| Macro alignment | 20 | +0.4 | -0.2 | +0.30 |
| Fundamental safety | 20 | +0.6 | -0.3 | +0.45 |
| Technical | 20 | +0.7 | -0.1 | +0.55 |
| Event impact | 10 | +0.5 | -0.4 | +0.20 |
| Sector momentum | 10 | +0.3 | -0.2 | +0.15 |
| RAG sentiment | 10 | +0.4 | 0.0 | +0.30 |
| Historical pattern | 10 | +0.5 | -0.3 | +0.30 |

vote_score = 50 + 50 × (52.8 / 100) = 76.4
```
