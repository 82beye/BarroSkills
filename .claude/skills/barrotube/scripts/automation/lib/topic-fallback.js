/** A deliberately conservative, no-model topic choice for a failed research run. */
const ECON_TERMS = /증시|주식|주가|코스피|코스닥|반도체|금리|환율|달러|원화|부채|대출|연체|물가|인플레이션|수출|무역|부동산|아파트|전세|유가|원유|채권|금융|경제|실적|매출|고용|소비|삼성|하이닉스|stock|market|share|debt|loan|delinquen|inflation|tariff|fed|rate|oil|bond|econom|earnings|jobs|consumer/i;
const NO_STANDALONE_HEADLINE = new Set(['홈', '국내', '해외', '뉴스', '경제', '증시', '미국 · 글로벌']);
const SENSITIVE_HEADLINE = /사망|참사|피살|살해|총격|kills?\b|deaths?\b|murder|shooting/i;

export function cleanHeadline(value) {
  return String(value ?? '')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

export function topicKey(value) {
  return cleanHeadline(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Compare the question, explanation and consequence, not just changed headlines.
// A genuinely new observed fact keeps a revisited topic eligible. This is a
// narrow duplicate warning, not a claim to understand Korean economic meaning.
function bigrams(value) {
  const key = topicKey(value);
  return new Set(Array.from({ length: Math.max(0, key.length - 1) }, (_, i) => key.slice(i, i + 2)));
}
function overlap(a, b) {
  const left = bigrams(a), right = bigrams(b);
  if (!left.size || !right.size) return 0;
  return [...left].filter((token) => right.has(token)).length / (left.size + right.size - [...left].filter((token) => right.has(token)).length);
}
export function isRepeatStory(spine, priorTopics = []) {
  if (!spine?.question || !spine?.mechanism || !spine?.viewer_result || !spine?.new_fact) return false;
  return priorTopics.some(({ story_spine: old }) => old
    && overlap(spine.question, old.question) >= 0.75
    && overlap(spine.mechanism, old.mechanism) >= 0.75
    && overlap(spine.viewer_result, old.viewer_result) >= 0.75
    && overlap(spine.new_fact, old.new_fact) >= 0.75);
}

export function isRepeatTopic(title, link, priorTopics = []) {
  const key = topicKey(title);
  return priorTopics.some((prior) => {
    const oldKey = topicKey(prior.topic);
    return (key.length >= 12 && (oldKey.includes(key) || key.includes(oldKey) && oldKey.length >= 12))
      || (link && prior.source_url && link === prior.source_url);
  });
}

/** A verified closing move takes precedence over an unrelated fresh headline. */
export function marketShockTopic(market, { slotName, date } = {}) {
  if (slotName !== 'kr-close' || market?.available !== true || market.stale
    || market.content_mode !== 'market_close' || market.expected_session_date !== date) return null;
  const kospi = (market.quotes ?? []).find((q) => q.symbol === 'KOSPI');
  if (!kospi || kospi.market_status !== 'CLOSE' || !kospi.traded_at?.startsWith(date)
    || !Number.isFinite(kospi.change_pct) || kospi.change_pct > -3
    || !Number.isFinite(kospi.price)) return null;
  return {
    topic: `코스피 ${Math.abs(kospi.change_pct).toFixed(2)}% 급락, ${kospi.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 마감`,
    source_url: 'https://global.krx.co.kr/cn/main/main.jsp',
  };
}

export function rankFallbackNews(news, { asOf, slotName, priorTopics = [] } = {}) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error('fallback requires a valid collection time');
  // A morning briefing cannot be built from a three-day-old headline. Weekly real estate can.
  const maxAgeHours = slotName === 'realestate' ? 168 : slotName === 'us-close' ? 72 : 30;
  const seen = new Set();
  const candidates = [];
  for (const source of news?.sources ?? []) {
    for (const item of source.items ?? []) {
      const title = cleanHeadline(item.title);
      const description = cleanHeadline(item.description);
      const link = String(item.link ?? '').trim();
      const published = Date.parse(item.pubDate ?? '');
      const ageHours = (now - published) / 3600_000;
      const key = topicKey(title);
      if (seen.has(key)) continue;
      seen.add(key);
      const rejected = [];
      if (title.length < 12 || NO_STANDALONE_HEADLINE.has(title)) rejected.push('headline_too_thin');
      if (!/^https?:\/\//i.test(link)) rejected.push('missing_source_url');
      if (!Number.isFinite(published)) rejected.push('missing_published_at');
      else if (ageHours < -1 || ageHours > maxAgeHours) rejected.push('outside_freshness_window');
      if (!ECON_TERMS.test(`${title} ${description}`)) rejected.push('no_economic_relevance');
      if (SENSITIVE_HEADLINE.test(title)) rejected.push('casualty_lead_not_suitable_for_fallback');
      if (isRepeatTopic(title, link, priorTopics)) rejected.push('recent_channel_repeat');
      candidates.push({
        topic: title, source: source.source_name ?? item.source ?? 'unknown', source_url: link,
        published_at: Number.isFinite(published) ? new Date(published).toISOString() : null,
        age_hours: Number.isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null,
        status: rejected.length ? 'rejected' : 'eligible', reasons: rejected,
        score: rejected.length ? null : Math.max(0, 72 - ageHours) + Math.min(description.length, 120) / 30,
        summary: description.slice(0, 240),
      });
    }
  }
  candidates.sort((a, b) => (a.status === 'eligible' ? -1 : 1) - (b.status === 'eligible' ? -1 : 1)
    || (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return candidates;
}
