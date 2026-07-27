/**
 * Standalone channel operations document renderer.
 *
 * The generated file is intentionally useful without a server: it contains a
 * redacted snapshot and all of its CSS/JavaScript.  When the same document is
 * served from `/channels/:id`, the client refreshes the snapshot from the local
 * board API.  No mutating controls are emitted by this renderer.
 */

const SECRET_KEY = /(?:^|[_-])(?:auth|authorization|credential|credentials|secret|secrets|token|tokens|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|oauth)(?:$|[_-])/i;
const SECRET_KEY_COMPACT = /(?:auth|authorization|credentials?|secrets?|tokens?|password|passwd|apikey|privatekey|clientsecret|refreshtoken|accesstoken|oauth)(?:refs?|env|names?|values?)?s?$/i;
const CREDENTIAL_REFERENCE = /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIALS?|OAUTH)[A-Z0-9_]*\b/g;
const TOKEN_SHAPE = /\b(?:Bearer\s+[-._~+/A-Za-z0-9]+=*|sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/gi;
const FILE_URL = /file:\/{2,3}[^\s"'<>]+/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g;
const POSIX_PATH = /(^|[\s("'=:\[])(\/(?!\/)[^\s"',)\]}<>]+)/g;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function redactString(value) {
  return value
    .replace(FILE_URL, '[로컬 경로 숨김]')
    .replace(WINDOWS_PATH, '[로컬 경로 숨김]')
    .replace(POSIX_PATH, (_match, prefix) => `${prefix}[로컬 경로 숨김]`)
    .replace(CREDENTIAL_REFERENCE, '[자격 증명 참조 숨김]')
    .replace(TOKEN_SHAPE, '[토큰 숨김]');
}

function isSecretKey(key) {
  const compact = String(key).replace(/[^A-Za-z0-9]/g, '');
  return SECRET_KEY.test(key) || SECRET_KEY_COMPACT.test(compact);
}

/** Recursively makes a JSON-safe, public snapshot and tolerates cyclic input. */
function sanitize(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map(item => sanitize(item, seen)).filter(item => item !== undefined);
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    const safeChild = sanitize(child, seen);
    if (safeChild !== undefined) result[key] = safeChild;
  }
  seen.delete(value);
  return result;
}

function first(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function text(value, fallback = '') {
  const selected = first(value, fallback);
  if (Array.isArray(selected)) return selected.map(item => text(item)).filter(Boolean).join(', ');
  if (selected && typeof selected === 'object') {
    return text(first(selected.name, selected.title, selected.id, selected.description), fallback);
  }
  return selected === undefined || selected === null ? '' : String(selected);
}

function list(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return Object.entries(value).map(([name, detail]) => ({ name, detail }));
  return [value];
}

function itemText(item) {
  if (item === undefined || item === null) return '';
  if (typeof item !== 'object') return String(item);
  const title = first(item.title, item.name, item.message, item.description, item.id, item.code);
  const suffix = first(item.detail, item.reason, item.status);
  if (title && suffix && String(title) !== String(suffix)) return `${text(title)} — ${text(suffix)}`;
  if (title) return text(title);
  try { return JSON.stringify(item); } catch { return ''; }
}

function formatNames(value) {
  if (Array.isArray(value)) {
    return value.map(item => text(item)).filter(Boolean);
  }
  if (value && typeof value === 'object') return Object.keys(value);
  return value ? [text(value)] : [];
}

function platformNames(channel) {
  const platforms = channel.platforms;
  if (Array.isArray(platforms)) return platforms.map(item => text(item)).filter(Boolean);
  if (platforms && typeof platforms === 'object') return Object.keys(platforms);
  return ['youtube', 'instagram'].filter(name => channel[name]);
}

function normalizeChannel(input = {}) {
  const wrapper = sanitize(input) || {};
  const manifest = wrapper.manifest && typeof wrapper.manifest === 'object' ? wrapper.manifest : {};
  const context = wrapper.context && typeof wrapper.context === 'object' ? wrapper.context : {};
  const safe = { ...manifest, ...context, ...wrapper };
  const legacy = safe.channel && typeof safe.channel === 'object' ? safe.channel : {};
  const identity = safe.identity && typeof safe.identity === 'object' ? safe.identity : {};
  const id = text(first(safe.id, safe.channel_id, identity.id, legacy.id), 'unknown-channel');
  const name = text(first(safe.name, identity.display_name, identity.name, legacy.name), id);
  const description = text(first(safe.description, identity.description, legacy.description), '채널별 콘텐츠 제작과 발행 상태를 한곳에서 관리합니다.');
  const formats = formatNames(first(safe.formats, safe.format_ids, legacy.formats));
  const pipeline = text(first(safe.pipeline_profile, safe.pipeline?.profile, safe.adapter, legacy.pipeline_profile), 'channel-default');
  const status = text(first(safe.activation_status, safe.status, safe.state), 'needs_review');

  return {
    ...safe,
    id,
    name,
    description,
    handle: text(first(safe.handle, identity.handle, safe.platforms?.instagram?.handle, safe.platforms?.youtube?.handle, legacy.handle)),
    language: text(first(safe.language, identity.language, legacy.language), 'ko'),
    target_country: text(first(safe.target_country, identity.target_country, legacy.target_country), 'KR'),
    formats,
    platform_names: platformNames(safe),
    pipeline_profile: pipeline,
    status,
    revision: first(safe.revision, safe.version, 1),
    cadence: first(safe.cadence, legacy.cadence, {}),
    purpose: list(first(safe.purpose, safe.objectives), [description]),
    scope: list(safe.scope, ['채널 설정·시리즈 계획·에피소드 상태 통합', '문서 스냅샷 생성과 로컬 보드 조회']),
    qa: list(first(safe.qa?.checklist, safe.qa_rules, safe.quality_checks), []),
    risks: list(first(safe.risks, safe.unresolved_conflicts, safe.unresolved, safe.conflicts, safe.migration?.conflicts), []),
    tasks: list(first(safe.tasks, safe.todo, safe.todos, safe.unresolved), []),
  };
}

function publishedFromEpisode(ep) {
  if (ep.published === true) return true;
  if (ep.publish && typeof ep.publish === 'object') {
    return ep.publish.published === true
      || Boolean(first(ep.publish.video_id, ep.publish.videoId, ep.publish.url, ep.publish.published_at));
  }
  if (ep.publish_result && typeof ep.publish_result === 'object') return true;
  return /^(?:published|scheduled|playlist_registered)$/i.test(text(first(ep.status, ep.state)));
}

function inferLifecycle(ep, nativeStage, isPublished) {
  if (isPublished) return 'published';
  const explicit = first(ep.lifecycle_stage, ep.common_stage, ep.lifecycle?.stage);
  if (explicit) return text(explicit);
  const stage = text(nativeStage).toUpperCase();
  if (/^(?:S10|R10|R11)$/.test(stage) || /APPROV|REVIEW/.test(stage)) return 'approval';
  if (/^(?:S8|S9|R8|R9|C4)$/.test(stage) || /QA|META|DISTRIBUT/.test(stage)) return 'qa';
  if (/^(?:S7|R6|R7|C3)$/.test(stage) || /RENDER|COMPOSE|EXPORT/.test(stage)) return 'render';
  if (/^(?:S6|R2|R3|R4|R5|C2)$/.test(stage) || /ASSET|IMAGE|VIDEO|TTS/.test(stage)) return 'assets';
  if (/^(?:S2|S3|S4|S5|R0\.5|R1|C1)$/.test(stage) || /SCRIPT|STRATEG|RESEARCH|FACT/.test(stage)) return 'script';
  return 'planned';
}

function qaVerdict(ep) {
  const qa = first(ep.qa, ep.qa_result, ep.qa_verdict, ep.quality);
  if (typeof qa === 'string') return qa;
  if (qa && typeof qa === 'object') return text(first(qa.verdict, qa.status, qa.result, qa.outcome), '—');
  return '—';
}

function assetSummary(ep) {
  const source = first(ep.assets, ep.artifacts, ep.asset_counts, ep.outputs, {});
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.length;
  }
  return result;
}

function positiveEpisodeNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function normalizeEpisode(input = {}, plan = {}) {
  const safe = sanitize({ ...plan, ...input }) || {};
  const id = text(first(safe.id, safe.episode_id, safe.slug, safe.key), 'unassigned');
  const isPublished = publishedFromEpisode(safe);
  const nativeStage = text(first(safe.native_stage, safe.current_stage, safe.stage), '—');
  const lifecycleStage = inferLifecycle(safe, nativeStage, isPublished);
  const qa = qaVerdict(safe);
  const status = text(
    first(safe.status, safe.state),
    isPublished ? 'published' : /fail|failed/i.test(qa) ? 'failed' : lifecycleStage === 'planned' ? 'planned' : 'in_progress',
  );
  return {
    id,
    title: text(first(safe.title, safe.topic, safe.name), '제목 미정'),
    series_id: text(first(safe.series_id, safe.series, safe.season_id)),
    episode_no: positiveEpisodeNumber(safe.episode_no, safe.series_episode),
    plan_id: text(first(input?.plan_id, plan?.plan_id, plan?.id, plan?.episode_id, plan?.slug)),
    slug: text(first(safe.slug, plan?.slug)),
    format: text(first(safe.format, safe.content_format, safe.type), 'unspecified'),
    native_stage: nativeStage,
    lifecycle_stage: lifecycleStage,
    status,
    qa,
    published: isPublished,
    updated_at: text(first(safe.updated_at, safe.updated, safe.last_updated)),
    summary: text(first(safe.summary, safe.description, safe.narrative_beat, safe.beat)),
    assets: assetSummary(safe),
    provenance: text(first(
      safe.provenance,
      safe.source,
      safe.source_profile,
      Object.keys(input || {}).length ? undefined : 'series-index',
    )),
  };
}

function plannedEpisodes(series) {
  const safe = sanitize(series);
  if (!safe) return [];
  const roots = Array.isArray(safe) ? safe : Array.isArray(safe.series) ? safe.series : [safe];
  const result = [];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    const seriesId = text(first(root.id, root.series_id, root.slug));
    for (const ep of list(root.episodes)) {
      if (ep && typeof ep === 'object') {
        result.push({
          ...ep,
          series_id: text(first(ep.series_id, seriesId)),
          series_start_date: text(first(ep.series_start_date, root.start_date, safe.start_date)),
          series_generated_at: text(first(ep.series_generated_at, root.generated_at, safe.generated_at)),
        });
      }
    }
  }
  return result;
}

function correlationKeys(episode, includeEpisodeNumber = false) {
  if (!episode || typeof episode !== 'object') return [];
  const keys = [];
  const add = (kind, value) => {
    const normalized = text(value).trim().toLowerCase();
    if (normalized) keys.push(`${kind}:${normalized}`);
  };
  [episode.id, episode.episode_id, episode.plan_id, episode.key].forEach(value => add('id', value));
  add('slug', episode.slug);
  const episodeNo = positiveEpisodeNumber(episode.episode_no, episode.series_episode);
  const seriesId = text(first(episode.series_id, episode.series, episode.season_id));
  if (seriesId && episodeNo) add('series-episode', `${seriesId}:${episodeNo}`);
  if (includeEpisodeNumber && episodeNo && !seriesId) add('episode-no', episodeNo);
  return [...new Set(keys)];
}

export function mergeEpisodeSources(episodes, series) {
  const actual = Array.isArray(episodes) ? episodes : Array.isArray(episodes?.episodes) ? episodes.episodes : [];
  const plans = plannedEpisodes(series);
  const episodeNumberCounts = new Map();
  for (const plan of plans) {
    const episodeNo = positiveEpisodeNumber(plan.episode_no, plan.series_episode);
    if (episodeNo) episodeNumberCounts.set(episodeNo, (episodeNumberCounts.get(episodeNo) || 0) + 1);
  }

  const buckets = new Map();
  const merged = plans.map(plan => ({ plan, observed: null }));
  plans.forEach((plan, index) => {
    const episodeNo = positiveEpisodeNumber(plan.episode_no, plan.series_episode);
    const keys = correlationKeys(plan, episodeNo && episodeNumberCounts.get(episodeNo) === 1);
    for (const key of keys) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(index);
    }
  });

  const consumed = new Set();
  const extras = [];
  for (const episode of actual) {
    const keys = correlationKeys(episode, true);
    let planIndex = -1;
    for (const key of keys) {
      const candidates = (buckets.get(key) || []).filter(index => !consumed.has(index));
      if (candidates.length === 1) {
        [planIndex] = candidates;
        break;
      }
    }
    if (planIndex >= 0) {
      consumed.add(planIndex);
      merged[planIndex] = { plan: plans[planIndex], observed: episode };
    } else {
      extras.push({ plan: null, observed: episode });
    }
  }
  return [...merged, ...extras];
}

function normalizeEpisodes(episodes, series) {
  return mergeEpisodeSources(episodes, series).map(({ plan, observed }) => (
    normalizeEpisode(observed || {}, plan || {})
  ));
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function pipelineNativeRange(profile) {
  const value = text(profile).toLowerCase();
  if (value.includes('r11') || value.includes('media-render')) return 'R0–R11';
  if (value.includes('c4') || value.includes('carousel')) return 'C0–C4';
  if (value.includes('s12') || value.includes('barrotube')) return 'S0–S12';
  return '채널 어댑터 단계';
}

function listMarkup(values, fallback) {
  const items = list(values, fallback).map(itemText).filter(Boolean);
  return items.map(value => `<li>${escapeHtml(value)}</li>`).join('');
}

function cadenceRows(cadence) {
  if (!cadence || typeof cadence !== 'object' || Array.isArray(cadence)) {
    return '<tr><td colspan="4">등록된 발행 리듬이 없습니다.</td></tr>';
  }
  const rows = Object.entries(cadence).map(([format, raw]) => {
    const config = raw && typeof raw === 'object' ? raw : { schedule: raw };
    const days = Array.isArray(config.days) ? config.days.join(', ') : text(first(config.days, config.day), '—');
    const perWeek = text(first(config.target_per_week, config.per_week, config.frequency), '—');
    const time = text(first(config.time, config.publish_time, config.schedule), '—');
    return `<tr><td>${escapeHtml(format)}</td><td>${escapeHtml(perWeek)}</td><td>${escapeHtml(days)}</td><td>${escapeHtml(time)}</td></tr>`;
  });
  return rows.length ? rows.join('') : '<tr><td colspan="4">등록된 발행 리듬이 없습니다.</td></tr>';
}

function styles() {
  return String.raw`
:root{--bg:#f8f7f4;--card:#fff;--ink:#282824;--mut:#77766f;--line:#e6e2d9;--warm:#fff1df;--accent:#dd6d2c;--accent2:#396db1;--ok:#287c54;--okbg:#e7f4ec;--warn:#a96910;--warnbg:#fff3d8;--bad:#b84141;--badbg:#faeaea;--shadow:0 8px 28px rgba(54,48,37,.06)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;line-height:1.65}
button,input,select{font:inherit}.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;min-height:58px;padding:10px 22px;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}
.brand{font-size:17px;font-weight:850}.top-spacer{flex:1}.connection{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#f0efeb;color:var(--mut);font-size:12px;font-weight:700}.connection.live{background:var(--okbg);color:var(--ok)}.connection.warn{background:var(--warnbg);color:var(--warn)}
.layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:22px;max-width:1320px;margin:0 auto;padding:24px 20px 72px}.toc{position:sticky;top:78px;align-self:start;max-height:calc(100vh - 96px);overflow:auto}.toc strong{display:block;margin:0 0 8px;padding:6px 9px;color:var(--accent2);background:#edf3fb;border-radius:8px;font-size:12px}.toc a{display:block;padding:4px 10px;border-left:2px solid var(--line);color:var(--mut);font-size:12px;text-decoration:none}.toc a:hover{border-color:var(--accent);color:var(--accent)}main{min-width:0}
.card{margin-bottom:18px;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}.hero{overflow:hidden;position:relative}.hero:after{content:"";position:absolute;width:220px;height:220px;right:-75px;top:-105px;border-radius:50%;background:linear-gradient(135deg,var(--warm),#f6d9cb);opacity:.7}.eyebrow{position:relative;z-index:1;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.hero h1{position:relative;z-index:1;margin:5px 0 6px;font-size:clamp(25px,4vw,37px);line-height:1.2}.lede{position:relative;z-index:1;max-width:760px;margin:0;color:var(--mut)}
h2{margin:0 0 15px;font-size:19px;scroll-margin-top:76px}h3{font-size:14px;margin:18px 0 8px;color:#4d4c47}p{margin:7px 0}code{padding:2px 6px;border-radius:5px;background:var(--warm);color:#a94e1f;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}pre{margin:10px 0;padding:15px 17px;overflow:auto;border-radius:10px;background:#252623;color:#f4f2eb;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}pre code{padding:0;background:none;color:inherit}
.meta-grid,.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.meta,.kpi{min-width:0;padding:11px 13px;background:#faf9f6;border:1px solid var(--line);border-radius:10px}.meta dt,.kpi span{display:block;color:var(--mut);font-size:11px}.meta dd{margin:3px 0 0;font-size:13px;font-weight:750;overflow-wrap:anywhere}.kpi strong{display:block;font-size:24px;line-height:1.2}
.split{display:grid;grid-template-columns:1fr 1fr;gap:18px}.clean{margin:0;padding-left:21px}.clean li{margin:4px 0}.callout{padding:11px 14px;border:1px solid #c8d8ea;border-radius:10px;background:#eef5fc;color:#315a87;font-size:13px}.callout.warn{border-color:#edd09a;background:var(--warnbg);color:#85570c}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{padding:8px 9px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:#faf3e9;white-space:nowrap}.pill{display:inline-block;padding:2px 8px;border-radius:99px;background:#efefec;color:#62615b;font-size:11px;font-weight:800}.pill.ok{background:var(--okbg);color:var(--ok)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.bad{background:var(--badbg);color:var(--bad)}
.board-tools{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.board-tools input,.board-tools select{min-height:36px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}.board-tools input{flex:1;min-width:210px}.episode-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.episode{padding:14px;border:1px solid var(--line);border-radius:12px;background:#fff}.episode-head{display:flex;align-items:flex-start;gap:8px}.episode-title{min-width:0;flex:1}.episode-title strong,.episode-title small{display:block;overflow-wrap:anywhere}.episode-title small{color:var(--mut)}.badges{display:flex;flex-wrap:wrap;gap:5px;margin:9px 0}.episode details{border-top:1px dashed var(--line);padding-top:8px}.episode summary{cursor:pointer;color:var(--accent2);font-size:12px;font-weight:750}.detail-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:9px 0 0;font-size:12px}.detail-grid dt{color:var(--mut)}.detail-grid dd{margin:0;overflow-wrap:anywhere}.asset-list{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.asset{padding:2px 7px;border-radius:6px;background:#f1f3f6;color:#545d69;font-size:10.5px}.empty{padding:25px;border:1px dashed var(--line);border-radius:10px;color:var(--mut);text-align:center}
.checklist{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;margin:0;padding:0;list-style:none}.checklist li{position:relative;padding-left:24px}.checklist li:before{content:"✓";position:absolute;left:0;top:1px;display:grid;place-items:center;width:17px;height:17px;border-radius:5px;background:var(--okbg);color:var(--ok);font-size:11px;font-weight:900}.footer{color:var(--mut);font-size:11px;text-align:center}.noscript{margin:12px;padding:12px;border:1px solid #edd09a;border-radius:9px;background:var(--warnbg);color:var(--warn)}
@media(max-width:920px){.layout{grid-template-columns:1fr}.toc{display:none}.meta-grid,.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.top{padding:9px 12px}.brand{font-size:14px}.layout{padding:12px 10px 52px}.card{padding:18px 14px;border-radius:13px}.split,.episode-grid{grid-template-columns:1fr}.checklist{grid-template-columns:1fr}.hero h1{font-size:27px}.meta-grid{grid-template-columns:1fr 1fr}.connection{max-width:145px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
@media print{.top,.toc,.board-tools{display:none}.layout{display:block;padding:0}.card{box-shadow:none;break-inside:avoid}.episode-grid{display:block}.episode{margin:8px 0}}
`;
}

function clientScript() {
  return String.raw`
(function () {
  'use strict';
  var snapshotNode = document.getElementById('channel-snapshot');
  var state;
  try { state = JSON.parse(snapshotNode.textContent); }
  catch (_error) { state = { channel: {}, series: [], episodes: [], offline: true }; }

  function one() {
    for (var i = 0; i < arguments.length; i += 1) {
      if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
    }
    return '';
  }
  function str(value, fallback) {
    var picked = one(value, fallback || '');
    if (picked && typeof picked === 'object') return str(one(picked.name, picked.title, picked.id, picked.description), fallback || '');
    return String(picked || '');
  }
  function el(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function asList(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    if (typeof value === 'object') return Object.keys(value).map(function (key) { return { name: key, detail: value[key] }; });
    return [value];
  }
  function itemText(item) {
    if (!item || typeof item !== 'object') return str(item);
    var title = one(item.title, item.name, item.message, item.description, item.id, item.code);
    var detail = one(item.detail, item.reason, item.status);
    return detail && detail !== title ? str(title) + ' — ' + str(detail) : str(title || JSON.stringify(item));
  }
  function channelFromPayload(payload) {
    var manifest = payload && payload.manifest && typeof payload.manifest === 'object' ? payload.manifest : {};
    var context = payload && payload.channel && typeof payload.channel === 'object' ? payload.channel : payload || {};
    var combined = Object.assign({}, manifest, context);
    var legacy = combined.channel && typeof combined.channel === 'object' ? combined.channel : {};
    var identity = combined.identity && typeof combined.identity === 'object' ? combined.identity : {};
    combined.id = str(one(combined.id, combined.channel_id, identity.id, legacy.id), 'unknown-channel');
    combined.name = str(one(combined.name, identity.display_name, identity.name, legacy.name), combined.id);
    combined.description = str(one(combined.description, identity.description, legacy.description), '채널 제작·운영 문서');
    combined.handle = str(one(combined.handle, identity.handle, combined.platforms && combined.platforms.instagram && combined.platforms.instagram.handle, combined.platforms && combined.platforms.youtube && combined.platforms.youtube.handle, legacy.handle));
    combined.language = str(one(combined.language, identity.language, legacy.language), 'ko');
    combined.target_country = str(one(combined.target_country, identity.target_country, legacy.target_country), 'KR');
    combined.pipeline_profile = str(one(combined.pipeline_profile, combined.adapter, combined.pipeline && combined.pipeline.profile), 'channel-default');
    combined.status = str(one(combined.activation_status, combined.status, combined.state), 'needs_review');
    if (payload && Array.isArray(payload.conflicts)) combined.risks = payload.conflicts;
    if (payload && Array.isArray(payload.unresolved) && payload.unresolved.length) combined.tasks = payload.unresolved;
    return combined;
  }
  function isPublished(ep) {
    if (ep.published === true) return true;
    var pub = one(ep.publish, ep.publish_result);
    if (pub && typeof pub === 'object' && (pub.published === true || one(pub.video_id, pub.videoId, pub.url, pub.published_at))) return true;
    return /^(published|scheduled|playlist_registered)$/i.test(str(one(ep.status, ep.state)));
  }
  function lifecycle(ep, nativeStage, published) {
    if (published) return 'published';
    var explicit = one(ep.lifecycle_stage, ep.common_stage, ep.lifecycle && ep.lifecycle.stage);
    if (explicit) return str(explicit);
    var stage = str(nativeStage).toUpperCase();
    if (/^(S10|R10|R11)$/.test(stage) || /APPROV|REVIEW/.test(stage)) return 'approval';
    if (/^(S8|S9|R8|R9|C4)$/.test(stage) || /QA|META|DISTRIBUT/.test(stage)) return 'qa';
    if (/^(S7|R6|R7|C3)$/.test(stage) || /RENDER|COMPOSE|EXPORT/.test(stage)) return 'render';
    if (/^(S6|R2|R3|R4|R5|C2)$/.test(stage) || /ASSET|IMAGE|VIDEO|TTS/.test(stage)) return 'assets';
    if (/^(S2|S3|S4|S5|R0\.5|R1|C1)$/.test(stage) || /SCRIPT|STRATEG|RESEARCH|FACT/.test(stage)) return 'script';
    return 'planned';
  }
  function episodeNumber() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = Number(arguments[i]);
      if (Number.isInteger(value) && value > 0) return value;
    }
    return null;
  }
  function normalizeEpisode(ep) {
    ep = ep || {};
    var published = isPublished(ep);
    var nativeStage = str(one(ep.native_stage, ep.current_stage, ep.stage), '—');
    var qa = one(ep.qa, ep.qa_result, ep.qa_verdict, ep.quality, '—');
    if (qa && typeof qa === 'object') qa = one(qa.verdict, qa.status, qa.result, qa.outcome, '—');
    var assets = one(ep.assets, ep.artifacts, ep.asset_counts, ep.outputs, {});
    var assetCounts = {};
    if (assets && typeof assets === 'object' && !Array.isArray(assets)) {
      Object.keys(assets).forEach(function (key) {
        var value = assets[key];
        if (Array.isArray(value)) assetCounts[key] = value.length;
        else if (['number', 'boolean', 'string'].indexOf(typeof value) >= 0) assetCounts[key] = value;
      });
    }
    var lifecycleStage = lifecycle(ep, nativeStage, published);
    var status = str(one(ep.status, ep.state), published ? 'published' : /fail|failed/i.test(str(qa)) ? 'failed' : lifecycleStage === 'planned' ? 'planned' : 'in_progress');
    return {
      id: str(one(ep.id, ep.episode_id, ep.slug, ep.key), 'unassigned'),
      title: str(one(ep.title, ep.topic, ep.name), '제목 미정'),
      series_id: str(one(ep.series_id, ep.series, ep.season_id)),
      episode_no: episodeNumber(ep.episode_no, ep.series_episode),
      plan_id: str(one(ep.plan_id, ep.id, ep.episode_id, ep.slug)),
      slug: str(ep.slug),
      format: str(one(ep.format, ep.content_format, ep.type), 'unspecified'),
      native_stage: nativeStage,
      lifecycle_stage: lifecycleStage,
      status: status,
      qa: str(qa, '—'), published: published,
      updated_at: str(one(ep.updated_at, ep.updated, ep.last_updated)),
      summary: str(one(ep.summary, ep.description, ep.narrative_beat, ep.beat)),
      assets: assetCounts,
      provenance: str(one(ep.provenance, ep.source, ep.source_profile))
    };
  }
  function plannedEpisodeRows(series) {
    if (!series || typeof series !== 'object') return [];
    var roots = Array.isArray(series) ? series : Array.isArray(series.series) ? series.series : [series];
    var rows = [];
    roots.forEach(function (root) {
      if (!root || typeof root !== 'object') return;
      var seriesId = str(one(root.id, root.series_id, root.slug));
      asList(root.episodes).forEach(function (episode) {
        if (!episode || typeof episode !== 'object') return;
        var copy = Object.assign({}, episode);
        copy.series_id = str(one(copy.series_id, seriesId));
        copy.provenance = str(one(copy.provenance, copy.source, 'series-index'));
        rows.push(copy);
      });
    });
    return rows;
  }
  function episodeCorrelationKeys(episode, includeNumber) {
    if (!episode || typeof episode !== 'object') return [];
    var keys = [];
    function add(kind, value) {
      var normalized = str(value).trim().toLowerCase();
      if (normalized) keys.push(kind + ':' + normalized);
    }
    [episode.id, episode.episode_id, episode.plan_id, episode.key].forEach(function (value) { add('id', value); });
    add('slug', episode.slug);
    var number = episodeNumber(episode.episode_no, episode.series_episode);
    var seriesId = str(one(episode.series_id, episode.series, episode.season_id));
    if (seriesId && number) add('series-episode', seriesId + ':' + number);
    if (includeNumber && number && !seriesId) add('episode-no', number);
    return keys.filter(function (value, index) { return keys.indexOf(value) === index; });
  }
  function mergeEpisodeRows(actual, series) {
    actual = Array.isArray(actual) ? actual : [];
    var plans = plannedEpisodeRows(series);
    var numberCounts = {};
    plans.forEach(function (plan) {
      var number = episodeNumber(plan.episode_no, plan.series_episode);
      if (number) numberCounts[number] = (numberCounts[number] || 0) + 1;
    });
    var buckets = Object.create(null);
    var rows = plans.map(normalizeEpisode);
    plans.forEach(function (plan, index) {
      var number = episodeNumber(plan.episode_no, plan.series_episode);
      episodeCorrelationKeys(plan, number && numberCounts[number] === 1).forEach(function (key) {
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(index);
      });
    });
    var consumed = Object.create(null);
    var extras = [];
    actual.forEach(function (episode) {
      var planIndex = -1;
      var keys = episodeCorrelationKeys(episode, true);
      for (var i = 0; i < keys.length; i += 1) {
        var candidates = (buckets[keys[i]] || []).filter(function (index) { return !consumed[index]; });
        if (candidates.length === 1) { planIndex = candidates[0]; break; }
      }
      if (planIndex >= 0) {
        consumed[planIndex] = true;
        var plan = plans[planIndex];
        var merged = Object.assign({}, plan, episode);
        merged.series_id = str(one(episode.series_id, plan.series_id));
        merged.episode_no = episodeNumber(episode.episode_no, episode.series_episode, plan.episode_no, plan.series_episode);
        merged.plan_id = str(one(episode.plan_id, plan.plan_id, plan.id, plan.episode_id, plan.slug));
        merged.slug = str(one(episode.slug, plan.slug));
        rows[planIndex] = normalizeEpisode(merged);
      } else extras.push(normalizeEpisode(episode));
    });
    return rows.concat(extras);
  }
  function statusClass(value) {
    value = str(value).toLowerCase();
    if (/publish|pass|active|complete/.test(value)) return 'ok';
    if (/fail|block|conflict|error/.test(value)) return 'bad';
    return 'warn';
  }
  function setConnection(message, kind) {
    var node = document.getElementById('connection');
    node.className = 'connection' + (kind ? ' ' + kind : '');
    node.textContent = message;
  }
  function renderIdentity() {
    var channel = state.channel || {};
    document.getElementById('channel-name').textContent = str(channel.name, str(channel.id, '채널'));
    document.getElementById('channel-description').textContent = str(channel.description, '채널 제작·운영 문서');
    document.getElementById('meta-id').textContent = str(channel.id, '—');
    document.getElementById('meta-handle').textContent = str(channel.handle, '—');
    document.getElementById('meta-profile').textContent = str(channel.pipeline_profile, 'channel-default');
    document.getElementById('meta-revision').textContent = str(one(channel.revision, channel.version), '1');
    var status = document.getElementById('channel-status');
    status.textContent = str(one(channel.activation_status, channel.status, channel.state), 'needs_review');
    status.className = 'pill ' + statusClass(status.textContent);
    document.title = str(channel.name, channel.id) + ' · 영상 제작·관리 설계문서';
    replaceList('purpose-list', asList(one(channel.purpose, channel.objectives, [channel.description])));
    replaceList('scope-list', asList(channel.scope).length ? asList(channel.scope) : ['채널 설정·시리즈 계획·에피소드 상태 통합', '문서 스냅샷과 로컬 보드 조회']);
    renderCadence(); renderRiskTasks();
  }
  function replaceList(id, values) {
    var root = document.getElementById(id); clear(root);
    values.map(itemText).filter(Boolean).forEach(function (value) { root.appendChild(el('li', '', value)); });
    if (!root.children.length) root.appendChild(el('li', '', '등록된 항목이 없습니다.'));
  }
  function renderCadence() {
    var body = document.getElementById('cadence-body'); clear(body);
    var cadence = state.channel && state.channel.cadence;
    if (!cadence || typeof cadence !== 'object' || Array.isArray(cadence) || !Object.keys(cadence).length) {
      var emptyRow = el('tr'); var emptyCell = el('td', '', '등록된 발행 리듬이 없습니다.'); emptyCell.colSpan = 4; emptyRow.appendChild(emptyCell); body.appendChild(emptyRow); return;
    }
    Object.keys(cadence).forEach(function (format) {
      var config = cadence[format] && typeof cadence[format] === 'object' ? cadence[format] : { schedule: cadence[format] };
      var row = el('tr');
      var days = Array.isArray(config.days) ? config.days.join(', ') : str(one(config.days, config.day), '—');
      [format, one(config.target_per_week, config.per_week, config.frequency, '—'), days, one(config.time, config.publish_time, config.schedule, '—')]
        .forEach(function (value) { row.appendChild(el('td', '', value)); });
      body.appendChild(row);
    });
  }
  function renderRiskTasks() {
    var channel = state.channel || {};
    replaceList('risk-list', asList(one(channel.risks, state.conflicts)));
    replaceList('task-list', asList(one(channel.tasks, channel.todo, channel.todos, state.unresolved)));
  }
  function filteredEpisodes() {
    var query = document.getElementById('episode-query').value.trim().toLowerCase();
    var status = document.getElementById('episode-status-filter').value;
    var format = document.getElementById('episode-format-filter').value;
    return (state.episodes || []).map(normalizeEpisode).filter(function (ep) {
      var haystack = [ep.id, ep.title, ep.series_id, ep.summary].join(' ').toLowerCase();
      var statusOk = status === 'all' || (status === 'published' && ep.published) ||
        (status === 'active' && !ep.published && !/blocked|failed|archived/i.test(ep.status)) ||
        (status === 'blocked' && /blocked|failed|conflict|error/i.test(ep.status));
      return (!query || haystack.indexOf(query) >= 0) && statusOk && (format === 'all' || ep.format === format);
    });
  }
  function renderFilters() {
    var select = document.getElementById('episode-format-filter');
    var selected = select.value; clear(select);
    var all = el('option', '', '전체 포맷'); all.value = 'all'; select.appendChild(all);
    var formats = {};
    (state.episodes || []).map(normalizeEpisode).forEach(function (ep) { formats[ep.format] = true; });
    Object.keys(formats).sort().forEach(function (format) { var option = el('option', '', format); option.value = format; select.appendChild(option); });
    if (formats[selected]) select.value = selected;
  }
  function renderKpis() {
    var episodes = (state.episodes || []).map(normalizeEpisode);
    var published = episodes.filter(function (ep) { return ep.published; }).length;
    var qaPass = episodes.filter(function (ep) { return /pass|passed|통과/i.test(ep.qa); }).length;
    var blocked = episodes.filter(function (ep) { return /blocked|failed|conflict|error/i.test(ep.status); }).length;
    document.getElementById('kpi-total').textContent = episodes.length;
    document.getElementById('kpi-active').textContent = episodes.length - published - blocked;
    document.getElementById('kpi-qa').textContent = qaPass;
    document.getElementById('kpi-published').textContent = published;
  }
  function badge(value, kind) { return el('span', 'pill ' + (kind || ''), value); }
  function addDetail(grid, label, value) { grid.appendChild(el('dt', '', label)); grid.appendChild(el('dd', '', value || '—')); }
  function renderEpisodes() {
    var root = document.getElementById('episode-grid'); clear(root);
    var episodes = filteredEpisodes();
    document.getElementById('episode-count').textContent = episodes.length + '개 표시';
    if (!episodes.length) { root.appendChild(el('div', 'empty', '조건에 맞는 에피소드가 없습니다.')); return; }
    episodes.forEach(function (ep) {
      var card = el('article', 'episode');
      var head = el('div', 'episode-head');
      var title = el('div', 'episode-title'); title.appendChild(el('strong', '', ep.title)); title.appendChild(el('small', '', ep.id)); head.appendChild(title);
      head.appendChild(badge(ep.status, statusClass(ep.status))); card.appendChild(head);
      var badges = el('div', 'badges'); badges.appendChild(badge(ep.format)); badges.appendChild(badge(ep.lifecycle_stage, ep.published ? 'ok' : '')); badges.appendChild(badge('QA ' + ep.qa, statusClass(ep.qa))); card.appendChild(badges);
      if (ep.summary) card.appendChild(el('p', '', ep.summary));
      var details = el('details'); details.appendChild(el('summary', '', '상세 상태 보기'));
      var grid = el('dl', 'detail-grid'); addDetail(grid, '시리즈', ep.series_id); addDetail(grid, 'Native stage', ep.native_stage); addDetail(grid, '공통 단계', ep.lifecycle_stage); addDetail(grid, '업데이트', ep.updated_at); addDetail(grid, '출처', ep.provenance); details.appendChild(grid);
      var assets = el('div', 'asset-list'); Object.keys(ep.assets || {}).forEach(function (key) { assets.appendChild(el('span', 'asset', key + ' ' + ep.assets[key])); }); if (assets.children.length) details.appendChild(assets);
      card.appendChild(details); root.appendChild(card);
    });
  }
  function render() { renderIdentity(); renderKpis(); renderFilters(); renderEpisodes(); }
  document.getElementById('episode-query').addEventListener('input', renderEpisodes);
  document.getElementById('episode-status-filter').addEventListener('change', renderEpisodes);
  document.getElementById('episode-format-filter').addEventListener('change', renderEpisodes);

  async function hydrate() {
    var route = location.pathname.match(/^\/channels\/([^/]+)\/?$/);
    var queryId = new URLSearchParams(location.search).get('channel');
    var channelId = route ? decodeURIComponent(route[1]) : queryId;
    if (location.protocol === 'file:' || !channelId) {
      setConnection('오프라인 스냅샷 · 읽기 전용', 'warn'); render(); return;
    }
    setConnection('최신 상태 확인 중…', '');
    try {
      var encoded = encodeURIComponent(channelId);
      var responses = await Promise.all([fetch('/api/channels/' + encoded, { headers: { Accept: 'application/json' } }), fetch('/api/channels/' + encoded + '/episodes', { headers: { Accept: 'application/json' } })]);
      if (!responses[0].ok || !responses[1].ok) throw new Error('API ' + responses[0].status + '/' + responses[1].status);
      var payloads = await Promise.all([responses[0].json(), responses[1].json()]);
      state.channel = channelFromPayload(payloads[0]);
      state.conflicts = payloads[0].conflicts || [];
      state.unresolved = payloads[0].unresolved_conflicts || [];
      var observed = Array.isArray(payloads[1]) ? payloads[1] : (payloads[1].episodes || []);
      state.episodes = mergeEpisodeRows(observed, state.series);
      state.offline = false; render(); setConnection('로컬 API 연결됨 · 최신 상태', 'live');
    } catch (error) {
      render(); setConnection('API 연결 실패 · 스냅샷 표시', 'warn');
      document.getElementById('api-warning').hidden = false;
    }
  }
  render(); hydrate();
}());
`;
}

/**
 * Render a redacted, standalone channel production document.
 *
 * @param {object} input
 * @param {object} input.channel channel manifest or ChannelContext
 * @param {object|Array} [input.series] series/index data
 * @param {Array|object} [input.episodes] common EpisodeView items
 * @param {boolean} [input.offline=true] snapshot mode marker
 * @param {string} [input.generatedAt] deterministic generation timestamp for idempotent writers
 * @returns {string} standalone HTML
 */
export function renderChannelDocument({
  channel = {}, series = [], episodes = [], offline = true, generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedChannel = normalizeChannel(channel);
  const safeSeries = sanitize(series) ?? [];
  const normalizedEpisodes = normalizeEpisodes(episodes, safeSeries);
  const snapshot = sanitize({
    schema_version: 1,
    generated_at: generatedAt,
    offline: Boolean(offline),
    channel: normalizedChannel,
    series: safeSeries,
    episodes: normalizedEpisodes,
  });
  const name = escapeHtml(normalizedChannel.name);
  const id = escapeHtml(normalizedChannel.id);
  const profile = escapeHtml(normalizedChannel.pipeline_profile);
  const nativeRange = escapeHtml(pipelineNativeRange(normalizedChannel.pipeline_profile));
  const defaultQa = [
    '스크립트의 사실·표현·채널 톤 검증',
    '이미지·영상·음성 자산의 누락과 정합성 확인',
    '렌더 해상도·길이·자막 안전 영역 검사',
    '제목·설명·태그 및 플랫폼 정책 확인',
    '발행 전 운영자 승인과 산출물 해시 확인',
  ];
  const qaItems = normalizedChannel.qa.length ? normalizedChannel.qa : defaultQa;
  const riskItems = normalizedChannel.risks.length ? normalizedChannel.risks : [
    '미검토 매니페스트나 미해결 마이그레이션 충돌은 실행·발행을 차단한다.',
    '파일 상태와 저장된 상태가 다르면 실제 산출물 관측값을 우선하고 출처를 표시한다.',
  ];
  const taskItems = normalizedChannel.tasks.length ? normalizedChannel.tasks : [
    '채널 설정과 시리즈 계획의 정본을 검토한다.',
    'QA PASS와 운영자 승인 뒤에만 외부 발행을 진행한다.',
  ];

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${name} · 영상 제작·관리 설계문서</title><style>${styles()}</style></head>
<body><header class="top"><span aria-hidden="true">🎬</span><span class="brand">BarroTube 채널 운영 문서</span><span class="top-spacer"></span><span id="connection" class="connection">상태 확인 중…</span></header>
<div class="layout"><nav class="toc" aria-label="문서 목차"><strong>${id}</strong>
<a href="#meta">0. 문서 메타</a><a href="#purpose">1. 목적·범위</a><a href="#pipeline">2. 파이프라인</a><a href="#folders">3. 폴더·자산 규칙</a><a href="#status-model">4. 상태 모델</a><a href="#qa">5. QA</a><a href="#episodes">6. 에피소드 보드</a><a href="#cadence">7. 운영 리듬</a><a href="#risks">8. 리스크·할 일</a><a href="#cli">9. CLI</a></nav>
<main><section class="card hero"><div class="eyebrow">CHANNEL OPERATIONS · ${id}</div><h1 id="channel-name">${name}</h1><p class="lede" id="channel-description">${escapeHtml(normalizedChannel.description)}</p></section>

<section class="card" id="meta"><h2>0. 문서 메타</h2><dl class="meta-grid">
<div class="meta"><dt>채널 ID</dt><dd id="meta-id">${id}</dd></div><div class="meta"><dt>핸들</dt><dd id="meta-handle">${escapeHtml(normalizedChannel.handle || '—')}</dd></div>
<div class="meta"><dt>파이프라인 프로필</dt><dd id="meta-profile">${profile}</dd></div><div class="meta"><dt>Revision</dt><dd id="meta-revision">${escapeHtml(normalizedChannel.revision)}</dd></div>
<div class="meta"><dt>상태</dt><dd><span id="channel-status" class="pill">${escapeHtml(normalizedChannel.status)}</span></dd></div><div class="meta"><dt>언어·국가</dt><dd>${escapeHtml(normalizedChannel.language)} · ${escapeHtml(normalizedChannel.target_country)}</dd></div>
<div class="meta"><dt>플랫폼</dt><dd>${escapeHtml(normalizedChannel.platform_names.join(', ') || '—')}</dd></div><div class="meta"><dt>포맷</dt><dd>${escapeHtml(normalizedChannel.formats.join(', ') || '—')}</dd></div></dl>
<div id="api-warning" class="callout warn" hidden>로컬 API를 읽지 못해 생성 시점의 스냅샷을 표시합니다. 이 문서에서는 데이터를 수정하거나 제작·발행 액션을 실행하지 않습니다.</div></section>

<section class="card" id="purpose"><h2>1. 배경·목적과 범위</h2><div class="split"><div><h3>목적</h3><ul id="purpose-list" class="clean">${listMarkup(normalizedChannel.purpose, [normalizedChannel.description])}</ul></div><div><h3>관리 범위</h3><ul id="scope-list" class="clean">${listMarkup(normalizedChannel.scope)}</ul></div></div>
<div class="callout">채널 설정은 매니페스트, 시즌·에피소드 계획은 시리즈 인덱스, 실제 제작 상태는 산출물 관측값을 정본으로 사용합니다.</div></section>

<section class="card" id="pipeline"><h2>2. 제작 파이프라인</h2><p><code>${profile}</code> 어댑터의 native 단계 <strong>${nativeRange}</strong>를 공통 lifecycle로 투영합니다. 원래 단계는 진단을 위해 함께 보존합니다.</p>
<div class="scroll"><table><thead><tr><th>공통 단계</th><th>의미</th><th>완료 신호</th></tr></thead><tbody>
<tr><td><span class="pill">planned</span></td><td>주제·포맷·시리즈 계획</td><td>에피소드 계획 또는 브리프</td></tr><tr><td><span class="pill">script</span></td><td>리서치·전략·대본·팩트체크</td><td>검토 가능한 최종 대본</td></tr>
<tr><td><span class="pill">assets</span></td><td>TTS·이미지·영상 소재</td><td>필수 씬 자산 완성</td></tr><tr><td><span class="pill">render</span></td><td>플랫폼 규격으로 합성</td><td>최종 영상 또는 캐러셀</td></tr>
<tr><td><span class="pill">qa</span></td><td>기술·콘텐츠·정책 검수</td><td>QA PASS와 메타데이터</td></tr><tr><td><span class="pill">approval</span></td><td>사람의 외부 공개 승인</td><td>승인 기록과 해시 일치</td></tr>
<tr><td><span class="pill ok">published</span></td><td>플랫폼 게시·예약</td><td>플랫폼 결과 식별자</td></tr></tbody></table></div></section>

<section class="card" id="folders"><h2>3. 폴더·자산 규칙</h2><p>문서에는 로컬 절대 경로를 기록하지 않습니다. 모든 위치는 채널 작업공간을 기준으로 한 상대 구조로 표현합니다.</p>
<pre><code>workspace/channels/&lt;channel-id&gt;/
├─ channel.yaml               # 채널 정적 설정의 정본
├─ series/index.json          # 시즌·에피소드 계획과 수동 QA
├─ brand/                     # DNA·스타일·정책 문서
├─ episodes/&lt;episode-id&gt;/     # 파이프라인별 실제 산출물
└─ documents/channel.html     # 생성된 읽기 전용 스냅샷</code></pre>
<ul class="clean"><li>새 산출물에는 <code>channel_id</code>와 native stage를 기록합니다.</li><li>파일명은 어댑터 규격을 유지하고 공통 보드는 이동 없이 읽습니다.</li><li>문서 스냅샷에는 자격 증명 참조, 토큰, 절대 경로를 포함하지 않습니다.</li></ul></section>

<section class="card" id="status-model"><h2>4. 상태 모델</h2><div class="scroll"><table><thead><tr><th>상태</th><th>운영 의미</th><th>허용 동작</th></tr></thead><tbody>
<tr><td><code>needs_review</code></td><td>초기 마이그레이션 또는 충돌 검토 필요</td><td>조회·설정 검토</td></tr><tr><td><code>active</code></td><td>검증된 매니페스트가 활성화됨</td><td>지원되는 제작 액션</td></tr>
<tr><td><code>blocked / failed</code></td><td>충돌, QA 실패 또는 실행 오류</td><td>원인 해소와 재검증</td></tr><tr><td><code>archived</code></td><td>보존용 비활성 채널</td><td>읽기 전용 조회</td></tr></tbody></table></div>
<div class="callout warn">알 수 없는 채널 ID를 기본 채널로 바꾸지 않습니다. 채널 ID와 revision이 일치하지 않으면 저장·실행을 중단해야 합니다.</div></section>

<section class="card" id="qa"><h2>5. QA 기준</h2><ul class="checklist">${listMarkup(qaItems)}</ul><p>발행 게이트는 활성 매니페스트, 충돌 0건, QA PASS, 운영자 승인, 최종 산출물 해시 일치를 서버에서 다시 검사합니다.</p></section>

<section class="card" id="episodes"><h2>6. 에피소드 보드</h2><div class="kpis"><div class="kpi"><strong id="kpi-total">${normalizedEpisodes.length}</strong><span>전체</span></div><div class="kpi"><strong id="kpi-active">0</strong><span>진행 중</span></div><div class="kpi"><strong id="kpi-qa">0</strong><span>QA PASS</span></div><div class="kpi"><strong id="kpi-published">0</strong><span>발행·예약</span></div></div>
<div class="board-tools"><input id="episode-query" type="search" aria-label="에피소드 검색" placeholder="EP ID·제목·시리즈 검색"><select id="episode-status-filter" aria-label="상태 필터"><option value="all">전체 상태</option><option value="active">진행 중</option><option value="published">발행·예약</option><option value="blocked">실패·차단</option></select><select id="episode-format-filter" aria-label="포맷 필터"><option value="all">전체 포맷</option></select><span id="episode-count" class="pill"></span></div><div id="episode-grid" class="episode-grid" aria-live="polite"></div>
<noscript><div class="noscript">JavaScript가 꺼져 있어 에피소드 스냅샷을 표시할 수 없습니다. 이 파일 자체에는 데이터 변경 기능이 없습니다.</div></noscript></section>

<section class="card" id="cadence"><h2>7. 운영 리듬</h2><div class="scroll"><table><thead><tr><th>포맷</th><th>주당 목표</th><th>요일</th><th>시각</th></tr></thead><tbody id="cadence-body">${cadenceRows(normalizedChannel.cadence)}</tbody></table></div><p>시각은 채널 매니페스트의 타임존을 따르며, 값이 없으면 운영자 로컬 타임존을 기본으로 표시합니다.</p></section>

<section class="card" id="risks"><h2>8. 리스크와 다음 할 일</h2><div class="split"><div><h3>리스크·충돌</h3><ul id="risk-list" class="clean">${listMarkup(riskItems)}</ul></div><div><h3>운영 할 일</h3><ul id="task-list" class="clean">${listMarkup(taskItems)}</ul></div></div></section>

<section class="card" id="cli"><h2>9. CLI·로컬 보드</h2><p>명령은 채널 ID를 명시하고, 변경 전에는 dry-run 결과와 충돌 보고서를 검토합니다.</p><pre><code>node scripts/automation/channel-migrate.js --channel &lt;channel-id&gt; --dry-run
node scripts/automation/render-channel-document.js --channel &lt;channel-id&gt;
node tools/board/server.js --port 8933 --open</code></pre><div class="callout warn">외부 발행은 문서에서 실행하지 않습니다. 로컬 보드가 허용 목록의 액션과 명시적 확인 토큰을 서버 측에서 검증해야 합니다.</div></section>

<p class="footer">생성 시각 ${escapeHtml(generatedAt)} · 공개용 스냅샷 schema v1 · 직접 연 파일은 읽기 전용</p></main></div>
<script id="channel-snapshot" type="application/json">${jsonForHtml(snapshot)}</script><script>${clientScript()}</script></body></html>`;
}

export default renderChannelDocument;
