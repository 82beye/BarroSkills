#!/usr/bin/env python3
"""완성 HTML의 미치환 항목·근거 집계·필수 블록 검사. 사실 검증은 별도다.

python3 assets/check_report.py /path/to/report.html
"""
import json
import re
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

GRADES = ("기록", "판매자", "추정", "미확인", "제원", "리뷰")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class Report(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.visible, self.claims, self.errors = [], [], [], []
        self.classes = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get("class", "").split())
        self.classes.update(classes)
        hidden = (bool(self.stack) and self.stack[-1]["hidden"]) or tag in {"script", "style"} or "trust" in classes
        for key, value in attrs.items():
            if value and re.search(r"\{\{.*?\}\}|\{광고ID\}", value):
                self.errors.append(f"미치환 속성: {key}={value}")
        if tag == "a" and urlsplit(attrs.get("href", "")).scheme not in {"", "http", "https"}:
            self.errors.append("허용하지 않은 링크 스킴")
        if tag not in VOID:
            self.stack.append({"tag": tag, "hidden": hidden, "attrs": attrs, "text": []})

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack or self.stack[-1]["tag"] != tag:
            self.errors.append(f"태그 중첩 불일치: </{tag}>")
            return
        node = self.stack.pop()
        text, attrs = "".join(node["text"]).strip(), node["attrs"]
        if "data-count-grade" in attrs or "data-count-total" in attrs:
            self.claims.append((attrs.get("data-count-grade"), text))
        if "b-pass" in attrs.get("class", "").split() and re.search("미확인|보류|미완료", text):
            self.errors.append("미확인 항목에 통과 배지 사용")

    def handle_data(self, data):
        for node in self.stack:
            node["text"].append(data)
        if re.search(r"\{\{.*?\}\}|\{광고ID\}", data, re.S):
            self.errors.append("미치환 본문 항목")
        if self.stack and not self.stack[-1]["hidden"]:
            self.visible.append(data)


def check(html):
    parser = Report()
    parser.feed(html)
    parser.close()
    if parser.stack:
        parser.errors.append("닫히지 않은 HTML 태그")
    text = "".join(parser.visible)
    counts = Counter(re.findall(r"\[(" + "|".join(GRADES) + r")\]", text))
    for name in {"trust", "verifybox", "verdict", "master", "gradebar"} - parser.classes:
        parser.errors.append(f"필수 블록 누락: {name}")
    for marker in ("⑧", "⑩"):
        if marker not in text:
            parser.errors.append(f"필수 섹션 누락: {marker}")
    covered, total_claims = [], 0
    for grades, value in parser.claims:
        if grades is None:
            total_claims += 1
            expected = sum(counts.values())
        else:
            covered.extend(grades.split())
            expected = sum(counts[g] for g in grades.split())
        if not value.isdecimal() or int(value) != expected:
            parser.errors.append(f"근거 집계 불일치 {grades or '전체'}: 표기={value!r}, 실제={expected}")
    if Counter(covered) != Counter(GRADES) or total_claims != 1:
        parser.errors.append("근거 집계 속성 누락/중복: data-count-grade 및 data-count-total 확인")
    return {"counts": {g: counts[g] for g in GRADES}, "total": sum(counts.values()),
            "errors": sorted(set(parser.errors))}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    failed = False
    for arg in sys.argv[1:]:
        result = check(Path(arg).read_text())
        failed |= bool(result["errors"])
        print(json.dumps({"file": arg, **result}, ensure_ascii=False, indent=2))
    sys.exit(1 if failed else 0)
