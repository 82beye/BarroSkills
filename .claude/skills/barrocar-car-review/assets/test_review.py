#!/usr/bin/env python3
"""python3 assets/test_review.py — 합성 입력을 쓰는 네트워크 없는 회귀 검사."""
import base64
import copy
import json
import re
import subprocess
from unittest.mock import patch

import check_report
import encar_fetch as ef
import platform_fetch as pf


def raises(call):
    try:
        call()
    except (ValueError, subprocess.SubprocessError):
        return
    raise AssertionError("오류가 정상/0건으로 숨겨졌습니다")


def run():
    base = {"vehicle_id": 7, "vehicle": {"vehicleId": 7, "category": {}, "spec": {}, "advertisement": {}},
            "record": {"openData": True, "myAccidentCnt": 0, "myAccidentCost": 0,
                       "otherAccidentCnt": 0, "otherAccidentCost": 0, "accidents": [],
                       "loan": 0, "business": 0, "government": 0,
                       **{f"notJoinDate{i}": None for i in range(1, 6)}},
            "inspection": {"master": {"detail": {"recordNo": "test", "issueDate": "20260913",
                           "seriousTypes": [], "recall": False}}, "outers": [], "inners": []},
            "diagnosis": None}

    def screen(d):
        with patch.object(ef, "dossier", return_value=d):
            return ef.screen("1")

    d = copy.deepcopy(base); d.update(record=None, inspection=None)
    s = screen(d)
    assert all(s[k] is None for k in ("F1_docs", "F2_frame_ok", "F5_usage_ok", "S5_no_join", "S6_recall"))
    assert "대상아님" not in ef._fmt(s)
    s = screen(base)
    assert s["sum_matches"] is True and s["F1_docs"] is True
    assert s["F3_drivetrain_ok"] is None and s["F4_post_repair_ok"] is None
    d = copy.deepcopy(base); d["inspection"]["master"]["detail"]["recordNo"] = None
    assert screen(d)["F1_docs"] is None and screen(d)["F2_frame_ok"] is None

    d = copy.deepcopy(base)
    d["record"].update(myAccidentCnt=1, myAccidentCost=9, otherAccidentCnt=1, otherAccidentCost=6,
                       accidents=[{"type": kind, "date": "2026-01-01", "partCost": n, "laborCost": n,
                                   "paintingCost": n, "insuranceBenefit": 20} for kind, n in (("1", 3), ("3", 2))])
    s = screen(d)
    assert s["sum_matches"] is True and s["other_sum_matches"] is True
    assert s["accident_totals"] == {"내차": 9, "타차": 6}
    d["record"]["accidents"][0]["partCost"] = None
    assert screen(d)["sum_matches"] is None and screen(d)["F1_docs"] is None
    d["record"]["accidents"][0]["type"] = "unexpected"
    assert screen(d)["sum_matches"] is None
    d = copy.deepcopy(base); d["record"].update(loan="0", business="0", government="0")
    assert screen(d)["F5_usage_ok"] is True
    d["record"]["loan"] = None
    assert screen(d)["F5_usage_ok"] is None
    d["record"]["loan"] = "1"
    assert screen(d)["F5_usage_ok"] is False

    assert not any(ef.is_outer(x) for x in (None, "", "패널", "도어손잡이"))
    assert ef.is_outer("프론트 휀더(우)")
    d = copy.deepcopy(base)
    part = {"type": {"title": "트렁크 리드"}, "attributes": ["RANK_ONE"], "statusTypes": [{"code": "W"}]}
    d["inspection"]["outers"] = [part]
    assert screen(d)["F2_outer_repairs"] == [{"part": "트렁크 리드", "status": ["W"]}]
    assert screen(d)["F2_outer_swaps"] == []
    part.update(type={"title": "루프 패널"}, attributes=["RANK_TWO"])
    assert screen(d)["F2_frame_ok"] is None
    part.update(type={"title": "프론트 사이드 멤버(우)"}, attributes=["RANK_B"])
    assert screen(d)["F2_frame_ok"] is False
    part.update(type={"title": "알 수 없는 부위"}, attributes=[])
    assert screen(d)["F2_frame_ok"] is None
    d = copy.deepcopy(base)
    d["inspection"]["master"]["detail"]["seriousTypes"] = [{"title": "침수"}]
    s = screen(d)
    assert s["special_history"] == ["침수"] and s["F2_frame_hits"] == [] and s["F2_frame_ok"] is None
    d = copy.deepcopy(base); d["inspection"]["master"]["accdient"] = True
    assert screen(d)["F2_frame_ok"] is None

    with patch.object(ef, "_json", return_value={"category": {}}) as fetch:
        d = ef.dossier("1")
        assert d["vehicle_id"] is None and fetch.call_count == 1 and d["errors"]
    with patch.object(ef, "_json", side_effect=ValueError("bad response")):
        assert ef.dossier("1")["errors"]
    for module in (ef, pf):
        with patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(22, ["curl"])):
            raises(lambda module=module: module._curl("https://example.invalid/"))
    with patch.object(ef, "_curl", return_value="<html>access denied</html>"):
        raises(lambda: ef.search("query"))

    def search(query, sort):
        lo, hi = query.split("..")
        rows = [{"Id": str(n)} for n in range(int(lo or 0), int(hi) + 1)]
        return len(rows), rows[:2]
    with patch.object(ef, "search", side_effect=search):
        assert len(ef.search_bands("%s", [(0, 3)], verbose=False)) == 4
    with patch.object(ef, "search", return_value=(201, [{"Id": "1"}])):
        raises(lambda: ef.search_bands("%s", [(100, 100)], verbose=False))
    raises(lambda: ef.search_bands("%s"))
    rows = [{"Id": str(i), "Year": "202001", "Mileage": 50000, "Price": 3000} for i in range(2)]
    assert len(ef.dedup_map(rows)[0]) == 2
    for row in rows:
        row["VehicleId"] = 7
    assert ef.dedup_map(rows)[1] == {"0": ["1"]}
    rows[0]["vin"], rows[1]["vin"] = "A" * 17, "B" * 17
    assert len(ef.dedup_map(rows)[0]) == 2

    code = {"classCode": "1911", "makerCode": "107", "className": "X5", "makerName": "BMW"}
    with patch.object(pf, "kb_codes", return_value=({}, {"nested": [code]})):
        assert pf.kb_find("BMW", "X5") == ("107", "1911", "X5")
    def card(cid, price):
        ga = json.dumps({"params": {"vehicle_info": "BMW X5", "vehicle_price": price}})
        return f'''<div data-x="1" class="item"><a href="?carSeq={cid}" data-ga4='{ga}'><div><span>99/02식</span><span>10,000km</span></div></a></div>'''
    rows = pf.kb_parse(card(1, 3000) + card(2, "리스승계 101만원"))
    assert rows[0]["price"] == 3000 and rows[0]["year"] == "199902"
    assert rows[1]["price"] is None and rows[1]["sell_type"] == "리스"
    region_card = card(1, 3000).replace('</a>', '<span>경기</span><span class="blind">관심차</span></a>')
    assert pf.kb_parse(region_card)[0]["region"] == "경기"
    simple = card(3, 4000).replace('<div data-x="1" class="item">', '<li>').removesuffix('</div>') + '</li>'
    assert len(pf.kb_parse(card(1, 3000) + simple)) == 2
    waiting = '<li><span class="title">BMW X5</span><span>22/03식</span><span>20,000km</span><a data-car-seq="4">딜러</a><span class="consultation">가격상담</span></li>'
    waiting_row = pf.kb_parse(waiting)[0]
    assert waiting_row["id"] == "4" and waiting_row["listing_status"] == "광고대기" and waiting_row["price"] is None
    empty = "입력하신 정보에 맞는 차량이 없습니다"
    assert pf.kb_parse(empty) == []
    raises(lambda: pf.kb_parse("<html>access denied</html>"))
    with patch.object(pf, "kb_page", side_effect=[card(1, "3000만원"), empty]):
        assert len(pf.kb_collect("107", "1911", pages=2, verbose=False)) == 1
    with patch.object(pf, "kb_page", return_value=card(1, "3000만원")):
        raises(lambda: pf.kb_collect("107", "1911", pages=2, verbose=False))
        raises(lambda: pf.kb_collect("107", "1911", pages=1, verbose=False))
    with patch.object(pf, "kcar_post", return_value={"data": {"totalCnt": "2", "rows": [{"ccCarId": "CC00000001"}]}}):
        total, rows = pf.kcar_search("X5")
        assert total == 2 and len(rows) == 1 and rows[0]["price"] is None and rows[0]["mileage"] is None
        assert rows[0]["url"] == "https://market.kcar.com/ds/detail/adInfoDtl/CC00000001"
    with patch.object(pf, "kcar_post", return_value={}):
        raises(lambda: pf.kcar_search("X5"))
    with patch.object(pf, "_curl", return_value="<html>blocked</html>"):
        raises(lambda: pf.kcar_post("/list", {}))
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.primitives.padding import PKCS7
    except ImportError:
        print("SKIP 케이카 암호화 왕복: cryptography 미설치")
    else:
        encrypted = base64.b64decode(pf._kcar_enc({"zero": 0, "false": False, "empty": "", "none": None}))
        decryptor = Cipher(algorithms.AES(pf._K), modes.CBC(pf._IV)).decryptor()
        padded = decryptor.update(encrypted) + decryptor.finalize()
        unpadder = PKCS7(128).unpadder()
        assert json.loads(unpadder.update(padded) + unpadder.finalize()) == {"zero": 0, "false": False}

    stats = ''.join(f'<span data-count-grade="{g}">{1 if g == "기록" else 0}</span>' for g in check_report.GRADES)
    html = '<html><body><div class="trust">[기록]' + stats + '<b data-count-total>1</b></div>'
    html += ''.join(f'<div class="{c}"></div>' for c in ('verifybox', 'verdict', 'master', 'gradebar'))
    html += '<p>⑧ ⑩ [기록]</p><!-- [추정] --><style>/* [미확인] */</style></body></html>'
    assert check_report.check(html)["errors"] == []
    assert check_report.check(html)["total"] == 1
    assert check_report.check(html.replace('data-count-total>1', 'data-count-total>2'))["errors"]
    assert check_report.check(html.replace('[기록]</p>', '{{미치환}}</p>'))["errors"]
    print("PASS: 수집 오류·빈 서류·보험 구분/합계·부위 상태·중복·수집 상한·플랫폼 파싱·HTML 검사")


if __name__ == "__main__":
    run()
