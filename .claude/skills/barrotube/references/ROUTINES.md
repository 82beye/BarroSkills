# 정기 증시 브리핑 루틴 (일 2회)

바로경제 채널의 정기 발행 슬롯. 슬롯 정의는 `config/routines.json` 하나가 정본이다.

| 슬롯 | 시작 | 공개 | 내용 |
|---|---|---|---|
| `us-close` | 06:00 KST | 08:00 KST | 전날 미국 증시 마감 + 경쟁 채널 신규 콘텐츠 |
| `kr-close` | 16:00 KST | 18:00 KST | 국내 증시 마감 + 오늘 밤 미장 관전 포인트 |

## 설치

```bash
cd $BARROTUBE_HOME
bash lib/install-cron.sh install us-close "06:00"
bash lib/install-cron.sh install kr-close "16:00"
bash lib/install-cron.sh list
```

`DRY_RUN=1` 을 붙이면 plist 만 만들고 `launchctl load` 는 하지 않는다 (켜기 전 확인용).

launchd `StartCalendarInterval` 이 단일 dict 라 **하루 2회는 라벨을 나눠야 한다** —
그래서 슬롯마다 별도 routine 이다. 라벨은 `com.barroskills.barrotube.<slot>`.

## 3단 구조

```
Stage A  무인·결정론 (브라우저 불필요)
  Phase 1  시세 스냅샷(네이버) · 뉴스 RSS · 경쟁 채널
  Phase 2  리서치 + 전략 + 토픽 선정 (claude -p, 소셜 검색; 실패 시 수집 원문 폴백)
  Phase 3  S0 brief 생성 + `10_market_research.md` + `20_strategy.md` 설치
  Phase 4  S4 대본 (Gemini)
  Phase 5  📐 image_prompt 계약 게이트  ← 이미지 굽기 전에 막는 지점
  Phase 6  S5 팩트체크

Stage B  하이브리드 브라우저
  Phase 7  media-render (ChatGPT 이미지 → Grok 모션 클립 → 인트로)
           실패·타임아웃 → 텔레그램 호출 후 정상 종료 (자산 보존)

Stage C  무인 발행 + 거부창구
  Phase 8   S6~S9 자산·렌더·QA·메타 (publishAt 자동 주입)
  Phase 9   QA 게이트 (score ≥ 60, blocker = 0)
  Phase 10  S10 자율 승인
  Phase 11  텔레그램 30분 거부창구
  Phase 12  S11 업로드 (private + publishAt)
  Phase 13  완료 보고
```

## 데이터 소스

**시세** — `fetch-market-snapshot.js` (네이버 증권, 키 불필요)

| 대상 | 엔드포인트 |
|---|---|
| 코스피·코스닥 | `polling.finance.naver.com/api/realtime/domestic/index/{KOSPI\|KOSDAQ}` |
| S&P500·나스닥·다우 | `api.stock.naver.com/index/{.INX\|.IXIC\|.DJI}/basic` |
| 환율·달러인덱스 | `api.stock.naver.com/marketindex/majors/exchange` |

비공식 엔드포인트다. 막히면 `available:false` 로 기록하고 **헤드라인 전용으로 강등**되며
파이프라인은 계속 간다.

**뉴스** — `fetch-daily-news.js --sources <슬롯별>` (RSS 10종 중 선택)

## 알아둘 제약

**서머타임.** 미국 증시 마감은 서머타임 05:00 KST / 표준시 06:00 KST 다. 11~3월에는
`us-close` 시작(06:00)과 마감이 겹친다. `fetch-market-snapshot.js` 가 `marketStatus` 를
보고 최대 3회(5분 간격) 재시도하고, 그래도 미확정이면 `stale: true` 로 남긴다.
대본은 그때 "현지시간 기준 마감 직후" 로 쓰고 확정 종가를 단정하지 않는다.

**16:00 은 미국 프리마켓 전이다.** 프리마켓은 04:00 ET = 17:00 KST 부터다. 그래서
`kr-close` 의 "미장" 파트는 실시간 프리마켓 시세가 아니라 **야간 선물·유럽장·오늘 밤
예정 지표/실적 일정 + 전일 미국 종가** 로 쓴다. 미국 지수를 인용할 땐 "전일 종가"로 명시한다.

