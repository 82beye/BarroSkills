"""
mac_bridge — pyCapCut(draft_content.json / 剪映6.x 규격) 산출물을
mac CapCut 3.3.x(draft_info.json 규격)가 인식하도록 변환.

검증(2026-07-10): 이 브릿지 적용 후 mac CapCut 3.3.0이 드래프트를 인식·재작성·
root_meta_info.json에 등록함을 실측 확인.

두 가지가 필수:
  1) draft_content.json → draft_info.json (+ .bak) 복사 (mac CapCut이 읽는 파일명)
  2) draft_meta_info.json 의 draft_fold_path / draft_root_path / draft_name /
     draft_id / tm_* 채우기 (pyCapCut은 공란으로 남김 → mac CapCut 미인식)
"""
import json, os, time

def bridge_draft(draft_dir: str):
    draft_dir = os.path.abspath(draft_dir)
    name = os.path.basename(draft_dir)
    root = os.path.dirname(draft_dir)
    content_p = os.path.join(draft_dir, 'draft_content.json')
    if not os.path.exists(content_p):
        raise FileNotFoundError(f'draft_content.json 없음: {draft_dir} (pyCapCut save() 먼저 실행)')

    content = json.load(open(content_p, encoding='utf-8'))
    # 1) draft_info.json / .bak
    for fn in ('draft_info.json', 'draft_info.json.bak'):
        json.dump(content, open(os.path.join(draft_dir, fn), 'w', encoding='utf-8'), ensure_ascii=False)

    # 2) meta 경로/이름/시간 채우기
    meta_p = os.path.join(draft_dir, 'draft_meta_info.json')
    meta = json.load(open(meta_p, encoding='utf-8')) if os.path.exists(meta_p) else {}
    now = int(time.time() * 1e6)
    meta['draft_fold_path'] = draft_dir
    meta['draft_root_path'] = root
    meta['draft_name'] = name
    meta['draft_id'] = content.get('id', meta.get('draft_id', ''))
    meta.setdefault('tm_draft_create', now)
    meta['tm_draft_modified'] = now
    meta['tm_duration'] = content.get('duration', 0)
    json.dump(meta, open(meta_p, 'w', encoding='utf-8'), ensure_ascii=False)

    # 참조 파일 존재 점검
    missing = []
    m = content.get('materials', {})
    for grp in ('videos', 'audios'):
        for it in m.get(grp, []):
            p = it.get('path', '')
            if p and not os.path.exists(p):
                missing.append(p)
    return {'draft_dir': draft_dir, 'name': name, 'duration_us': content.get('duration', 0),
            'missing_refs': missing}

if __name__ == '__main__':
    import sys
    print(bridge_draft(sys.argv[1]))
