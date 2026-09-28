#!/usr/bin/env python3
"""엔카 밖의 매물 플랫폼 수집기. 엔카는 encar_fetch.py 를 그대로 쓴다.

  python platform_fetch.py kb  107 1911 [페이지수]   KB차차차 (제조사코드 모델코드)
  python platform_fetch.py kbcode BMW X5             KB차차차 코드 조회
  python platform_fetch.py kcar X5                   케이카 마켓 검색어 조회

이 수집기의 KB·케이카 레코드는 다음 스키마다. 엔카 원본은 별도 스키마다.
  {platform, id, url, name, year, mileage, price, fuel, seats, region, raw}

**커버리지 한계를 의견서에 반드시 밝힌다.**
- KB차차차  : 지정 페이지 내 수집. 종료 확인 없이 전체라고 부르지 않는다.
- 케이카    : **마켓(안심직거래) 목록 한 페이지.** 직영 재고는 이 코드의 수집 대상이 아니다.
"""
import json, re, subprocess, sys, base64
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urlencode

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def _curl(url, headers=None, post=None, timeout=40):
    cmd = ["curl", "--fail", "-sSL", "--compressed", "--max-time", str(timeout), "-H", f"User-Agent: {UA}"]
    for h in headers or []:
        cmd += ["-H", h]
    if post is not None:
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", post]
    return subprocess.run(cmd + [url], capture_output=True, text=True, check=True).stdout


# ─────────────────────────── KB차차차 ───────────────────────────
KB = "https://www.kbchachacha.com"
KB_REF = f"Referer: {KB}/public/search/main.kbc"


def kb_codes():
    """(제조사표, 모델표) 를 돌려준다. makerCode·classCode 를 여기서 찾는다."""
    mk = json.loads(_curl(f"{KB}/public/search/carMaker.json", [KB_REF]))
    cl = json.loads(_curl(f"{KB}/public/search/carClass.json", [KB_REF]))
    if not all(isinstance(x, dict) and isinstance(x.get("result"), (dict, list)) and x["result"] for x in (mk, cl)):
        raise ValueError("KB 제조사/모델 코드 응답 누락")
    return mk["result"], cl["result"]


def kb_find(maker_name, class_name):
    """이름으로 (makerCode, classCode, className) 조회. 복수 일치는 명시한다."""
    def walk(node):
        if isinstance(node, dict):
            yield node
            for value in node.values():
                yield from walk(value)
        elif isinstance(node, list):
            for value in node:
                yield from walk(value)
    matches = {(str(x["makerCode"]), str(x["classCode"]), x["className"])
               for x in walk(kb_codes()[1]) if x.get("makerName") == maker_name
               and class_name in x.get("className", "") and x.get("makerCode") and x.get("classCode")}
    exact = {x for x in matches if x[2] == class_name}
    matches = exact or matches
    if len(matches) > 1:
        raise ValueError(f"모델명 복수 일치 — 정확한 이름 필요: {sorted(matches)}")
    return next(iter(matches), (None, None, None))


def kb_page(maker_code, class_code, page=1, sort="-orderDate"):
    """목록 한 페이지(40대). 검색 결과는 list.empty 가 조각 HTML 로 돌려준다."""
    url = f"{KB}/public/search/list.empty?" + urlencode(
        {"makerCode": maker_code, "classCode": class_code, "page": page, "sort": sort})
    return _curl(url, [KB_REF])


class _Cards(HTMLParser):
    """중첩 div 수를 세어 카드 경계를 보존한다."""
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.depth, self.current, self.cards, self.root_tag = 0, [], [], None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.depth and tag == self.root_tag:
            self.depth += 1
        elif not self.depth and (tag == "li" or (tag == "div" and "item" in attrs.get("class", "").split())
                                 or (tag == "a" and "carSeq=" in attrs.get("href", ""))):
            self.root_tag, self.depth = tag, 1
        if self.depth:
            self.current.append(self.get_starttag_text())

    def handle_endtag(self, tag):
        if self.depth:
            self.current.append(f"</{tag}>")
            if tag == self.root_tag:
                self.depth -= 1
                if not self.depth:
                    self.cards.append("".join(self.current)); self.current = []

    def handle_data(self, data):
        if self.depth:
            self.current.append(data)

    def handle_entityref(self, name):
        self.handle_data(f"&{name};")

    def handle_charref(self, name):
        self.handle_data(f"&#{name};")


def _integer(value):
    if value is None or value == "":
        return None
    s = str(value).replace(",", "").removesuffix("만원").strip()
    if not re.fullmatch(r"\d+", s):
        raise ValueError(f"숫자 형식 확인 필요: {value!r}")
    return int(s)


