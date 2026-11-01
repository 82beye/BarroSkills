# Codex 0.157.0 실행 오류 복구

2026-09-26 KST. Orca 계정의 긴 Unix 소켓 경로 때문에 Codex TUI가 시작되지 않는 오류를 복구했다.

## 원인

- 설치된 CLI와 관리되는 app-server 버전은 0.157.0이다.
- 오류에 표시된 `app-server-control.sock` 경로는 144바이트다.
- 해당 경로는 `/private/tmp/codex-daemon-501/` 아래 94바이트 소켓을 가리키는 심볼릭 링크다.
- Python Unix 소켓 연결 검사에서 원래 경로는 `AF_UNIX path too long`, 링크 대상 경로는 연결 성공이었다. 관측 결과상 긴 링크 경로로 접속하는 클라이언트 경로가 문제다.

## 변경

[계정 config.toml](</Users/beye/Library/Application Support/orca/codex-accounts/f084e750-a586-4069-a137-d37c72c038df/home/config.toml:112>)의 기존 features 테이블에 다음 항목을 추가했다.

```toml
[features]
daemon_auto_start = false
```

설치된 CLI의 `features disable daemon_auto_start` 명령을 해당 계정 설정에 적용했다. 적용 직후 TOML을 비교해 이 항목만 변경됐음을 확인했다. 기존 계정·인증·모델·권한 설정을 유지했고, 계정 폴더 이동이나 데몬 종료는 수행하지 않았다.

백업: [config.toml.before-daemon-fix-20260926-093857](</Users/beye/Library/Application Support/orca/codex-accounts/f084e750-a586-4069-a137-d37c72c038df/home/config.toml.before-daemon-fix-20260926-093857>). 백업 권한은 600이다.

## 검증

- CLI 도움말에서 `--no-daemon` 지원과 `daemon_auto_start` stable 기능을 확인했다.
- 수정한 계정 환경으로 `codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen`을 실제 PTY에서 실행했다. `--no-daemon`을 명령에 추가하지 않아도 TUI와 `GPT-6-Astra xhigh` 모델 표시까지 정상 진입했다.
- 프롬프트를 전송하지 않고 테스트 세션을 종료했으며 종료 코드는 0이었다. 모델 응답 생성은 시험하지 않았다.
- TUI 실행 중 Codex가 `tui.model_availability_nux.gpt-6-astra` 안내 표시 상태를 추가로 저장했다. 이는 설정 한 항목 변경을 검증한 뒤 발생한 CLI 자체 변경이다.
- 별도 startup warning 1개는 설치된 `anthropic-skills/.../skills/schedule/SKILL.md`의 YAML 오류였다. 이번 연결 오류와 별개이며 해당 스킬 파일은 변경하지 않았다.

기존 실행 명령을 그대로 사용할 수 있다. 기능 업데이트 뒤 데몬 경로 처리가 고쳐지면 `daemon_auto_start`를 다시 활성화할 수 있다. 설정이 재생성되는 환경에서 같은 오류가 재발할 경우 일회성 `--no-daemon` 옵션으로 실행할 수 있다.
