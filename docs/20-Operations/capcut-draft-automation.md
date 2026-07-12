---
date: 2026-07-12
tags:
  - operations
  - capcut
  - automation
---

# CapCut Draft 자동화 노하우 (macOS)

EP02에서 draft 생성→미디어 연결→내보내기까지 완전 자동화하며 확보한 지식. 재현 시 이 순서를 따를 것.

## 1. Draft 파일 구조 (신형 CapCut)
- **타임라인 진실원천은 `<draft>/Timelines/<UUID>/draft_info.json`** — 톱레벨 `draft_info.json`은 구형 포맷(레거시)이라 수정해도 무시됨.
- `.bak`도 함께 갱신해야 복원 이슈가 없음. `draft_meta_info.json`은 이름/ID/duration 메타.
- 기존 draft 복제 → material의 `path`·`material_name`·`duration`·텍스트 `content`(text+styles[].range)·세그먼트 timerange 교체가 기본 패턴.

## 2. 함정 목록
| 함정 | 증상 | 해법 |
|---|---|---|
| macOS 샌드박스 | 경로가 맞아도 "파일에 액세스할 수 없음" | 미디어 연결 픽커에서 **폴더 선택**(폴더 선택 시 미디어 연결 체크) → 보안 북마크 부여. 연결은 다음 프로젝트 로드 때 반영됨 |
| 해상도 필드 검증 | 소재 width/height ≠ 실제 파일 → 접근 불가 판정 | material의 width/height를 실제 해상도로 |
| 클립 볼륨 | 복제 원본이 무음 클립이면 volume 0.0 | `volume`·`last_nonzero_volume` = 1.0 |
| `check_flag` 비트마스크 | 배경/테두리 등 스타일 필드를 넣어도 렌더 안 됨 | 스타일 원본 material의 **전체 필드 복사** (예: 파스텔 필 = 23) |
| Qt 커스텀 UI | System Events 클릭 무시 | **Quartz CGEvent** 클릭/더블클릭 (pyobjc, venv 설치) |
| 편집기 창 최소화 | 창이 안 보이는데 AX는 존재 | `AXMinimized=false` + `AXRaise` |
| 모달 좌표 | 시트 애니메이션 중 클릭 유실 | 스크린샷으로 안정화 확인 후 클릭 |

## 3. 자동화 루틴 (검증된 시퀀스)
1. `open -a CapCut` (Gatekeeper 확인창 뜨면 CoreServicesUIAgent에서 '열기')
2. 메뉴 `CapCut > 홈페이지로 돌아가기` → draft 목록
3. draft 행 이름은 AX `HomePageDraftTitle:<name>`으로 탐색 → **Quartz 더블클릭**으로 열기
4. 미디어 연결 다이얼로그: 픽커에서 경로는 go-to(cmd+shift+G)보다 **청크 타이핑**이 안정적. 폴더 선택 후 취소→홈→재오픈으로 연결 확정
5. `파일 > 내보내기` → 해상도 드롭다운 1080P → 내보내기 → 완료 후 공유 다이얼로그 **취소** (자동 발행 금지)
6. 산출물 기본 경로 `~/Desktop/<draft명>.mp4` → 프로젝트 폴더로 이동
- 스크린샷 피드백: `screencapture -x` + AX 좌표계 = 캡처 픽셀 좌표계(이 맥은 1920×1200)

## 4. 스타일 원본 draft
- `BT-EP01-pyCapCut-TEST` — 게시본 파스텔 필 자막 스타일 원본. 텍스트 material 전체 복사 소스로 사용.
- 관련 결정: [[30-Decisions/2026-07-12-todaymyo-subtitle-style]]