def kb_parse(html):
    """카드 HTML 을 정규화 레코드로. 가격·연식·주행은 data-ga4 와 본문에서 뽑는다."""
    out, seen = [], set()
    parser = _Cards(); parser.feed(html)
    if parser.depth:
        raise ValueError("KB 카드 HTML이 잘렸습니다")
    for blk in parser.cards:
        link = re.search(r'carSeq=(\d+)', blk)
        m = link or re.search(r'data-car-seq="(\d+)"', blk)
        if not m or m.group(1) in seen:
            continue
        cid = m.group(1); seen.add(cid)
        ga = re.search(r"data-ga4='(\{.*?\})'", blk, re.S)
        name = price = None
        if ga:
            try:
                p = json.loads(unescape(ga.group(1)))["params"]
                name = p.get("vehicle_info")
                price = p.get("vehicle_price")
            except (ValueError, KeyError, TypeError):
                raise ValueError("KB 카드 가격/차명 데이터 파싱 실패")
        if not name:
            t = re.search(r'<(?:strong class="tit"|span class="title")>\s*(.*?)\s*</(?:strong|span)>', blk, re.S)
            name = re.sub(r'\s+', ' ', t.group(1)).strip() if t else None
        if price is None:
            p = re.search(r'<span class="consultation">([^<]+)</span>', blk)
            price = p.group(1).strip() if p else None
        line = re.findall(r'<span(?:\s[^>]*)?>([^<]+)</span>', blk)
        ym = mil = region = None
        for v in line:
            v = v.strip()
            if re.match(r'^\d{2}/\d{2}식', v):
                yy, mm = re.match(r'^(\d{2})/(\d{2})', v).groups()
                year = 2000 + int(yy)
                if year > datetime.now().year + 1:
                    year -= 100
                ym = f"{year}{mm}" if 1 <= int(mm) <= 12 else None
            elif v.endswith("km"):
                mil = _integer(v.removesuffix("km").strip())
            elif v in {"서울", "경기", "인천", "부산", "대구", "광주", "대전", "울산", "세종",
                       "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"}:
                region = v
        sell_type = "리스" if "리스" in str(price) else "렌트" if "렌트" in str(price) else "현금"
        pr = None if sell_type != "현금" or "상담" in str(price) else _integer(price)
        out.append({"platform": "KB차차차", "id": cid,
                    "url": f"{KB}/public/car/detail.kbc?carSeq={cid}",
                    "name": name, "year": ym, "mileage": mil, "price": pr,
                    "fuel": None, "seats": None, "region": region,
                    "sell_type": sell_type, "listing_status": "상세 링크 제공" if link else "광고대기",
                    "raw": {"price_label": price}})
    if not out and "입력하신 정보에 맞는 차량이 없습니다" not in html:
        raise ValueError("KB 검색 결과 확인 불가 — 파싱/접근 실패를 0건으로 처리하지 않음")
    if seen != set(re.findall(r'carSeq=(\d+)', html)) | set(re.findall(r'data-car-seq="(\d+)"', html)):
        raise ValueError("KB 카드 일부 누락 — HTML 구조 확인 필요")
    return out


def kb_collect(maker_code, class_code, pages=100, sort="-orderDate", verbose=True):
    """빈 결과 페이지로 종료를 확인한다. 반복 페이지·상한 도달은 실패 처리한다."""
    if pages < 1:
        raise ValueError("페이지 상한은 1 이상이어야 합니다")
    got, all_rows = set(), []
    for p in range(1, pages + 1):
        rows = kb_parse(kb_page(maker_code, class_code, p, sort))
        new = [r for r in rows if r["id"] not in got]
        for r in new:
            got.add(r["id"]); all_rows.append(r)
        if verbose:
            print(f"  KB page {p:>2}: 신규 {len(new):>2} 누적 {len(all_rows)}", file=sys.stderr)
        if not rows:
            return all_rows
        if not new:
            raise ValueError(f"KB {p}페이지 반복 응답 — 수집 완료 여부 미확인")
    raise ValueError(f"KB 페이지 상한 {pages} 도달 ({len(all_rows)}대 수집) — pages를 늘려 종료 확인 필요")


# ─────────────────────────── 케이카 (마켓) ───────────────────────────
# 요청 파라미터를 AES-128-CBC 로 감싸 보낸다. 키·IV 는 공개 번들에 하드코딩된 값이고
# 공개 웹 클라이언트의 요청 형식이다. 현재 이용 조건과 접근 제한을 확인하고 목록만 조회한다.
KCAR_API = "https://market-api.kcar.com"
_K, _IV = b"SKFJ2424DasfaJRI", b"sfq241sf3dscs321"


