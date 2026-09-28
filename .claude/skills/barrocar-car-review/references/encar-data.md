# 엔카 수집기와 한계

`assets/encar_fetch.py`를 재사용한다. 아래 경로는 2026-09-13에 표본 응답을 확인했다. 비공식 웹 클라이언트용 경로이므로 동작·스키마가 유지된다고 보장하지 않는다. 실제 요청 실패는 기록하고 검색 0건·서류 미공개와 구분한다.

## 진입점

```bash
python3 assets/encar_fetch.py dossier 42712825
python3 assets/encar_fetch.py screen 42712825 42537270
python3 assets/encar_fetch.py search '<쿼리>' PriceAsc
python3 assets/encar_fetch.py bands '<Price.range(%s)를 포함한 쿼리>' 0 6000
python3 assets/test_review.py
```

명령은 스킬 디렉터리에서 실행하거나 스크립트 절대경로를 사용한다. `dossier` JSON 원문을 출처 폴더에 저장한다. Python 3와 curl이 필요하며 requests는 사용하지 않는다.

## 단일 매물

| 자료 | URL |
|---|---|
| 기본정보 | `https://api.encar.com/v1/readside/vehicle/{광고ID}` |
| 보험이력 | `https://api.encar.com/v1/readside/record/vehicle/{차량ID}/open` |
| 성능기록부 | `https://api.encar.com/v1/readside/inspection/vehicle/{차량ID}` |
| 엔카진단 | `https://api.encar.com/v1/readside/diagnosis/vehicle/{차량ID}` |

광고ID로 기본정보를 받은 후 **응답의 vehicleId**로 서류를 조회한다. 이 값이 없으면 광고ID를 대신 넣지 않는다. `dossier`에는 자료별 URL, 수집시각, 조회 오류가 포함된다. HTTP/JSON 오류는 자료 미확보이며 차량 결함의 증거가 아니다.

기본정보에서 `category.yearMonth`(등록 연월), `formYear`(모델연도), `gradeName`, `spec.mileage`, `advertisement.price`, `vin`, `vehicleNo`를 구분한다. 플랫폼 등록값과 공식 서류가 같다고 가정하지 않는다. 광고 내용·옵션·가격은 [판매자]로 표기하며, 공식 제원·등록 서류와 대조한 부분만 해당 근거를 붙인다.

`condition.accident.recordView=false` 또는 보험 응답 `openData=false`는 보험 공개 여부의 근거다. `resumeView`를 성능기록부 공개 여부로 대신 쓰지 않는다. 성능기록부는 실제 내용을 조회해 확인한다.

## 보험이력

- `accidents[].type`: 1·2는 내차피해, 3은 타차피해. **원래 type을 보존한다.** 미지 코드는 미확인이다.
- `partCost + laborCost + paintingCost`는 그 건에서 제공된 수리비 합계다. `insuranceBenefit`은 별도 지급액이므로 같은 열로 대체하지 않는다.
- 내차 건별 합계·건수는 `myAccidentCost`·`myAccidentCnt`, 타차는 `otherAccidentCost`·`otherAccidentCnt`와 각각 비교한다.
- 0건·0원·빈 상세 배열은 정상적인 무기록 입력이다. 양수 사고 건수인데 세부가 비거나, 0원 구성에 지급액이 있으면 미확인 내역이 있다. 요약과 불일치하면 차액과 원인을 확인한다.
- `notJoinDate1`~`notJoinDate5`가 모두 **존재하고** null/빈 값인 경우와 필드 자체 누락을 구별한다. 알려진 공백이 없어도 비보험 수리는 배제할 수 없다.
- `loan`·`business`·`government`의 0/양수/누락을 구분한다. 문자열 "0"도 0으로 읽으며 None은 미확인이다.

## 성능기록부

서식의 객체가 존재하는 것만으로 F1 통과가 아니다. `master.detail.recordNo`·`issueDate`와 실제 점검 내용, `outers`, `seriousTypes`를 확인한다. 모든 값이 null인 서식도 HTTP 200으로 올 수 있다.

