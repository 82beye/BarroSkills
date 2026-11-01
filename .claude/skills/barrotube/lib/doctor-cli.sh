#!/bin/bash
#
# doctor-cli.sh — BarroSkills 자동 진단 (cron 일일 호출용)
#
# /barrotube doctor 서브커맨드의 핵심 체크를 셸 명령으로 자동 실행.
# 결과를 logs/audit/YYYY-MM-DD.jsonl + logs/cron/doctor-daily.log에 기록.
#
# Usage:
#   bash doctor-cli.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SCRIPT_DIR = .../barrotube/lib → BARROTUBE_HOME = .../barrotube (한 번 dirname)
BARROTUBE_HOME="${BARROTUBE_HOME:-$(dirname "$SCRIPT_DIR")}"
BARROSKILLS_HOME="$BARROTUBE_HOME"   # 하위 호환 alias
cd "$BARROSKILLS_HOME"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
AUDIT_LOG="${BARROSKILLS_HOME}/logs/audit/$(date +%Y-%m-%d).jsonl"
mkdir -p "${BARROSKILLS_HOME}/logs/audit"

# 결과 누적
RESULTS=()
# guards.sh — notify_telegram 과 ensure_node_on_path 를 쓴다
# shellcheck source=./guards.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guards.sh"

add_result() {
  local key="$1"; local status="$2"; local detail="$3"
  RESULTS+=("$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1])+": "+json.dumps({"status":sys.argv[2],"detail":sys.argv[3]}))' "$key" "$status" "$detail")")
}

