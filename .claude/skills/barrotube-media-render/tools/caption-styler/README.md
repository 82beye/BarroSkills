# Caption Styler — 릴스 자막 스타일 프리셋 렌더러

세그먼트(자막+타이밍) → 투명 캡션 PNG 시퀀스. ffmpeg `overlay`로 영상에 합성한다.
libass/drawtext 불필요(PIL만). YouTube 자막 템플릿 스타일을 프리셋으로 재현.

## 사용
```bash
python3 caption_render.py spec.json outdir/
# 합성:
ffmpeg -i base.mp4 -framerate 30 -i outdir/f%04d.png \
  -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v];[v][1]overlay=0:0" out.mp4
```
spec.json:
```json
{ "canvas":[1080,1920], "fps":30, "style":"nanum_pastel",
  "segments":[{"start":0.0,"dur":10.04,"text":"어… 뭐야 저 인간"}],
  "font":"(옵션)/path/Pretendard-Bold.otf", "font_index":0, "font_size":67 }
```

## 프리셋
- **nanum_pastel** — 나훔템플릿 「파스텔 말 자막」 재현(YouTube TPIsjnh_pHE 분석).
  파스텔 라운드 pill(노랑#E9E596·분홍#EAC9E8 교대) + 굵은 검은 글자 + 얇은 흰 외곽선,
  pill 팝인 애니메이션, 하단 배치. 기본폰트 AppleSDGothicNeo **Bold**(idx6).
- **pop_word** — 단어별 팝인 + 악센트 하이라이트 + 하단 스크림(흰 글자). (v2)

## 폰트 노트 (중요)
영상 원폰트는 **굵은 클린 한글 산세리프**(Gmarket Sans/Pretendard 계열). 이 머신엔
Pretendard·Gmarket 미설치 → 기본은 **AppleSDGothicNeo Bold**로 근사. **정확 매칭**하려면
Pretendard(OFL 무료, github.com/orioncactus/pretendard) 설치 후 spec의 `"font"`에
`Pretendard-Bold.otf`(또는 ExtraBold/Black) 경로 지정. 제목용 헤비 웨이트는 Pretendard Black 권장.

## 새 스타일 추가
`caption_render.py`의 PRESETS 딕셔너리에 항목 추가(색·pill·애니메이션·폰트). YouTube 템플릿을
새로 분석할 때: 프레임 추출→깨끗한 프레임 크롭→색/폰트/pill/애니메이션 파라미터화.
