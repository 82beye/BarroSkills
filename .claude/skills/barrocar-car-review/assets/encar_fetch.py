#!/usr/bin/env python3
"""엔카 매물 데이터 수집 도구. 사용법은 references/encar-data.md 참고.

  python encar_fetch.py dossier 42537270          단일 매물 서류 4종
  python encar_fetch.py screen 42537270 41776883  여러 매물 게이트 스크리닝
  python encar_fetch.py search '<쿼리>' [정렬]     매물 검색 (200건 상한)
  python encar_fetch.py bands '<쿼리템플릿>' 0 6000  지정 가격 범위 수집 (만원)
                                                  %s 자리에 range가 들어간다
"""
import json
import re
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
API = "https://api.encar.com/v1/readside"

# 서식상 외판 분류. 2랭크는 수리 방식 확인 전까지 자동 통과시키지 않는다.
OUTER_PANELS = {
    "후드", "프론트 휀더", "프론트휀더", "프론트 펜더", "프론트펜더",
    "도어", "프론트 도어", "프론트도어", "리어 도어", "리어도어",
    "트렁크 리드", "트렁크리드", "라디에이터 서포트", "라디에이터서포트",
    "쿼터 패널", "쿼터패널", "루프 패널", "루프패널", "사이드실 패널", "사이드실패널",
}
BAD_STATUS = {"불량", "누유", "미세누유", "누수", "미세누수", "부족"}
RANK_TWO = {"쿼터패널", "루프패널", "사이드실패널", "리어펜더", "리어휀더"}
FRAME_PANELS = {
    "프론트패널", "크로스멤버", "인사이드패널", "사이드멤버", "프론트사이드멤버",
    "리어사이드멤버", "휠하우스", "프론트휠하우스", "리어휠하우스", "필러패널",
    "필러패널A", "필러패널B", "필러패널C", "대쉬패널", "플로어패널",
    "트렁크플로어", "리어패널", "패키지트레이",
}


def _curl(url, timeout=30, headers=None):
    cmd = ["curl", "--fail", "-sSL", "--compressed", "--max-time", str(timeout),
           "-H", f"User-Agent: {UA}",
           "-H", "Referer: https://fem.encar.com/",
           "-H", "Accept-Language: ko-KR,ko;q=0.9"]
    for h in headers or []:
        cmd += ["-H", h]
    return subprocess.run(cmd + [url], capture_output=True, text=True, check=True).stdout


def _json(url):
    data = json.loads(_curl(url))
    if not isinstance(data, dict):
        raise ValueError("JSON 객체가 아닌 응답")
    return data


def _part_name(name):
    name = re.sub(r"\((?:좌|우|전|후|볼트체결부품|볼트 체결식)\)", "", name or "")
    return re.sub(r"[\s()]", "", name)


def is_outer(part_name):
    """서식상 외판인지 확인한다. 빈 이름·부분 문자열은 일치시키지 않는다."""
    return bool(part_name) and _part_name(part_name) in {
        _part_name(p) for p in OUTER_PANELS
    } | RANK_TWO


def _number(value):
    """API의 비음수 정수/숫자 문자열. 누락·잘못된 값은 0과 구분한다."""
    if isinstance(value, bool) or value is None:
        return None
    s = str(value).replace(",", "")
    return int(s) if re.fullmatch(r"\d+", s) else None


def dossier(ad_id):
    """광고ID 하나로 서류 4종을 모은다. 차량ID 해석까지 처리한다."""
    if not re.fullmatch(r"\d+", str(ad_id)):
        raise ValueError("광고ID는 숫자여야 합니다")
    d = {"ad_id": str(ad_id), "vehicle_id": None, "vehicle": None,
         "record": None, "inspection": None, "diagnosis": None,
         "fetched_at": datetime.now(timezone.utc).isoformat(), "sources": {}, "errors": {}}

    def fetch(key, url):
        d["sources"][key] = url
        try:
            d[key] = _json(url)
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            d["errors"][key] = str(exc)

    fetch("vehicle", f"{API}/vehicle/{ad_id}")
    v = d["vehicle"] or {}
    vid = _number(v.get("vehicleId"))
    if not vid or not all(isinstance(v.get(k), dict) for k in ("category", "spec", "advertisement")):
        d["errors"].setdefault("vehicle", "기본정보/차량ID 누락 — 광고ID로 대체하지 않음")
        return d
    d["vehicle_id"] = vid
    for key in ("record", "inspection", "diagnosis"):
        suffix = "/open" if key == "record" else ""
        fetch(key, f"{API}/{key}/vehicle/{vid}{suffix}")
    return d


