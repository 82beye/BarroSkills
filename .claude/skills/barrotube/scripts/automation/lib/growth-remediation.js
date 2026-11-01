/**
 * growth-remediation.js — 처방을 켜고, 켜 둔 처방의 효과를 판정한다 (결정론)
 *
 * 처방의 정의(무엇을 바꾸나·언제 판정하나)는 두 곳에 있다:
 *   config/growth.json remedies             — 사람이 정한 고정 처방 (진단 규칙이 켠다)
 *   workspace/growth/remedies-dynamic.json  — 성장 매니저(LLM)가 설계한 처방 (R-AI-*)
 * 실제로 켜져 있는 처방은 workspace/growth/remediations.json(런타임)에 있다.
 * 누가 설계했든 판정은 여기서 같은 자로 한다 — 매니저의 판단이 틀려도 숫자가 되돌린다.
 *
 * mode
 *   auto    — 콘텐츠 레버(대본·제목 지시, 마무리 문장). 켜고, 이후 발행분으로 효과를 재서
 *             유지(adopted)하거나 되돌린다(reverted). 되돌린 처방은 cooldown_days 동안 다시 켜지 않는다.
 *   propose — 운영자 결정이나 코드 수정이 필요한 것. 근거를 붙인 설계서를 남기고 알린다.
 *   notify  — 알릴 사실(배포 안 된 영상 등). 알림만.
 *   propose·notify 는 같은 진단을 resend_days 마다 한 번만 다시 알린다.
 *
 * 처방 정의의 선택 필드
 *   slots: ['us-close', …]  적용 슬롯 (없으면 전체). 효과도 그 슬롯 영상으로만 잰다.
 *   target: 'script'|'metadata'|'closing'  지시가 들어갈 자리 (closing 은 closing_cta 문장)
 *   eval: { metric: 'like_rate'|'views48', min_episodes, max_episodes, keep_if_lift }
 *         min_episodes 편이 쌓이면 판정한다 — lift ≥ keep_if_lift 면 adopted, 아니면 reverted.
 *
 * 효과는 처방이 **실제로 들어간 회차**로만 잰다. 생성기가 대본(30_script.md)·메타(70_publish_meta.json)에
 * growth_remedies 로 받은 처방을 남기고, 판정은 그 기록이 있는 영상만 센다 — 켜기 전에 만든 대본이 켠 뒤에
 * 발행되거나(10-06 EP-0213), 처방을 안 읽는 포맷(미국 증시 요약)이 섞이면 효과가 엉뚱하게 재진다.
 *
 * 상태
 *   { active:    [{ remedy, finding, kpi, started_at, baseline, status: 'active'|'adopted', ... }],
 *     history:   [{ ...active 항목, ended_at, verdict: 'reverted'|'retired', result }],
 *     proposals: { <finding id>: { first, last_sent, count } },
 *     resolved:  [{ cause, resolved_at, note }] }   ← 고친 원인. 진단이 그 뒤의 재발만 센다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { viewsAtAge } from './growth-kpi.js';

const DAY_MS = 86400_000;
const STALE_DAYS = 21;
export const METRICS = ['like_rate', 'views48'];

/** 대본이 포맷 계약으로 고정돼 대본 처방(target=script)을 읽지 않는 포맷. 정본: generate-summary-script.js. */
export const SCRIPT_LOCKED_FORMS = {
  'market-summary': '대본 고정(씬 1 「… 미국 증시 요약입니다」·통신사 브리핑체·질문 금지) — 대본 처방이 들어가지 않는다. '
    + '바꾸려면 propose. 일·월요일·미국 휴장 다음 날은 일반 쇼츠로 가서 대본 처방을 받는다.',
};

const targetOf = (def) => def?.target ?? (def?.closing_cta ? 'closing' : 'script');

