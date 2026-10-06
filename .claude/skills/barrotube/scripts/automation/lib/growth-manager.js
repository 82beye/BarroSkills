/**
 * growth-manager.js — 성장 매니저(LLM)의 지시문·출력 검증·적용 (순수 함수)
 *
 * 규칙 진단(growth-diagnosis.js)은 미리 정한 원인만 찾는다. KPI 가 계속 RED 인데 새 원인을 가설로
 * 세우고, 처방을 설계하고, 결과를 기억해 다음 판단에 쓰는 일은 규칙으로 안 된다 — 2026-10-06 운영자:
 * "KPI 성장 관리가 되지 않고 있다. 분석하고 계속 추적하면서 업데이트가 돼야 한다."
 *
 * 역할 분담
 *   매니저(LLM)  — 해석·가설·처방 설계. 출력은 JSON 하나.
 *   이 파일      — 그 JSON 을 허용된 레버·한도 안으로 거른다(validatePlan). 통과한 것만 적용한다.
 *   처방 엔진    — 효과 판정과 되돌리기(growth-remediation.js). 매니저 판단이 틀려도 숫자가 되돌린다.
 *
 * 매니저가 바꿀 수 있는 것은 생성 프롬프트에 들어가는 지시(대본·제목)와 마무리 한 문장뿐이다.
 * 포맷·편성·코드·발행 설정은 설계서(propose)로만 낸다.
 */
import { METRICS, SCRIPT_LOCKED_FORMS, activateRemedy, canActivate } from './growth-remediation.js';

export const LIMITS = {
  newAutoPerRun: 1,      // 한 번에 하나만 바꿔야 무엇이 효과였는지 가른다
  maxActiveAuto: 3,
  maxProposals: 3,
  maxHypotheses: 8,
  directive: [15, 400],
  ctaMax: 40,
  minEpisodes: [4, 10],
  maxEpisodes: 20,
  liftRange: [1.05, 1.5],
};
const TARGETS = ['script', 'metadata', 'closing'];
const STATUSES = ['open', 'supported', 'refuted'];