# 1. 설정은 데이터로 파싱한다. source .env 는 명령 치환까지 실행한다.
MISSING=$(node --input-type=module -e '
import { validateSecrets } from "./scripts/automation/config-loader.js";
console.log(validateSecrets(["ELEVENLABS_API_KEY", "GOOGLE_AI_API_KEY", "YOUTUBE_DATA_API_KEY", "YOUTUBE_OAUTH_REFRESH_TOKEN"]).missing.join(", "));
')
if [ $? -ne 0 ]; then
  add_result "secrets" "RED" "secret validation failed"
elif [ -n "$MISSING" ]; then
  add_result "secrets" "RED" "missing: $MISSING"
else
  add_result "secrets" "GREEN" "4/4 keys present"
fi

# 2. PAPERCLIP_DISABLED
if [ "${PAPERCLIP_DISABLED:-}" = "1" ]; then
  add_result "paperclip_isolation" "GREEN" "PAPERCLIP_DISABLED=1"
else
  add_result "paperclip_isolation" "YELLOW" "PAPERCLIP_DISABLED 미설정 — BarroSkills 권장: =1"
fi

# 3. 파이프라인 필수 에이전트
#
# 개수를 정확히 세던 검사("17이면 GREEN")는 두 방향으로 틀렸다:
# 에이전트가 하나 늘면 멀쩡한데 RED 가 되고(2026-08-13 실측 18/17),
# 반대로 엉뚱한 17개여도 통과했다. 이름으로 필수 항목을 확인한다.
# 선택 에이전트(reel-director, producer-shorts 등)는 개수에만 잡힌다.
REQUIRED_AGENTS="ceo cmo marketing-analyst content-manager producer researcher strategist \
writer fact-checker asset-pm voice-engineer image-generator capcut-composer qa-reviewer \
metadata-writer publisher"

AGENT_COUNT=$(ls ~/.claude/agents/barrotube-*.md 2>/dev/null | wc -l | tr -d ' ')
MISSING_AGENTS=""
for _a in $REQUIRED_AGENTS; do
  [ -f "$HOME/.claude/agents/barrotube-${_a}.md" ] || MISSING_AGENTS="${MISSING_AGENTS}${MISSING_AGENTS:+, }${_a}"
done

if [ -n "$MISSING_AGENTS" ]; then
  add_result "agents" "RED" "missing: ${MISSING_AGENTS} (installed ${AGENT_COUNT})"
else
  add_result "agents" "GREEN" "${AGENT_COUNT} installed, all required present"
fi

# 4. In-flight lock
#
# stale 락은 보고만 하면 안 된다. 락은 다음 회차 전체를 막는데 해제가 사람 손을
# 기다리면 그동안 슬롯이 통째로 빈다(EP-2026-0134·0138 등 반복). 감시자가 이미
# "pid 죽음" 을 확인했으니 여기서 정리한다 — 죽은 프로세스의 락은 정의상 아무도
# 쓰고 있지 않다.
#
# forceRelease 를 직접 부르지 않는 이유: 판정과 삭제 사이에 새 프로세스가 락을
# 잡을 수 있고, 그때 무조건 지우면 **살아 있는 작업의 락**을 뺏어 두 에피소드가
# 동시에 돈다. release-stale 은 지우기 직전에 pid·started_at 을 다시 확인한다.
if [ -f workspace/.in-flight.json ]; then
  LOCK_PID=$(python3 -c "import json; print(json.load(open('workspace/.in-flight.json')).get('pid', ''))" 2>/dev/null)
  LOCK_EP=$(python3 -c "import json; print(json.load(open('workspace/.in-flight.json')).get('episode_id', '?'))" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && ps -p "$LOCK_PID" > /dev/null 2>&1; then
    add_result "in_flight_lock" "YELLOW" "active ${LOCK_EP}, PID=$LOCK_PID alive"
  else
    RS=$(node scripts/automation/in-flight-lock.js release-stale 2>&1 | tr -d '\n"' | cut -c1-120)
    if printf '%s' "$RS" | grep -q "Released stale lock"; then
      add_result "in_flight_lock" "YELLOW" "STALE ${LOCK_EP} (PID=${LOCK_PID:-?} dead) — 자동 해제함"
    elif printf '%s' "$RS" | grep -qE "No lock|Lock is live"; then
      add_result "in_flight_lock" "GREEN" "clear (${RS})"
    else
      add_result "in_flight_lock" "RED" "STALE ${LOCK_EP} 해제 실패 — ${RS}"
    fi
  fi
else
  add_result "in_flight_lock" "GREEN" "no lock"
fi

# 5. _legacy_paperclip 격리
LEGACY_COUNT=$(ls scripts/automation/_legacy_paperclip/ 2>/dev/null | wc -l | tr -d ' ')
add_result "legacy_isolation" "GREEN" "$LEGACY_COUNT scripts isolated"

# 6. Active scripts에 Paperclip API 호출 잔재 검색 (-E로 ERE 사용, escape 명확)
PAPERCLIP_LEAK=$(grep -lE "(localhost|127\.0\.0\.1):3100" scripts/automation/*.js 2>/dev/null | wc -l | awk '{print $1}')
if [ "${PAPERCLIP_LEAK:-0}" = "0" ]; then
  add_result "paperclip_leak" "GREEN" "clean (0 active files reference Paperclip API URL)"
else
  add_result "paperclip_leak" "YELLOW" "$PAPERCLIP_LEAK files still reference Paperclip API URL"
fi

# 6b. 유튜브 실제 공개 상태 동기화
# 보드와 파이프라인은 "발행됨"을 로컬 기록으로 판정한다. 슬롯 시각을 넘겨 예약이 걸리지
# 않으면 유튜브는 private 로 남기는데, 업로드는 됐고 ID 도 있어서 전부 발행으로 세어 왔다.
# 2026-09-23 실측: 보드가 107편을 발행으로 셌고 실제 공개는 83편이었다.
# videos.list 는 50건당 1유닛(일일 10,000)이라 무과금이고 읽기 전용이다.
if node scripts/automation/sync-youtube-state.js --quiet 2>/dev/null; then
  YT_BURIED=$(python3 -c "
import json,sys
try:
    d=json.load(open('workspace/youtube-state.json'))
    c=d.get('counts',{})
    print(f\"{c.get('private',0)} {c.get('public',0)} {c.get('gone',0)}\")
except Exception: print('? ? ?')
" 2>/dev/null)
  set -- $YT_BURIED
  if [ "${1:-?}" != "?" ] && [ "${1:-0}" -gt 0 ] 2>/dev/null; then
    add_result "youtube_buried_private" "YELLOW" "업로드했지만 비공개로 묻힌 영상 ${1}편 (공개 ${2}, 유실 ${3}) — 보드의 '비공개' 칩으로 확인"
  else
    add_result "youtube_buried_private" "GREEN" "비공개로 묻힌 영상 없음"
  fi
else
  add_result "youtube_buried_private" "INFO" "유튜브 상태 동기화 실패 — 보드는 로컬 기록으로 표시한다"
fi

# 7. YouTube OAuth 만료 임박
# 동의 화면이 "테스트" 상태면 refresh token 이 7일 뒤 만료된다. 무비용 경과일 검사만 한다
# (실검증은 1 unit 이라 doctor 에 넣지 않는다 — check-oauth-expiry.js --verify 로 따로).
OAUTH_LEVEL=$(node scripts/automation/check-oauth-expiry.js --json 2>/dev/null \
  | grep -o '"level": "[^"]*"' | head -1 | cut -d'"' -f4)
case "${OAUTH_LEVEL:-UNKNOWN}" in
  OK)       add_result "youtube_oauth" "GREEN"  "refresh token 유효 범위" ;;
  WARN)     add_result "youtube_oauth" "YELLOW" "만료 임박 — setup-youtube-oauth.js 실행 권장" ;;
  CRITICAL) add_result "youtube_oauth" "YELLOW" "만료 직전 — 오늘 갱신 필요" ;;
  EXPIRED)  add_result "youtube_oauth" "RED"    "만료됨 — setup-youtube-oauth.js 실행 필요" ;;
  *)        add_result "youtube_oauth" "INFO"   "발급 시각 미기록 — 다음 갱신 시 기록된다" ;;
esac

# 8. codex CLI 실행 가능성
#
# command -v 만으로는 이 고장을 못 잡는다. 2026-09-06 npm 자동 업데이트가 플랫폼
# 패키지(@openai/codex-darwin-arm64)를 vendor/ 만 남기고 package.json 없이 풀어서,
# 런처의 require.resolve 가 실패했다 — bin 심볼릭도 함께 빠져 PATH 에서도 사라졌다.
# 같은 고장이 2026-09-04 에도 났고, 두 번 다 새벽 파이프라인이 Phase 7 에서 멈춘 뒤에야
# 발견됐다(EP-2026-0140). S6c 씬 이미지가 전부 codex 라 이게 죽으면 그날 편이 안 나간다.
# 그래서 실제로 --version 을 돌려 본다. 실행 비용은 수십 ms 다.
CODEX_FIX="npm install -g @openai/codex@latest"
if ! command -v codex >/dev/null 2>&1; then
  add_result "codex_cli" "RED" "PATH 에 codex 없음 — ${CODEX_FIX}"
else
  CODEX_VER=$(codex --version 2>&1 | head -1 | tr -d '"' | tr -d '\n')
  if printf '%s' "$CODEX_VER" | grep -qi "codex"; then
    add_result "codex_cli" "GREEN" "$CODEX_VER"
  else
    add_result "codex_cli" "RED" "설치는 있으나 실행 실패(${CODEX_VER:0:60}) — ${CODEX_FIX}"
  fi
fi

# 9. 실제 cron 종료 상태·KPI 신선도·게시 조정 잠금·비밀 파일 권한
#
# 감시 목록을 손으로 적지 않는다. 고정 목록은 새 루틴이 늘 때마다 조용히 낡고,
# 그 사이의 고장은 아무도 못 본다 — 2026-09-16 에 설치된 omnibus 가 여기 없어서
# 09-17·19·20 세 번의 점심 회차가 "Invalid slot" 으로 죽는 동안 doctor 는 계속
# all GREEN 을 찍었다. 설치된 plist 를 그대로 열거하면 목록이 스스로 최신이 된다.
#
# 여기서 보는 것은 "돌았는가" 만이 아니다. 파이프라인이 이미 남긴 RED 감사 이벤트
# (publish_left_private 등)를 읽지 않으면 doctor 는 고장을 코앞에 두고도 통과시킨다 —
# 2026-09-16~20 에 다섯 편이 비공개로 묻히는 동안 실제로 그랬다.
RUNTIME_RESULTS=$(python3 - "$BARROTUBE_HOME" <<'PY'
import datetime, json, os, pathlib, plistlib, re, subprocess, sys

root = pathlib.Path(sys.argv[1])
UID = os.getuid()
KST = datetime.timezone(datetime.timedelta(hours=9))
NOW = datetime.datetime.now(datetime.timezone.utc)

def emit(key, status, detail):
    print(json.dumps(key) + ': ' + json.dumps({'status': status, 'detail': detail}, ensure_ascii=False))

def audit_events(hours=24):
    out = []
    # 파일은 KST 날짜별이다. 창이 하루를 넘으면(금요일 회차를 월요일 아침에 볼 때) 그만큼 거슬러 연다.
    today = NOW.astimezone(KST).date()
    first = (NOW - datetime.timedelta(hours=hours)).astimezone(KST).date()
    for day in (today - datetime.timedelta(days=n) for n in range((today - first).days + 1)):
        f = root / 'logs' / 'audit' / f'{day}.jsonl'
        if not f.is_file():
            continue
        for line in f.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            raw = d.get('at') or d.get('timestamp')
            if not raw:
                continue
            try:
                t = datetime.datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
            except ValueError:
                continue
            if t.tzinfo is None:
                t = t.replace(tzinfo=datetime.timezone.utc)
            if (NOW - t).total_seconds() <= hours * 3600:
                out.append((t, d))
    return out

# ── cron: 설치된 plist 를 열거한다 (고정 목록 금지) ──────────────────────────
# launchd 의 'last exit code' 는 그 라벨이 다시 돌 때까지 남는다. 실패한 회차를 다른 경로
# (일회성 plist·RESUME)로 다시 돌려 발행까지 마쳐도 다음 정규 회차 전까지 그대로다 —
# 2026-10-02 07:10 doctor 가 전날 16:00 kr-close 실패(EP-0201, LLM 한도)로 RED 를 울렸는데,
# 그 슬롯은 20:06 에 EP-0202 로 이미 발행돼 있었다. 회차 시각도 없어 아침에 받은 사람은
# 방금 끝난 미국장 회차가 깨진 줄 알았다. 그래서 어느 회차의 코드인지 적고, 그 회차 뒤
# 같은 슬롯이 마지막 실패 이후 발행까지 갔으면 YELLOW 로 낮춘다 (텔레그램은 RED 만 울린다).
def last_fire(plist):
    """StartCalendarInterval 기준 지금 이전의 마지막 정시(로컬 시각). 정할 수 없으면 None."""
    try:
        sci = plistlib.loads(plist.read_bytes()).get('StartCalendarInterval')
    except Exception:   # 깨진 plist 하나로 런타임 검사 전체가 죽으면 안 된다
        return None
    now = NOW.astimezone()
    best = None
    for e in sci if isinstance(sci, list) else [sci]:
        if not isinstance(e, dict) or 'Hour' not in e or 'Minute' not in e:
            continue   # 시·분이 빠진 항목은 매시·매분이라 회차가 하나로 안 정해진다
        for n in range(366):
            day = (now - datetime.timedelta(days=n)).date()
            wd = (day.weekday() + 1) % 7   # launchd 요일: 0·7=일, 1=월
            if e.get('Month', day.month) != day.month or e.get('Day', day.day) != day.day \
                    or e.get('Weekday', wd) % 7 != wd:
                continue
            t = datetime.datetime.combine(day, datetime.time(e['Hour'], e['Minute']), now.tzinfo)
            if t <= now:
                best = max(best or t, t)
                break
    return best

def slot_recovery(routine, fired):
    """fired 회차 이후 이 슬롯의 (첫 실패 단계, 마지막 실패 뒤의 발행 (시각, EP))."""
    eps, stage, pub = set(), None, None
    for t, d in sorted(audit_events((NOW - fired).total_seconds() / 3600), key=lambda x: x[0]):
        det = str(d.get('detail') or '')
        if det.startswith(f'slot={routine} '):
            ep = re.search(r'\bep=(EP-\d{4}-\d{4})', det)
            if ep:
                eps.add(ep[1])
            if d.get('event') == 'auto_pipeline_fail':
                st = re.search(r'stage=(.+?) detail=', det)
                stage = stage or (st[1] if st else None)
                pub = None   # 발행 뒤에 다시 깨졌으면 복구가 아니다
            elif d.get('event') == 'auto_pipeline_published' and ep:
                pub = (t, ep[1])
        elif d.get('action') == 'published' and d.get('episode_id') in eps:
            pub = (t, d['episode_id'])   # 손으로 이어 붙인 발행(RESUME·publish-resume)도 센다
    return stage, pub

# doctor 자신은 뺀다. RED 를 찾으면 exit 1 로 끝나도록 설계돼 있어서, 자기 종료코드를
# 자기가 감시하면 한 번 RED 가 난 뒤로는 영원히 RED 가 된다.
SELF = 'doctor-daily'
agents = pathlib.Path.home() / 'Library' / 'LaunchAgents'
labels = sorted(f.name[:-len('.plist')] for f in agents.glob('com.barroskills.barrotube.*.plist'))
if not labels:
    emit('cron_installed', 'YELLOW', 'com.barroskills.barrotube.* plist 가 하나도 없다 — on-demand 모드')
for label in labels:
    routine = label.rsplit('.', 1)[-1]
    if routine == SELF:
        continue
    r = subprocess.run(['launchctl', 'print', f'gui/{UID}/{label}'], capture_output=True, text=True)
    if r.returncode:
        emit('cron_' + routine, 'RED', 'plist 는 있는데 launchd 에 적재되지 않았다 — 이 루틴은 돌지 않는다')
        continue
    if re.search(r'^\s*state = running$', r.stdout, re.M):
        emit('cron_' + routine, 'GREEN', 'running')
        continue
    code = re.search(r'last exit code = (-?\d+)', r.stdout)
    runs = re.search(r'runs = (\d+)', r.stdout)
    n_runs = int(runs[1]) if runs else 0
    fired = last_fire(agents / f'{label}.plist') if code and code[1] != '0' else None
    if fired:
        stage, pub = slot_recovery(routine, fired)
        what = (f"last exit={code[1]} — {fired:%m/%d}({'월화수목금토일'[fired.weekday()]}) {fired:%H:%M} 회차"
                + (f' {stage} 실패' if stage else ''))
        if pub:
            emit('cron_' + routine, 'YELLOW', f'{what} → {pub[1]} {pub[0].astimezone():%m/%d %H:%M} 발행으로 복구됨')
        else:
            emit('cron_' + routine, 'RED', what)
    elif code:
        emit('cron_' + routine, 'GREEN' if code[1] == '0' else 'RED', 'last exit=' + code[1])
    elif n_runs:
        # 정상 종료했으면 launchd 가 종료코드를 남긴다. 돈 적은 있는데 코드가 없으면
        # 시그널로 죽은 것이다(2026-09-18 realestate 가 SIGTERM 으로 11:08 에 끊겼다).
        # 옛 검사는 이걸 'not yet observed' → GREEN 으로 삼켰다.
        emit('cron_' + routine, 'YELLOW', f'{n_runs}회 실행됐으나 종료코드 없음 — 시그널로 중단된 회차가 있다')
    else:
        emit('cron_' + routine, 'GREEN', 'not yet observed')

# ── 페이퍼클립 관제 (2026-10-07~) ─────────────────────────────────────────
# 정기 잡이 페이퍼클립 루틴으로 옮겨 가면서 launchd 종료코드로는 회차 성패가 안 보인다.
# 대신 페이퍼클립 응답·가동 루틴 수·거버너 갱신 시각·회차 마커(workspace/ops/runs)를 본다.
ops = pathlib.Path(sys.argv[1]) / 'workspace' / 'ops'
ids_path = ops / 'paperclip-ids.json'
if ids_path.exists():
    import urllib.request
    try:
        ids = json.loads(ids_path.read_text())
    except Exception:
        ids = {}
    try:
        with urllib.request.urlopen('http://127.0.0.1:3100/api/health', timeout=5) as r:
            ok = json.loads(r.read().decode()).get('status') == 'ok'
    except Exception:
        ok = False
    if not ids.get('activated'):
        emit('paperclip', 'GREEN', '가동 전(launchd 운영) — 페이퍼클립 관제 미적용')
    elif not ok:
        emit('paperclip', 'RED', '페이퍼클립 서버 응답 없음 — 정기 회차는 데드맨(정시+20분)만 지킨다. paperclipai service status')
    else:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:3100/api/companies/{ids['companyId']}/routines", timeout=10) as r:
                routines = json.loads(r.read().decode())
            want = set((ids.get('routines') or {}).values())
            active = [x for x in routines if x.get('id') in want and x.get('status') == 'active']
            paused = [x['title'] for x in routines if x.get('id') in want and x.get('status') != 'active']
            st = json.loads((ops / 'token-state.json').read_text()) if (ops / 'token-state.json').exists() else {}
            held = {k for k, v in (st.get('routines') or {}).items() if v.get('pausedBy') == 'governor'}
            age = (NOW - datetime.datetime.fromisoformat(st['updatedAt'].replace('Z', '+00:00'))).total_seconds() / 60 if st.get('updatedAt') else None
            if age is None or age > 45:
                emit('paperclip', 'YELLOW', f'토큰 거버너 갱신 {"없음" if age is None else f"{age:.0f}분 전"} — Token Governor 타이머 확인')
            elif len(paused) > len(held):
                emit('paperclip', 'YELLOW', f'루틴 {len(active)}/{len(want)} 가동 — 사람이 멈춘 루틴: {", ".join(paused)[:200]}')
            else:
                emit('paperclip', 'GREEN', f'루틴 {len(active)}/{len(want)} 가동 (거버너 보류 {len(held)}) · Claude {st.get("providers", {}).get("claude", {}).get("level", "?")} · Codex {st.get("providers", {}).get("codex", {}).get("level", "?")}')
        except Exception as e:
            emit('paperclip', 'YELLOW', f'루틴 조회 실패: {e}')
    # 어제·오늘 회차 마커 중 실패·멈춤 (SRE 이슈로 넘어갔는지)
    bad = []
    for day in {(NOW - datetime.timedelta(days=1)).astimezone(KST).date().isoformat(), NOW.astimezone(KST).date().isoformat()}:
        d = ops / 'runs' / day
        if not d.exists():
            continue
        for f in d.glob('*.json'):
            try:
                m = json.loads(f.read_text())
            except Exception:
                continue
            if m.get('status') in ('failed', 'halted', 'lost') and not m.get('action', '').startswith('test:'):
                sre = ', '.join(o.get('issue', '') for o in (m.get('sreIssues') or [])) or 'SRE 이슈 없음'
                bad.append(f"{day} {m.get('action')} {m.get('status')}{(' ' + m['ep']) if m.get('ep') else ''} → {sre}")
    if bad:
        emit('paperclip_runs', 'YELLOW', f'{len(bad)}건 실패·멈춤 (SRE 처리 중이면 정상): ' + ' / '.join(sorted(bad))[:400])
    else:
        emit('paperclip_runs', 'GREEN', '어제·오늘 회차 마커에 실패·멈춤 없음')

# ── 감사 로그 24시간 창 ────────────────────────────────────────────────────
events = audit_events()
def detail_of(d):
    return str(d.get('detail') or '')
def by_event(name):
    return [d for _, d in events if d.get('event') == name]

# 발행됐는데 비공개로 남은 회차. 파이프라인은 이미 RED 로 적어 두지만 아무도 안 읽었다.
buried = by_event('publish_left_private')
if buried:
    ids = ', '.join(sorted({m[1] for m in (re.search(r'ep=(EP-\d{4}-\d{4})', detail_of(d)) for d in buried) if m}))
    vids = ', '.join(sorted({m[1] for m in (re.search(r'video=(\S+)', detail_of(d)) for d in buried) if m}))
    emit('publish_left_private', 'RED',
         f'{len(buried)}편이 비공개로 묻혔다: {ids} (video {vids}) — set-video-privacy.js 로 공개하거나 폐기 판단 필요')
else:
    emit('publish_left_private', 'GREEN', '24h 내 비공개 방치 없음')

# 24시간 창은 **사건**만 잡는다. 묻힌 영상은 다음 날이면 창 밖으로 나가 다시 보이지
# 않게 되는데, 정작 영상은 그대로 비공개로 남아 있다 — 2026-09-16~20 에 다섯 편이
# 그렇게 쌓이는 동안 아무 신호도 없었다. 산출물 자체를 세서 잔고를 본다.
#
# 결과 파일은 **업로드 시점**의 기록이다. 나중에 사람이 공개로 바꾼 편(set-video-privacy.js·Studio)
# 까지 비공개로 세면 7일 창이 끝날 때까지 가짜 RED 가 난다 — 2026-09-29 EP-0176·0177 이 그랬다
# (실제 공개, 조회 755·1,025). 위에서 방금 동기화한 youtube-state.json 이 싱싱하면 그 판정이 정본이다.
live = {}
try:
    ys = json.loads((root / 'workspace' / 'youtube-state.json').read_text(encoding='utf-8'))
    checked = datetime.datetime.fromisoformat(str(ys.get('checked_at', '')).replace('Z', '+00:00'))
    if (NOW - checked).total_seconds() <= 48 * 3600:
        live = ys.get('videos') or {}
except (OSError, ValueError, TypeError):
    live = {}
backlog = []
for res in sorted((root / 'workspace' / 'episodes').glob('EP-*/platforms/*/80_publish_result.json')):
    try:
        if (NOW - datetime.datetime.fromtimestamp(res.stat().st_mtime, datetime.timezone.utc)).days > 7:
            continue
        yt = json.loads(res.read_text(encoding='utf-8')).get('targets', {}).get('youtube', {})
    except (OSError, ValueError):
        continue
    # 예약(scheduled)은 publishAt 에 스스로 공개된다. 비공개로 '올라가 버린' 것만 센다.
    if yt.get('privacyStatus') == 'private' and yt.get('status') != 'scheduled':
        now_privacy = (live.get(yt.get('videoId')) or {}).get('privacy')
        if now_privacy and now_privacy != 'private':
            continue   # 지금은 공개(또는 삭제)다 — 방치가 아니다
        backlog.append(f"{res.parent.parent.parent.name}:{yt.get('videoId', '?')}")
emit('publish_private_backlog', 'RED' if backlog else 'GREEN',
     f'최근 7일 비공개 방치 {len(backlog)}편 — ' + ', '.join(backlog) if backlog
     else '최근 7일 비공개 방치 없음')

# 모션 폴백 — Grok 이 정본인데 HyperFrames 로 나간 컷 수.
fb = by_event('motion_fallback_shipped')
if fb:
    total = sum(int(m[1]) for m in (re.search(r'hyperframes=(\d+)', detail_of(d)) for d in fb) if m)
    emit('motion_fallback', 'YELLOW', f'{len(fb)}편 {total}컷이 HyperFrames 폴백 — Grok 세션·쿼터 확인')
else:
    emit('motion_fallback', 'GREEN', '24h 내 모션 폴백 없음')

# 자산 재사용은 정상 운영이 아니라 이미지 생성 쿼터가 마른 증상이다. 텔레그램은 그 순간
# 한 번만 울리므로, 며칠째 재활용으로 버티고 있다는 사실은 여기서만 보인다.
# 약한 매칭 컷 수까지 같이 센다 — 그게 시청자가 먼저 알아채는 지점이다.
reuse = []
weak_cuts = 0
for man in sorted((root / 'workspace' / 'episodes').glob('EP-*/platforms/*/40_assets/_reuse.json')):
    try:
        if (NOW - datetime.datetime.fromtimestamp(man.stat().st_mtime, datetime.timezone.utc)).days > 7:
            continue
        d = json.loads(man.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        continue
    scenes = d.get('scenes') or []
    weak = sum(1 for sc in scenes if sc.get('weak'))
    weak_cuts += weak
    reuse.append(f"{d.get('episode_id') or man.parents[2].name} {len(scenes)}컷{f'(약함 {weak})' if weak else ''}")
if reuse:
    emit('asset_reuse', 'YELLOW',
         f"7일 내 {len(reuse)}편이 기존 자산으로 발행 — 약한 매칭 {weak_cuts}컷 · " + '; '.join(reuse[:4]))
else:
    emit('asset_reuse', 'GREEN', '7일 내 자산 재사용 없음')

# 경보가 도착하지 못하면 다른 모든 검사가 무의미해진다.
tg = [d for d in by_event('telegram_delivery') if d.get('status') == 'ERROR']
emit('telegram_delivery', 'YELLOW' if tg else 'GREEN',
     f'{len(tg)}건 전송 실패 — 경보가 운영자에게 닿지 않았다' if tg else '24h 내 전송 실패 없음')

# 목표 공개 시각 대비 실제. 늦어도 나가게 됐지만(유예), 계속 늦으면 구조를 손봐야 한다.
late = []
for meta in sorted((root / 'workspace' / 'episodes').glob('EP-*/platforms/*/70_publish_meta.json')):
    try:
        if (NOW - datetime.datetime.fromtimestamp(meta.stat().st_mtime, datetime.timezone.utc)).total_seconds() > 86400:
            continue
        pl = json.loads(meta.read_text(encoding='utf-8')).get('publish_late')
    except (OSError, ValueError):
        continue
    if pl:
        late.append(f"{meta.parent.parent.parent.name} {pl.get('hours_late')}h→{pl.get('action')}")
emit('publish_timeliness', 'YELLOW' if late else 'GREEN',
     '; '.join(late) if late else '24h 내 지각 발행 없음')

# 만들다 만 에피소드. 락은 안 잡고 있어 아무도 안 막지만, 쌓이면 상태를 못 읽는다.
stale = []
for ep in sorted((root / 'workspace' / 'episodes').glob('EP-*')):
    st = ep / '.episode_status.json'
    if not st.is_file():
        continue
    age_h = (NOW - datetime.datetime.fromtimestamp(st.stat().st_mtime, datetime.timezone.utc)).total_seconds() / 3600
    if age_h <= 24 or age_h > 24 * 7:
        continue
    if list(ep.glob('platforms/*/80_publish_result.json')) or (ep / '80_publish_result.json').is_file():
        continue
    try:
        status = json.loads(st.read_text(encoding='utf-8')).get('status', '?')
    except (OSError, ValueError):
        status = '?'
    if status in ('cancelled', 'archived'):   # 접은 회차 — status-local.js TERMINAL_STATUSES
        continue
    stale.append(f'{ep.name}({status}, {age_h:.0f}h)')
emit('stale_episodes', 'YELLOW' if stale else 'GREEN',
     ', '.join(stale) + ' — 재개하거나 접어야 한다' if stale else '미완 에피소드 없음')

# 기상 예약. 이 기계는 노트북이라 슬립이 구조적 위험인데, caffeinate 는 이미 깨어
# 있을 때만 듣는다. pmset 예약은 root 가 필요해 무인으로 걸 수 없으므로 상태만 본다.
try:
    sched = subprocess.run(['pmset', '-g', 'sched'], capture_output=True, text=True, timeout=10).stdout
except (OSError, subprocess.SubprocessError):
    sched = ''
emit('power_wake_schedule', 'GREEN' if re.search(r'wake|poweron', sched, re.I) else 'YELLOW',
     sched.strip().splitlines()[-1].strip() if re.search(r'wake|poweron', sched, re.I)
     else '기상 예약 없음 — 잠든 시각의 회차는 깨어난 뒤에야 만회된다 (lib/install-cron.sh wake)')

# ── 기존 검사 ──────────────────────────────────────────────────────────────
files = sorted((root / 'workspace/growth/kpi').glob('????-??-??.json'))
try:
    card = json.loads(files[-1].read_text())
    observed = card.get('inputs', {}).get('observed_at')
    t = datetime.datetime.fromisoformat(observed.replace('Z', '+00:00'))
    age = (NOW - t).total_seconds() / 3600
    emit('growth_kpi', 'GREEN' if 0 <= age <= 24 else 'RED', f'observation age={age:.1f}h; performance={card.get("overall")}')
except (IndexError, AttributeError, ValueError, TypeError, OSError):
    emit('growth_kpi', 'RED', 'KPI missing or observation freshness unverified')
locks = sorted((root / 'workspace/episodes').glob('EP-*/platforms/*/80_publish_result.json.lock'))
pending = [p for p in locks if not p.with_suffix('').exists()]
emit('publish_reconciliation', 'RED' if pending else 'GREEN', ', '.join(p.parent.parent.parent.name for p in pending) or 'no pending upload locks')
unsafe = [p.name for p in root.glob('.env*') if p.name != '.env.example' and p.is_file() and p.stat().st_mode & 0o077]
emit('secret_permissions', 'RED' if unsafe else 'GREEN', ', '.join(unsafe) or 'secret files restricted to owner')
PY
 ) || add_result "runtime_checks" "RED" "runtime diagnostic failed"
while IFS= read -r result; do
  [ -n "$result" ] && RESULTS+=("$result")
done <<< "$RUNTIME_RESULTS"

# 10. 최근 24h audit 활동
# bash 는 입력 리다이렉트를 2>/dev/null 보다 **먼저** 처리한다. 파일이 아직 없는
# 새 날 첫 실행에서 "No such file or directory" 가 그 억제를 빠져나와 찍혔다.
AUDIT_TODAY=0
[ -f "$AUDIT_LOG" ] && AUDIT_TODAY=$(wc -l < "$AUDIT_LOG" | tr -d ' ')
add_result "audit_today" "INFO" "$AUDIT_TODAY entries"

# 결과 JSON 합성 + audit 기록
RESULT_JSON="{\"at\": \"$NOW\", \"event\": \"doctor_daily\", \"source\": \"doctor-cli.sh\", \"checks\": {$(IFS=','; echo "${RESULTS[*]}")}}"
echo "$RESULT_JSON" >> "$AUDIT_LOG"

# 콘솔 출력
echo "🩺 BarroSkills Doctor — $NOW"
echo ""
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "Audit logged: $AUDIT_LOG"

# RED 는 조용히 지나가면 안 된다.
# doctor 의 존재 이유가 "silent failure 탐지" 인데, 결과가 로그 파일에만 남으면
# 아무도 안 본다 — 2026-08-13 까지 알림 경로가 아예 없었다.
if echo "$RESULT_JSON" | grep -q '"status": "RED"'; then
  RED_LIST=$(printf '%s' "$RESULT_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)['checks']
print('\n'.join(f'• {k}: {v[\"detail\"]}' for k,v in d.items() if v['status']=='RED'))
" 2>/dev/null)
  notify_telegram "🩺 <b>doctor RED</b>
${RED_LIST}

<code>bash ${BARROTUBE_HOME}/lib/doctor-cli.sh</code>"
  exit 1
fi
exit 0