export function emptyState() {
  return { active: [], history: [], proposals: {}, resolved: [] };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 처방이 그 슬롯에 적용되나. slot 을 모르면(생성기 밖) 적용으로 본다. */
export function appliesTo(def, slot) {
  const slots = def?.slots;
  return !Array.isArray(slots) || !slots.length || slot == null || slots.includes(slot);
}

/**
 * 그 영상이 이 처방을 받을 수 있던 회차인가 — 기준선과 적용 후를 같은 모집단으로 맞춘다.
 * 슬롯이 정해진 처방은 그 슬롯 영상만(슬롯 모르는 영상은 뺀다), 대본 처방은 대본 고정 포맷을 뺀다.
 */
function eligible(def) {
  const slots = Array.isArray(def?.slots) && def.slots.length ? def.slots : null;
  const script = targetOf(def) === 'script';
  return (v) => (!slots || slots.includes(v.slot)) && !(script && SCRIPT_LOCKED_FORMS[v.form]);
}

/**
 * 처방이 재는 지표. 발행 후 minAgeHours 가 지난 공개 영상만 센다 — 갓 올라온 편은 조회·좋아요가
 * 덜 붙어 효과를 깎아 먹는다.
 *   like_rate — Σ좋아요/Σ조회
 *   views48   — 게시 48시간 시점 조회의 중앙값 (Shorts 는 이틀 안에 승부가 난다)
 */
export function measure(metric, videos, { from = -Infinity, to = Infinity, now, minAgeHours = 48, filter = () => true } = {}) {
  let num = 0;
  let den = 0;
  const xs = [];
  for (const v of videos ?? []) {
    const t = Date.parse(v.publishedAt ?? '');
    if (!Number.isFinite(t) || t < from || t >= to) continue;
    if ((v.privacy ?? 'public') !== 'public' || !filter(v)) continue;
    if ((now.getTime() - t) / 3600_000 < minAgeHours) continue;
    if (metric === 'like_rate') {
      if (!Number.isFinite(v.views) || v.views <= 0) continue;
      num += Number(v.likes) || 0;
      den += v.views;
      xs.push(1);
    } else if (metric === 'views48') {
      const x = viewsAtAge(v, 48);
      if (Number.isFinite(x)) xs.push(x);
    }
  }
  if (metric === 'like_rate') return { value: den > 0 ? num / den : null, episodes: xs.length };
  return { value: median(xs), episodes: xs.length };
}

/** 켜진 처방의 진행도 — 매니저 자료집과 알림이 쓴다. 적용 후는 그 처방을 실제로 받은 회차만 센다. */
export function remedyProgress(entry, def, videos, now) {
  if (!entry || !def?.eval) return null;
  const ok = eligible(def);
  const after = measure(def.eval.metric, videos, { from: Date.parse(entry.started_at), now,
    filter: (v) => ok(v) && (v.remedies ?? []).includes(entry.remedy) });
  const base = entry.baseline?.value;
  return {
    metric: def.eval.metric, episodes: after.episodes, need: def.eval.min_episodes, value: after.value,
    lift: after.value != null && base > 0 ? after.value / base : null,
  };
}

/** 처방 하나를 켠다. 기준선은 직전 baselineDays 일의 같은 범위 영상. */
export function activateRemedy(state, id, def, { videos, now, reason = '', finding = null, kpi = null, baselineDays = 14 }) {
  const at = now.toISOString();
  const baseline = def?.eval
    ? measure(def.eval.metric, videos, { from: now.getTime() - baselineDays * DAY_MS, to: now.getTime(), now, filter: eligible(def) })
    : null;
  const entry = { remedy: id, finding, kpi, started_at: at, baseline, status: 'active', reason };
  state.active.push(entry);
  return { at, remedy: id, transition: 'activated', finding, baseline };
}

/** 같은 처방을 지금 켤 수 있나 — 이미 켜져 있거나 되돌린 뒤 cooldown 중이면 아니다. */
export function canActivate(state, id, def, now) {
  if ((state.active ?? []).some((a) => a.remedy === id)) return false;
  return !(state.history ?? []).some((h) => h.remedy === id && h.verdict === 'reverted'
    && now.getTime() - Date.parse(h.ended_at) < (def?.cooldown_days ?? 14) * DAY_MS);
}

/** 진단 + 현재 상태 → 새 상태, 상태 전이 기록(events), 이번에 알릴 것(outbox). */
export function planRemediation({ findings, state, catalog, videos, now, baselineDays = 14 }) {
  const s = structuredClone(state ?? emptyState());
  s.active ??= [];
  s.history ??= [];
  s.proposals ??= {};
  s.resolved ??= [];
  const at = now.toISOString();
  const events = [];
  const outbox = [];

  // 1) 켜져 있는 처방의 효과 판정
  for (const a of [...s.active]) {
    const def = catalog?.[a.remedy];
    if (!def) {
      s.active = s.active.filter((x) => x !== a);
      s.history.push({ ...a, ended_at: at, verdict: 'retired', result: null });
      events.push({ at, remedy: a.remedy, transition: 'retired' });
      continue;
    }
    if (a.status !== 'active' || !def.eval) continue;
    const p = remedyProgress(a, def, videos, now);
    if (!p) continue;
    // 3주 동안 한 편도 안 들어갔으면 적용 경로가 없는 처방이다 — 판정도 못 하면서 자리만 차지하지 않게 내린다
    if (p.episodes === 0 && now.getTime() - Date.parse(a.started_at) > STALE_DAYS * DAY_MS) {
      s.active = s.active.filter((x) => x !== a);
      s.history.push({ ...a, ended_at: at, verdict: 'retired', result: { reason: 'not_applied', ...p } });
      events.push({ at, remedy: a.remedy, transition: 'retired', reason: 'not_applied' });
      outbox.push({ kind: 'stale', remedy: a.remedy, def });
      continue;
    }
    if (p.lift === null || p.episodes < def.eval.min_episodes) continue;
    if (p.lift >= def.eval.keep_if_lift) {
      a.status = 'adopted';
      a.adopted_at = at;
      a.result = p;
      events.push({ at, remedy: a.remedy, transition: 'adopted', ...p });
      outbox.push({ kind: 'adopted', remedy: a.remedy, def, lift: p.lift });
    } else {
      // min_episodes 를 채우고도 기준에 못 미치면 되돌린다. max_episodes 까지 기다리지 않는다 —
      // 48h 조회는 관측 이력이 잘려 오래된 회차가 빠지므로 14편에 닿지 못했다(2026-10-22 YOU-552: kr-cause-first 0.08×가 계속 active)
      s.active = s.active.filter((x) => x !== a);
      s.history.push({ ...a, ended_at: at, verdict: 'reverted', result: p });
      events.push({ at, remedy: a.remedy, transition: 'reverted', ...p });
      outbox.push({ kind: 'reverted', remedy: a.remedy, def, lift: p.lift });
    }
  }

  // 2) 새 진단 → 처방
  for (const f of findings ?? []) {
    const def = catalog?.[f.remedy];
    if (!def) continue;
    if (def.mode === 'auto') {
      if (!canActivate(s, f.remedy, def, now)) continue;
      events.push(activateRemedy(s, f.remedy, def, { videos, now, reason: f.summary, finding: f.id, kpi: f.kpi, baselineDays }));
      outbox.push({ kind: 'applied', remedy: f.remedy, def, finding: f });
      continue;
    }
    const p = s.proposals[f.id];
    if (p && now.getTime() - Date.parse(p.last_sent) < (def.resend_days ?? 7) * DAY_MS) continue;
    s.proposals[f.id] = { first: p?.first ?? at, last_sent: at, count: (p?.count ?? 0) + 1 };
    outbox.push({ kind: def.mode, remedy: f.remedy, def, finding: f });
  }
  return { state: s, events, outbox };
}

/** 고정 처방(config) + 매니저 처방(workspace). 이름이 겹치면 고정 처방이 이긴다. */
export function loadCatalog(root) {
  const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
  const fixed = { ...(read(join(root, 'config', 'growth.json'))?.remedies ?? {}) };
  delete fixed._comment;
  const p = join(root, 'workspace', 'growth', 'remedies-dynamic.json');
  const dynamic = existsSync(p) ? (read(p) ?? {}) : {};
  return { ...dynamic, ...fixed };
}

/** 켜져 있는(active·adopted) 처방과 그 정의. slot 을 주면 그 슬롯에 적용되는 것만. */
export function activeRemedies(state, catalog, { slot } = {}) {
  return (state?.active ?? [])
    .filter((a) => a.status === 'active' || a.status === 'adopted')
    .map((a) => ({ ...a, def: catalog?.[a.remedy] }))
    .filter((a) => a.def && appliesTo(a.def, slot));
}

/**
 * 이 회차가 실제로 받은 처방 id — 생성기가 frontmatter·메타의 growth_remedies 로 남긴다.
 * script·metadata 는 지시가 프롬프트(성장 지시 파일)에 들어갔을 때, closing 은 마무리 문장이 마지막 씬에 있을 때.
 * targets 는 그 생성기가 반영하는 자리만 준다(요약 대본 생성기는 closing 만).
 */
export function remediesApplied(remedies, { targets, prompt = '', scenes = [] }) {
  const last = String(scenes.at(-1)?.narration ?? '');
  return (remedies ?? []).filter((r) => {
    const t = targetOf(r.def);
    if (!targets.includes(t)) return false;
    if (t === 'closing') return Boolean(r.def.closing_cta) && last.includes(r.def.closing_cta.replace(/[.!?。]\s*$/, ''));
    return prompt.includes(`[${r.remedy} · `);
  }).map((r) => r.remedy);
}

/** 대본 마무리에 넣을 문장. 켜진 처방이 없으면 null. */
export function closingCtaOf(remedies) {
  return (remedies ?? []).map((r) => r.def?.closing_cta).find(Boolean) ?? null;
}

/** 생성기·처방 생성기가 쓰는 로더. 파일이 없거나 깨지면 처방 없음 — 처방 부재가 회차를 세우면 안 된다. */
export function readActiveRemedies(root, { slot } = {}) {
  try {
    const p = join(root, 'workspace', 'growth', 'remediations.json');
    const state = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : emptyState();
    return activeRemedies(state, loadCatalog(root), { slot });
  } catch {
    return [];
  }
}

// 문장 끝 뒤 공백, 또는 자막에서 쓰는 " | " 에서 나눈다. 나눈 자리(캡처)는 그대로 살려 다시 잇는다.
const BOUNDARY = /((?<=[.!?。])\s+|\s+\|\s+)/;
const DISCLAIMER = /투자 조언|투자 판단|책임은 본인|본인의 판단/;

/**
 * 마지막 씬에 처방 문장을 결정론으로 넣는다. 모델이 지시를 빼먹어도 처방이 실제로 반영되게.
 * 팔로우·구독 안내 바로 앞에, 없으면 면책 문장 앞에, 둘 다 없으면 끝에 둔다.
 * subtitle_text 도 같은 자리에 넣는다 — 렌더러가 자막을 씬 시간에 나눠 띄우므로
 * 맨 앞에 붙으면 목소리보다 먼저 뜬다. 이미 들어 있으면 손대지 않는다. 바꿨으면 true.
 */
export function ensureClosingCta(scenes, cta) {
  if (!cta || !Array.isArray(scenes) || !scenes.length) return false;
  const last = scenes[scenes.length - 1];
  const key = cta.replace(/[.!?。]\s*$/, '');
  if (String(last.narration ?? '').includes(key)) return false;
  const put = (text) => {
    const raw = String(text ?? '').trim();
    const pieces = raw.split(BOUNDARY);              // [문장, 구분, 문장, 구분, …]
    const segs = pieces.filter((_, i) => i % 2 === 0);
    let i = segs.findIndex((p) => /팔로우|구독/.test(p));
    if (i < 0) i = segs.findIndex((p) => DISCLAIMER.test(p));
    if (i < 0) return raw ? `${raw} ${cta}` : cta;
    pieces.splice(2 * i, 0, cta, ' ');
    return pieces.join('');
  };
  last.narration = put(last.narration);
  if (typeof last.subtitle_text === 'string' && last.subtitle_text.trim()) last.subtitle_text = put(last.subtitle_text);
  return true;
}

const TARGET_LABEL = { script: '대본', metadata: '제목', closing: '마무리 문장' };

/** 성장 지시 맨 위에 붙일 절. 대본 프롬프트가 지시 파일 앞 3000자만 읽으므로 앞에 둔다. */
export function remedySection(remedies) {
  const lines = (remedies ?? []).filter((r) => r.def?.directive)
    .map((r) => `- [${r.remedy} · ${r.def.label}${r.def.target ? ` · 적용 대상: ${TARGET_LABEL[r.def.target] ?? r.def.target}` : ''}] ${r.def.directive}`);
  return lines.length ? ['## 자동 처방 (KPI 진단 · 반드시 반영)', ...lines, ''] : [];
}
