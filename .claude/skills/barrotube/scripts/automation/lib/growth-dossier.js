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
import { normalizeIndex, viewsAtAge, indexViewsAt, netDelta, recentVideos } from './growth-kpi.js';
import { kstDate, isOperatorPass, LIKE_CTA, FOLLOW_CTA } from './growth-diagnosis.js';
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

/**
 * workspace/ops/runs/<KST 날짜>/slot_<slot>[#n|@am].json 최근 days 일 → { 'slot|day': 마커 }.
 * 운영자 패스는 감사 로그가 아니라 마커(guard·operatorSkip)에만 남을 수 있다. 같은 날 재실행이 여럿이면
 * 운영자 패스인 쪽을 남긴다.
 */
export function loadRunMarkers(root, now, days = 8) {
  const out = {};
  for (let n = days; n >= 0; n--) {
    const day = kstDate(now.getTime() - n * 86400_000);
    const dir = join(root, 'workspace', 'ops', 'runs', day);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const slot = f.match(/^slot_([^#@]+?)(?:[#@][^/]*)?\.json$/)?.[1];
      const doc = slot ? loadJSON(join(dir, f)) : null;
      if (!doc) continue;
      const key = `${slot}|${day}`;
      if (!out[key] || !isOperatorPass(out[key])) out[key] = doc;
    }
  }
  return out;
}

/** 진단기·매니저 공용 사실 묶음. videos 는 normalizeIndex 결과에 slot 이 붙은 것. */
export function loadFacts(root, now) {
  const videos = normalizeIndex(loadJSON(join(root, 'workspace', 'growth', 'channel', 'videos.json'), {}), now);
  const videosById = new Map(videos.map((v) => [v.videoId, v]));
  const audit = loadAudit(root, now);
  const { episodes, cancelled } = loadEpisodes(root, audit, videosById);
  return { videos, audit, episodes, cancelled, markers: loadRunMarkers(root, now) };
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
 * 채널 데스크 — 미시 처방(대본·제목) 앞에 채널 방향(거시)을 같은 판단자가 먼저 보게 하는 사실 묶음.
 * 설계서 workspace/growth/proposals/2026-10-21-cmo-daily-desk.md (결정 수정 10-21 17:40). 산수와 경보는 여기서
 * 판정한다 — LLM 이 「경보가 났다」를 지어내거나 놓치지 않게.
 */
export const DESK = {
  zeroReach: 35,        // 48h 이 이하 = 첫 시험 노출에서 탈락한 「미배포형」
  deadReach: 10,        // 하루에 이 이하가 deadPerDay 편 이상이면 경보
  deadPerDay: 2,
  lowIndex: 0.5,        // 48h 조회 지수가 lowIndexDays 일 연속 이 미만이면 경보
  lowIndexDays: 3,
  repeatHours: 72,      // 이 시간 안에 같은 주제 repeatCount 회 이상이면 경보 (10-10~12 가계 연체 718→143→32)
  repeatCount: 3,
};

// 주제 반복은 **제목**으로 센다. 주제문(05_desk_topic.json)은 배경으로 금리·유가를 거의 매번 적어서 그걸로 세면
// 금리가 날마다 걸린다. 시청자가 「또 그 얘기」로 받는 것은 피드에 보이는 제목이다.
export const DESK_TOPICS = {
  반도체: /반도체|삼성전자|하이닉스|메모리|D램|엔비디아|마이크론|TSMC|램리서치/i,
  'AI': /(?<![A-Za-z])AI(?![A-Za-z])|인공지능|데이터센터/,
  '금리·연준': /금리|국채|10년물|연준|FOMC/,
  '유가': /유가|원유|브렌트|WTI|유조선|석유/,
  가계부채: /연체|가계|주담대/,
  환율: /환율|원\/달러|원화|달러 ?(?:강세|약세|인덱스)/,
  금: /금값|(?<![가-힣])금(?=[이은값·\s])/,
  부동산: /집값|아파트|부동산|전세|주택/,
  코인: /비트코인|가상자산|코인|이더리움/,
};

export function deskTopics(title) {
  const t = String(title ?? '').replace(/#\S+/g, '');
  return Object.entries(DESK_TOPICS).filter(([, re]) => re.test(t)).map(([k]) => k);
}

const isPublic = (v) => (v.privacy == null || v.privacy === 'public') && (v.upload_status == null || v.upload_status === 'processed');
const r1 = (x, d = 0) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

/**
 * 48h 조회. 관측 창(±6h)을 놓친 영상은 지금 조회로 본다 — 48h 조회의 상한이라 「≤35뷰」 판정은 틀리지 않는다.
 * 아직 48시간이 안 됐으면 null.
 */
function reach48(v, now) {
  const x = viewsAtAge(v, 48);
  if (Number.isFinite(x)) return x;
  const ageH = (now.getTime() - Date.parse(v.publishedAt ?? '')) / 3600_000;
  return ageH >= 48 && Number.isFinite(v.views) ? v.views : null;
}

/**
 * 데스크 사실 묶음 (순수 함수). videos 는 loadFacts 결과(slot 이 붙은 것), kpiIndex 는 { 'YYYY-MM-DD': 48h 지수 값 }.
 */
export function channelDesk({ videos, episodes = [], history = [], kpiIndex = {}, state = {}, experiment = null, config = {}, va = new Map(), now, date }) {
  const epBy = new Map(episodes.map((e) => [e.videoId, e]));
  const label = (v) => epBy.get(v.videoId)?.ep ?? v.videoId;
  const titleOf = (v) => String(epBy.get(v.videoId)?.title ?? v.title ?? '');
  const pub = videos.filter(isPublic);
  const ms = now.getTime();

  // 북극성 산수 — 순증 = 7d 조회 × 전환(/1k). KPI 와 같은 식(인덱스 조회 증분)을 판단 시각에 다시 잰다.
  const v0 = indexViewsAt(pub, now);
  const v1 = indexViewsAt(pub, new Date(ms - 7 * 86400_000));
  const views7d = v0 !== null && v1 !== null ? v0 - v1 : null;
  const published7d = recentVideos(pub, now, 7).length;
  const netSubs = netDelta(history, 'subs', now);
  const conv = netSubs !== null && views7d > 0 ? netSubs / (views7d / 1000) : null;
  const target = config.kpis?.weekly_net_subs?.green ?? 10;
  const planned = config.kpis?.publish_consistency_7d?.planned_per_week ?? null;
  const perPublish = views7d !== null && published7d ? views7d / published7d : null;
  const needViews = conv > 0 ? (target / conv) * 1000 : null;
  const needPerPublish = needViews !== null && planned ? needViews / planned : null;
  const northstar = {
    views_7d: views7d, published_7d: published7d, net_subs_7d: netSubs, subs_per_1k: r1(conv, 2),
    views_per_publish: r1(perPublish), target_net_subs: target, planned_per_week: planned,
    need_views_7d: r1(needViews), need_views_per_publish: r1(needPerPublish),
    gap_x: needPerPublish !== null && perPublish > 0 ? r1(needPerPublish / perPublish, 2) : null,
  };

  // 최근 72h 공개분 해부 — 영상 전체가 아니라 이 행들만 데스크가 본다. 비공개·처리 중 0뷰를 공개 성과와 섞지 않는다
  const since72 = ms - DESK.repeatHours * 3600_000;
  const recent = pub
    .filter((v) => { const t = Date.parse(v.publishedAt ?? ''); return t >= since72 && t <= ms; })
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
  const recent72h = recent.map((v) => {
    const v48 = viewsAtAge(v, 48);
    const topics = deskTopics(titleOf(v));
    return {
      ep: label(v), slot: v.slot ?? null, at: kst(v.publishedAt), dur: v.duration_s ?? null,
      views: Number.isFinite(v48) ? v48 : v.views,
      basis: Number.isFinite(v48) ? '48h' : `현재 ${Math.round((ms - Date.parse(v.publishedAt)) / 3600_000)}h`,
      avp: va.get(v.videoId)?.avp ?? null,
      ...(topics.length ? { topics } : {}),
      title: titleOf(v).replace(/\s*#Shorts\s*$/i, '').slice(0, 60),
    };
  });

  // 미배포형 — 최근 7일 공개분 중 48h ≤35뷰
  const matured = recentVideos(pub, now, 7).map((v) => ({ v, x: reach48(v, now) })).filter((r) => r.x !== null);
  const zero = matured.filter((r) => r.x <= DESK.zeroReach);
  const zeroReach = { window_days: 7, max_views: DESK.zeroReach, observed: matured.length, count: zero.length, eps: zero.map((r) => label(r.v)) };

  // 같은 주제 72h 반복 (2회 이상만 싣고, repeatCount 이상이면 경보)
  const byTopic = {};
  for (const v of recent) for (const t of deskTopics(titleOf(v))) (byTopic[t] ??= []).push(label(v));
  const topicRepeats = Object.entries(byTopic).filter(([, eps]) => eps.length >= 2)
    .map(([topic, eps]) => ({ topic, count: eps.length, eps })).sort((a, b) => b.count - a.count);

  // 동시에 도는 처방·실험 — 많을수록 무엇이 효과였는지 못 가른다
  const live = (state.active ?? []).filter((a) => a.status === 'active' || a.status === 'adopted').map((a) => a.remedy);
  const concurrent = { remedies: live, experiment: experiment?.id ?? null, total: live.length + (experiment?.id ? 1 : 0) };

  const alerts = [];
  const dayShift = (n) => kstDate(Date.parse(`${date}T12:00:00+09:00`) - n * 86400_000);
  const idx = Array.from({ length: DESK.lowIndexDays }, (_, i) => kpiIndex[dayShift(DESK.lowIndexDays - 1 - i)]);
  if (idx.every((x) => Number.isFinite(x) && x < DESK.lowIndex)) {
    alerts.push({ id: 'index_low', text: `48h 조회 지수 ${DESK.lowIndexDays}일 연속 <${DESK.lowIndex} (${idx.map((x) => x.toFixed(2)).join('·')})` });
  }
  // 48h 가 막 찬 공개일(그제·사흘 전)만 본다 — 같은 날을 일주일 내내 다시 울리지 않게
  for (const day of [dayShift(3), dayShift(2)]) {
    const onDay = pub.filter((v) => kstDate(Date.parse(v.publishedAt ?? '')) === day);
    const dead = onDay.filter((v) => { const x = reach48(v, now); return x !== null && x <= DESK.deadReach; });
    if (dead.length >= DESK.deadPerDay) {
      alerts.push({ id: 'dead_day', text: `${day.slice(5)} 공개 ${onDay.length}편 중 ${dead.length}편이 48h 0~${DESK.deadReach}뷰 (${dead.map(label).join(', ')})` });
    }
  }
  for (const t of topicRepeats.filter((x) => x.count >= DESK.repeatCount)) {
    alerts.push({ id: 'topic_repeat', text: `${DESK.repeatHours}h 안 「${t.topic}」 ${t.count}회 (${t.eps.join(', ')})` });
  }

  return { northstar, recent72h, zeroReach, topicRepeats, concurrent, alerts };
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

  const rawHistory = existsSync(join(growth, 'channel', 'history.jsonl'))
    ? readFileSync(join(growth, 'channel', 'history.jsonl'), 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const history = rawHistory.slice(-28).map((h) => ({ at: kst(h.at), subs: h.subs, views: h.views }));
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
  const kpiIndex = {};
  for (let n = 0; n < DESK.lowIndexDays; n++) {
    const d = kstDate(Date.parse(`${date}T12:00:00+09:00`) - n * 86400_000);
    const v = (loadJSON(join(growth, 'kpi', `${d}.json`), {})?.kpis ?? []).find((k) => k.id === 'views_48h_index_7d')?.value;
    if (Number.isFinite(v)) kpiIndex[d] = v;
  }
  let desk = null;
  try {
    desk = channelDesk({ videos, episodes, history: rawHistory, kpiIndex, state, experiment: exp.current ?? null, config, va, now, date });
  } catch (e) {
    console.warn(`⚠ 채널 데스크 자료 실패 — 기존 판단만: ${e.message}`);
  }

  return {
    date,
    north_star: config.north_star ?? 'weekly_net_subs',
    // 채널 방향(거시) — 매니저가 처방 전에 먼저 본다. 경보는 코드가 판정한 것만.
    desk,
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
