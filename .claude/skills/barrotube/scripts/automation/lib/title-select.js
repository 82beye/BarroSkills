/**
 * title-select.js — 제목 후보를 규칙으로 거르고 하나를 고른다 (2026-09-26)
 *
 * 왜 필요한가: 지금까지 S9 는 LLM 이 제목을 **한 개** 쓰고 끝났다. 규칙("왜"를 말하라,
 * 라벨로 시작하지 마라, 3일 안 같은 수치 금지)은 프롬프트에만 있었고 받은 제목을 검사하는
 * 코드가 없었다. 그 결과가 두 가지로 나타났다.
 *   ① 공식 쏠림 — 프롬프트 예시 「진짜 이유는 …」을 그대로 따라 09-16 이후 15편 중 9편이
 *     같은 틀이 됐고, 최근 5편은 전부 "진짜" 가 들어갔다.
 *   ② 수치 반복 — 3일 안에 같은 수치를 또 쓴 편의 48h 조회 중앙값 337 vs 516
 *     (09-01 이후 36편 중 9편). 경고(headline_conflict)는 기록만 되고 아무도 보지 않았다.
 *
 * 그래서 LLM 에게는 **서로 다른 유형의 후보 여러 개**를 쓰게 하고, 고르는 일은 여기서
 * 결정론적으로 한다. 규칙 위반은 거르고(hard), 최근과 같은 유형은 뒤로 미룬다(soft).
 *
 * 게시는 멈추지 않는다 — 모든 후보가 규칙을 어기면 가장 덜 어긴 것을 고르고 fallback 으로
 * 표시해 거부창에서 사람이 본다. 제목 하나 때문에 게시를 멈추면 손실이 더 크다.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTitle, titleCore, TYPE_LABEL } from './title-types.js';

/**
 * 제목 수치 토큰. 2026-09-14 실측(48h 조회, 2026-09-01~09-11): 3일 안에 같은 수치를
 * 제목에 반복한 두 번째 영상은 -68%·-64%·-32% 였고, 같은 사건을 다른 각도·다른 수치로
 * 연 회차는 +67%·+48% 였다. 하루 두 편을 돌리는 채널이라 이 충돌이 구조적으로 생긴다.
 * (generate-metadata.js 에서 옮겨 왔다 — 그쪽은 이 함수를 그대로 다시 내보낸다.)
 */
const NUM_TOKEN = /\d+(?:[.,]\d+)?\s*(?:%|퍼센트|달러|원|bp|배|선|조|억|만|포인트)/g;

export function headlineNumberTokens(title) {
  return new Set((String(title || '').match(NUM_TOKEN) || []).map((t) => t.replace(/\s+/g, '')));
}

export function findHeadlineCollision(title, videosIndex, now, { days = 3 } = {}) {
  const mine = headlineNumberTokens(title);
  if (!mine.size) return null;
  const cutoff = now.getTime() - days * 86400_000;
  for (const v of Object.values(videosIndex?.videos ?? {})) {
    const t = Date.parse(v?.publishedAt ?? '');
    if (!Number.isFinite(t) || t < cutoff || t > now.getTime()) continue;
    const shared = [...headlineNumberTokens(v.title)].filter((x) => mine.has(x));
    if (shared.length) return { title: v.title, publishedAt: v.publishedAt, shared };
  }
  return null;
}

/**
 * 최근 제목 — 채널 인덱스(videos.json)와 **이미 업로드된** 로컬 회차 메타를 합친다.
 *
 * 인덱스만 보면 부족하다. us-close(08:00)와 kr-close(18:00)가 같은 날 돌고 인덱스 동기화는
 * 그 사이에 늦게 돌 수 있어, 두 번째 회차가 첫 회차 제목을 못 보고 같은 수치를 또 쓴다.
 * 로컬 메타는 80_publish_result.json 이 있는 것만 센다 — 업로드되지 않은 회차의 제목은
 * 시청자가 본 적이 없으니 피할 이유가 없다.
 */
