#!/usr/bin/env node

/**
 * BarroTube — 새 에피소드 생성 스크립트 (v1.5 — 시리즈 모드 + v2 layout)
 *
 * 두 가지 모드:
 *
 * 1) 단발 (Line B — Shorts 단발 또는 Long 단발)
 *    Usage: node create-episode.js --channel <id> --topic "<주제>" [--length 60] [--format shorts]
 *    출력: episodeDir/00_brief.md (v1 평면) — produce-episode가 자동으로 v2 platforms/로 끌어올림.
 *
 * 2) 시리즈 (Line A — sp500-basic, nasdaq100-basic 등 시리즈 정의 기반)
 *    Usage: node create-episode.js --channel <id> --series <series_id> --episode-slot N --brief <path>
 *    동작:
 *      - paperclip/config/series.json 에서 series_id 검증
 *      - 입력 brief을 episodeDir/00_brief.md로 복사 (episode_id/created_at 갱신)
 *      - episodeDir/series_link.json 생성 (시리즈 멤버십)
 *      - v2 layout 미리 생성: platforms/{long|shorts}/40_assets/{images,tts}
 */

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { registerIssue } from './register-paperclip-issue.js';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(ROOT, 'workspace');

function generateEpisodeId() {
  const year = new Date().getFullYear();
  const episodesDir = join(WORKSPACE, 'episodes');
  if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });
  const existing = readdirSync(episodesDir).filter(d => d.startsWith(`EP-${year}-`)).sort();
  const lastNum = existing.length > 0 ? parseInt(existing[existing.length - 1].split('-')[2], 10) : 0;
  return `EP-${year}-${String(lastNum + 1).padStart(4, '0')}`;
}

