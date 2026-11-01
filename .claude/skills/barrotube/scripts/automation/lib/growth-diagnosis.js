/**
 * growth-diagnosis.js — KPI 가 RED·YELLOW 일 때 **왜** 그런지를 최근 발행분에서 찾는 순수 함수
 *
 * 스코어카드(growth-kpi.js)는 무엇이 나쁜지만 말한다. 2026-10-06 KPI RED 때 좋아요율 0.61% 의
 * 원인은 마무리 문장에 좋아요 요청이 39편 중 0편이었다는 것이었고, 48h 조회 0.63× 는 2분 넘는
 * 새 포맷과 배포가 안 된 공개 영상이 끌어내린 것이었다. 그런데 처방(growth-directives)은 같은
 * 수치를 다시 보여 줄 뿐이었다. 원인을 찾아야 고칠 수 있다.
 *
 * I/O 없음 · LLM 없음 · 네트워크 없음. CLI(../growth-diagnose.js)가 파일을 읽어 넘긴다.
 *
 * finding: { id, kpi, grade, summary, evidence, remedy }
 *   remedy 는 config/growth.json remedies 의 키다. 적용 방식(auto·propose·notify)은 카탈로그가
 *   정한다 — 진단은 무엇이 원인인지까지만 말한다.
 *
 * episodes: [{ videoId, ep, slot, publishedAt, durationS, privacy, lateHours, closing, form }]
 *   closing = 마지막 씬 narration. videos 는 growth-kpi.js normalizeIndex() 결과.
 */
import { ageDays, viewsAtAge } from './growth-kpi.js';

export const LIKE_CTA = /좋아요/;
export const FOLLOW_CTA = /구독|팔로우/;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EP_RE = /\bep=(EP-\d{4}-\d{4})/;
const STAGE_RE = /\bstage=(.+?)(?= detail=| ep=|$)/;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** epoch ms → KST 날짜 'YYYY-MM-DD'. 감사 로그 파일과 편성은 KST 날짜로 나뉜다. */
/** 단계 → 볼 코드. 진단 설계서와 장애 분석(incident-analyze.js)이 같은 지도를 쓴다. */
export const STAGE_CODE = {
  'Phase 1': 'scripts/automation/fetch-market-snapshot.js · collect-summary-data.js',
  'Phase 2': 'scripts/automation/desk-briefing.js · research-brief.js',
  'Phase 4': 'scripts/automation/generate-script.js · generate-summary-script.js · lib/text-engine.js',
  'Phase 5': 'scripts/automation/lib/image-prompt-contract.js · generate-script.js (재작성 루프)',
  'Phase 6': 'scripts/automation/run-factcheck.js · revise-script-factcheck.js',
  'Phase 7': 'lib/auto-pipeline.sh (Phase 7) · grok-motion-applescript.js',
  'Phase 8': 'scripts/automation/produce-episode.js',
  'Phase 12': 'scripts/automation/run-episode.js · publish-youtube.js',
};

