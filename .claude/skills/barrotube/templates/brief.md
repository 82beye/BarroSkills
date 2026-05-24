---
episode_id: EP-YYYY-NNNN
channel: econ-daily
format: long-3min                # long-3min | shorts
persona: barro-teacher           # barro-teacher | barro-alert
series_id: null                  # 시리즈 멤버십 (선택)
target_seconds: 180              # long-3min=180 / shorts=60
scene_count: 7                   # long=7 / shorts=5
language: ko
created_at: YYYY-MM-DDTHH:MM:SS+09:00
created_by: ceo                  # ceo | producer | board
status: planned                  # planned | in_progress | published | cancelled
---

# Brief: <에피소드 제목>

## 한 줄 요약
시청자가 영상을 본 후 가져갈 단 하나의 인사이트.

## 토픽
무엇을 다루는가 (구체적인 주제 명사).

## Why Now
왜 지금 이 토픽인가? (시의성·뉴스 트리거·시즌·검색 트렌드 등)

## Target Viewer
이 영상을 가장 가치 있게 볼 사람의 페르소나 1~2문장.

## 학습 목표 (3개)
1. ...
2. ...
3. ...

## 차별화 포인트
경쟁 채널 대비 우리만의 각도 (휴리스틱·데이터·표현 등).

## 핵심 키워드
- 메인 키워드 1개
- 서브 키워드 3~5개
- 페르소나 hook 패턴 (formats.json 참조)

## 시리즈 컨텍스트 (시리즈 멤버일 때만)
- 시리즈 ID: <series_id>
- 이번 편이 시리즈에서 어느 단계? (WHAT / WHY / HOW / RISK / WHEN)
- 이전 편과의 연결 / 다음 편 예고

## 산출 가이드
- Hook: 첫 3초 안에 시청자가 멈추게 만들 강력한 진술 또는 질문
- 본문: <target_seconds>초 안에 핵심 3개 전달
- Outro: 다음 편 또는 CTA (구독·재생목록)

## 금기 (forbidden_patterns)
페르소나(`personas.json`)의 forbidden_patterns 참조. 위반 시 warning.

## 참고 자료 (선택)
- URL 또는 파일 경로
- Marketing Analyst 리포트 (있을 시)

## Notes
운영자 메모 자유 양식.