function loadSeriesConfig() {
  const p = resolve(ROOT, 'paperclip/config/series.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function bootstrapV2Layout(epDir, format) {
  const platform = format === 'long-3min' ? 'long' : 'shorts';
  mkdirSync(join(epDir, 'platforms', platform, '40_assets', 'images'), { recursive: true });
  mkdirSync(join(epDir, 'platforms', platform, '40_assets', 'tts'), { recursive: true });
  return platform;
}

function writeStatus(epDir, episodeId, channel, actor) {
  const status = {
    episode_id: episodeId,
    channel_id: channel,
    created_at: new Date().toISOString(),
    current_stage: 'S0',
    status: 'created',
    stage_history: [{
      stage: 'S0', status: 'completed', timestamp: new Date().toISOString(), actor,
    }],
  };
  writeFileSync(join(epDir, '.episode_status.json'), JSON.stringify(status, null, 2), 'utf-8');
}

function singleEpisode({ channel, topic, length, notes, format }) {
  const channelDir = join(WORKSPACE, 'channels', channel);
  if (!existsSync(channelDir)) { console.error(`❌ Channel not found: ${channel}`); process.exit(1); }
  const episodeId = generateEpisodeId();
  const episodeDir = join(WORKSPACE, 'episodes', episodeId);
  const platform = bootstrapV2Layout(episodeDir, format);

  // Brief frontmatter — CEO 정책 v1.0 (2026-04-26) public-figure 필드 자동 주입.
  // 모든 신규 필드는 선언적 default (빈 배열 / null / 'low')만 가지며 기존 EP 영향 없음.
  // 운영자가 EP-specific 토큰이 필요하면 brief 수정 후 produce-episode 재실행.
  // YAML-safe topic encoding (2026-04-30 fix) — JSON.stringify로 내부 따옴표 escape.
  const topicYaml = JSON.stringify(String(topic));
  const brief = `---
episode_id: ${episodeId}
channel_id: ${channel}
created_at: ${new Date().toISOString()}
topic: ${topicYaml}
target_length_seconds: ${length}
format: ${format}
status: created
# Public Figure Policy v1.0 (CEO 결정 2026-04-26) — 모두 선택. 비워두면 디폴트 적용.
public_figures: []                # 등록 인물 id 또는 객체 배열. 미명시 시 topic 자동 감지.
sensitivity: low                  # low | medium | high (정책 §3.1). 사망·범죄·암살 보도면 high.
policy_override: null             # 운영자 명시 우회 토큰 (정책 §6.5). { section, reason, approved_by, approved_at }
legal_review_approved_by: null    # REQUIRES_LEGAL_REVIEW 카테고리 (한국 인사) 시 운영자 핸들
legal_review_approved_at: null    # ISO8601 (legal_review_approved_by와 함께 사용)
caricature_scene_limit_override: false  # §5.4 — 씬 수 상한 우회 (Shorts >2 / Long >3 캐리커처)
---

# Episode Brief

## 주제
${topic}

## 채널
${channel}

## 목표 길이
${length}초 (${Math.round(length / 60)}분)

## 운영자 요구사항
${notes || '없음'}
`;
  writeFileSync(join(episodeDir, '00_brief.md'), brief, 'utf-8');
  writeStatus(episodeDir, episodeId, channel, 'board');

  console.log(`✅ Episode created (single mode)`);
  console.log(`   ID:       ${episodeId}`);
  console.log(`   Channel:  ${channel}`);
  console.log(`   Topic:    ${topic}`);
  console.log(`   Format:   ${format} → platforms/${platform}/`);
  console.log(`   Length:   ${length}s`);
  console.log(`   Path:     ${episodeDir}`);

  console.log(`\n📎 Registering Paperclip issue...`);
  try {
    const r = registerIssue(episodeId);
    if (r) console.log(`   → ${r.identifier}`);
    else console.log(`   ⚠ paperclip CLI 미설치 또는 등록 실패 (파이프라인은 계속 진행 가능)`);
  } catch (e) { console.log(`   ⚠ ${e.message}`); }

  console.log(`\n📋 Next: node scripts/automation/produce-episode.js --episode ${episodeId}`);
}

function seriesEpisode({ channel, seriesId, slot, briefPath }) {
  const cfg = loadSeriesConfig();
  if (!cfg) { console.error('❌ paperclip/config/series.json 없음'); process.exit(1); }
  const series = (cfg.series || []).find(s => s.id === seriesId);
  if (!series) {
    const known = (cfg.series || []).map(s => s.id).join(', ');
    console.error(`❌ Series not found: ${seriesId}. Known: ${known}`);
    process.exit(1);
  }
  if (slot < 1 || slot > (series.total_episodes || 5)) {
    console.error(`❌ episode-slot ${slot} out of range (1..${series.total_episodes || 5})`);
    process.exit(1);
  }

  const briefAbs = resolve(briefPath);
  if (!existsSync(briefAbs)) { console.error(`❌ Brief not found: ${briefAbs}`); process.exit(1); }
  const raw = readFileSync(briefAbs, 'utf-8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) { console.error('❌ Brief frontmatter parse fail'); process.exit(1); }
  const fm = parseYAML(m[1]);

  const episodeId = generateEpisodeId();
  const episodeDir = join(WORKSPACE, 'episodes', episodeId);
  const format = series.format || fm.format || 'long-3min';
  const platform = bootstrapV2Layout(episodeDir, format);

  // brief frontmatter 갱신: episode_id, created_at 동기화
  fm.episode_id = episodeId;
  fm.channel_id = fm.channel_id || channel;
  fm.created_at = new Date().toISOString();
  fm.status = 'created';
  // 시리즈 정보가 brief에 없으면 series.json에서 채워넣음
  fm.series_id = fm.series_id || series.id;
  fm.series_episode = fm.series_episode || slot;
  fm.series_total = fm.series_total || series.total_episodes || 5;
  fm.format = format;

  // Public Figure Policy v1.0 (CEO 결정 2026-04-26) — frontmatter에 누락된 필드 default 주입.
  // 입력 brief에 이미 명시되어 있으면 운영자 의도 유지 (덮어쓰지 않음).
  if (!('public_figures' in fm)) fm.public_figures = [];
  if (!('sensitivity' in fm)) fm.sensitivity = 'low';
  if (!('policy_override' in fm)) fm.policy_override = null;
  if (!('legal_review_approved_by' in fm)) fm.legal_review_approved_by = null;
  if (!('legal_review_approved_at' in fm)) fm.legal_review_approved_at = null;
  if (!('caricature_scene_limit_override' in fm)) fm.caricature_scene_limit_override = false;

  const newBrief = `---\n${stringifyYAML(fm).trim()}\n---\n${m[2]}`;
  writeFileSync(join(episodeDir, '00_brief.md'), newBrief, 'utf-8');

  // series_link.json — episodeDir 직속, 시리즈 멤버십 1회 정의
  const seriesLink = {
    series_id: series.id,
    series_episode: slot,
    series_total: series.total_episodes || 5,
    series_name: series.name,
    parent_long_id: episodeId,
  };
  writeFileSync(join(episodeDir, 'series_link.json'), JSON.stringify(seriesLink, null, 2) + '\n', 'utf-8');

  writeStatus(episodeDir, episodeId, channel, 'ceo-agent');

  console.log(`✅ Series episode created`);
  console.log(`   ID:       ${episodeId}`);
  console.log(`   Series:   ${series.name} [${slot}/${series.total_episodes || 5}]`);
  console.log(`   Channel:  ${channel}`);
  console.log(`   Topic:    ${fm.topic}`);
  console.log(`   Format:   ${format} → platforms/${platform}/`);
  console.log(`   Brief:    ${briefAbs}`);
  console.log(`   Path:     ${episodeDir}`);

  console.log(`\n📎 Registering Paperclip issue...`);
  try {
    const r = registerIssue(episodeId);
    if (r) console.log(`   → ${r.identifier}`);
    else console.log(`   ⚠ paperclip CLI 미설치 또는 등록 실패 (파이프라인은 계속 진행 가능)`);
  } catch (e) { console.log(`   ⚠ ${e.message}`); }

  console.log(`\n📋 Next: node scripts/automation/produce-episode.js --episode ${episodeId}`);
}

function main() {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string', short: 'c' },
      topic: { type: 'string', short: 't' },
      length: { type: 'string', short: 'l' },
      format: { type: 'string', short: 'f' },
      notes: { type: 'string', short: 'n', default: '' },
      // 시리즈 모드
      series: { type: 'string', short: 's' },
      'episode-slot': { type: 'string' },
      brief: { type: 'string', short: 'b' },
    },
  });

  if (!values.channel) {
    console.error('Usage:');
    console.error('  단발: node create-episode.js --channel <id> --topic "<주제>" [--format shorts|long-3min] [--length <초>]');
    console.error('  시리즈: node create-episode.js --channel <id> --series <id> --episode-slot N --brief <path>');
    process.exit(1);
  }

  if (values.series) {
    if (!values['episode-slot'] || !values.brief) {
      console.error('❌ Series mode requires --episode-slot and --brief');
      process.exit(1);
    }
    seriesEpisode({
      channel: values.channel,
      seriesId: values.series,
      slot: parseInt(values['episode-slot'], 10),
      briefPath: values.brief,
    });
  } else {
    if (!values.topic) { console.error('❌ Single mode requires --topic'); process.exit(1); }
    const format = values.format || 'shorts';
    const defaultLength = format === 'long-3min' ? 180 : 60;
    singleEpisode({
      channel: values.channel,
      topic: values.topic,
      length: parseInt(values.length || String(defaultLength), 10),
      notes: values.notes,
      format,
    });
  }
}

main();
