# Caption Reel Builder — 영상클립 + 자막 + 인-애니메이션 CapCut 드래프트 자동 생성

이미 만들어진 세로 영상 클립들을 CapCut 릴스 드래프트로 조립하고, **컷별 자막 + CapCut
네이티브 인-애니메이션을 JSON에 직접 주입**한다. CapCut 수동 조작 없이 드래프트가 완성되며,
CapCut에서 열어 확인·내보내기만 하면 된다.

## 왜 있나
기존 `capcut-draft-builder.js`는 이미지+TTS 슬라이드쇼 전용. 이 도구는 **영상 클립 + 오소링된
자막(직접 타이밍)** 케이스용. 애니메이션은 클라우드 리소스라 임의 ID 주입 시 깨지므로,
**CapCut에서 1회 시드해 확보한 유효 리소스**를 `animations.json` 레지스트리에 등록해 재사용한다.

## 사용
```bash
node bin/caption-reel.mjs spec.json
```
spec.json:
```json
{
  "projectName": "BT-EP01-FirstEyeContact",
  "animation": "chalk_in",              // animations.json 키. null이면 애니메이션 없음
  "bgmPath": "/abs/audio/bgm.wav",       // 선택. 영구 경로 권장(임시폴더 금지)
  "clips": [
    { "videoPath": "/abs/video/cut1.mp4", "caption": "어… 뭐야 저 인간" },
    { "videoPath": "/abs/video/cut2.mp4", "caption": "너로 정했다." }
  ]
}
```
- 클립 길이는 ffprobe로 자동 산출(없으면 `"durationUs": 10041667` 명시).
- 캔버스 기본 vertical(1080×1920), 자막 하단(transformY -0.72)·그림자·외곽선.
- 클립 원음은 기본 음소거(`muteClipAudio`) → BGM만.
- 생성 후 **CapCut 재시작** → 프로젝트 목록에서 열기(실행 중 추가분은 즉시 안 보임).
- **주의**: 편집(JSON 조작)은 CapCut을 ⌘Q로 종료한 상태에서만. 실행 중이면 덮어써짐.

## 새 애니메이션 스타일 등록 (스타일당 1회)
1. CapCut에서 아무 드래프트의 자막 1개에 원하는 인 애니메이션 적용 → 저장 → ⌘Q
2. `node scripts/capture-animation.mjs <드래프트폴더명> <key>`
   예: `node scripts/capture-animation.mjs BT-EP01-FirstEyeContact fade_in`
   → 해당 애니메이션 블록을 animations.json[key]에 등록. 이후 spec의 `"animation"`으로 재사용.

## 현재 등록된 애니메이션
- `chalk_in` — "초크 인"(in, ~0.97s). 2026-07-09 EP01에서 시드 확보.

## 한계/노트
- CapCut 3.3.0 / draft_info.json(app_version 7.6.0) 스키마 기준. 큰 버전업 시 재검증 필요.
- 애니메이션 리소스는 이 머신 캐시 의존. 캐시 삭제 시 CapCut이 resource_id로 재다운로드(대개 정상).
- 영상은 캔버스 크기로 선언해 꽉 채움(소스 720×1264 → 1080×1920, ~1.3% 가로 늘어남, 무시 가능).
