#!/usr/bin/env node

/**
 * analyze-competitors.js — 경쟁 인텔 분석기
 *
 * 입력 (주):  workspace/intel/competitors/videos/<channelId>.json  영구 비디오 인덱스
 * 입력 (보조): workspace/intel/competitors/YYYY-MM-DD.json         당일 스냅샷 — 채널 통계용
 * 입력 (우리): workspace/episodes/EP-YYYY-NNNN                     중복 회피용 자체 코퍼스
 *
 * 인덱스를 정본으로 삼는 이유: 누적되므로 90일 baseline 이 여기서만 나오고,
 * OAuth 가 만료돼 당일 수집이 실패해도 분석은 계속 돌아간다.
 *
 * 산출: analysis-YYYY-MM-DD.json (schema_version 1) + analysis-YYYY-MM-DD.md
 *
 * 결정론: LLM 없이 전부 계산된다. --llm 은 후킹 패턴 '명명'에만 쓰이는 opt-in.
 *
 * Usage:
 *   node analyze-competitors.js                     # 오늘 날짜로 분석
 *   node analyze-competitors.js --date 2026-08-13
 *   node analyze-competitors.js --dry-run           # 파일 쓰지 않고 요약만
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  tokenize, contentGaps, outliers, formatPatterns, titleFeatures, blueOcean, relatedTerms,
  DEFAULT_STOPWORDS, stopwordCandidates,
} from './lib/competitor-analytics.js';

const ROOT = resolve(import.meta.dirname, '../..');
const INTEL_DIR = join(ROOT, 'workspace', 'intel', 'competitors');
const INDEX_DIR = join(INTEL_DIR, 'videos');
const EPISODES_DIR = join(ROOT, 'workspace', 'episodes');
const POLICY_PATH = join(ROOT, 'config', 'competitor-channels.json');
const ROUTINES_PATH = join(ROOT, 'config', 'routines.json');

function loadJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

/** 인덱스 + config 를 분석 함수가 먹는 형태로 정규화한다. */
function loadChannels(policy) {
  const byId = new Map((policy.channels ?? []).map((c) => [c.channelId, c]));
  const channels = [];
  if (!existsSync(INDEX_DIR)) return channels;

  for (const f of readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const idx = loadJSON(join(INDEX_DIR, f));
    if (!idx?.videos) continue;
    const meta = byId.get(idx.channelId);
    if (meta?.active === false) continue;

    const videos = Object.entries(idx.videos).map(([videoId, v]) => {
      const hist = v.stats_history ?? [];
      const last = hist.at(-1);
      const prev = hist.at(-2);
      let accelerating = null;
      if (last && prev) {
        const hours = (Date.parse(last.at) - Date.parse(prev.at)) / 3600_000;
        accelerating = hours > 0 ? (last.views - prev.views) / hours > 0 : null;
      }
      return {
        videoId,
        title: v.title ?? '',
        publishedAt: v.publishedAt,
        duration_s: v.duration_s ?? null,
        length_bucket: v.length_bucket ?? 'live',
        isShorts: v.isShorts ?? false,
        tags: v.tags ?? [],
        thumbnail: v.thumbnail ?? null,
        views: last?.views ?? 0,
        likes: last?.likes ?? 0,
        comments: last?.comments ?? 0,
        accelerating,
      };
    });

    channels.push({
      id: meta?.id ?? idx.channelId,
      channelId: idx.channelId,
      name: meta?.name ?? idx.channelId,
      tier: meta?.tier ?? 'core',
      videos,
    });
  }
  return channels;
}

/** 우리가 이미 다룬 주제. 최근 N일 에피소드의 brief·publish_meta 에서 뽑는다. */
function loadOwnCorpus(windowDays, now, stopwords) {
  const tf = {};
  if (!existsSync(EPISODES_DIR)) return tf;
  const cutoff = now.getTime() - windowDays * 86400_000;

  const bump = (text) => {
    for (const t of tokenize(text, stopwords)) tf[t] = (tf[t] ?? 0) + 1;
  };

  for (const ep of readdirSync(EPISODES_DIR).filter((d) => d.startsWith('EP-'))) {
    const dir = join(EPISODES_DIR, ep);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;

    const brief = join(dir, '00_brief.md');
    if (existsSync(brief)) {
      const m = /^topic:\s*(.+)$/m.exec(readFileSync(brief, 'utf-8'));
      if (m) bump(m[1]);
    }

    // platforms/<p>/70_publish_meta.json (v2) 와 평면 구조(v1) 를 모두 훑는다
    const metaPaths = [];
    const platforms = join(dir, 'platforms');
    if (existsSync(platforms)) {
      for (const p of readdirSync(platforms)) metaPaths.push(join(platforms, p, '70_publish_meta.json'));
    }
    metaPaths.push(join(dir, '70_publish_meta.json'));

    for (const mp of metaPaths) {
      const meta = loadJSON(mp);
      if (!meta) continue;
      bump(meta.title ?? '');
      for (const t of meta.tags ?? []) bump(t);
      const seo = meta.seo ?? {};
      bump(seo.primary_keyword ?? '');
      for (const k of seo.secondary_keywords ?? []) bump(k);
      for (const k of seo.long_tail_keywords ?? []) bump(k);
    }
  }
  return tf;
}

