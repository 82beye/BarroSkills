/**
 * growth-dossier.js — 진단기(규칙)와 성장 매니저(판단)가 함께 보는 사실 적재기
 *
 * 둘이 서로 다른 데이터를 보면 매니저가 진단과 다른 세계를 상대로 처방한다. 그래서 파일 읽기는
 * 여기 한곳에 둔다. 해석은 하지 않는다 — 진단은 growth-diagnosis.js, 판단은 growth-manager.js 몫이다.
 * 네트워크 없음 · LLM 없음.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { normalizeIndex, viewsAtAge } from './growth-kpi.js';
import { kstDate, LIKE_CTA, FOLLOW_CTA } from './growth-diagnosis.js';
import { classifyTitle } from './title-types.js';
import { loadCatalog, emptyState, remedyProgress, SCRIPT_LOCKED_FORMS } from './growth-remediation.js';

export function loadJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

/** logs/audit/<KST 날짜>.jsonl 최근 days 일. 깨진 줄은 건너뛴다. */
export function loadAudit(root, now, days = 31) {
  const rows = [];
  for (let n = days; n >= 0; n--) {
    const f = join(root, 'logs', 'audit', `${kstDate(now.getTime() - n * 86400_000)}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return rows;
}

/**
 * Analytics 영상별 리포트(columnHeaders/rows) → videoId → {avp 시청 지속률 %, avd 평균 시청 초, subs 구독 전환, shares}.
 * 28일 누적이다. 빈 리포트면 빈 Map.
 */
export function videoAnalyticsIndex(report) {
  const cols = (report?.columnHeaders ?? []).map((c) => c.name);
  const at = (name) => cols.indexOf(name);
  const out = new Map();
  if (at('video') < 0) return out;
  for (const r of report.rows ?? []) {
    const num = (name) => (at(name) >= 0 && Number.isFinite(Number(r[at(name)])) ? Number(r[at(name)]) : null);
    out.set(r[at('video')], {
      avp: num('averageViewPercentage') == null ? null : Math.round(num('averageViewPercentage') * 10) / 10,
      avd: num('averageViewDuration'), subs: num('subscribersGained'), shares: num('shares'),
    });
  }
  return out;
}

/** workspace/growth/incidents.jsonl 최근 days 일 — 장애 분석 요약만(설계서 본문은 incidents/<id>.md). */
export function recentIncidents(growth, now, days = 14) {
  const f = join(growth, 'incidents.jsonl');
  if (!existsSync(f)) return [];
  const since = now.getTime() - days * 86400_000;
  const rows = readFileSync(f, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  // 처리 기록({type:'resolution', id, status, note})은 같은 원장에 덧붙인다 — 고친 장애를 매니저가 다시 올리지 않게.
  const resolution = new Map(rows.filter((r) => r.type === 'resolution').map((r) => [r.id, r]));
  return rows
    .filter((r) => r.type !== 'resolution' && Date.parse(r.at) >= since)
    .slice(-12)
    .map((r) => ({ id: r.id, at: r.at?.slice(0, 16), ep: r.ep, slot: r.slot, stage: r.stage, class: r.class,
      root_cause: String(r.root_cause ?? '').slice(0, 300), files: r.files ?? [],
      resolution: resolution.has(r.id) ? `${resolution.get(r.id).status}: ${String(resolution.get(r.id).note ?? '').slice(0, 160)}` : null }));
}

/** 대본에서 훅 첫 문장·마무리 문장·포맷을 뽑는다. */
function scriptFacts(scriptPath) {
  if (!existsSync(scriptPath)) return {};
  const fm = readFileSync(scriptPath, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  try {
    const meta = parseYAML(fm[1]);
    const scenes = Array.isArray(meta?.scenes) ? meta.scenes : [];
    const first = String(scenes[0]?.narration ?? '').split(/(?<=[.!?。])\s+/)[0];
    return {
      closing: typeof scenes.at(-1)?.narration === 'string' ? scenes.at(-1).narration : null,
      hook: first || null,
      form: meta?.form ?? null,
      remedies: Array.isArray(meta?.growth_remedies) ? meta.growth_remedies : [],
    };
  } catch {
    return {};
  }
}

/**
 * 발행된 에피소드 목록과 취소된 EP. 슬롯은 감사 로그의 slot=… ep=… 에서 찾는다.
 * videosById 의 영상에는 slot·form·remedies(실제로 받은 처방)를 붙여 둔다 — 처방 판정이 이 값을 쓴다.
 */
export function loadEpisodes(root, audit, videosById) {
  const epDir = join(root, 'workspace', 'episodes');
  const slotOf = new Map();
  for (const r of audit) {
    const m = String(r.detail ?? '').match(/^slot=(\S+).*?\bep=(EP-\d{4}-\d{4})/);
    if (m && !slotOf.has(m[2])) slotOf.set(m[2], m[1]);
  }
  const episodes = [];
  const cancelled = {};
  if (!existsSync(epDir)) return { episodes, cancelled };
  for (const ep of readdirSync(epDir).filter((d) => /^EP-\d{4}-\d{4}$/.test(d))) {
    const status = loadJSON(join(epDir, ep, '.episode_status.json'), {});
    if (status?.status === 'cancelled') cancelled[ep] = String(status.cancel_reason ?? '취소');
    const dirs = existsSync(join(epDir, ep, 'platforms'))
      ? readdirSync(join(epDir, ep, 'platforms')).map((p) => join(epDir, ep, 'platforms', p))
      : [];
    for (const dir of [...dirs, join(epDir, ep)]) {
      const vid = loadJSON(join(dir, '80_publish_result.json'))?.targets?.youtube?.videoId;
      if (!vid) continue;
      const meta = loadJSON(join(dir, '70_publish_meta.json'), {}) ?? {};
      const facts = scriptFacts(join(dir, '30_script.md'));
      const v = videosById.get(vid);
      const slot = slotOf.get(ep) ?? null;
      // 대본(대본·마무리 처방)과 메타(제목 처방)가 각자 받은 처방을 남긴다
      const remedies = [...new Set([...(facts.remedies ?? []), ...(Array.isArray(meta.growth_remedies) ? meta.growth_remedies : [])])];
      if (v) Object.assign(v, { slot, form: facts.form ?? null, remedies });
      episodes.push({
        videoId: vid, ep, slot,
        publishedAt: v?.publishedAt ?? null, durationS: v?.duration_s ?? null, privacy: v?.privacy ?? null,
        lateHours: meta.publish_late?.hours_late ?? null,
        closing: facts.closing ?? null, hook: facts.hook ?? null, form: facts.form ?? null,
        title: meta.title ?? v?.title ?? null, remedies,
      });
      break;
    }
  }
  return { episodes, cancelled };
}

/** 진단기·매니저 공용 사실 묶음. videos 는 normalizeIndex 결과에 slot 이 붙은 것. */
export function loadFacts(root, now) {
  const videos = normalizeIndex(loadJSON(join(root, 'workspace', 'growth', 'channel', 'videos.json'), {}), now);
  const videosById = new Map(videos.map((v) => [v.videoId, v]));
  const audit = loadAudit(root, now);
  const { episodes, cancelled } = loadEpisodes(root, audit, videosById);
  return { videos, audit, episodes, cancelled };
}

const pct = (x, d = 2) => (Number.isFinite(x) ? Number((x * 100).toFixed(d)) : null);
const kst = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? new Date(t + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') : null;
};

/** 최근 days 일 KPI 값 추이 — 매니저가 「좋아지고 있나」를 판단하는 축. */
export function kpiTrend(root, date, days = 14) {
  const out = [];
  for (let n = days - 1; n >= 0; n--) {
    const d = kstDate(Date.parse(`${date}T12:00:00+09:00`) - n * 86400_000);
    const doc = loadJSON(join(root, 'workspace', 'growth', 'kpi', `${d}.json`));
    if (!doc) continue;
    out.push({ date: d, overall: doc.overall,
      kpis: Object.fromEntries((doc.kpis ?? []).map((k) => [k.id, k.display ?? k.value])) });
  }
  return out;
}

/**
 * 성장 매니저에게 넘길 자료집. 토큰을 아끼려고 영상은 한 줄 객체로 줄이고, 처방은 진행도를 붙인다.
 */
export function buildDossier({ root, date, now, slots }) {
  const growth = join(root, 'workspace', 'growth');
  const { videos, episodes } = loadFacts(root, now);
  const epBy = new Map(episodes.map((e) => [e.videoId, e]));
  const vaFile = existsSync(join(growth, 'channel'))
    ? readdirSync(join(growth, 'channel')).filter((f) => /^video-analytics-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1)
    : null;
  const va = videoAnalyticsIndex(vaFile ? loadJSON(join(growth, 'channel', vaFile), {}) : {});
  const cutoff = now.getTime() - 30 * 86400_000;
  const rows = videos
    .filter((v) => Date.parse(v.publishedAt ?? '') >= cutoff)
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)))
    .map((v) => {
      const e = epBy.get(v.videoId) ?? {};
      const v48 = viewsAtAge(v, 48);
      return {
        ep: e.ep ?? null, slot: e.slot ?? null, form: e.form ?? null, at: kst(v.publishedAt),
        dur: v.duration_s, privacy: v.privacy, late: e.lateHours ?? null,
        v48: Number.isFinite(v48) ? v48 : null, views: v.views, likes: v.likes,
        likePct: v.views > 0 ? pct((v.likes ?? 0) / v.views) : null,
        titleType: classifyTitle(e.title ?? v.title ?? '')?.primary ?? null, title: String(e.title ?? v.title ?? '').slice(0, 70),
        hook: e.hook ? String(e.hook).slice(0, 70) : null,
        cta: e.closing ? { like: LIKE_CTA.test(e.closing), follow: FOLLOW_CTA.test(e.closing) } : null,
        rx: e.remedies?.length ? e.remedies : null,
        // 28일 누적 영상별 지표 — 있으면만 (Analytics 스코프 없을 때는 빠진다)
        ...(va.get(v.videoId) ?? {}),
      };
    });

  const history = existsSync(join(growth, 'channel', 'history.jsonl'))
    ? readFileSync(join(growth, 'channel', 'history.jsonl'), 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-28)
      .map((h) => ({ at: kst(h.at), subs: h.subs, views: h.views }))
    : [];
  const analyticsFile = existsSync(join(growth, 'channel'))
    ? readdirSync(join(growth, 'channel')).filter((f) => /^analytics-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1)
    : null;
  const analytics = analyticsFile ? loadJSON(join(growth, 'channel', analyticsFile), {}) : {};
  const cols = (analytics?.columnHeaders ?? []).map((c) => c.name);
  const daily = (analytics?.rows ?? []).slice(-14).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

  const catalog = loadCatalog(root);
  const state = loadJSON(join(growth, 'remediations.json'), emptyState());
  const remedies = {
    active: (state.active ?? []).map((a) => ({
      id: a.remedy, status: a.status, since: a.started_at?.slice(0, 10), label: catalog[a.remedy]?.label ?? null,
      scope: catalog[a.remedy]?.slots ?? 'all', metric: catalog[a.remedy]?.eval?.metric ?? null,
      baseline: a.baseline, progress: remedyProgress(a, catalog[a.remedy], videos, now),
    })),
    ended: (state.history ?? []).slice(-10).map((h) => ({
      id: h.remedy, verdict: h.verdict, ended: h.ended_at?.slice(0, 10), result: h.result ?? null,
      label: catalog[h.remedy]?.label ?? null,
    })),
    resolved: state.resolved ?? [],
  };
  const strategy = loadJSON(join(growth, 'strategy.json'), { hypotheses: {}, journal: [] });
  const exp = loadJSON(join(growth, 'experiments.json'), {});
  const diagnosis = loadJSON(join(growth, 'diagnosis', `${date}.json`), {});
  const config = loadJSON(join(root, 'config', 'growth.json'), {});

  return {
    date,
    north_star: config.north_star ?? 'weekly_net_subs',
    kpi_today: (loadJSON(join(growth, 'kpi', `${date}.json`), {})?.kpis ?? [])
      .map((k) => ({ id: k.id, label: k.label, value: k.display, grade: k.grade })),
    kpi_trend: kpiTrend(root, date),
    slots: Object.fromEntries(Object.entries(slots ?? {}).map(([k, v]) => [k, { cron: v.cron, publish_at: v.publish_at, form: v.form ?? null,
      ...(SCRIPT_LOCKED_FORMS[v.form] ? { script_locked: SCRIPT_LOCKED_FORMS[v.form] } : {}) }])),
    videos: rows,
    channel_history: history,
    analytics_daily: daily,
    diagnosis: (diagnosis.findings ?? []).map((f) => ({ id: f.id, kpi: f.kpi, summary: f.summary })),
    // 회차가 멈출 때마다 incident-analyze.js 가 남긴 원인·수정 설계 (2026-10-07). 발행 일관성 판단이
    // 「누락 N회」 숫자가 아니라 「무엇이 왜 막혔고 무엇을 고치면 되는지」를 보게 한다.
    incidents: recentIncidents(growth, now),
    remedies,
    experiments: { current: exp.current ?? null, recent: (exp.history ?? []).slice(-3).map((h) => ({ id: h.id, verdict: h.verdict, directive: h.directive })) },
    hypotheses: Object.values(strategy.hypotheses ?? {}).slice(-20),
    journal: (strategy.journal ?? []).slice(-7),
  };
}