export function buildPrompt(dossier) {
  const system = `너는 한국어 경제 쇼츠 채널 「바로경제」의 성장 매니저다. 북극성 지표는 주간 순증 구독(weekly_net_subs)이다.
매일 저녁 자료집(JSON)을 받아 다음 세 가지를 한다.
1) 켜져 있는 처방의 진행도·끝난 처방의 판정·KPI 추이를 해석하고, 가설 장부를 갱신한다(open·supported·refuted).
2) 지금 북극성을 가장 막고 있는 병목 하나를 고르고, 그 원인 가설을 자료집의 숫자로 뒷받침한다.
3) 그 가설을 검증할 처방을 설계한다.

## 쓸 수 있는 레버
- target=script   대본 작성 지시(훅·전개·마무리 방식). 다음 회차 대본 프롬프트 맨 위에 들어간다.
- target=metadata 제목 작성 지시. 제목 생성 프롬프트에 들어간다.
- target=closing  마지막 씬에 그대로 넣을 한 문장(closing_cta). 숫자·수사 없이 ${LIMITS.ctaMax}자 이하.
- mode=auto 는 바로 켜지고, 이후 발행분으로 효과를 재서 유지·되돌림이 자동으로 정해진다(metric·min_episodes·max_episodes·keep_if_lift).
- 포맷 길이·편성·발행 시각·코드·채널 설정 변경은 mode=propose 로만 낸다. 사람이 정한다.
- 슬롯에 script_locked 가 있으면 그 포맷 대본은 계약으로 고정이라 script 처방이 들어가지 않는다. 그 포맷을 바꾸려면 propose.
- 처방 효과는 그 처방을 실제로 받은 회차(videos[].rx)로만 잰다. 받은 회차가 없으면 판정도 없다.
- videos[] 의 avp(시청 지속률 %)·avd(평균 시청 초)·subs(구독 전환)·shares 는 최근 28일 누적이다. v48 이 낮을 때
  avp 가 높으면 「노출·클릭」 쪽, avp 가 낮으면 「도입·전개」 쪽 문제로 갈라 보라. 값이 없으면 수집 전이다.

## 규칙
- 근거는 자료집에 있는 숫자로만 댄다. 자료집에 없는 수치·사실·경쟁 정보를 만들지 마라.
- 처방은 가설을 검증하는 실험이다. 원인이 확정될 때까지 기다리지 마라 — 병목을 재는 켜진 처방이 없고 되돌릴 수 있는
  레버가 있으면 auto 처방 하나를 켜라. 효과가 없으면 엔진이 되돌린다. 근거가 약하면 가설의 confidence 를 낮게 적어라.
- 새 auto 처방은 이번에 최대 ${LIMITS.newAutoPerRun}개다. 켜진 처방과 같은 지표(metric)를 같은 슬롯에서 노리면 효과를 가를 수 없으니 내지 마라.
- 진행 중인 주간 실험(experiments.current)과 같은 target 의 auto 처방은 내지 마라 — 실험과 섞인다.
- 마무리 문장(closing) 처방이 이미 켜진 슬롯에는 새 closing 처방을 내지 마라.
- 켜진 처방은 엔진이 판정한다. 네 판단으로 끄려면 retire 에 근거를 적어라(R-AI-* 만 가능).
- 지시는 작성자가 그대로 따를 수 있는 한두 문장으로. 사실 왜곡·과장·클릭베이트 금지.
  채널 제목 규칙(제목은 '왜'를 말한다, 일상 등락률을 제목의 주어로 쓰지 않는다)과 충돌하지 마라.
- 병목을 이미 켜진 처방이 재고 있거나 위 규칙 때문에 낼 처방이 없을 때만 remedies 를 비우고, 그 이유를 analysis 에 써라.

## 출력 — JSON 객체 하나만 (설명·코드펜스 없이)
{
  "summary": "텔레그램 한 줄, 80자 이내",
  "analysis": "판단 근거 3~6문장",
  "bottleneck": { "kpi": "<KPI id>", "why": "…" },
  "hypotheses": [ { "id": "H-<영문짧게>", "kpi": "<KPI id>", "statement": "…", "evidence": "자료집 숫자", "status": "open|supported|refuted", "confidence": 0.0 } ],
  "remedies": [ { "id": "R-AI-<영문짧게>", "label": "…", "mode": "auto|propose", "target": "script|metadata|closing",
                  "directive": "…", "closing_cta": "target=closing 일 때만", "slots": ["us-close"],
                  "metric": "like_rate|views48", "min_episodes": 6, "max_episodes": 14, "keep_if_lift": 1.15,
                  "hypothesis": "H-…", "rationale": "…" } ],
  "retire": [ { "id": "R-AI-…", "reason": "…" } ],
  "proposals": [ { "title": "…", "body": "…", "kpi": "…" } ]
}`;
  const user = `## 자료집 — ${dossier.date}\n\n${JSON.stringify(dossier)}\n\n위 자료집만 근거로, 출력 형식의 JSON 객체 하나만 내라.`;
  return { system, user };
}

const str = (x, max) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const clamp = (x, lo, hi, dflt) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : dflt);

/** 두 처방의 슬롯 범위가 겹치나 (슬롯이 없으면 전체). */
function overlaps(a, b) {
  const sa = Array.isArray(a) && a.length ? a : null;
  const sb = Array.isArray(b) && b.length ? b : null;
  return !sa || !sb || sa.some((s) => sb.includes(s));
}

/**
 * 매니저 출력 → 허용된 계획. 어긴 항목은 버리고 이유를 남긴다(rejected) — 매니저가 다음 날 보고 고친다.
 */
