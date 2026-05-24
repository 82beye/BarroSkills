#!/usr/bin/env node

/**
 * marketing-fetch-local.js — BarroSkills 마케팅 데이터 fetch (Paperclip 대체)
 *
 * 3가지 데이터 소스 지원:
 *   --source rss              config/domain-whitelist.json의 RSS feeds에서 fetch
 *   --source manual           --file <path>의 사용자 입력 JSON 읽기
 *   --source paperclip-export --file <path> 기존 Paperclip 리포트 JSON
 *
 * 출력: workspace/intel/marketing/auto-YYYY-MM-DD.json (또는 --out 명시)
 *
 * Usage:
 *   node marketing-fetch-local.js --source rss
 *   node marketing-fetch-local.js --source rss --out workspace/intel/marketing/custom.json
 *   node marketing-fetch-local.js --source manual --file workspace/intel/marketing/manual-2026-05-24.json
 *   node marketing-fetch-local.js --source paperclip-export --file ~/youtube-co/workspace/intel/marketing/YOU-99.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const CONFIG_DIR = join(ROOT, 'config');
const INTEL_DIR = join(ROOT, 'workspace/intel/marketing');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_ITEMS_PER_FEED = 20;

// 간단 RSS 2.0 / Atom XML 파서 (외부 의존성 없이)
// <item> 또는 <entry> 블록에서 title, link, description/summary, pubDate/updated 추출.
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[0];
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || '';
    let link = (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1];
    if (!link) link = (block.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || '';
    const desc = (block.match(/<(?:description|summary|content[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/i) || [])[1] || '';
    const pubDate = (block.match(/<(?:pubDate|published|updated)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:pubDate|published|updated)>/i) || [])[1] || '';
    items.push({
      title: title.trim().replace(/<[^>]+>/g, ''),
      link: link.trim(),
      summary: desc.trim().replace(/<[^>]+>/g, '').slice(0, 500),
      published_at: pubDate.trim(),
    });
    if (items.length >= MAX_ITEMS_PER_FEED) break;
  }
  return items;
}

async function fetchWithTimeout(url, ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'BarroSkills/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function sourceRSS() {
  const whitelistFile = join(CONFIG_DIR, 'domain-whitelist.json');
  if (!existsSync(whitelistFile)) {
    throw new Error(`domain-whitelist.json missing: ${whitelistFile}`);
  }
  const wl = JSON.parse(readFileSync(whitelistFile, 'utf-8'));
  const rssFeeds = wl.rss_feeds || wl.feeds || [];
  if (rssFeeds.length === 0) {
    console.error('⚠️ domain-whitelist.json에 rss_feeds 필드 없음. fallback 기본 RSS 사용.');
    rssFeeds.push(
      { url: 'https://www.hankyung.com/feed/economy', label: 'Hankyung Economy' },
      { url: 'https://www.mk.co.kr/rss/30000001/', label: 'MK Economy' },
    );
  }

  const items = [];
  const errors = [];
  for (const feed of rssFeeds.slice(0, 10)) {
    const url = feed.url || feed;
    const label = feed.label || url;
    try {
      const xml = await fetchWithTimeout(url);
      const feedItems = parseRSS(xml);
      for (const it of feedItems) {
        items.push({ ...it, source: label, feed_url: url });
      }
    } catch (e) {
      errors.push({ url, error: e.message });
    }
  }

  return {
    type: 'rss',
    fetched_at: new Date().toISOString(),
    items: items.slice(0, 50),  // 상한 50건
    fetched_count: items.length,
    errors,
  };
}

function sourceManual(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`manual file not found: ${filePath}`);
  }
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  // 형식 검증 (느슨)
  if (!Array.isArray(data.items)) {
    throw new Error(`manual file must have items: [...] field`);
  }
  return {
    type: 'manual',
    source_file: filePath,
    fetched_at: new Date().toISOString(),
    items: data.items,
    fetched_count: data.items.length,
  };
}

function sourcePaperclipExport(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`paperclip-export file not found: ${filePath}`);
  }
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  // Paperclip Marketing Analyst 리포트 형식 변환
  const items = (data.actionItems || data.items || []).map(it => ({
    title: it.title || it.topic || '',
    summary: it.description || it.summary || '',
    link: it.url || it.link || '',
    source: 'paperclip-export',
    published_at: it.created_at || '',
  }));
  return {
    type: 'paperclip-export',
    source_file: filePath,
    fetched_at: new Date().toISOString(),
    items,
    fetched_count: items.length,
    original_report: { title: data.title, content_preview: (data.content || '').slice(0, 500) },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: 'rss' },
      file: { type: 'string' },
      out: { type: 'string' },
    },
  });

  let result;
  switch (values.source) {
    case 'rss':
      result = await sourceRSS();
      break;
    case 'manual':
      if (!values.file) throw new Error('--source manual requires --file');
      result = sourceManual(values.file);
      break;
    case 'paperclip-export':
      if (!values.file) throw new Error('--source paperclip-export requires --file');
      result = sourcePaperclipExport(values.file);
      break;
    default:
      throw new Error(`Unknown source: ${values.source} (rss | manual | paperclip-export)`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const outPath = values.out || join(INTEL_DIR, `auto-${date}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log(`✅ Marketing intel fetched`);
  console.log(`   source: ${result.type}`);
  console.log(`   items: ${result.fetched_count}`);
  console.log(`   output: ${outPath}`);
  if (result.errors && result.errors.length) {
    console.log(`   errors: ${result.errors.length} (일부 RSS feed 실패)`);
    for (const e of result.errors.slice(0, 3)) {
      console.log(`     - ${e.url}: ${e.error}`);
    }
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