export function recentTitles({ videosIndex = null, episodesRoot = null, excludeEpisode = null, now = new Date(), days = 3 } = {}) {
  const cutoff = now.getTime() - days * 86400_000;
  const out = [];
  for (const v of Object.values(videosIndex?.videos ?? {})) {
    const at = Date.parse(v?.publishedAt ?? '');
    if (v?.title && Number.isFinite(at) && at >= cutoff && at <= now.getTime()) out.push({ title: v.title, at, source: 'channel' });
  }
  if (episodesRoot && existsSync(episodesRoot)) {
    for (const ep of readdirSync(episodesRoot)) {
      if (!/^EP-/.test(ep) || ep === excludeEpisode) continue;
      const dirs = [join(episodesRoot, ep)];
      const plat = join(episodesRoot, ep, 'platforms');
      if (existsSync(plat)) for (const p of readdirSync(plat)) dirs.push(join(plat, p));
      for (const d of dirs) {
        const metaPath = join(d, '70_publish_meta.json');
        if (!existsSync(metaPath) || !existsSync(join(d, '80_publish_result.json'))) continue;
        let meta;
        try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { continue; }
        const at = Date.parse(meta.publishAt ?? '') || statSync(metaPath).mtimeMs;
        if (meta.title && at >= cutoff && at <= now.getTime() + 86400_000) out.push({ title: meta.title, at, source: ep });
      }
    }
  }
  const seen = new Set();
  return out.sort((a, b) => b.at - a.at).filter((r) => {
    const k = titleCore(r.title);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 쇼츠 제목 끝 #Shorts 를 한 번만. 09-01 이후 100% 붙여 왔으므로 현상 유지한다 — 빼는 것은 별도 실험이다. */
export function normalizeTitle(title, { shorts = true } = {}) {
  const core = titleCore(title);
  return shorts ? `${core} #Shorts` : core;
}

/** "왜"를 말하는 장치 — 통념과 어긋남·반대로 움직임·숨은 원인·물음. content_policy.title_requires_causal_clause. */
const WHY = /왜|이유|인데|는데|에도|지만|아니라|아닌|반대|오히려|\?|숨은|가린|착시|역설|때문|탓|덕분|알고 보니/;

export const HARD = {
  LABEL_PREFIX: '시황 라벨([美마감] 등)로 시작',
  NO_WHY: '"왜"가 없음 (인과·반전·질문 장치 부재)',
  NUMBER_REPEAT: '최근 3일 제목과 같은 수치',
  JINJJA_RECENT: '최근 제목에 이미 "진짜"가 있음',
  DUPLICATE: '최근 제목과 동일',
  TOO_LONG: '길이 상한 초과',
};

/**
 * 후보 하나를 판정한다.
 * @returns {{ title, type, tags, hard: string[], soft: string[], penalty: number }}
 */
export function judgeCandidate(title, ctx = {}) {
  const {
    recent = [], shorts = true, requireWhy = true, seriesBadge = null,
    figure = null, maxLen = shorts ? 100 : 70,
  } = ctx;
  const t = normalizeTitle(title, { shorts });
  const core = titleCore(t);
  const { primary, tags } = classifyTitle(core);
  const hard = [];
  const soft = [];
  let penalty = 0;

  if (/^\s*\[/.test(core) && !(seriesBadge && core.startsWith(seriesBadge))) hard.push('LABEL_PREFIX');
  if (requireWhy && !WHY.test(core)) hard.push('NO_WHY');
  if ([...t].length > maxLen) hard.push('TOO_LONG');

  const mine = headlineNumberTokens(core);
  const recentCores = recent.map((r) => titleCore(r.title));
  if (mine.size && recent.some((r) => [...headlineNumberTokens(r.title)].some((x) => mine.has(x)))) hard.push('NUMBER_REPEAT');
  if (/진짜/.test(core) && recentCores.slice(0, 3).some((r) => /진짜/.test(r))) hard.push('JINJJA_RECENT');
  if (recentCores.includes(core)) hard.push('DUPLICATE');

  // 유형 순환 — 바로 앞 제목과 같은 유형이면 크게, 최근 3편 안에 있으면 작게 뒤로 민다.
  const recentTypes = recentCores.slice(0, 3).map((r) => classifyTitle(r).primary);
  if (recentTypes[0] && recentTypes[0] === primary) { soft.push('SAME_TYPE_AS_LAST'); penalty += 2; }
  else if (recentTypes.includes(primary)) { soft.push('TYPE_IN_RECENT'); penalty += 1; }
  // 기록·수치 보도가 주 장치면 약하다(기록 단독 중앙값 275) — "왜"와 함께 쓰면 보조 태그로 내려간다.
  if (primary === 'record' || primary === 'report') { soft.push('WEAK_TYPE'); penalty += 1; }
  // 공인 정책(CEO v1.0): 메인 인물이 있으면 앞 30자 안에.
  if (figure && ![...core].slice(0, 30).join('').includes(figure)) { soft.push('FIGURE_NOT_FRONT'); penalty += 2; }

  return { title: t, type: primary, tags, hard, soft, penalty };
}

/**
 * 후보들 중 하나를 고른다. 규칙을 다 지킨 후보 중 벌점이 낮은 것 → 같으면 LLM 이 앞에 둔 것.
 * 다 어기면 가장 덜 어긴 것을 고르고 fallback 표시.
 */
export function selectTitle(candidates, ctx = {}) {
  const judged = candidates
    .map((c, i) => ({ ...judgeCandidate(c.title ?? c, ctx), index: i, llm_type: c.type ?? null }))
    .filter((j) => titleCore(j.title).length > 0);
  if (!judged.length) return null;
  const valid = judged.filter((j) => j.hard.length === 0);
  const pool = valid.length ? valid : judged;
  const chosen = [...pool].sort((a, b) =>
    (a.hard.length - b.hard.length) || (a.penalty - b.penalty) || (a.index - b.index))[0];
  return { chosen, judged, fallback: valid.length === 0 };
}

/** 거부창 알림에 붙일 줄 — 운영자가 30분 안에 제목을 보고 판단할 수 있게. */
export function summaryLines(meta) {
  if (!meta?.title) return [];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [`제목: ${esc(meta.title)}`];
  const sel = meta.title_selection;
  if (sel?.chosen_type) lines.push(`유형: ${TYPE_LABEL[sel.chosen_type] ?? sel.chosen_type} (후보 ${sel.candidates?.length ?? 1}개 중)`);
  if (sel?.fallback) lines.push(`⚠ 규칙을 모두 지킨 후보가 없어 차선을 골랐습니다: ${esc((sel.chosen_hard ?? []).map((c) => HARD[c] ?? c).join(', '))}`);
  if (meta.headline_conflict) lines.push(`⚠ 최근 제목과 수치 겹침: ${esc((meta.headline_conflict.shared ?? []).join(', '))}`);
  return lines;
}

export default { headlineNumberTokens, findHeadlineCollision, recentTitles, normalizeTitle, judgeCandidate, selectTitle, summaryLines, HARD };