export function validatePlan(raw, { catalog, state, slots, now, experiment = null }) {
  const rejected = [];
  const reject = (item, reason) => rejected.push({ item: item?.id ?? item?.title ?? null, reason });
  const known = Object.keys(slots ?? {});
  const plan = {
    summary: str(raw?.summary, 120),
    analysis: str(raw?.analysis, 3000),
    bottleneck: raw?.bottleneck && typeof raw.bottleneck === 'object'
      ? { kpi: str(raw.bottleneck.kpi, 60), why: str(raw.bottleneck.why, 600) } : null,
    hypotheses: [], remedies: [], retire: [], proposals: [],
  };

  for (const h of (Array.isArray(raw?.hypotheses) ? raw.hypotheses : []).slice(0, LIMITS.maxHypotheses)) {
    if (!/^H-[A-Za-z0-9-]{2,40}$/.test(h?.id ?? '')) { reject(h, '가설 id 형식(H-영문)'); continue; }
    const statement = str(h.statement, 300);
    if (statement.length < 5) { reject(h, '가설 내용 없음'); continue; }
    plan.hypotheses.push({ id: h.id, kpi: str(h.kpi, 60), statement, evidence: str(h.evidence, 500),
      status: STATUSES.includes(h.status) ? h.status : 'open', confidence: clamp(h.confidence, 0, 1, 0.5) });
  }

  const live = (state?.active ?? []).filter((a) => a.status === 'active' || a.status === 'adopted')
    .map((a) => ({ id: a.remedy, def: catalog?.[a.remedy] })).filter((a) => a.def);
  let newAuto = 0;
  for (const r of Array.isArray(raw?.remedies) ? raw.remedies : []) {
    if (!/^R-AI-[A-Za-z0-9-]{2,40}$/.test(r?.id ?? '')) { reject(r, '처방 id 형식(R-AI-영문)'); continue; }
    if (catalog?.[r.id]) { reject(r, '이미 있는 처방 id'); continue; }
    const mode = r.mode === 'auto' ? 'auto' : r.mode === 'propose' ? 'propose' : null;
    if (!mode) { reject(r, 'mode 는 auto·propose'); continue; }
    if (!TARGETS.includes(r.target)) { reject(r, 'target 은 script·metadata·closing'); continue; }
    const rs = Array.isArray(r.slots) ? [...new Set(r.slots.map(String))] : [];
    if (rs.some((s) => !known.includes(s))) { reject(r, `모르는 슬롯: ${rs.filter((s) => !known.includes(s)).join(',')}`); continue; }
    const cta = r.target === 'closing' ? str(r.closing_cta, 200) : null;
    if (r.target === 'closing' && (!cta || cta.length > LIMITS.ctaMax || /\d/.test(cta))) {
      reject(r, `마무리 문장은 숫자 없이 ${LIMITS.ctaMax}자 이하`); continue;
    }
    const directive = str(r.directive, LIMITS.directive[1]) || (cta ? `마지막 씬에 「${cta}」를 문구 그대로 넣는다.` : '');
    if (directive.length < LIMITS.directive[0]) { reject(r, '지시가 너무 짧다'); continue; }
    const def = {
      label: str(r.label, 40) || r.id, mode, target: r.target, directive,
      ...(cta ? { closing_cta: cta } : {}),
      ...(rs.length ? { slots: rs } : {}),
      hypothesis: str(r.hypothesis, 60) || null, rationale: str(r.rationale, 600),
    };
    if (mode === 'auto') {
      if (!METRICS.includes(r.metric)) { reject(r, `metric 은 ${METRICS.join('·')}`); continue; }
      if (experiment?.target === r.target) { reject(r, `주간 실험 ${experiment.id} 가 같은 레버(${r.target})를 쓰는 중`); continue; }
      const locked = r.target === 'script' ? rs.filter((s) => SCRIPT_LOCKED_FORMS[slots?.[s]?.form]) : [];
      if (locked.length) { reject(r, `${locked.join(',')} 는 대본 고정 포맷(${slots[locked[0]].form}) — 대본 처방은 propose 로`); continue; }
      if (newAuto >= LIMITS.newAutoPerRun) { reject(r, `새 auto 처방은 한 번에 ${LIMITS.newAutoPerRun}개`); continue; }
      if (live.length + newAuto >= LIMITS.maxActiveAuto) { reject(r, `켜진 처방이 이미 ${LIMITS.maxActiveAuto}개`); continue; }
      const sameMetric = live.find((a) => a.def.eval?.metric === r.metric && overlaps(a.def.slots, rs));
      if (sameMetric) { reject(r, `같은 지표(${r.metric})를 ${sameMetric.id} 가 이미 재고 있다`); continue; }
      const sameClosing = cta && live.find((a) => a.def.closing_cta && overlaps(a.def.slots, rs));
      if (sameClosing) { reject(r, `마무리 문장 처방 ${sameClosing.id} 가 이미 켜져 있다`); continue; }
      const minE = Math.round(clamp(r.min_episodes, LIMITS.minEpisodes[0], LIMITS.minEpisodes[1], 6));
      def.eval = {
        metric: r.metric, min_episodes: minE,
        max_episodes: Math.round(clamp(r.max_episodes, minE + 2, LIMITS.maxEpisodes, minE + 8)),
        keep_if_lift: Number(clamp(r.keep_if_lift, LIMITS.liftRange[0], LIMITS.liftRange[1], 1.15).toFixed(2)),
      };
      def.cooldown_days = 14;
      if (!canActivate(state, r.id, def, now)) { reject(r, '되돌린 뒤 쉬는 중'); continue; }
      newAuto += 1;
    }
    plan.remedies.push({ id: r.id, def });
  }

  for (const x of Array.isArray(raw?.retire) ? raw.retire : []) {
    if (!/^R-AI-/.test(x?.id ?? '') || !live.some((a) => a.id === x.id)) { reject(x, '끌 수 있는 것은 켜진 R-AI-* 뿐'); continue; }
    plan.retire.push({ id: x.id, reason: str(x.reason, 300) || '매니저 판단' });
  }
  for (const p of (Array.isArray(raw?.proposals) ? raw.proposals : []).slice(0, LIMITS.maxProposals)) {
    const title = str(p?.title, 80);
    if (!title) { reject(p, '제안 제목 없음'); continue; }
    plan.proposals.push({ title, body: str(p.body, 2000), kpi: str(p.kpi, 60) });
  }
  return { plan, rejected };
}

