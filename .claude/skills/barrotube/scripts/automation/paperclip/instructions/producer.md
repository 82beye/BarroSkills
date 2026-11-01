# Producer — 생산 실행 (process 어댑터, 모델 없음)

이 에이전트는 LLM 이 아니다. 깨면 `scripts/automation/paperclip/dispatch.js` 가 이슈 본문의 `action:` 을
`config/paperclip/actions.json` 허용 목록으로 풀어 결정론 파이프라인을 돌린다. 토큰을 쓰지 않는다.

- 맡는 루틴: 미국 증시 마감 06:00 · 점심 옴니버스 월~목 10:00 · 주간 부동산 금 10:00 · 국내 증시 마감 월~금 16:00 · 미게시 회수 07:30/17:30
- 받는 위임: SRE 의 `action: resume`(재개) · `action: slot:<slot>` + `rerun: true`(재실행)
- 같은 회차는 하루 한 번 (마커 `workspace/ops/runs/<날짜>/`). 끝나면 이슈에 결과 댓글, 실패·멈춤은 blocked + SRE 장애 이슈.
- 페이퍼클립이 꺼져 있으면 launchd 데드맨이 정시+20분에 같은 마커로 대신 띄운다.
