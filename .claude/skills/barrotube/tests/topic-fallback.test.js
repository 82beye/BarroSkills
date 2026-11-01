import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHeadline, isRepeatTopic, marketShockTopic, rankFallbackNews } from '../scripts/automation/lib/topic-fallback.js';

test('fallback rejects repeated and stale headlines and keeps a sourced new angle', () => {
  const news = { sources: [{ source_name: 'wire', items: [
    { title: 'Americans&apos; debt problems are flashing a warning not seen since the Great Recession',
      link: 'https://example.com/debt', pubDate: '2026-10-09T19:18:24Z' },
    { title: 'Fed rate decision changes the bond market outlook',
      link: 'https://example.com/rates', pubDate: '2026-10-11T23:00:00Z', description: 'Bond yields and loans may change.' },
    { title: 'Stocks jump on old report', link: 'https://example.com/old', pubDate: '2026-09-01T10:00:00Z' },
    { title: 'Stocks move with no URL', pubDate: '2026-10-11T23:00:00Z' },
    { title: 'Hurricane kills two and disrupts US oil production', link: 'https://example.com/storm',
      pubDate: '2026-10-11T22:00:00Z' },
  ] }] };
  const rows = rankFallbackNews(news, { asOf: '2026-10-12T01:00:00Z', slotName: 'omnibus',
    priorTopics: [{ topic: "이번 주 준비: Americans' debt problems are flashing a warning not seen since the Great Recession",
      source_url: 'https://example.com/debt' }] });
  assert.equal(rows[0].topic, 'Fed rate decision changes the bond market outlook');
  assert.equal(rows[0].status, 'eligible');
  assert.ok(rows.find((r) => r.topic.includes('debt problems')).reasons.includes('recent_channel_repeat'));
  assert.ok(rows.find((r) => r.topic.includes('old report')).reasons.includes('outside_freshness_window'));
  assert.ok(rows.find((r) => r.topic.includes('no URL')).reasons.includes('missing_source_url'));
  assert.ok(rows.find((r) => r.topic.includes('Hurricane')).reasons.includes('casualty_lead_not_suitable_for_fallback'));
});

test('HTML entities are normalized for display and repeat detection', () => {
  assert.equal(cleanHeadline('Americans&apos; debt &amp; loans'), "Americans' debt & loans");
  assert.equal(isRepeatTopic('Americans&apos; debt problems', 'https://example.com/a',
    [{ topic: "이번 주 준비: Americans' debt problems" }]), true);
});

test('kr-close fallback leads with a same-day verified 3% closing loss', () => {
  const market = { available: true, stale: false, content_mode: 'market_close',
    expected_session_date: '2026-10-13', quotes: [
      { symbol: 'KOSPI', price: 6035.35, change_pct: -5.46, market_status: 'CLOSE', traded_at: '2026-10-13T16:00:00+09:00' },
    ] };
  assert.equal(marketShockTopic(market, { slotName: 'kr-close', date: '2026-10-13' })?.topic,
    '코스피 5.46% 급락, 6,035.35 마감');
  assert.equal(marketShockTopic({ ...market, stale: true }, { slotName: 'kr-close', date: '2026-10-13' }), null);
  assert.equal(marketShockTopic(market, { slotName: 'kr-close', date: '2026-10-14' }), null);
});