/** 경쟁 채널명·핸들 토큰은 갭·블루오션에서 잡음이다 — 스톱워드에 합친다. */
function buildStopwords(policy) {
  const extra = [];
  for (const c of policy.channels ?? []) {
    extra.push(...stopwordCandidates(c.name));
    extra.push(...stopwordCandidates(String(c.handle ?? '').replace('@', '')));
  }
  return new Set([...DEFAULT_STOPWORDS, ...extra]);
}

const LLM_MIN_OUTLIERS = 3;
const LLM_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

/**
 * 이상치 제목에서 재현 가능한 후킹 패턴을 이름 붙인다 (--llm opt-in, 1콜).
 *
 * 수치 판정은 전부 결정론으로 끝났고, 여기서 모델이 하는 일은 언어 추상화 하나다.
 * 실패·타임아웃·키 부재는 전부 빈 배열로 흡수한다 — 분석 자체를 막지 않는다.
 */
export async function nameHookPatterns(outliers, features) {
  if (outliers.length < LLM_MIN_OUTLIERS) {
    return { patterns: [], used: false,
             note: `이상치 ${outliers.length}건 — ${LLM_MIN_OUTLIERS}건 미만이라 LLM 호출을 건너뛴다` };
  }

  let getSecret, recordCost;
  try {
    ({ getSecret } = await import('./config-loader.js'));
    ({ recordCost } = await import('./lib/cost-tracker.js'));
  } catch (e) {
    return { patterns: [], used: false, note: `LLM 모듈 로드 실패: ${e.message}` };
  }

  const key = getSecret('GOOGLE_AI_API_KEY');
  if (!key) return { patterns: [], used: false, note: 'GOOGLE_AI_API_KEY 없음 — hook_patterns 비움' };

  // 입력은 제목과 배수만. 조회수 원본이나 채널 통계는 넘기지 않는다.
  const sample = outliers.slice(0, 15).map((o) => ({
    title: o.title, multiple: o.multiple, channel: o.channel, length_bucket: o.length_bucket,
  }));
  const positives = features.filter((f) => f.direction === 'positive').map((f) => f.feature);

  const system = [
    '너는 한국어 경제·금융 YouTube 채널의 제목 패턴을 분석한다.',
    '입력은 경쟁 채널에서 평소 대비 성과가 튄 영상 제목들이다.',
    '각 제목이 왜 눌렸는지를 재현 가능한 "패턴"으로 이름 붙여라.',
    '',
    '규칙:',
    '- 제목을 그대로 베끼지 마라. 구조만 추상화해라.',
    '- 이미 결정론으로 검출된 피처(' + (positives.join(', ') || '없음') + ')를 그대로 반복하지 마라.',
    '- 우리 채널은 3분 이하 한국어 경제 입문 콘텐츠다. 적용 불가면 applicable_to_us=false 와 이유를 적어라.',
    '- 최대 5개. 근거가 약하면 적게 내라.',
  ].join('\n');

  const user = JSON.stringify({ outliers: sample }, null, 2);
  const schema = `{"hook_patterns":[{"pattern":"<한 문장 패턴명>","evidence_titles":["..."],"applicable_to_us":true,"why_not":"<false일 때만>"}]}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${key}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: `${system}\n\n출력 스키마(JSON만):\n${schema}` }] },
    contents: [{ parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 1200 },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  const post = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body,
  });

  try {
    let res = await post();
    // 429/5xx 는 transient — 짧게 한 번만 물러섰다 다시 친다.
    // 무료 티어 일일 한도가 소진된 경우라면 재시도해도 429 라 그대로 비우고 넘어간다.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 5_000));
      res = await post();
    }
    if (!res.ok) {
      const why = res.status === 429
        ? 'Gemini 429 (rate limit / 무료 한도) — 재시도 후에도 실패'
        : `Gemini ${res.status}`;
      return { patterns: [], used: false, note: `${why} — hook_patterns 비움 (분석은 정상)` };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const usage = data.usageMetadata || {};
    recordCost('strategist', {
      model: LLM_MODEL,
      input_tokens: Number(usage.promptTokenCount) || Math.ceil((system.length + user.length) / 4),
      output_tokens: Number(usage.candidatesTokenCount) || Math.ceil(text.length / 4),
      stage: 'intel-hook-patterns',
      note: `outliers=${sample.length}`,
    });

    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return { patterns: [], used: false, note: 'Gemini 응답이 JSON 이 아니다 — hook_patterns 비움' }; }

    const patterns = (parsed.hook_patterns ?? [])
      .filter((p) => p && typeof p.pattern === 'string')
      .slice(0, 5)
      .map((p) => ({
        pattern: p.pattern,
        evidence_titles: Array.isArray(p.evidence_titles) ? p.evidence_titles.slice(0, 3) : [],
        applicable_to_us: p.applicable_to_us !== false,
        why_not: p.applicable_to_us === false ? (p.why_not ?? null) : null,
      }));
    return { patterns, used: true, note: null };
  } catch (e) {
    const why = e.name === 'AbortError' ? '60s 타임아웃' : e.message;
    return { patterns: [], used: false, note: `LLM 호출 실패(${why}) — hook_patterns 비움` };
  } finally {
    clearTimeout(timer);
  }
}

function renderMarkdown(a) {
  const L = [];
  L.push(`# 경쟁 인텔 — ${a.date}`, '');
  L.push(`채널 ${a.channel_count} · 갭 ${a.content_gaps.length} · 이상치 ${a.outliers.length} · 블루오션 ${a.blue_ocean_keywords.length}`, '');
  if (a.degraded) L.push(`> ⚠ degraded=${a.degraded} — 부분 데이터로 분석했다.`, '');

  if (a.channel_summary.length) {
    L.push('## 채널 현황', '', '| 채널 | 구독자 | Δ7d | 7일 업로드 | 30일 median vpd |', '|---|---:|---:|---:|---:|');
    for (const c of a.channel_summary) {
      const d = c.subscriber_delta_7d;
      L.push(`| ${c.name} | ${c.subscribers?.toLocaleString() ?? '—'} | ${d === null || d === undefined ? '—' : (d >= 0 ? '+' : '') + d.toLocaleString()} | ${c.uploads_7d} | ${c.median_vpd_30d?.toLocaleString() ?? '—'} |`);
    }
    L.push('');
  }

  if (a.content_gaps.length) {
    L.push('## 콘텐츠 갭 — 경쟁사가 다뤘고 우리는 안 다룬 주제', '', '| 주제 | 점수 | 다룬 채널 | 조회수 합 | 근거 |', '|---|---:|---:|---:|---|');
    for (const g of a.content_gaps.slice(0, 10)) {
      const ev = g.evidence.map((e) => `[${e.channel}](https://youtu.be/${e.videoId})`).join(' ');
      L.push(`| **${g.term}** | ${g.gap_score} | ${g.comp_df} | ${g.comp_views.toLocaleString()} | ${ev} |`);
    }
    L.push('');
  }

  if (a.outliers.length) {
    L.push('## 성과 이상치 — 오늘 다루지 말 것 (이미 소진된 화제)', '', '| 배수 | 채널 | 제목 | 조회수 |', '|---:|---|---|---:|');
    for (const o of a.outliers.slice(0, 8)) {
      L.push(`| ${o.multiple}× | ${o.channel} | [${o.title.slice(0, 50)}](https://youtu.be/${o.videoId}) | ${o.views.toLocaleString()} |`);
    }
    L.push('');
  }

  if (a.blue_ocean_keywords.length) {
    L.push('## 블루오션 — 수요는 있고 경쟁은 얕은 키워드', '', '| 키워드 | 점수 | 경쟁도 | 수요(vpd) |', '|---|---:|---:|---:|');
    for (const b of a.blue_ocean_keywords) {
      L.push(`| **${b.keyword}** | ${b.score} | ${b.competition} | ${b.demand.toLocaleString()} |`);
    }
    L.push('');
  }

  const tf = a.patterns.title_features;
  if (tf.length) {
    L.push('## 제목 후킹 피처', '', '| 피처 | lift | 방향 | 표본(있음/없음) |', '|---|---:|---|---|');
    for (const f of tf) L.push(`| ${f.feature} | ${f.lift}× | ${f.direction} | ${f.n_with}/${f.n_without} |`);
    L.push('');
  }

  const hooks = a.patterns.hook_patterns ?? [];
  if (hooks.length) {
    L.push('## 후킹 패턴 (LLM 명명)', '');
    for (const h of hooks) {
      L.push(`- **${h.pattern}**${h.applicable_to_us ? '' : ' _(우리 채널엔 부적합)_'}`);
      if (h.evidence_titles?.length) {
        L.push(`  - 근거: ${h.evidence_titles.map((t) => `"${t.slice(0, 40)}"`).join(', ')}`);
      }
      if (!h.applicable_to_us && h.why_not) L.push(`  - 이유: ${h.why_not}`);
    }
    L.push('');
  }

  const len = a.patterns.length;
  L.push('## 포맷·시각 패턴', '');
  L.push(`- 권장 길이 버킷: **${len.recommendation ?? '판단 불가'}**`);
  L.push(`- 경쟁사 최적 업로드 시각(KST): ${a.patterns.upload_hour_kst.best_hours.join(', ') || '—'}시`);
  for (const [slot, s] of Object.entries(a.patterns.slot_alignment)) {
    L.push(`- \`${slot}\` 우리 ${s.our_publish_kst}시 → **${s.verdict}**`);
  }
  L.push('');
  L.push('---', '', `_generated ${a.generated_at} · schema v${a.schema_version} · llm_used=${a.llm_used}_`);
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      llm: { type: 'boolean', default: false },
    },
  });

  const date = values.date || new Date().toISOString().slice(0, 10);

  // 기준 시각을 날짜 끝으로 고정한다.
  //
  // vpd = views / age_days 라 now 가 흐르면 같은 입력에도 gap_score·multiple 이
  // 미세하게 달라진다. PRD §2.2 의 "결정성 100%" 는 그래서 실측에서 깨졌다
  // (2026-08-13, intel-metrics --check-determinism 이 검출).
  // 분석은 "그 날짜의 상태"를 재는 것이므로 날짜 끝을 기준으로 잡으면
  // 같은 날 몇 번을 돌려도 결과가 같고, 과거 날짜 재분석도 그때 기준으로 재현된다.
  const runAt = new Date();           // 실제 실행 시각 — generated_at 용
  const now = new Date(`${date}T23:59:59.000Z`);  // 분석 기준 시각 — 계산 전부가 이걸 쓴다
  if (Number.isNaN(now.getTime())) {
    console.error(`✗ 날짜 형식 오류: ${date}`);
    return;
  }

  const policy = loadJSON(POLICY_PATH);
  if (!policy || policy.version !== '3.0') {
    console.error(`✗ policy v3.0 필요: ${POLICY_PATH}`);
    return;
  }

  const channels = loadChannels(policy);
  if (channels.length === 0) {
    console.warn('⚠ 비디오 인덱스가 비어 있다 — fetch-competitor-stats.js 를 먼저 실행하라');
    return;
  }

  const cfg = policy.analysis ?? {};
  const stopwords = buildStopwords(policy);
  const ownWindow = cfg.own_window_days ?? 30;
  const ownTf = loadOwnCorpus(ownWindow, now, stopwords);

  const routines = loadJSON(ROUTINES_PATH, {});
  const ourSlots = {};
  for (const [slot, r] of Object.entries(routines.routines ?? routines.slots ?? {})) {
    const h = parseInt(String(r?.publish_at ?? '').slice(0, 2), 10);
    if (Number.isFinite(h)) ourSlots[slot] = h;
  }

  const gapOpts = {
    windowDays: cfg.gap_window_days ?? 7,
    minDf: cfg.gap_min_channel_df ?? 2,
    minViews: cfg.gap_min_views ?? 20000,
    stopwords, now,
  };
  const gaps = contentGaps(channels, ownTf, gapOpts);
  const outs = outliers(channels, {
    minZ: cfg.outlier_mad_z ?? 3.5,
    minViews: cfg.outlier_min_views ?? 10000,
    baselineDays: policy.tracking?.baseline_window_days ?? 90,
    now,
  });
  const patterns = formatPatterns(channels, { windowDays: ownWindow, ourSlots, now });
  const feats = titleFeatures(channels, {
    windowDays: ownWindow,
    minN: cfg.title_feature_min_n ?? 5,
    minLift: cfg.title_feature_min_lift ?? 1.3,
    now,
  });
  const bo = blueOcean(channels, ownTf, {
    windowDays: cfg.gap_window_days ?? 7,
    maxCompetition: cfg.blue_ocean_max_competition ?? 0.34,
    minDemandNorm: cfg.blue_ocean_min_demand_norm ?? 0.5,
    stopwords, now,
  });
  const related = relatedTerms(channels, [...gaps.map((g) => g.term), ...bo.map((b) => b.keyword)], {
    windowDays: ownWindow, stopwords, now,
  });

  const snapshot = loadJSON(join(INTEL_DIR, `${date}.json`));
  const summary = channels.map((ch) => {
    const snap = snapshot?.channels?.find((c) => c.resolved?.channelId === ch.channelId);
    const win = ch.videos.filter((v) => {
      const t = Date.parse(v.publishedAt ?? '');
      return Number.isFinite(t) && now.getTime() - t <= 7 * 86400_000;
    });
    const vpds = ch.videos
      .filter((v) => {
        const t = Date.parse(v.publishedAt ?? '');
        return Number.isFinite(t) && now.getTime() - t <= ownWindow * 86400_000;
      })
      .map((v) => v.views / Math.max((now.getTime() - Date.parse(v.publishedAt)) / 86400_000, 1));
    vpds.sort((a, b) => a - b);
    return {
      id: ch.id,
      name: ch.name,
      subscribers: snap?.stats?.statistics?.subscriberCount ? Number(snap.stats.statistics.subscriberCount) : null,
      subscriber_delta_7d: snap?.stats?.subscriber_delta_7d ?? null,
      uploads_7d: win.length,
      median_vpd_30d: vpds.length ? Math.round(vpds[vpds.length >> 1]) : null,
      indexed_videos: ch.videos.length,
    };
  });

  const analysis = {
    schema_version: 1,
    date,
    generated_at: runAt.toISOString(),
    analysis_basis: now.toISOString(),
    source: 'workspace/intel/competitors/videos/*.json',
    source_snapshot: snapshot ? `workspace/intel/competitors/${date}.json` : null,
    channel_count: channels.length,
    windows: {
      gap_days: gapOpts.windowDays,
      own_days: ownWindow,
      baseline_days: policy.tracking?.baseline_window_days ?? 90,
    },
    degraded: snapshot?.degraded ?? null,
    llm_used: false,
    own_corpus_terms: Object.keys(ownTf).length,
    content_gaps: gaps,
    outliers: outs,
    patterns: { ...patterns, title_features: feats, hook_patterns: [] },
    blue_ocean_keywords: bo,
    related_terms: related,
    channel_summary: summary,
  };

  if (values.llm) {
    const named = await nameHookPatterns(outs, feats);
    analysis.patterns.hook_patterns = named.patterns;
    analysis.llm_used = named.used;
    if (named.note) console.warn(`ℹ ${named.note}`);
  }

  console.log(`📊 analyze-competitors — ${date}`);
  console.log(`   채널 ${analysis.channel_count} · 인덱스 영상 ${channels.reduce((s, c) => s + c.videos.length, 0)}`);
  console.log(`   우리 코퍼스 토큰 ${analysis.own_corpus_terms}`);
  console.log(`   갭 ${gaps.length} · 이상치 ${outs.length} · 블루오션 ${bo.length} · 제목피처 ${feats.length}`);
  if (gaps.length) console.log(`   최상위 갭: ${gaps.slice(0, 5).map((g) => g.term).join(', ')}`);
  if (bo.length) console.log(`   블루오션: ${bo.slice(0, 5).map((b) => b.keyword).join(', ')}`);

  if (values['dry-run']) {
    console.log('\n✓ dry-run — 파일을 쓰지 않았다');
    return;
  }

  mkdirSync(INTEL_DIR, { recursive: true });
  writeFileSync(join(INTEL_DIR, `analysis-${date}.json`), JSON.stringify(analysis, null, 2));
  writeFileSync(join(INTEL_DIR, `analysis-${date}.md`), renderMarkdown(analysis));
  console.log(`\n✓ Saved: workspace/intel/competitors/analysis-${date}.{json,md}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.stack || e.message}`);
    process.exitCode = 0; // 분석 실패가 파이프라인을 막지 않는다
  });
}