def screen(ad_id, label=""):
    """하드 게이트 F1·F2·F5 와 S1·S5·S6 을 판정해 dict 로 돌려준다.

    F3(현가·구동계)와 F4(사고 후 주행)는 국토부 정비이력이 있어야 확정되므로
    여기서는 판정하지 않는다. 의견서에는 반드시 [미확인]/[추정] 으로 남긴다.
    """
    d = dossier(ad_id)
    if not d or not d.get("vehicle_id") or not d.get("vehicle"):
        return {"ad_id": str(ad_id), "label": label, "error": "매물 조회 실패",
                "errors": (d or {}).get("errors", {})}
    v, rec, ins, dia = d["vehicle"], d["record"], d["inspection"], d["diagnosis"]
    ca, sp, ad = v.get("category") or {}, v.get("spec") or {}, v.get("advertisement") or {}
    det = ((ins or {}).get("master") or {}).get("detail") or {}
    ins_ok = bool(det.get("recordNo") and det.get("issueDate")) and all(
        isinstance(x, list) for x in (det.get("seriousTypes"), (ins or {}).get("outers")))
    rec_ok = (rec or {}).get("openData") is True and isinstance((rec or {}).get("accidents"), list)
    frame_hits, outer_repairs, review_parts = [], [], []
    special_history = ([(t or {}).get("title") or "내용 미확인" for t in det["seriousTypes"]]
                       if ins_ok else None)
    if ins_ok:
        if special_history:
            review_parts.append("특별이력 추가 확인 필요 — 골격 손상 목록과 별도")
        for part in ins["outers"]:
            name = (part.get("type") or {}).get("title") or "부위명 미확인"
            normalized = _part_name(name)
            ranks = set(part.get("attributes") or [])
            codes = {s.get("code") for s in part.get("statusTypes") or []}
            repair = bool(codes & {"X", "W"})
            if (ranks & {"RANK_A", "RANK_B", "RANK_C"} or normalized in FRAME_PANELS) and repair:
                frame_hits.append(name)
            elif "RANK_TWO" in ranks or normalized in RANK_TWO:
                review_parts.append(name + " — 절단·용접 여부 확인 필요")
            elif ("RANK_ONE" in ranks or is_outer(name)) and repair:
                outer_repairs.append({"part": name, "status": sorted(codes)})
            else:
                review_parts.append(name + " — 부위/상태 확인 필요")
        if (ins.get("master") or {}).get("accdient") is True and not frame_hits:
            review_parts.append("사고이력 있음 — 상세 부위·수리 방식 대조 필요")

    accidents = []
    for a in ((rec or {}).get("accidents") or []) if rec_ok else []:
        costs = [_number(a.get(k)) for k in ("partCost", "laborCost", "paintingCost")]
        total = sum(costs) if None not in costs else None
        benefit = _number(a.get("insuranceBenefit"))
        kind = {"1": "내차", "2": "내차", "3": "타차"}.get(str(a.get("type")), "미확인")
        accidents.append({"type": a.get("type"), "kind": kind, "date": a.get("date"),
                          "total": total, "part": costs[0], "labor": costs[1], "paint": costs[2],
                          "benefit": benefit,
                          "detail_available": total is not None and not (total == 0 and benefit != 0)})
    totals, matches, counts = {}, {}, {}
    for kind, prefix in (("내차", "my"), ("타차", "other")):
        rows = [a for a in accidents if a["kind"] == kind]
        expected_count = _number((rec or {}).get(prefix + "AccidentCnt"))
        expected_cost = _number((rec or {}).get(prefix + "AccidentCost"))
        known = rec_ok and expected_count is not None and expected_cost is not None and all(
            a["total"] is not None for a in rows) and all(a["kind"] != "미확인" for a in accidents)
        totals[kind] = sum(a["total"] for a in rows) if known else None
        counts[kind] = len(rows) == expected_count if known else None
        matches[kind] = totals[kind] == expected_cost if known else None
    details_ok = rec_ok and all(matches[k] is True and counts[k] is True for k in matches) and all(
        a["detail_available"] and a["date"] for a in accidents)
    no_join_keys = [f"notJoinDate{i}" for i in range(1, 6)]
    no_join = [rec[k] for k in no_join_keys if rec[k]] if rec_ok and all(k in rec for k in no_join_keys) else None
    usage = [_number((rec or {}).get(k)) for k in ("loan", "business", "government")]
    usage_ok = (False if any(n is not None and n > 0 for n in usage)
                else True if None not in usage else None) if rec_ok else None
    hidden = (rec or {}).get("openData") is False or (
        ((v.get("condition") or {}).get("accident") or {}).get("recordView") is False)

    bad_inner = []

    def _scan(node, sec):
        if (node.get("statusType") or {}).get("title") in BAD_STATUS:
            bad_inner.append(f"{sec}>{(node.get('type') or {}).get('title') or '항목 미확인'}")
        for c in node.get("children") or []:
            _scan(c, sec)
    for grp in (ins or {}).get("inners") or []:
        for c in grp.get("children") or []:
            _scan(c, (grp.get("type") or {}).get("title", ""))

    return {
        "ad_id": str(ad_id), "vehicle_id": d["vehicle_id"], "label": label,
        "car_no": v.get("vehicleNo"), "vin": v.get("vin"),
        "grade": ca.get("gradeName"), "year_month": ca.get("yearMonth"),
        "origin_price": ca.get("originPrice"), "price": ad.get("price"),
        "mileage": sp.get("mileage"), "fuel": sp.get("fuelName"),
        "fetched_at": d.get("fetched_at"), "sources": d.get("sources", {}), "errors": d.get("errors", {}),
        "F1_docs": False if hidden else True if ins_ok and details_ok else None,
        "F1_detail": {"record": rec_ok, "inspection": ins_ok, "accident_details": details_ok},
        "F2_frame_ok": False if frame_hits else True if ins_ok and not review_parts else None,
        "F2_frame_hits": frame_hits,
        "F2_outer_repairs": outer_repairs, "F2_review_parts": review_parts,
        "F2_outer_swaps": [p["part"] for p in outer_repairs if "X" in p["status"]],
        "special_history": special_history,
        "F3_drivetrain_ok": None, "F4_post_repair_ok": None,
        "F5_usage_ok": usage_ok,
        "S1_owner_changes": _number((rec or {}).get("ownerChangeCnt")) if rec_ok else None,
        "S5_no_join": no_join,
        "S6_recall": det.get("recall") if ins_ok and isinstance(det.get("recall"), bool) else None,
        "S6_recall_done": [(t or {}).get("title") for t in det.get("recallFullFillTypes") or []],
        "accidents": accidents,
        "my_accident_cnt": (rec or {}).get("myAccidentCnt"),
        "my_accident_cost": (rec or {}).get("myAccidentCost"),
        "other_accident_cnt": (rec or {}).get("otherAccidentCnt"),
        "sum_matches": matches["내차"], "other_sum_matches": matches["타차"],
        "accident_count_matches": counts, "accident_totals": totals,
        "inner_faults": bad_inner if ins_ok and isinstance(ins.get("inners"), list) else None,
        "inspection_comments": det.get("comments"),
        "diagnosis": bool((dia or {}).get("vehicleId") and (dia or {}).get("items")),
    }


