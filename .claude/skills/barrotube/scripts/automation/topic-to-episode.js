#!/usr/bin/env node

/**
 * topic-to-episode.js — 주제어 기반 에피소드 자동 생성기
 *
 * 사용자가 입력한 주제어에 대해:
 *   1. 최근 3일치 뉴스 수집 (오늘 news.json 없으면 fetch-daily-news 자동 실행)
 *   2. 주제어 + 유사 키워드 포함 기사 필터
 *   3. 점수화 (최근성 + 제목 매치 + 키워드 밀도)
 *   4. Top 5 기사 → Brief의 레퍼런스로 첨부
 *   5. create-episode.js 호출해 에피소드 초기화
 *
 * Usage:
 *   node topic-to-episode.js --topic "AI 반도체 수출" [--channel econ-daily] [--days 3]
 *   node topic-to-episode.js --topic "코스피 5000" --auto-run   # S6~S9 자동 실행
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');

const CHANNEL_SYNONYMS = {
  'econ-daily': {
    '코스피': ['KOSPI', '주가지수', '증시', '주식시장'],
    'AI': ['인공지능', '챗GPT', '제미나이', 'LLM', '생성형'],
    '반도체': ['메모리', 'HBM', 'D램', '파운드리', 'TSMC', '엔비디아', 'SK하이닉스', '삼성전자'],
    '2차전지': ['배터리', 'LG에너지솔루션', '삼성SDI', '에코프로', 'SK온', '전기차'],
    '바이오': ['제약', '신약', '삼성바이오로직스', '셀트리온', '유한양행'],
    '원화': ['환율', '달러', '원달러', '외환', 'FX'],
    '금리': ['기준금리', '연준', 'Fed', '한국은행', '통화정책'],
    '부동산': ['아파트', '집값', '전세', '매매', '주택'],
    '수출': ['무역', '무역수지', '수입', '경상수지'],
  },
};

function run(cmd, args, { capture = true } = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

/**
 * 주제어를 확장 키워드 세트로 변환
 */
function expandTopic(topic, channel) {
  const lex = CHANNEL_SYNONYMS[channel] || CHANNEL_SYNONYMS['econ-daily'];
  const keywords = new Set([topic]);
  // 공백 기준 토큰 추가
  topic.split(/\s+/).forEach(tok => {
    if (tok.length >= 2) keywords.add(tok);
  });
  // 사전 매칭: 주제 토큰이 사전 키에 포함되거나 그 역
  for (const [key, syns] of Object.entries(lex)) {
    for (const tok of [topic, ...topic.split(/\s+/)]) {
      if (tok.includes(key) || key.includes(tok)) {
        syns.forEach(s => keywords.add(s));
        keywords.add(key);
        break;
      }
    }
  }
  return Array.from(keywords).filter(k => k.length >= 2);
}

/**
 * 최근 N일치 뉴스 로드 (없으면 fetch)
 */
function loadRecentNews(days = 3) {
  const items = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const path = join(ROOT, 'workspace/daily-news', date, 'news.json');

    if (!existsSync(path) && i === 0) {
      // 오늘자 없으면 수집
      console.log(`📰 오늘자 뉴스 수집 (${date})...`);
      run('node', ['scripts/automation/fetch-daily-news.js', '--date', date], { capture: false });
    }

    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      for (const src of data.sources || []) {
        for (const item of src.items || []) {
          items.push({ ...item, source: src.source_name, date });
        }
      }
    }
  }
  return items;
}

/**
 * 주제어 매칭 점수
 */
function scoreRelevance(item, keywords, primary) {
  let score = 0;
  const text = `${item.title} ${item.description || ''}`;

  // Primary 정확 매치 +10
  if (text.includes(primary)) score += 10;

  // 확장 키워드 매치 +2 per
  const matched = [];
  for (const kw of keywords) {
    if (text.includes(kw)) {
      score += 2;
      matched.push(kw);
    }
  }

  // 제목에 매치 +5 추가
  for (const kw of keywords) {
    if (item.title.includes(kw)) { score += 5; break; }
  }

  // 수치 포함 +2 per (최대 4개)
  const nums = (text.match(/\d+(\.\d+)?(\s*(%|퍼센트|조|억|만|달러|원))?/g) || []).slice(0, 4);
  score += nums.length * 2;

  // 최근성
  if (item.pubDate) {
    try {
      const hoursAgo = (Date.now() - new Date(item.pubDate).getTime()) / (1000 * 60 * 60);
      if (hoursAgo < 24) score += 4;
      else if (hoursAgo < 48) score += 2;
      else if (hoursAgo < 72) score += 1;
    } catch {}
  }

  return { score, matched };
}