/** 검증된 계획을 상태에 반영한다. 입력은 바꾸지 않는다. */
export function applyPlan(plan, { dynamic, state, strategy, videos, now, date }) {
  const d = structuredClone(dynamic ?? {});
  const s = structuredClone(state);
  s.active ??= [];
  s.history ??= [];
  const st = structuredClone(strategy ?? {});
  st.hypotheses ??= {};
  st.journal ??= [];
  const at = now.toISOString();
  const events = [];
  const proposals = [];

  for (const h of plan.hypotheses) {
    const prev = st.hypotheses[h.id];
    // 같은 날 다시 판단하면(--force) 그날 기록을 갈아 끼운다
    st.hypotheses[h.id] = { ...h, first_seen: prev?.first_seen ?? date, updated: date,
      history: [...(prev?.history ?? []).filter((x) => x.date !== date), { date, status: h.status, confidence: h.confidence }].slice(-20) };
  }
  for (const r of plan.retire) {
    const a = s.active.find((x) => x.remedy === r.id);
    if (!a) continue;
    s.active = s.active.filter((x) => x !== a);
    s.history.push({ ...a, ended_at: at, verdict: 'retired', result: { reason: r.reason } });
    events.push({ at, remedy: r.id, transition: 'retired', reason: r.reason, by: 'growth-manager' });
  }
  for (const { id, def } of plan.remedies) {
    d[id] = { ...def, created: date, created_by: 'growth-manager' };
    if (def.mode === 'auto') {
      events.push({ ...activateRemedy(s, id, d[id], { videos, now, reason: def.rationale, finding: def.hypothesis }), by: 'growth-manager' });
    } else {
      proposals.push({ id, title: def.label, body: `${def.directive}\n\n${def.rationale ?? ''}`.trim(), kpi: def.eval?.metric ?? '' });
    }
  }
  proposals.push(...plan.proposals.map((p, i) => ({ id: `P${i + 1}`, ...p })));   // 파일명 앞에 날짜가 붙는다
  st.journal = [...st.journal.filter((j) => j.date !== date), { date, summary: plan.summary, bottleneck: plan.bottleneck?.kpi ?? null }].slice(-60);
  return { dynamic: d, state: s, strategy: st, events, proposals };
}