def search(action, sort="PriceAsc", page=1):
    """목록 페이지 __NEXT_DATA__ 파싱. (전체건수, 매물배열) 을 돌려준다. 최대 200건."""
    q = urllib.parse.quote(json.dumps(
        {"type": "car", "action": action, "toggle": {}, "layer": "", "sort": sort},
        ensure_ascii=False))
    html = _curl(f"https://car.encar.com/list/car?page={page}&search={q}", timeout=40)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json"[^>]*>(.*?)</script>',
                  html, re.S)
    if not m:
        raise ValueError("엔카 검색 데이터 없음 — 접근 실패를 검색 0건으로 처리하지 않음")
    qs = json.loads(m.group(1))["props"]["pageProps"]["initialState"]["ryvussApi"]["queries"]
    keys = [k for k in qs if k.startswith("getCarNormal")]
    if not keys or "data" not in qs[keys[0]]:
        raise ValueError("엔카 검색 응답 구조 변경 또는 조회 실패")
    node = qs[keys[0]]["data"]
    count, rows = _number(node.get("Count")), node.get("SearchResults")
    if count is None or not isinstance(rows, list):
        raise ValueError("엔카 Count/SearchResults 누락")
    return count, rows


def search_bands(template, bands=None, sort="PriceDesc", verbose=True):
    """지정된 정수 가격 구간만 수집. 포화 구간은 분할, 분할 불가면 실패한다."""
    if not bands or template.count("%s") != 1:
        raise ValueError("%s 1개인 쿼리와 명시적 bands=[(최저만원, 최고만원)]가 필요합니다")
    if any(type(lo) is not int or type(hi) is not int or not 0 <= lo <= hi for lo, hi in bands):
        raise ValueError("가격 범위는 0 이상 정수이며 최저 <= 최고여야 합니다")
    out = {}
    pending = list(bands)
    while pending:
        lo, hi = pending.pop(0)
        rng = f"{lo}..{hi}" if lo else f"..{hi}"
        c, r = search(template % rng, sort)
        if c > len({str(x["Id"]) for x in r}):
            if lo == hi:
                raise ValueError(f"{lo}만원 구간 {len(r)}/{c}건 — 수집 불완전, 추가 필터 필요")
            mid = (lo + hi) // 2
            pending[:0] = [(lo, mid), (mid + 1, hi)]
            continue
        for x in r:
            out[str(x["Id"])] = x
        if verbose:
            print(f"  {lo:>4}~{hi:<4} Count={c:<5} 수집={len(r):<4} 누적={len(out)}",
                  file=sys.stderr)
    return list(out.values())


