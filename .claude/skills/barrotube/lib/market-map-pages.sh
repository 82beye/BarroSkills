#!/bin/bash
# market-map-pages.sh — 카드 10장 + index.html 을 GitHub Pages(gh-pages 브랜치)로 올린다.
#
# 왜 GitHub Pages 인가 (2026-09-17 실측)
# ────────────────────────────────────
# claude.ai 아티팩트 링크는 **사람이 세션에서 발행할 때만** 갱신된다:
#   - `claude -p` 헤드리스 세션에는 Artifact 도구가 없다 (도구 목록으로 확인)
#   - CronCreate 는 세션 전용이라 세션이 끝나면 사라진다 (7일 만료)
#   - claude.ai 클라우드 루틴도 Artifact 가 없다 (실제로 한 번 돌려 확인)
#   - 발행된 페이지 자체는 CSP 가 외부 통신을 막아 시세를 못 가져온다
# 크론이 인증을 들고 쓸 수 있는 호스트는 gh(GitHub) 뿐이라 여기로 간다.
#
# 히스토리를 안 쌓는다: 매번 임시 저장소에 orphan 커밋 하나를 만들어 강제 푸시한다.
# 판마다 1MB 쯤 되는 PNG 가 쌓이면 저장소가 금방 부푼다.
#
#   bash market-map-pages.sh <cards_dir>
set -euo pipefail
SRC="${1:?cards 폴더 경로가 필요하다}"
REPO="${MARKETMAP_PAGES_REPO:-https://github.com/82beye/BarroSkills.git}"
BRANCH="${MARKETMAP_PAGES_BRANCH:-gh-pages}"

[[ -f "$SRC/index.html" ]] || { echo "❌ $SRC/index.html 이 없다 (--site 로 렌더했는지 확인)" >&2; exit 1; }
command -v gh >/dev/null || { echo "❌ gh 가 없다" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$SRC/index.html" "$TMP/"
cp "$SRC"/card-*.png "$TMP/"
touch "$TMP/.nojekyll"

cd "$TMP"
git init -q
git checkout -qb "$BRANCH"
git add -A
git -c user.email="82beye@gmail.com" -c user.name="barrotube-cron" \
    commit -q -m "마켓맵 $(TZ=Asia/Seoul date '+%F %H:%M') KST"
# 토큰은 gh 자격증명 헬퍼가 넘긴다 — URL 이나 프로세스 목록에 남기지 않는다.
git -c credential.helper='!gh auth git-credential' push -q --force "$REPO" "$BRANCH"

OWNER_REPO="$(echo "$REPO" | sed -E 's#.*github.com[:/]##; s#\.git$##')"
echo "🌐 https://$(echo "$OWNER_REPO" | cut -d/ -f1 | tr 'A-Z' 'a-z').github.io/$(echo "$OWNER_REPO" | cut -d/ -f2)/"