export function kstDate(ms) {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

function kpiOf(kpiDoc, id) {
  return (kpiDoc?.kpis ?? []).find((k) => k.id === id) ?? null;
}
const isBad = (k) => k?.grade === 'RED' || k?.grade === 'YELLOW';

/** routines.json cron("Mon-Fri 16:00" · "Fri 10:00" · "06:00") → 요일 집합(0=일). 요일이 없으면 매일. */
export function slotWeekdays(cron) {
  const all = new Set([0, 1, 2, 3, 4, 5, 6]);
  const parts = String(cron ?? '').trim().split(/\s+/);
  if (parts.length < 2) return all;
  const days = new Set();
  for (const seg of parts[0].split(',')) {
    const [a, b = a] = seg.split('-');
    const i = WEEKDAY.indexOf(a);
    const j = WEEKDAY.indexOf(b);
    if (i < 0 || j < 0) return all;
    for (let k = i; ; k = (k + 1) % 7) {
      days.add(k);
      if (k === j) break;
    }
  }
  return days;
}

/** 실행 마커가 운영자 패스인가. dispatch 가 로그의 🛑 줄을 guard 로 남기고, 손으로 멈춘 회차는 operatorSkip 을 단다. */
export function isOperatorPass(marker) {
  return marker?.operatorSkip === true || /운영자 패스/.test(String(marker?.guard ?? ''));
}

/**
 * 한 슬롯·하루의 감사 이벤트로 누락 원인을 가른다. 그날 **처음** 난 장애가 원인이다 — 재실행은 복구 시도다.
 * marker: 그 슬롯·날짜의 실행 마커(workspace/ops/runs). 운영자 패스는 감사 이벤트 없이 마커에만 남을 수 있다 —
 * 2026-10-15 omnibus 는 Phase 2 도중 운영자 지시로 멈춰 「시작했는데 끝 없음」(interrupted)으로 잘못 셌다.
 */
export function classifyMiss(events, cancelled = {}, marker = null) {
  const first = (name) => events.find((e) => e.event === name);
  const skipped = first('auto_pipeline_skipped');
  if (skipped) return { cause: 'operator_skip', detail: String(skipped.detail ?? '') };
  if (isOperatorPass(marker)) return { cause: 'operator_skip', detail: String(marker.guard ?? '').slice(0, 200) };
  const stop = events.find((e) => e.event === 'auto_pipeline_halt' || e.event === 'auto_pipeline_fail');
  if (stop) {
    const det = String(stop.detail ?? '');
    const stage = det.match(STAGE_RE)?.[1]?.trim() ?? '?';
    const kind = stop.event === 'auto_pipeline_halt' ? 'halt' : 'fail';
    return {
      cause: `${kind}:${stage}`,
      at: stop.at ?? null,
      ep: det.match(EP_RE)?.[1] ?? null,
      detail: det.slice(0, 200),
      deskFailed: events.some((e) => e.event === 'desk_briefing_failed'),
    };
  }
  const ep = events.map((e) => String(e.detail ?? '').match(EP_RE)?.[1]).find(Boolean);
  if (ep && cancelled[ep]) return { cause: 'cancelled', ep, detail: cancelled[ep] };
  // 시작했는데 끝 기록이 없다 — 절전 중 멈춤·강제 종료. 시작조차 없으면 크론이 안 떴다.
  if (first('auto_pipeline_start')) return { cause: 'interrupted', ep: ep ?? null, detail: '' };
  return { cause: 'no_run', ep: null, detail: '' };
}

/**
 * 지난 windowDays 일(오늘 제외)의 편성 대비 발행 누락과 원인.
 * 같은 원인이 2번 이상이면 우연이 아니라 구조 문제다 — 고칠 대상으로 올린다.
 * resolved: [{ cause, resolved_at }] — 고친 뒤 재발한 것만 다시 센다.
 * markers: { 'slot|day': 실행 마커 } — 운영자 패스 판정용.
 * videos: 채널 인덱스(normalizeIndex) — 업로드는 됐지만 비공개로 남은 회차를 누락으로 되돌린다.
 */
export function diagnosePublishing({ kpi, slots, audit, cancelled = {}, resolved = [], now, windowDays = 7,
  markers = {}, videos = [] }) {
  const k = kpiOf(kpi, 'publish_consistency_7d');
  if (!isBad(k)) return [];

  const rows = (audit ?? [])
    .map((r) => ({ r, t: Date.parse(r.at ?? r.timestamp ?? '') }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const bySlotDay = new Map();
  const epSlot = new Map();
  const published = new Map();   // 'slot|day' → 발행으로 남은 EP
  const upload = new Map();      // EP → 마지막 업로드 { videoId, publishAt }
  for (const { r, t } of rows) {
    const det = String(r.detail ?? '');
    const slot = det.match(/^slot=(\S+)/)?.[1];
    const yt = r.action === 'published' ? r.result?.targets?.youtube : null;
    if (yt?.videoId && r.episode_id) upload.set(r.episode_id, { videoId: yt.videoId, publishAt: yt.publishedAt ?? null });
    if (slot) {
      const ep = det.match(EP_RE)?.[1];
      if (ep && !epSlot.has(ep)) epSlot.set(ep, slot);
      const key = `${slot}|${kstDate(t)}`;
      if (!bySlotDay.has(key)) bySlotDay.set(key, []);
      bySlotDay.get(key).push(r);
      if (r.event === 'auto_pipeline_published') published.set(key, ep ?? null);
    } else if (r.action === 'published' && epSlot.has(r.episode_id)) {
      // 손으로 이어 붙인 발행(RESUME 뒤 수동 S11)은 슬롯 태그 없이 남는다.
      published.set(`${epSlot.get(r.episode_id)}|${kstDate(t)}`, r.episode_id);
    }
  }

  // 감사엔 발행으로 남았는데 시청자는 못 본 회차 — 업로드 뒤 비공개로 남았다(2026-10-15 us-close EP-2026-0234:
  // 운영자가 예약을 풀고 비공개 유지). 시각이 찍힌 관측이 없거나 예약 공개 시각이 마지막 관측보다 뒤면
  // 판정을 보류한다 — 인덱스가 낡았을 뿐 공개됐을 수 있다. 보류는 누락도 발행도 아니다(counts.pending_review).
  const videoBy = new Map((videos ?? []).map((v) => [v.videoId, v]));
  const unpublished = (ep) => {
    const u = ep ? upload.get(ep) : null;
    const v = u ? videoBy.get(u.videoId) : null;
    if (v?.privacy !== 'private') return null;
    const seen = Math.max(-Infinity, ...(v.stats_history ?? [])
      .map((h) => Date.parse(h?.at ?? h?.observed_at ?? ''))
      .filter(Number.isFinite));
    const due = Date.parse(u.publishAt ?? '');
    // 관측 시각을 모르면 지금 시각으로 대신하지 않는다 — 확인 안 된 예약 업로드가 누락으로 확정된다(YOU-458 반려).
    const hold = !Number.isFinite(seen) ? 'no_dated_observation'
      : Number.isFinite(due) && due > seen ? 'scheduled_after_last_observation' : null;
    if (hold) return { pending: hold, ep, videoId: u.videoId, publishAt: u.publishAt ?? null,
      lastObservedAt: Number.isFinite(seen) ? new Date(seen).toISOString() : null };
    return { cause: 'unpublished_after_upload', ep, videoId: u.videoId,
      detail: `업로드 ${u.videoId} 가 비공개로 남음${u.publishAt ? ` (예약 ${u.publishAt})` : ''}` };
  };

  const today = kstDate(now.getTime());
  const misses = [];
  const pending = [];
  let planned = 0;
  for (let n = windowDays; n >= 1; n--) {
    const day = kstDate(now.getTime() - n * 86400_000);
    if (day >= today) continue;
    const wd = new Date(`${day}T12:00:00+09:00`).getUTCDay();
    for (const [slot, def] of Object.entries(slots ?? {})) {
      if (def?.enabled === false || !slotWeekdays(def?.cron).has(wd)) continue;
      planned++;
      const key = `${slot}|${day}`;
      if (published.has(key)) {
        const lost = unpublished(published.get(key));
        if (lost?.pending) pending.push({ day, slot, ...lost });
        else if (lost) misses.push({ day, slot, ...lost });
        continue;
      }
      misses.push({ day, slot, ...classifyMiss(bySlotDay.get(key) ?? [], cancelled, markers?.[key]) });
    }
  }
  if (!misses.length && !pending.length) return [];

  const fixedAt = (cause) => Math.max(-Infinity, ...resolved
    .filter((x) => x.cause === cause).map((x) => Date.parse(x.resolved_at)).filter(Number.isFinite));
  // 고친 시점과는 **사건 시각**으로 비교한다. 날짜로 비교하면 고친 날 새벽의 장애가 재발로 잡힌다.
  const open = misses.filter((m) => m.cause !== 'operator_skip'
    && Date.parse(m.at ?? `${m.day}T00:00:00+09:00`) > fixedAt(m.cause));
  const groups = new Map();
  for (const m of open) {
    if (!groups.has(m.cause)) groups.set(m.cause, []);
    groups.get(m.cause).push(m);
  }

  // 운영자 패스는 누락이 아니라 편성에서 빠진 회차다 — 분모에서도 뺀다.
  const skipped = misses.filter((m) => m.cause === 'operator_skip').length;
  const due = planned - skipped;
  const lost = misses.length - skipped;
  const held = pending.length;
  const shipped = due - lost - held;
  const findings = [{
    id: 'publish_misses',
    kpi: k.id,
    grade: k.grade,
    summary: `최근 ${windowDays}일 편성 ${planned}편${skipped ? `(운영자 패스 ${skipped} 제외 ${due})` : ''} 중 ` +
      `발행 ${shipped}${due > 0 ? ` (${Math.round((shipped / due) * 100)}%)` : ''}${held ? ` · 판정 보류 ${held}` : ''}` +
      ` · ${lost}회 누락` + (misses.length ? ' — ' : '') +
      [...new Set(misses.map((m) => m.cause))].map((c) => `${c} ${misses.filter((m) => m.cause === c).length}`).join(', '),
    counts: { planned, skipped, published: shipped, missed: lost, pending_review: held },
    pending_review: pending,
    evidence: misses,
    remedy: 'R-MISS-REPORT',
  }];
  for (const [cause, list] of groups) {
    if (list.length < 2) continue;
    const code = cause.startsWith('halt:') || cause.startsWith('fail:');
    findings.push({
      id: `systemic_miss:${cause}`,
      kpi: k.id,
      grade: k.grade,
      summary: `「${cause}」 로 ${list.length}회 누락 — 같은 원인이 반복된다`,
      evidence: list,
      remedy: code ? 'R-FIX-BRIEF' : 'R-ENV',
    });
  }
  return findings;
}

/**
 * 좋아요율이 낮은데 마무리에 좋아요 요청이 없다 — 가장 싼 레버가 비어 있다.
 * 요청이 이미 절반 이상에 있으면 다른 원인이므로 이 진단은 아무것도 말하지 않는다.
 */
export function diagnoseLikeRate({ kpi, episodes, lastN = 12, minEpisodes = 4 }) {
  const k = kpiOf(kpi, 'like_rate_7d');
  if (!isBad(k)) return [];
  const recent = (episodes ?? [])
    .filter((e) => typeof e.closing === 'string' && e.closing.trim())
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, lastN);
  if (recent.length < minEpisodes) return [];
  const withLike = recent.filter((e) => LIKE_CTA.test(e.closing));
  if (withLike.length / recent.length >= 0.5) return [];
  const noCta = recent.filter((e) => !LIKE_CTA.test(e.closing) && !FOLLOW_CTA.test(e.closing));
  return [{
    id: 'like_cta_missing',
    kpi: k.id,
    grade: k.grade,
    summary: `좋아요율 ${k.display} 인데 최근 ${recent.length}편 마무리에 좋아요 요청이 ${withLike.length}편뿐이다` +
      (noCta.length ? ` (요청이 아예 없는 편 ${noCta.length}: ${[...new Set(noCta.map((e) => e.slot))].join('·')})` : ''),
    evidence: recent.map((e) => ({ ep: e.ep, slot: e.slot, like: LIKE_CTA.test(e.closing), follow: FOLLOW_CTA.test(e.closing) })),
    remedy: 'R-LIKE-CTA',
  }];
}

/**
 * 48h 조회가 기준보다 낮은 이유를 영상 단위로 가른다.
 *   - 비공개로 묻힌 업로드, 공개인데 배포가 안 된 영상(48h ≤ zeroViews)은 따로 센다 — 콘텐츠 탓이 아니다.
 *   - 나머지에서 긴 영상(> longSec)·지각 발행 묶음의 중앙값이 기준의 ratioFloor 미만이면 원인 후보다.
 * 기준선: recentDays 보다 오래되고 recentDays+30 일 이내인 공개 영상의 48h 중앙값.
 */
export function diagnoseViews48({ kpi, videos, episodes, now, recentDays = 14, longSec = 90,
  zeroViews = 10, minSamples = 3, ratioFloor = 0.6 }) {
  const k = kpiOf(kpi, 'views_48h_index_7d');
  if (!isBad(k)) return [];
  const epBy = new Map((episodes ?? []).map((e) => [e.videoId, e]));
  const rows = (videos ?? []).map((v) => ({
    v, e: epBy.get(v.videoId) ?? null, age: ageDays(v, now), v48: viewsAtAge(v, 48),
  })).filter((r) => r.age !== null);
  const isPublic = (r) => (r.v.privacy ?? 'public') === 'public';
  const base = median(rows
    .filter((r) => r.age > recentDays && r.age <= recentDays + 30 && isPublic(r) && Number.isFinite(r.v48))
    .map((r) => r.v48));
  const recent = rows.filter((r) => r.age >= 2 && r.age <= recentDays);
  const label = (r) => `${r.e?.ep ?? r.v.videoId}${r.e?.slot ? `(${r.e.slot})` : ''}`;
  const out = [];

  const buried = recent.filter((r) => r.v.privacy === 'private');
  if (buried.length) {
    out.push({
      id: 'buried_private', kpi: k.id, grade: k.grade,
      summary: `최근 ${recentDays}일 업로드 중 ${buried.length}편이 비공개로 남아 조회 0`,
      evidence: buried.map((r) => ({ ep: r.e?.ep ?? null, videoId: r.v.videoId, title: r.v.title })),
      remedy: 'R-BURIED',
    });
  }
  const zero = recent.filter((r) => isPublic(r) && Number.isFinite(r.v48) && r.v48 <= zeroViews);
  if (zero.length) {
    out.push({
      id: 'zero_distribution', kpi: k.id, grade: k.grade,
      summary: `공개인데 48시간 조회 ${zeroViews}회 이하 ${zero.length}편 — 배포가 안 됐다: ${zero.map(label).join(', ')}`,
      evidence: zero.map((r) => ({ ep: r.e?.ep ?? null, videoId: r.v.videoId, views48: r.v48, title: r.v.title })),
      remedy: 'R-ZERO-DIST',
    });
  }
  if (!base) return out;

  const pool = recent.filter((r) => isPublic(r) && Number.isFinite(r.v48) && r.v48 > zeroViews);
  const segment = (id, pick, describe, remedy) => {
    const xs = pool.filter(pick);
    if (xs.length < minSamples) return;
    const m = median(xs.map((r) => r.v48));
    const others = median(pool.filter((r) => !pick(r)).map((r) => r.v48));
    if (m / base >= ratioFloor) return;
    out.push({
      id, kpi: k.id, grade: k.grade,
      summary: `${describe} ${xs.length}편의 48h 중앙값 ${Math.round(m)} — 기준 ${Math.round(base)}의 ` +
        `${(m / base).toFixed(2)}×${others ? ` (나머지 ${Math.round(others)})` : ''}`,
      evidence: xs.map((r) => ({ ep: r.e?.ep ?? null, slot: r.e?.slot ?? null, videoId: r.v.videoId,
        views48: r.v48, durationS: r.v.duration_s, lateHours: r.e?.lateHours ?? null })),
      remedy,
    });
  };
  segment('long_format', (r) => Number(r.v.duration_s) > longSec, `${longSec}초 넘는 영상`, 'R-LONG-FORMAT');
  segment('late_publish', (r) => Number(r.e?.lateHours) >= 1, '목표 시각보다 1시간 넘게 늦게 나간 영상', 'R-LATE');
  return out;
}

/** 진단 전부. 순서 = 알림·처방 우선순위. */
export function diagnose(input) {
  return [
    ...diagnosePublishing(input),
    ...diagnoseViews48(input),
    ...diagnoseLikeRate(input),
  ];
}