def _kcar_enc(obj):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding
    raw = json.dumps({k: v for k, v in obj.items() if v is not None and v != ""}, ensure_ascii=False,
                     separators=(",", ":")).encode()
    pad = padding.PKCS7(128).padder()
    data = pad.update(raw) + pad.finalize()
    enc = Cipher(algorithms.AES(_K), modes.CBC(_IV)).encryptor()
    return base64.b64encode(enc.update(data) + enc.finalize()).decode()


def kcar_post(path, cond):
    body = json.dumps({"enc": _kcar_enc(cond)})
    r = _curl(f"{KCAR_API}{path}",
              ["Origin: https://www.kcar.com", "Referer: https://www.kcar.com/"], post=body)
    data = json.loads(r)
    if not isinstance(data, dict) or data.get("data") is None:
        raise ValueError("케이카 응답 오류/data 누락")
    return data


def kcar_makers():
    """제조사 코드표. 현대 001 · BMW 012 · 벤츠 013."""
    return kcar_post("/api/v1/ds/getMnuftrListCount", {"wr_eq_sell_dcd": "ALL"}).get("data") or []


def kcar_search(keyword=None, maker_cd=None, price_lt=None, price_gt=None, size=100):
    """케이카 마켓 한 페이지 검색. (전체 표기건수, 실제 수집 목록) 반환.

    wr_txt_idx 검색어 · wr_eq_mnuftr_cd 제조사 · wr_gt_prc/wr_lt_prc 가격(만원)
    wr_gt_milg/wr_lt_milg 주행 · wr_gt_mfg_dt/wr_lt_mfg_dt 연식 · wr_in_pasngr_cnt 정원
    """
    cond = {"wr_eq_sell_dcd": "ALL", "index": 1, "pageSize": size}
    if keyword:  cond["wr_txt_idx"] = keyword
    if maker_cd: cond["wr_eq_mnuftr_cd"] = maker_cd
    if price_gt is not None: cond["wr_gt_prc"] = price_gt
    if price_lt is not None: cond["wr_lt_prc"] = price_lt
    d = kcar_post("/api/v1/ds/carSearchListCount", cond).get("data")
    if not isinstance(d, dict) or _integer(d.get("totalCnt")) is None or not isinstance(d.get("rows"), list):
        raise ValueError("케이카 totalCnt/rows 누락 — 검색 0건과 구분")
    out = []
    for x in d["rows"]:
        if not re.fullmatch(r"CC\d+", str(x.get("ccCarId"))):
            raise ValueError("케이카 마켓 매물ID 형식 변경")
        fd = str(x.get("fstRegDt") or "")
        out.append({"platform": "케이카", "id": x.get("ccCarId"),
                    "url": f"https://market.kcar.com/ds/detail/adInfoDtl/{x['ccCarId']}",
                    "name": (x.get("carWhlNm") or "").strip(),
                    "year": fd[:6] or None,
                    "mileage": _integer(x.get("milg")),
                    "price": _integer(x.get("salprc")),
                    "fuel": x.get("fuelNm"),
                    "seats": _integer(x.get("pasngrCnt")) or None,
                    "region": (x.get("sidosigungu") or "").split("|")[-1],
                    "raw": {"optn": x.get("optnNm"), "grd": x.get("grdNm"),
                            "cno": x.get("cno"), "wrnty": x.get("wrntyYn")}})
    return _integer(d["totalCnt"]), out


def show(rows):
    for r in sorted(rows, key=lambda x: x.get("price") if x.get("price") is not None else float("inf")):
        mileage = f"{r['mileage']:,}" if r.get("mileage") is not None else "?"
        print(f"  [{r['platform']:<7}] {str(r['price']):>5}만 {r.get('year') or '??????'} "
              f"{mileage:>8}km {str(r.get('seats') or '?'):>2}인 "
              f"{(r.get('name') or '')[:46]:<46} {r.get('listing_status', '')} {r['url']}")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(0)
    if a[0] == "kbcode":
        mk, cl, nm = kb_find(a[1], a[2])
        if mk is None:
            sys.exit("제조사/모델 일치 결과 없음")
        print(f"makerCode={mk} classCode={cl} className={nm}")
    elif a[0] == "kb":
        rows = kb_collect(a[1], a[2], int(a[3]) if len(a) > 3 else 100)
        show(rows); print(f"\n총 {len(rows)}대")
    elif a[0] == "kcar":
        n, rows = kcar_search(keyword=a[1])
        show(rows); print(f"\n케이카 마켓 수집 {len(rows)}/{n}대 (목록 한 페이지, 직영 재고 미조회)")
