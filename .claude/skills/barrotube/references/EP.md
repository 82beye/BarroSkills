
당신은 BarroSkills의 **EP 라이프사이클 관리자**입니다. `/barrotube`의 Mode A/C와 동일한 단계를 수행하지만, 단일 EP 대상 단축 호출에 최적화되어 있습니다.

## When to Use

- 특정 EP-YYYY-NNNN을 빠르게 진행
- `/barrotube` 모드 선택 없이 곧장 EP 작업
- 단일 stage 재실행 (S6c만, S8만 등)

전체 워크플로우(마케팅 → 시리즈 → 첫 EP)는 `/barrotube`로.

## Subcommands

### `/barrotube ep create <topic> [--channel <ch>] [--format <fmt>]`

S0 brief만 생성. 비용 0.

```bash
node scripts/automation/create-episode.js --channel <ch> --topic "<topic>"
```

### `/barrotube ep produce <EP-YYYY-NNNN> [--execute]`

S4~S9 경량 체인 (Shorts 또는 빠른 long-form).

```bash
node scripts/automation/produce-episode.js --episode <EP> [--execute]
```

- `--execute` 없으면 dry-run echo
- 있으면 TTS·Image·Render·QA·Metadata 일괄 (💰 비용 발생)

### `/barrotube ep run <EP-YYYY-NNNN> [--from <S?>] [--execute]`

S0~S11 전체 체인. 체크포인트 재시작 지원.

```bash
node scripts/automation/run-episode.js --episode <EP> [--from S4] [--execute]
```

- `--from S4` 명시 시 S4부터 재시작
- 미명시 시 `.episode_status.json`의 current_stage에서 자동 결정

### `/barrotube ep approve <EP-YYYY-NNNN>`

S10 Board 승인 발급.

```bash
node scripts/automation/approve-episode.js --episode <EP>
```

운영자 본인 호출만 허용. AskUserQuestion으로 publish/cancel/defer 명시.

### `/barrotube ep publish <EP-YYYY-NNNN> [--execute]`

S11 YouTube 업로드 (S10 승인 토큰 검증 후).

```bash
node scripts/automation/publish-youtube.js \
  --video workspace/episodes/<EP>/55_render/video.mp4 \
  --meta workspace/episodes/<EP>/70_publish_meta.json \
  --thumbnail workspace/episodes/<EP>/47_thumbnail.png \
  [--execute]
```

`--execute` 없이는 dry-run echo. 있으면 실제 YouTube 발행 (📺 영상 공개).

### `/barrotube ep status <EP-YYYY-NNNN>`

단일 EP의 `.episode_status.json` + 산출물 매트릭스.

```bash
cat workspace/episodes/<EP>/.episode_status.json | python3 -m json.tool
ls workspace/episodes/<EP>/
```

### `/barrotube ep cancel <EP-YYYY-NNNN>`

EP cancel + in-flight 락 해제. 자산 보존(삭제 X).

```bash
# .episode_status.json status를 cancelled로 변경
# in-flight 락 보유 중이면 release
node scripts/automation/in-flight-lock.js release --episode <EP>
```

## Key Rules

- `--execute` 가드는 모든 비용 발생 단계에 필수
- in-flight 락은 produce/run 양쪽에서 자동 acquire/release
- approve/publish는 두 단계 가드 (--execute + AskUserQuestion)
- audit log 자동 기록

## Error Handling

- 잘못된 EP-ID → 운영자에게 `ls workspace/episodes/` 결과 제시
- `--execute` 누락 시 비용 발생 단계 → 명시적으로 명령어 echo만 출력하고 종료
- S10 미승인 상태에서 publish 시도 → 즉시 거부 + 운영자 안내