def dedup_map(rows, drop_lease=True):
    """중복 광고를 제거하되 (남긴 매물, 병행광고지도) 를 함께 돌려준다.

    병행광고지도는 {남긴 광고ID: [같은 차의 다른 광고ID, ...]} 형태다.
    사용자는 엔카에서 어느 쪽 번호든 만날 수 있으므로 **버리지 말고 의견서에 싣는다.**
    """
    keep, out, dups, ad_ids = {}, [], {}, set()
    for x in rows:
        if drop_lease and x.get("SellType") in ("리스", "렌트"):
            continue
        ad_id = str(x["Id"])
        if ad_id in ad_ids:
            continue
        ad_ids.add(ad_id)
        vin = str(x.get("vin") or x.get("Vin") or "").strip().upper()
        vid = x.get("vehicleId") or x.get("VehicleId") or x.get("vehicle_id")
        plate = re.sub(r"\s", "", x.get("vehicleNo") or x.get("VehicleNo") or "")
        key = (("vin", vin) if re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", vin)
               else ("vehicle", str(vid)) if _number(vid)
               else ("plate", plate) if re.fullmatch(r"\d{2,3}[가-힣]\d{4}", plate) else None)
        if key is not None and key in keep:
            dups.setdefault(keep[key], []).append(ad_id)
            continue
        if key is not None:
            keep[key] = ad_id
        out.append(x)
    return out, dups


def dedup(rows, drop_lease=True):
    """같은 차의 중복 광고를 제거한다. 리스·렌트도 기본으로 뺀다.

    제거된 광고ID가 필요하면 dedup_map() 을 쓴다.
    """
    return dedup_map(rows, drop_lease)[0]