/** 하루 일지(마크다운). 사람이 매니저의 판단을 따라가며 검토할 수 있게 근거·결정·거절을 남긴다. */
export function journalMarkdown({ date, plan, rejected, events, progress, engine }) {
  const lines = [`# 성장 매니저 일지 — ${date}`, '', `> ${plan.summary || '(요약 없음)'}`, '', `엔진: ${engine ?? '—'}`, ''];
  if (plan.bottleneck?.kpi) lines.push('## 병목', '', `- **${plan.bottleneck.kpi}** — ${plan.bottleneck.why}`, '');
  if (plan.analysis) lines.push('## 판단', '', plan.analysis, '');
  if (progress?.length) {
    lines.push('## 켜진 처방 경과', '');
    for (const p of progress) {
      const lift = p.progress?.lift != null ? ` · ${p.progress.lift.toFixed(2)}×` : '';
      lines.push(`- ${p.id} (${p.status}) ${p.progress ? `${p.progress.episodes}/${p.progress.need}편${lift}` : '판정 지표 없음'}`);
    }
    lines.push('');
  }
  if (plan.hypotheses.length) {
    lines.push('## 가설', '', '| id | KPI | 상태 | 확신 | 내용 | 근거 |', '|---|---|---|---|---|---|');
    for (const h of plan.hypotheses) lines.push(`| ${h.id} | ${h.kpi} | ${h.status} | ${h.confidence} | ${h.statement.replace(/\|/g, '/')} | ${h.evidence.replace(/\|/g, '/')} |`);
    lines.push('');
  }
  if (plan.remedies.length || plan.retire.length || events.length) {
    lines.push('## 결정', '');
    for (const { id, def } of plan.remedies) {
      lines.push(`- ${def.mode === 'auto' ? '켬' : '설계서'}: **${id}** ${def.label} (${def.target}${def.slots ? ` · ${def.slots.join(',')}` : ''}${def.eval ? ` · ${def.eval.metric} ≥${def.eval.keep_if_lift}× @${def.eval.min_episodes}편` : ''}) — ${def.directive}`);
    }
    for (const r of plan.retire) lines.push(`- 끔: **${r.id}** — ${r.reason}`);
    lines.push('');
  }
  if (rejected.length) {
    lines.push('## 거른 것 (한도·규칙 위반)', '');
    for (const r of rejected) lines.push(`- ${r.item ?? '?'}: ${r.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 텔레그램 한 덩어리(평문 — 호출자가 HTML 이스케이프). */
export function telegramText({ date, plan, events, proposals, progress }) {
  const lines = [`📈 성장 매니저 — ${date}`, plan.summary || '(요약 없음)'];
  if (plan.bottleneck?.kpi) lines.push(`병목: ${plan.bottleneck.kpi}`);
  for (const e of events) {
    if (e.transition === 'activated') lines.push(`🩹 새 처방 켬: ${e.remedy}`);
    if (e.transition === 'retired') lines.push(`⏹ 처방 끔: ${e.remedy} — ${e.reason ?? ''}`);
  }
  for (const p of progress ?? []) {
    if (p.progress) lines.push(`· ${p.id} ${p.progress.episodes}/${p.progress.need}편${p.progress.lift != null ? ` ${p.progress.lift.toFixed(2)}×` : ''}`);
  }
  if (proposals.length) lines.push(`📝 설계서 ${proposals.length}건: ${proposals.map((p) => p.title).join(', ')}`);
  lines.push(`일지: growth/journal/${date}.md`);
  return lines.join('\n');
}