function dedup(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.title.slice(0, 20).replace(/\s/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      topic: { type: 'string', short: 't' },
      channel: { type: 'string', short: 'c' },
      days: { type: 'string', short: 'd' },
      'auto-run': { type: 'boolean', default: false },
    },
  });

  if (!values.topic) {
    console.error('Usage: topic-to-episode.js --topic "주제어" [--channel econ-daily] [--days 3]');
    process.exit(1);
  }

  const topic = values.topic.trim();
  const channel = values.channel || 'econ-daily';
  const days = parseInt(values.days || '3');

  console.log(`\n🎯 Topic: "${topic}"`);
  console.log(`   Channel: ${channel} | Days: ${days}\n`);

  // 1. 키워드 확장
  const keywords = expandTopic(topic, channel);
  console.log(`🔍 Expanded keywords (${keywords.length}): ${keywords.slice(0, 10).join(', ')}${keywords.length > 10 ? '...' : ''}`);

  // 2. 최근 뉴스 로드
  const allNews = loadRecentNews(days);
  console.log(`📥 Loaded ${allNews.length} news items from last ${days} days`);

  // 3. 관련성 점수화
  const scored = allNews
    .map(it => ({ ...it, ...scoreRelevance(it, keywords, topic) }))
    .filter(it => it.score >= 5);

  const unique = dedup(scored);
  unique.sort((a, b) => b.score - a.score);

  if (unique.length === 0) {
    console.error(`\n❌ "${topic}" 관련 기사가 없습니다. 다른 주제어나 --days 값을 늘려보세요.`);
    process.exit(1);
  }

  console.log(`\n🏆 Top ${Math.min(5, unique.length)} related articles:`);
  const refs = unique.slice(0, 5);
  refs.forEach((it, i) => {
    console.log(`  ${i + 1}. [${it.score}점] ${it.title.slice(0, 70)}`);
    console.log(`     📰 ${it.source} | ${it.date}`);
  });

  // 4. create-episode.js 호출 (Brief notes에 레퍼런스 첨부)
  const notes = [
    `운영자 지정 주제: ${topic}`,
    `관련 확장 키워드: ${keywords.join(', ')}`,
    '',
    '최근 관련 기사:',
    ...refs.map((it, i) => `${i + 1}. [${it.source}] ${it.title}\n   ${it.link}`),
  ].join('\n');

  const topicTitle = refs[0] ? `${topic} — ${refs[0].title.slice(0, 50)}` : topic;

  console.log(`\n🎬 Creating episode...`);
  const r = run('node', [
    'scripts/automation/create-episode.js',
    '--channel', channel,
    '--topic', topicTitle,
    '--length', '60',
    '--notes', notes,
  ]);

  if (r.status !== 0) {
    console.error('❌ create-episode failed:', r.stderr);
    process.exit(1);
  }

  const m = r.stdout.match(/EP-\d{4}-\d{4}/);
  const epId = m?.[0];
  if (!epId) {
    console.error('❌ EP ID 추출 실패');
    console.error(r.stdout);
    process.exit(1);
  }

  // 5. 레퍼런스 별도 저장
  const refsPath = join(ROOT, 'workspace/episodes', epId, '05_topic_references.md');
  const refsContent = [
    `# ${epId} — Topic References`,
    '',
    `**주제어**: ${topic}`,
    `**채널**: ${channel}`,
    `**생성일**: ${new Date().toISOString()}`,
    `**확장 키워드** (${keywords.length}): ${keywords.join(', ')}`,
    '',
    '## 최근 관련 기사 (Top 5)',
    '',
    ...refs.map((it, i) => [
      `### ${i + 1}. ${it.title}`,
      `- **출처**: ${it.source}`,
      `- **날짜**: ${it.date} ${it.pubDate ? `(${it.pubDate})` : ''}`,
      `- **링크**: ${it.link || '-'}`,
      `- **점수**: ${it.score} (매치: ${it.matched.slice(0, 5).join(', ')})`,
      `- **요약**: ${(it.description || '').slice(0, 200)}`,
      '',
    ].join('\n')),
  ].join('\n');
  writeFileSync(refsPath, refsContent, 'utf-8');

  console.log(`\n✅ Episode created: ${epId}`);
  console.log(`   📁 workspace/episodes/${epId}/`);
  console.log(`   📄 05_topic_references.md (Top 5 기사 첨부됨)`);
  console.log(`\n다음 단계: Claude Code에서 Writer(S4) + Asset PM(S6) 진행`);

  if (values['auto-run']) {
    console.log(`\n🤖 --auto-run: S6~S9는 향후 확장 예정 (현재는 Claude CLI 필요)`);
  }

  // 결과 JSON 출력 (봇이 파싱 용이)
  const result = {
    episode_id: epId,
    topic,
    channel,
    expanded_keywords: keywords,
    references_count: refs.length,
    references: refs.map(it => ({
      title: it.title,
      source: it.source,
      link: it.link,
      score: it.score,
    })),
  };
  console.log(`\n<!--RESULT-->${JSON.stringify(result)}<!--/RESULT-->`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