def _n(v, unit=""):
    """None 안전 숫자 포맷. 값이 없으면 물음표를 돌려준다."""
    return f"{v:,}{unit}" if isinstance(v, (int, float)) else f"?{unit}"


def _fmt(s):
    if s.get("error"):
        return f"{s['ad_id']} {s['label']}: {s['error']}"
    ym = str(s["year_month"] or "")
    status = lambda value: "통과" if value is True else "★탈락" if value is False else "보류 [미확인]"
    L = [f"■ {s['label'] or s['grade']}  광고{s['ad_id']} / 차량{s['vehicle_id']} / {s['car_no']}",
         f"  {s['grade']} | {ym[:4]}.{ym[4:]}등록 | {_n(s['mileage'],'km')} | {_n(s['price'],'만원')}"
         f" | 신차가 {_n(s['origin_price'],'만원')}",
         f"  F1 서류   : {status(s['F1_docs'])}  {s['F1_detail']}",
         f"  F2 골격   : {status(s['F2_frame_ok'])}  손상={s['F2_frame_hits']} 확인={s['F2_review_parts']}",
         f"  외판 수리 : {s['F2_outer_repairs']} (X 교환 / W 판금·용접)",
         f"  특별이력  : {s['special_history'] if s['special_history'] is not None else '[미확인]'}",
         "  F3 / F4   : 보류 [미확인] — 정비이력·사고 당시 주행거리 필요",
         f"  F5 용도   : {status(s['F5_usage_ok'])}",
         f"  S1 소유   : 변경 {s['S1_owner_changes']}회",
         f"  S5 자차공백: {s['S5_no_join'] if s['S5_no_join'] is not None else '[미확인]'}",
         f"  S6 리콜   : {('대상-' + str(s['S6_recall_done'])) if s['S6_recall'] is True else '기록상 대상아님' if s['S6_recall'] is False else '[미확인]'}",
         f"  사고      : 내차 {s['my_accident_cnt']}건 {_n(s['my_accident_cost'],'원')}"
         f" / 타차가해 {s['other_accident_cnt']}건  (건별합계 일치: {s['sum_matches']})"]
    for a in s["accidents"]:
        t = a["total"]
        ratios = (f"부품 {a['part']/t*100:.0f}% 공임 {a['labor']/t*100:.0f}% 도장 {a['paint']/t*100:.0f}%"
                  if t and a["detail_available"] else "세부 금액 [미확인]")
        L.append(f"    · {a['kind']} {a['date']} 수리비 {_n(t, '원')} → {ratios}")
    if s["inner_faults"]:
        L.append(f"  성능점검 이상: {s['inner_faults']}")
    return "\n".join(L)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "dossier":
        data = dossier(sys.argv[2])
        print(json.dumps(data, ensure_ascii=False, indent=1))
        sys.exit(1 if data["errors"] else 0)
    elif cmd == "screen":
        if len(sys.argv) < 3:
            sys.exit("screen에는 광고ID가 1개 이상 필요합니다")
        failed = False
        for a in sys.argv[2:]:
            result = screen(a)
            failed |= bool(result.get("error") or result.get("errors"))
            print(_fmt(result), "\n" + "=" * 74)
        sys.exit(1 if failed else 0)
    elif cmd == "search":
        c, r = search(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "PriceAsc")
        print(f"Count={c} returned={len(r)}", file=sys.stderr)
        print(json.dumps(r, ensure_ascii=False))
    elif cmd == "bands":
        if len(sys.argv) != 5:
            sys.exit("사용법: encar_fetch.py bands '<쿼리 %s>' 최저만원 최고만원")
        rows, dups = dedup_map(search_bands(sys.argv[2], [(int(sys.argv[3]), int(sys.argv[4]))]))
        print(f"중복·리스 제거 후 {len(rows)}대", file=sys.stderr)
        for k, v in dups.items():
            print(f"  병행광고 {k} = {' = '.join(v)}", file=sys.stderr)
        print(json.dumps({"rows": rows, "dups": dups}, ensure_ascii=False))
    else:
        print(__doc__)
