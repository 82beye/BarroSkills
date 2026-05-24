# BarroSkills — Claude Code Skills Collection

> 사용자(beye) 자체 운영 스킬 모음 폴더. 각 스킬은 self-contained로 독립 운영 가능.

## 구조

```
/Users/beye/workspace/BarroSkills/
└── .claude/skills/
    ├── barrotube/                  ← YouTube 자동 회사 (마케팅·EP·업로드 corework)
    │   ├── SKILL.md                  진입점 (/barrotube)
    │   ├── scripts/                  자체 automation 60+
    │   ├── config/                   거버넌스 JSON
    │   ├── workspace/                EP 산출물
    │   ├── logs/                     audit·budget·cron
    │   ├── lib/                      install-cron.sh, doctor-cli.sh
    │   ├── node_modules/             격리된 의존성
    │   └── .env, package.json
    │   └── references/{PIPELINE,MARKETING,SECRETS,ARCHITECTURE,DOCTOR,EP}.md
```

## 사용

단일 스킬 `/barrotube`가 args 분기로 모든 기능 처리:
- `/barrotube` — AskUserQuestion 5 모드 (신규 EP / 마케팅·시리즈 / EP 재개 / 진단 / Cron)
- `/barrotube produce <topic>` — 신규 EP 부트스트랩
- `/barrotube ep <subcmd> <EP-ID>` — 단일 EP 라이프사이클 (run/approve/publish/cancel/status)
- `/barrotube doctor` — 시스템 진단
- `/barrotube install-cron <routine>` — launchd 데몬

상세: `.claude/skills/barrotube/QUICKSTART.md` 또는 `.claude/skills/barrotube/SKILL.md`

## 스킬 추가 (확장)

새 스킬 추가 시:
```bash
mkdir -p .claude/skills/<new-skill-name>
# SKILL.md + 필요한 자산을 모두 그 폴더 안에 self-contained로 둠
```

각 스킬은 다른 스킬과 격리된 독립 폴더. 환경변수·secrets·node_modules 모두 자체 관리.

## 17 글로벌 Agent

`~/.claude/agents/barrotube-*.md` 17개는 BarroTube 스킬용. Task 위임 시 `subagent_type="barrotube-writer"` 등으로 호출. 다른 스킬은 다른 prefix(예: `barrotrade-*`)로 격리 권장.

## 운영자 메모

- 본 폴더는 `~/.claude/skills/`와 별개. 운영자 본인이 직접 관리하는 스킬 collection.
- 본인 1명용 (1차). 일반 배포 v2 시 별도 init wizard 필요.
- 다른 스킬 (예: BarroAiTrade, BarroUs) 같은 형식으로 추가 가능.
