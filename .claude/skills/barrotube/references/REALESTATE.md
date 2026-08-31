# 부동산 섹션 (realestate 슬롯)

개설 2026-08-30. 증시 2슬롯(us-close·kr-close)과 **같은 파이프라인, 다른 데스크 세트**로 돈다.

## 왜 별도 섹션인가

경쟁사 분석에서 `집값`이 최상위 콘텐츠 갭으로 나왔다 — 경쟁 채널이 계속 다루는데 우리 코퍼스에는
0회다. 그런데 이 시장의 유튜브 담론은 한쪽으로 기울어 있다. 등록된 부동산 경쟁 채널 21개의 논조
분포는 **강세 기울기 4 : 약세 기울기 2** 다(`competitor-channels.json` 의 `stance` 필드).
즉 시청자는 이미 "사야 한다" 쪽 이야기에 더 많이 노출돼 있다.

그래서 이 섹션의 차별점은 소재가 아니라 **태도**다. 방향을 팔지 않고 판단 재료를 준다.

## 구성

| 항목 | 값 |
|---|---|
| 슬롯 | `realestate` — 주 1회, 목 17:00 KST 실행 / 19:00 발행 |
| 포맷 | `shorts-3min` (7씬 172초, 9:16) |
| 페르소나 | `barro-analyst` — 신설. 중립 규약 6개 + 금지표현 18개 |
| 데스크 | `re-price` `re-supply` `re-policy` `re-rental` `re-region` |
| 에디터 | `realestate-analyst` (부동산 애널리스트) |
| 지표 | `RE:*` 10종 + `BOND:KR10YT=RR` + `FX_USDKRW` |

목요일인 이유: **한국부동산원 주간아파트가격동향이 목요일 낮에 나온다.** 그 전에 돌리면
지난주 수치로 만들게 된다. KB 주간시계열은 금요일이라 한 주 늦다.

## 중립성을 무엇으로 강제하는가

말로만 "중립적으로 써라" 하면 지켜지지 않는다. 세 겹으로 박아 두었다.

1. **씬 4번이 반대 해석 전용이다** (`routines.json` 의 `scene_skeleton`).
   상방을 말했으면 하방을, 하방을 말했으면 상방을 같은 무게로 넣는 자리다. 구조적으로
   한쪽 논조만으로는 대본이 완성되지 않는다.
2. **페르소나 금지표현** (`personas.json` 의 `barro-analyst`).
   `지금이 마지막 기회` `막차` `영끌` `폭등` `폭락` `줍줍하세요` `지금 사야 할 단지` 등 18개.
3. **데스크별 `scope_caveat`** (`desk-reporters.json`).
   예: 가격 데스크는 "0.0X% 를 '폭등·폭락'으로 부르지 않는다", 지역 데스크는 "특정 단지를
   지목하지 않는다. 상승 지역을 말하면 하락 지역도 같이 말한다".

에디터에는 추가로 `bias_guard` 가 있다 — 경쟁 담론이 강세로 기울어 있다는 사실을 알려 주되,
**"그러니 비관적으로 쓰라"는 뜻이 아니라 "상방만 말하는 것이 중립처럼 보이는 함정"** 이라고
못 박는다. 상쇄한다며 반대로 기울면 편향을 바꾼 것일 뿐이다.

## 데이터 — 키가 없으면 비운다, 채우지 않는다

증시와 달리 부동산은 무키 공개 엔드포인트가 없다. 세 기관 모두 발급 키를 요구한다
(2026-08-30 실측: KOSIS `유효하지않은 인증KEY`, ECOS·R-ONE `필수 값 누락`).

| 키 | 발급처 | 주는 것 |
|---|---|---|
| `REB_API_KEY` | <https://www.reb.or.kr/r-one/openapi/> | **주간 아파트가격지수 — 이 섹션의 앵커** |
| `ECOS_API_KEY` | <https://ecos.bok.or.kr/api/> | 기준금리·주택담보대출 금리 |
| `KOSIS_API_KEY` | <https://kosis.kr/openapi/> | 미분양·거래량·인허가 |

셋 다 무료·즉시 발급이다. **없어도 파이프라인은 돈다** — 수집기가 해당 심볼을 error 로 남기고
데스크가 WebSearch 인용으로 대체한다. 0 이나 직전 값으로 채우지 않는 이유는, 부동산은 한 주
차이가 서사를 뒤집는 분야라 조용한 기본값이 증시보다 더 위험하기 때문이다.

심볼 → 통계표 코드 매핑은 `config/realestate-sources.json` 에 있다. **코드 값은 미검증이다** —
키가 없어 실호출로 확인하지 못했다. 키를 넣은 뒤 한 번 대조하고, 값이 안 나오면 그 파일의
`stat_code`/`item_code` 만 고치면 된다(스크립트 수정 불필요).

## 설치

```bash
bash lib/install-cron.sh install realestate "Thu 17:00"
node scripts/automation/desk-briefing.js --slot realestate --dry-run   # 라우팅 확인
node scripts/automation/fetch-market-snapshot.js --slot realestate     # 키 상태 확인
```

## 알아 둘 것

- **데스크 산출물은 슬롯별로 갈린다** — `desk-briefing-<slot>.md`. 예전에는 슬롯 셋이 같은
  `desk-briefing.md` 를 덮어써서, 나중에 돈 슬롯이 앞 슬롯의 브리핑을 지웠다. 읽는 쪽
  (`research-brief.js`, `auto-pipeline.sh`)은 슬롯 파일을 먼저 보고 없으면 예전 이름으로 떨어진다.
- **슬롯의 `format`·`persona` 가 실제로 전달된다** — 예전에는 `create-episode.js` 에 안 넘겨서
  어떤 슬롯이든 기본값(shorts 60초·barro-alert)으로 만들어졌다. 부동산이 3분·중립 페르소나를
  쓰려면 이 연결이 필수라 같이 고쳤다.
- 경쟁 채널 중 `@lucky_tv`(김작가TV)·`@주언규PD` 는 부동산 전문이 아니라 경제·콘텐츠 종합이다.
  `stance: general` 로 표시해 두었으니 부동산 갭 분석에서 같은 무게로 읽지 말 것.