- `outers[].attributes`: RANK_ONE(외판 1), RANK_TWO(외판 2), RANK_A/B/C(주요 골격).
- `outers[].statusTypes`: X 교환, W 판금/용접. 기존 필드 이름과 달리 `outers`에는 골격 부위도 포함된다.
- `master.detail.seriousTypes`는 **특별이력**이다. 2026-09-13 엔카 공개 화면 코드의 «특별이력» 라벨과 직접 대조했다. 골격 손상 목록으로 사용하지 않는다. `master.accdient`(API 원래 철자)는 사고이력 요약이며 outers와 충돌하면 보류한다. 특별이력이 있으면 골격 손상으로 단정하지 않고 추가 확인을 위해 자동 F2를 보류한다. 부위명·랭크·상태를 함께 확인한다. 알 수 없는 부위·외판 2랭크는 자동 보류한다.
- `recall`은 true/false/null을 구분하며 발급 시점의 기록이다. `recallFullFillTypes`와 VIN 기준 최신 공식 조회를 대조한다.
- `comments`는 면책·제외 항목을 포함하므로 읽는다. 여기에 기재된 정비이력 존재 여부는 상세 수리 내용과 다르다.
- `inners`의 이상 표기를 요약한다. 빈 배열·미지원 항목·누락을 «전 항목 정상»이라고 보고하지 않는다.

F3의 사고 관련 수리는 원문 정비자료, F4는 사고 당시의 실제 주행 기록이 필요하다. 수집기는 둘 다 **null**을 반환한다. 외판 수리는 `F2_outer_repairs`에서 부위와 X/W를 함께 반환한다. `F2_outer_swaps`는 호환용으로 유지하며 X(교환) 부위만 반환한다. W까지 포함한 수리는 `F2_outer_repairs`를 쓴다. `special_history`는 특별이력 목록이며 F2 골격 손상 목록과 분리된다.

## 검색

목록 HTML의 `__NEXT_DATA__`에서 `props.pageProps.initialState.ryvussApi.queries` 아래 `getCarNormal(...)`의 `data.Count`, `data.SearchResults`를 읽는다. 태그·경로가 없으면 파싱 실패이며 0건이 아니다.

```text
https://car.encar.com/list/car?page=1&search={URL인코딩된 JSON}
{"type":"car","action":"<쿼리>","toggle":{},"layer":"","sort":"PriceAsc"}
```

쿼리 예:

```text
(And.Hidden.N._.MultiView2Hidden.N._.(C.CarType.N._.(C.Manufacturer.BMW._.(C.ModelGroup.5시리즈._.Model.5시리즈 (G30).)))_.Price.range(%s)._.Mileage.range(30000..47000)._.Year.range(201905..202105).)
```

`CarType.N` 수입 / `CarType.Y` 국산, 가격은 만원, 주행은 km, Year는 YYYYMM이다. 정렬은 PriceAsc/PriceDesc 등 실제 응답을 확인해 쓴다. 배지·트림·좌석 조건은 목록/개별 자료와 대조한다.

한 응답은 통상 최대 200건이며 page 증가만으로 후속 결과를 확보했다고 가정하지 않는다. `search_bands(template, bands=[(0,6000)])`는 **지정 범위**를 실제 Count 대비 수집량이 부족할 때 분할한다. 같은 정수 가격에서도 상한을 넘으면 오류를 내므로 다른 확인된 필터로 좁혀야 한다. 고정 4,000만원 상한을 전 가격대 검색처럼 쓰지 않는다. 검색 중 재고가 변할 수 있어 완료 표시는 조회 시점·조건 범위에 한한다.

## 중복과 비교군

`dedup_map(rows)`는 `(남긴 목록, {남긴 광고ID: [다른 광고ID]})`를 반환한다. 동일 광고ID의 반복을 제거하고, 조회로 확보한 VIN·차량ID·전체 차량번호가 있는 경우에만 동일 차량으로 묶는다. 목록에 식별자가 없으면 개별조회해 보강하거나 중복 여부 미확인으로 유지한다. `(Year, Mileage, Price)` 일치만으로 합치지 않는다.

`SellType`이 리스·렌트인 행은 기본 제외한다. `Badge`, 연식·세대·좌석·주행 조건이 다른 차량을 시세 비교군에 넣어 감가율을 계산하지 않는다. `Condition`은 자료 확인을 위한 힌트이며 실제 서류 내용의 대체물이 아니다.

## 자동화 범위

`screen`은 F1·F2·F5 및 S1·S5·S6의 일부와 보험 합계·점검 이상을 요약한다. 값은 True(통과), False(탈락), None(보류)이며, 전체 F1~F5/S1~S8 자동 판정 엔진이나 보고서 생성 명령은 아니다. 최종 판정에는 나머지 자료 확인과 `SKILL.md`의 완료 조건이 필요하다.
