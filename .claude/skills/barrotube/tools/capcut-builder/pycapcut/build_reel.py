#!/usr/bin/env python3
"""
pyCapCut 기반 릴스 빌더 — 영상클립 + 자막(+파스텔 pill 배경 + 인트로 애니) + BGM
→ mac CapCut 3.3.x가 여는 드래프트 생성.

pyCapCut로 draft_content.json 생성 → mac_bridge로 draft_info.json 변환.
export는 mac에서 수동(pyCapCut 자동 export는 Windows 전용).

사용:
  python3 build_reel.py <spec.json>
spec.json:
{
  "projectName": "BT-EP01-FirstEyeContact",
  "canvas": [1080, 1920], "fps": 30,
  "bgmPath": "/abs/bgm.wav",
  "muteClipAudio": true,
  "textIntro": "Wiping_In",              // pyCapCut TextIntro enum명(옵션). null이면 없음
  "pill": true,                           // 파스텔 pill 배경
  "pillColors": ["#E9E596", "#EAC9E8"],   // 노랑/분홍 교대
  "fontSize": 9.0,
  "clips": [
    { "videoPath": "/abs/cut1.mp4", "caption": "어… 뭐야 저 인간", "durationUs": 10041667 }
  ]
}
durationUs 생략 시 pymediainfo로 자동 산출.
"""
import json, os, sys
import pycapcut as cc
from pycapcut import (ScriptFile, DraftFolder, VideoSegment, AudioSegment, TextSegment,
                      TextStyle, TextBackground, Timerange, TrackType)
from mac_bridge import bridge_draft

CAPCUT_DRAFTS = os.path.expanduser('~/Movies/CapCut/User Data/Projects/com.lveditor.draft')

def probe_us(path):
    try:
        from pymediainfo import MediaInfo
        for t in MediaInfo.parse(path).tracks:
            if t.track_type == 'Video' and t.duration:
                return int(float(t.duration) * 1000)  # ms→us
    except Exception:
        pass
    return None

def hex_to_rgb01(h):
    h = h.lstrip('#'); return tuple(int(h[i:i+2], 16)/255 for i in (0, 2, 4))

def build(spec):
    W, H = spec.get('canvas', [1080, 1920])
    fps = spec.get('fps', 30)
    name = spec['projectName']
    clips = spec['clips']
    mute = spec.get('muteClipAudio', True)

    df = DraftFolder(CAPCUT_DRAFTS)
    if df.has_draft(name): df.remove(name)
    script = df.create_draft(name, W, H, fps=fps)
    script.add_track(TrackType.video)
    script.add_track(TrackType.audio)
    script.add_track(TrackType.text)

    intro = None
    if spec.get('textIntro'):
        intro = getattr(cc.TextIntro, spec['textIntro'], None)
        if intro is None:
            print(f"⚠️ TextIntro '{spec['textIntro']}' 없음 — 애니 생략", file=sys.stderr)

    pill = spec.get('pill', True)
    pill_colors = spec.get('pillColors', ['#E9E596', '#EAC9E8'])
    fsize = spec.get('fontSize', 9.0)

    t = 0
    for i, c in enumerate(clips):
        dur = c.get('durationUs') or probe_us(c['videoPath'])
        if not dur:
            raise ValueError(f"길이 산출 실패: {c['videoPath']} (durationUs 명시)")
        vseg = VideoSegment(c['videoPath'], Timerange(t, dur), volume=0.0 if mute else 1.0)
        script.add_segment(vseg)

        style = TextStyle(size=fsize, bold=True, color=(0.1, 0.1, 0.1) if pill else (1, 1, 1), align=1)
        bg = None
        if pill:
            col = pill_colors[i % len(pill_colors)]
            bg = TextBackground(color=col, style=1, alpha=0.92, round_radius=0.5,
                                height=0.14, width=0.14)
        tseg = TextSegment(c['caption'], Timerange(t, dur), style=style, background=bg)
        if intro:
            try: tseg.add_animation(intro)
            except Exception as e: print("anim add fail:", e, file=sys.stderr)
        script.add_segment(tseg)
        t += dur

    if spec.get('bgmPath') and os.path.exists(spec['bgmPath']):
        script.add_segment(AudioSegment(spec['bgmPath'], Timerange(0, t), volume=1.0))

    script.save()
    res = bridge_draft(os.path.join(CAPCUT_DRAFTS, name))
    res['clips'] = len(clips); res['textIntro'] = spec.get('textIntro') or 'none'; res['pill'] = pill
    return res

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: python3 build_reel.py <spec.json>'); sys.exit(1)
    spec = json.load(open(sys.argv[1], encoding='utf-8'))
    r = build(spec)
    print('✅ pyCapCut 드래프트 생성 + mac 브릿지 완료')
    print(f"   {r['draft_dir']}")
    print(f"   길이 {r['duration_us']/1e6:.2f}s · 클립 {r['clips']} · 애니 {r['textIntro']} · pill {r['pill']}")
    print(f"   참조 누락: {r['missing_refs'] or '없음'}")
    print('   → CapCut 재시작 후 프로젝트 목록에서 열기 (편집/생성은 CapCut 종료 상태에서)')
