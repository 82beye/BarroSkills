# MARKETING.md — 마케팅 → CEO → Producer 자동 브릿지

> Paperclip API 없이 standalone 작동하는 마케팅 인텔리전스 파이프라인.

## 4단계 흐름

```
[1] 데이터 수집 (marketing-fetch-local.js, 무비용)
   ↓
[2] Marketing Analyst 분석 (Task 위임 → barrotube-marketing-analyst)
   ↓
[3] CMO 검토 + 시리즈 후보 (Task 위임 → barrotube-cmo)
   ↓
[4] CEO 시리즈 기획 (Task 위임 → barrotube-ceo)
   ↓
[5] Producer 5 EP 부트스트랩 (producer-trigger-series.js, 무비용)
   ↓
[6] 첫 EP 진행 (Mode A, 운영자 명시 후 비용 발생)
```

## 데이터 소스 (3종)

### Source 1: RSS (자동, 권장)

```bash
node scripts/automation/marketing-fetch-local.js --source rss --out workspace/intel/marketing/auto-$(date +%Y-%m-%d).json
```

`config/domain-whitelist.json`의 한국 경제 뉴스 RSS feeds 활용. 무비용.

### Source 2: 사용자 입력 JSON

```bash
# workspace/intel/marketing/manual-YYYY-MM-DD.json 직접 작성
{
  "date": "2026-05-24",
  "items": [
    {"title": "...", "url": "...", "summary": "...", "source": "..."}
  ]
}
```

운영자가 특정 토픽·시기 강조하고 싶을 때.

### Source 3: 기존 BarroTube paperclip-export

```bash
node scripts/automation/marketing-fetch-local.js --source paperclip-export --file ~/youtube-co/workspace/intel/marketing/YOU-99.json
```

마이그레이션 또는 기존 데이터 재활용.

## Step 1 — Marketing Analyst 분석 (Task 위임)

```
Task(
  subagent_type: "barrotube-marketing-analyst",
  prompt: "
    데이터 소스: $BARROTUBE_HOME/workspace/intel/marketing/<file>.json
    
    작업:
    1. items[]에서 최근 7일 핵심 토픽 5개 추출
    2. 시청자 관심도·SEO 점수·경쟁 채널 분석
    3. 출력: workspace/intel/marketing/analyst-report-YYYY-MM-DD.md
    형식: { topic, why_now, target_keywords[], competitor_gap }
  "
)
```

## Step 2 — CMO 검토 (Task 위임)

```
Task(
  subagent_type: "barrotube-cmo",
  prompt: "
    분석 리포트: workspace/intel/marketing/analyst-report-YYYY-MM-DD.md
    
    작업:
    1. 시리즈 후보 3안 제시 (5편 시리즈 단위)
    2. 각 안의 KPI 예측 (조회수·구독자 전환률·CTR)
    3. 출력: workspace/intel/marketing/cmo-options-YYYY-MM-DD.md
  "
)
```

## Step 3 — CEO 시리즈 기획 (Task 위임)

```
Task(
  subagent_type: "barrotube-ceo",
  prompt: "
    CMO 옵션: workspace/intel/marketing/cmo-options-YYYY-MM-DD.md
    
    작업:
    1. 3안 중 1개 채택 (근거 명시)
    2. 시리즈 ID 결정 (예: ai-econ-2026-summer)
    3. curriculum.md 작성 (5편 학습 아크: WHAT → WHY → HOW → RISK → WHEN)
    4. ep-01-brief.md ~ ep-05-brief.md (5개) 작성
    5. config/series.json에 status=planned로 등록
    6. workspace/channels/<ch>/series/<id>/ 디렉토리 생성
  "
)
```

## Step 4 — Producer 부트스트랩 (스크립트)

```bash
node scripts/automation/producer-trigger-series.js --series <new-series-id>
```

- 5개 EP 디렉토리 자동 생성 (`workspace/episodes/EP-YYYY-NNNN`)
- 각 EP의 `00_brief.md`는 `ep-NN-brief.md`에서 복사
- 무비용 (디렉토리·파일만)
- in-flight 락 존중 (다른 EP 진행 중이면 거부)

## Step 5 — 첫 EP 진행 (운영자 명시)

```bash
# 운영자가 명시 승인 후
/barrotube ep run EP-YYYY-NNNN --execute
```

비용 발생 시작 (S6a TTS + S6c Image + S11 publish). 약 $0.5~$1.

## Cron 자동화 (선택)

주간 마케팅 분석을 매주 월요일 09:00에 자동 실행:

```bash
bash $BARROTUBE_HOME/lib/install-cron.sh install weekly-marketing "Mon 09:00"
```

- 매주 월요일 9시에 `marketing-fetch-local.js --source rss` 실행
- 결과를 `workspace/intel/marketing/auto-YYYY-MM-DD.json`에 저장
- Marketing Analyst/CMO/CEO 후속 단계는 **운영자 명시 호출 필요** (자동 시리즈 등록 X)

이유: 시리즈 등록은 정책 결정이므로 운영자 검토 필수.

## 안전 가드

- `config/series.json` 자동 백업 (CEO가 등록 전 `.bak.<timestamp>` 생성)
- 같은 series_id 충돌 시 자동 `-v2`, `-v3` 접미사
- in-flight 락 존중 (다른 EP 진행 중이면 producer-trigger-series.js exit 32)
- 일일 신규 시리즈 1건 상한 (`autonomy-pause.json` guards)

## 출력 검증

각 단계 완료 후:
- Step 1 (Analyst): `workspace/intel/marketing/analyst-report-*.md` 존재 + 5+ 토픽
- Step 2 (CMO): `workspace/intel/marketing/cmo-options-*.md` 존재 + 3안
- Step 3 (CEO): `config/series.json`에 신규 entry + `curriculum.md` + 5 brief
- Step 4 (Producer): `workspace/episodes/`에 5개 신규 EP 디렉토리

각 단계 실패 시 운영자에게 escalation, 자동 진행 중단.