**예약 시각이 이미 지났으면 예약을 걸지 않는다.** `resolvePublishAt()` 이 null 을 돌려
`publishAt` 없이 private 로 업로드된다 — YouTube 가 과거 `publishAt` 을 거부하는데
`privacyStatus` 는 이미 private 로 강제된 뒤라, 억지로 넣으면 영상이 영영 안 열린다.
이 경우 로그에 경고가 남으니 운영자가 수동 공개한다.

## 실패 시

**브라우저 단계 실패** — 가장 흔하다. 텔레그램으로 알림이 오고 자산은 보존된다.
Chrome 의 ChatGPT/Grok 로그인을 확인한 뒤:

```bash
RESUME_EP=EP-2026-NNNN bash lib/auto-pipeline.sh --slot us-close
```

Phase 7 worker의 로그인 보고는 참고값이다. 사용자가 로그인을 확인했거나 기존 탭이 보이면
PD가 Playwright로 같은 브라우저의 기존 ChatGPT/Grok 탭을 한 번 선택해 프로필+composer를
확인한다. 로그인 상태면 누락 브라우저 자산만 직접 완성한다. 완료 정본은 worker 응답이
아니라 씬 PNG 5장 + 오디오 포함 MP4 5개 + 인트로 + 썸네일의 12/12 파일 게이트다.

12/12가 완성되면 위의 plain `RESUME_EP` 명령이 Phase 7을 자동으로 건너뛴다.
`BT_SKIP_MEDIA_RENDER=1`은 불완전 자산을 우회하지 못하며 진단용으로만 쓴다:

```bash
BT_SKIP_MEDIA_RENDER=1 RESUME_EP=EP-2026-NNNN bash lib/auto-pipeline.sh --slot us-close
```

**계약 게이트 차단** — 대본을 1회 자동 재생성하고, 그래도 위반이면 멈춘다.
`references/IMAGE-PROMPT.md` 를 보고 `30_script.md` 의 `image_prompt` 를 고친 뒤 재개한다.
**이미지를 굽기 전에 멈추므로 비용은 나가지 않는다.**

**리서치 모델 실패** — 수집된 시세·뉴스 원문으로 보수적인 `10_market_research.md`와
`20_strategy.md`를 만들고 텔레그램에 알린다. 두 파일이 없으면 대본 생성 전에 멈춘다.

## 환경 변수

| 변수 | 기본 | 용도 |
|---|---|---|
| `DRY_RUN=1` | 0 | 명령 echo only, 비용 0 |
| `RESUME_EP` | — | 특정 EP 이어서 |
| `FORCE_TOPIC` | — | 토픽 강제 (데이터 수집·리서치 건너뜀) |
| `BT_SKIP_MEDIA_RENDER=1` | 0 | 브라우저 단계 건너뛰기 |
| `MEDIA_RENDER_TIMEOUT` | 2400 | 브라우저 단계 타임아웃(초) |
| `RESEARCH_TIMEOUT` | 600 | 리서치 타임아웃(초) |
| `BT_RESEARCH_MODEL` | sonnet | 리서치용 모델 |
| `BT_PUBLISH_AT` | 슬롯값 | 예약 공개 시각 (S9 메타로 전달) |

## 비용

media-render 경로는 이미지·모션 클립을 브라우저로 만들어 **이미지 API 비용이 0** 이다.
편당 실측 ≈ **$0.22** (TTS $0.21 + Gemini 텍스트 $0.01). 하루 2편 × 30일 ≈ **$13/월**.
2026-07 실지출 $2.31 이 근거다.

실제 차단선은 `config/budget-policy.json` 의 `format_profiles` 가 아니라
`guards.sh` 가 보는 `roles` monthly_limit 합계 **$770 의 90% = $693** 이다.

## 알려진 이슈

`.episode_status.json` 의 최상위 `status` 가 발행 후에도 `completed` 로 남아,
`guard_daily_quota` 가 `status=='published'` 만 세기 때문에 일일 상한이 사실상
발화하지 않는다 (EP-0070·0071 확인). cron 이 슬롯당 1회만 뜨므로 당장 문제는 아니지만,
상한을 신뢰하지는 말 것.
