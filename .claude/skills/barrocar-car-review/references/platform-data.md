# KB차차차·케이카 수집과 플랫폼 대조

`assets/platform_fetch.py`를 사용한다. Python 3·curl이 필요하며 **케이카 요청에만 cryptography**가 필요하다. KB·케이카 반환 스키마는 `{platform, id, url, name, year, mileage, price, fuel, seats, region, raw}`이며, KB는 `sell_type`과 `listing_status`도 반환한다. 엔카 수집기는 별도 원본 스키마이므로 필드를 명시적으로 매핑한다.

## 실제 지원 범위

| 플랫폼 | 이 스킬의 수집 범위 | 완료 판단 |
|---|---|---|
| 엔카 | 지정 쿼리·가격 범위의 목록과 조회 가능한 개별 서류 | 분할한 각 범위 Count 대조. 누락·조회 실패 공시 |
| KB차차차 | 지정 제조사·모델의 목록 | 실제 빈 결과 페이지 확인. 페이지 상한·반복 응답은 미완료 |
| 케이카 | **마켓(안심직거래) 검색 한 페이지** | 표기 전체 수와 실제 수집 수 병기. 직영 재고는 미조회 |

2026-09-13 표본으로 각 경로의 응답을 확인했다. 과거 X5/GLE의 수집 대수·최저가·플랫폼 우열은 현재의 보편적 사실이 아니다. 과거 수집 원문·쿼리·시각이 없는 수치를 재사용하지 않는다. 직영 재고 수집 기능이 이 코드에 없다는 사실을 «공식 API가 존재하지 않음» 또는 «어떤 방법으로도 수집 불가»로 확대하지 않는다.

## KB차차차

```bash
python3 assets/platform_fetch.py kbcode BMW X5
python3 assets/platform_fetch.py kb 107 1911
```

| 자료 | 경로 (`https://www.kbchachacha.com`) |
|---|---|
| 제조사 코드 | `/public/search/carMaker.json` |
| 모델 코드 | `/public/search/carClass.json` |
| 목록 | `/public/search/list.empty?makerCode=&classCode=&page=&sort=-orderDate` |
| 상세 링크 | `/public/car/detail.kbc?carSeq={id}` |

curl은 `--compressed`로 전송 압축을 해제하고 HTTP 실패를 감지한다. Referer는 `/public/search/main.kbc`다. gzip 제공 여부는 서버에 따라 달라질 수 있다.

일반 카드·간편정보·광고대기 목록을 읽고, `listing_status`를 구분한다. 광고대기는 실제 판매 가능 여부 미확인이므로 가격 비교·적격 후보에서 제외한다. 카드의 `data-ga4` JSON과 본문에서 값을 읽는다. 중첩 div 경계를 보존한다. **«리스승계 101만원»은 차량가 101만원이 아니다.** 리스·렌트는 `sell_type`과 원문 `price_label`을 보존하고 price를 None으로 둔다. 시세 비교에서 제외한다. 누락 가격·주행도 0으로 채우지 않는다.

기본 페이지 상한은 100이다. 상한에 걸리면 더 큰 값을 명시해야 하며, 오류 상태에서 «KB 전수 수집 완료»라고 보고하지 않는다. 반복 페이지도 종료 증거가 아니다. 빈 결과 문구와 파싱 실패를 구분한다.

모델 코드는 고정 예시를 맹신하지 말고 `kbcode`로 확인한다. X5 코드처럼 여러 세대를 포함하는 경우 세대·트림을 따로 필터링한다. 제조사·모델명 JSON 키 순서에 의존하지 않는다. 가격·좌석·사용자 예산 조건이 서버에서 적용됐는지는 실제 행으로 검증한다.

## 케이카 마켓

```bash
python3 assets/platform_fetch.py kcar X5
```

목록 경로는 `https://market-api.kcar.com/api/v1/ds/carSearchListCount`다. POST 본문 `{"enc":"..."}`에 공개 웹 클라이언트 형식의 AES-128-CBC 인코딩을 사용한다. 키·IV나 경로가 바뀌면 오류를 남기며 응답 없이 성공으로 보고하지 않는다. cryptography를 찾지 못하면 케이카 미조회로 기록한다.

`wr_txt_idx` 검색어, `wr_eq_mnuftr_cd` 제조사, `wr_gt_prc`/`wr_lt_prc` 가격(만원), index/pageSize를 사용한다. 응답 `data.totalCnt`와 `data.rows`를 확인한다. **현재 함수는 첫 페이지만 반환한다.** totalCnt보다 rows가 적으면 부분 수집이라고 표시한다. 다음 페이지 API는 이 코드에서 구현·검증하지 않았다.

`pasngrCnt`, `optnNm`, `cno` 등은 플랫폼 등록값이다. 공식 제원·실제 옵션·서류 일치 여부는 추가 확인한다.

마켓 상세 링크는 **`https://market.kcar.com/ds/detail/adInfoDtl/{ccCarId}`**다. 2026-09-13 마켓의 공개 라우터에서 확인했다. 직영 사이트의 `/bc/detail/carInfoDtl?i_sCarCd=`에 CC 마켓 ID를 넣지 않는다. 이 수집기는 상세를 조회하지 않는다.

## 원문 보관

KB의 `kb_page()` HTML, 케이카의 `kcar_post()` JSON을 파싱 전에 출처 폴더에 저장하고 요청 조건·시각을 함께 기록한다. CLI의 요약 표만 저장한 경우 원문 전체를 보관했다고 보고하지 않는다.

## 플랫폼 간 같은 차 확인

연식·주행거리 ±150km는 탐색용 힌트이며, 가격은 플랫폼마다 다를 수 있다. **동일 VIN 또는 전체 차량번호 등 강한 식별 근거를 확인한 후** 동일 차량으로 묶는다. 가린 번호·연식·주행만으로 확정하지 않는다. 실제 모델연도와 등록 연월도 구분한다.

- 확정된 동일 차량: 플랫폼·광고ID·호가·조회시각·동일성 근거를 나란히 쓴다.
- 식별 미확인: «동일 차량 후보 [추정]»로 남기며 중복 제거·동일차 가격 절감액에 사용하지 않는다.
- 다른 플랫폼에서 못 찾았음: «이번 조회에서 대조되지 않음»이지 플랫폼 독점 매물이라는 증거가 아니다.

KB·케이카 단독 매물의 서류는 이 수집기가 확보하지 못한다. 사용자가 제공한 원문이나 접근 가능한 자료가 있으면 동일 게이트를 적용하고, 없으면 F1 보류다. 엔카 링크가 있어야만 심사할 수 있다고 제한하지 않는다.
