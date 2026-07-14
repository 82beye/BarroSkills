# pyCapCut 기반 릴스 빌더 (+ mac CapCut 브릿지)

pyCapCut(GuanYixuan/pyCapCut, pip) 으로 draft_content.json 을 생성하고,
`mac_bridge.py` 로 mac CapCut 3.3.x 가 여는 형식(draft_info.json)으로 변환한다.
기존 손제작 JS 빌더(../src/caption-reel-builder.js)보다 애니메이션·pill 배경·전환·
필터·키프레임 등 CapCut 네이티브 기능을 훨씬 풍부하게 지원.

## 왜 브릿지가 필요한가 (실측 2026-07-10)
- pyCapCut 은 **draft_content.json**(剪映6.x / app_version 6.7.0)만 쓴다.
- mac CapCut 3.3.0 은 **draft_info.json** 을 읽고, draft_meta_info.json 의
  draft_fold_path/root_path/name 으로 드래프트를 인식한다. pyCapCut 은 이 필드를 공란으로 둔다.
- `mac_bridge.bridge_draft()` 가 ① content→info(.bak) 복사 ② meta 경로/이름/시간 채우기.
- 검증: 브릿지 후 mac CapCut 이 드래프트 인식→root_meta_info.json 등록→draft_info.json
  자기형식 재작성 확인. **사용자가 CapCut 에서 열어 영상/자막/pill/애니 정상 확인.**

## 사용
```bash
./.venv/bin/python build_reel.py spec.json
```
spec.json:
```json
{ "projectName":"BT-EPxx", "canvas":[1080,1920], "fps":30,
  "bgmPath":"/abs/bgm.wav", "muteClipAudio":true,
  "textIntro":"Wiping_In", "pill":true, "pillColors":["#E9E596","#EAC9E8"], "fontSize":9.0,
  "clips":[ {"videoPath":"/abs/cut1.mp4","caption":"자막"} ] }
```
- 길이는 pymediainfo 자동 산출(없으면 `"durationUs"` 명시).
- `textIntro`: pyCapCut `TextIntro` enum명. 목록: `./.venv/bin/python -c "import pycapcut as cc;print([x for x in dir(cc.TextIntro) if not x.startswith('_')])"`
  (영문명 예: Wiping_In, Click, Bumper_Car / 중국어명도 다수). 애니 카탈로그는 剪映 세트라
  mac CapCut 국제판 "초크 인" 등과 다름 — 원하는 효과는 목록에서 골라 검증.
- `pill`: TextBackground(파스텔 pill). 색은 pillColors 교대.

## 필수 운영 규칙
- **CapCut 종료 상태에서 생성/편집** (실행 중이면 CapCut 이 덮어씀).
- 생성 후 **CapCut 재시작** → 홈 프로젝트 목록에서 열기.
- BGM/영상은 **영구 경로** 참조(job tmp 금지).
- **export 는 mac 에서 수동** (pyCapCut 자동 export = Windows/uiautomation 전용).

## 설치 (스킬 전용 venv)
```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
```

## 두 빌더 비교
- **pycapcut/build_reel.py (이 도구)**: 기능 풍부(애니·pill·전환·필터), pyCapCut 의존, 브릿지 필요.
- **../src/caption-reel-builder.js**: 순수 JS·의존성 0, draft_info.json 직접 생성, seed-once 애니(chalk_in).
  가벼운 경우/애니 카탈로그 정확매칭(초크 인) 필요 시 이쪽.
