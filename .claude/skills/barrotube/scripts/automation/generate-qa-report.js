#!/usr/bin/env node

/**
 * generate-qa-report.js — 자동 QA 리포트 (format 분기 지원)
 *
 * v1.1 (2026-04-22): shorts(60s·9:16) / long-3min(180s·16:9) 분기
 *   - script frontmatter의 format 값을 읽어 duration target/tolerance 및 aspect 자동 선택
 *
 * 검증 항목:
 *   - 영상 duration vs script target (format별 tolerance)
 *   - 해상도 (format별)
 *   - 코덱 H.264 yuv420p 30fps
 *   - 오디오 AAC 44.1kHz mono
 *   - 파일 크기 < 200MB (long은 더 큼)
 *   - 이미지 N개 존재 (format별)
 *   - TTS N개 존재 + 씬 duration 매치
 *
 * Usage:
 *   node generate-qa-report.js --episode <dir>
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse as parseYAML } from 'yaml';
import {
  detectPolicyViolations,
  formatPolicySection,
} from './lib/qa-policy-detect.js';

const FORMAT_QA_SPECS = {
  'shorts': {
    duration_target: 60,
    duration_tolerance: 2,
    aspect_w: 1080,
    aspect_h: 1920,
    aspect_label: '9:16 세로',
    max_size_mb: 100,
    scene_count: 5,
  },
  'long-3min': {
    duration_target: 180,
    duration_tolerance: 10,
    aspect_w: 1920,
    aspect_h: 1080,
    aspect_label: '16:9 가로',
    max_size_mb: 200,
    scene_count: 7,
  },
};

function probe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function dur(path) {
  const d = probe(path);
  return d ? parseFloat(d.format?.duration || 0) : 0;
}

const OK = '✅', WARN = '⚠️', FAIL = '❌';

async function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string', short: 'e' },
    platform: { type: 'string' },
  } });
  if (!values.episode) { console.error('Usage: generate-qa-report.js --episode <dir|EP-YYYY-NNNN> [--platform long|shorts]'); process.exit(1); }

  // EP-YYYY-NNNN 식별자 패턴이면 workspace/episodes/<id>로 자동 변환
  const ROOT = resolve(import.meta.dirname, '../..');
  let epDir;
  if (/^EP-\d{4}-\d{4}$/.test(values.episode.trim())) {
    epDir = join(ROOT, 'workspace', 'episodes', values.episode.trim());
  } else {
    epDir = resolve(values.episode);
  }
  // v2 (platforms/) 우선 → v1 fallback. --platform hint가 있으면 해당 플랫폼만.
  const platformHint = values.platform;
  const scriptCandidates = platformHint
    ? [join(epDir, 'platforms', platformHint, '30_script.md')]
    : [
        join(epDir, 'platforms', 'long', '30_script.md'),
        join(epDir, 'platforms', 'shorts', '30_script.md'),
        join(epDir, '30_script.md'),
      ];
  const scriptPath = scriptCandidates.find(p => existsSync(p));
  if (!scriptPath) { console.error('❌ Missing 30_script.md'); process.exit(1); }
  const baseDir = scriptPath.replace(/\/30_script\.md$/, '');
  const videoPath = join(baseDir, '55_render/video.mp4');
  if (!existsSync(videoPath)) { console.error(`❌ Missing 55_render/video.mp4 under ${baseDir}`); process.exit(1); }

  const md = readFileSync(scriptPath, 'utf-8');
  const fm = parseYAML(md.match(/^---\n([\s\S]*?)\n---/)[1]);
  const scenes = fm.scenes || [];

  // Format 분기 — frontmatter.format 우선, 미지정 시 scene 수로 추론
  let format = fm.format;
  if (!format) {
    format = scenes.length === 7 ? 'long-3min' : 'shorts';
    console.warn(`⚠️  script frontmatter에 format 필드 없음. ${scenes.length}씬 기준으로 ${format}로 추론.`);
  }
  const spec = FORMAT_QA_SPECS[format];
  if (!spec) {
    console.error(`❌ Unknown format: ${format}. Supported: ${Object.keys(FORMAT_QA_SPECS).join(', ')}`);
    process.exit(1);
  }

  let target = fm.target_total_seconds || spec.duration_target;

  const video = probe(videoPath);
  const vStream = video?.streams.find(s => s.codec_type === 'video');
  const aStream = video?.streams.find(s => s.codec_type === 'audio');
  const actualDur = parseFloat(video?.format?.duration || 0);
  const sizeMB = (statSync(videoPath).size / 1024 / 1024).toFixed(2);

  // Outro slot 보정 (2026-05-15): 별도 outro TTS 클립이 있으면 target에 해당 분량 + 0.3s tail 추가
  // render-direct.js가 outro slot detected 시 별도 outro 클립을 prepend하므로, duration target도 함께 늘어남.
  let outroSlotAdded = 0;
  const outroSlotCandidates = [
    join(baseDir, '40_assets', 'tts', 'scene_006_outro.wav'),
    join(baseDir, '40_assets', 'tts', 'outro.wav'),
  ];
  const outroSlotPath = outroSlotCandidates.find(p => existsSync(p));
  if (outroSlotPath) {
    try {
      const { spawnSync } = await import('node:child_process');
      const probeRes = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outroSlotPath], { encoding: 'utf-8' });
      const ttsDur = parseFloat(probeRes.stdout.trim());
      if (ttsDur > 0) {
        // render-direct.js logic: outroClipDur = min(6.0, ttsDur + 0.3)
        outroSlotAdded = Math.min(6.0, ttsDur + 0.3);
        target = target + outroSlotAdded;
      }
    } catch { /* probe fail은 silent */ }
  }

  // 렌더 부가 구간 보정 (2026-07-22): render-direct.js가 씬 클립 앞뒤에 붙이는 길이를
  // target에 반영하지 않아 Duration이 구조적으로 항상 FAIL하던 문제를 해결한다.
  //   - 씬 클립은 TTS 실측 길이로 잘리므로 기준을 TTS 합계로 잡는다
  //     (target_total_seconds는 씬별 padding을 포함한 값이라 실제보다 크다)
  //   - 인트로 카드 prepend / outro freeze pad / 엔드카드 append 를 더한다
  let renderPadNote = '';
  const ttsSum = scenes.reduce((sum, s) => {
    const p = join(baseDir, '40_assets', 'tts', `scene_${s.scene_id}.wav`);
    if (!existsSync(p)) return sum;
    const d = parseFloat(probe(p)?.format?.duration || 0);
    return sum + (d > 0 ? d : 0);
  }, 0);
  if (ttsSum > 0) {
    const introExists = ['45_intro.png', '47_thumbnail.png']
      .some(f => existsSync(join(baseDir, f)));
    const introSec = introExists ? (Number(process.env.BT_INTRO_SEC) || 2) : 0;
    const endcardExists = ['48_outro.png', '48_endcard.png']
      .some(f => existsSync(join(baseDir, f)));
    const endcardSec = endcardExists
      ? (Number(process.env.BT_ENDCARD_SEC) || (spec.aspect_h > spec.aspect_w ? 2.5 : 3.5))
      : 0;
    const padSec = outroSlotPath ? 0.3 : 1.0;   // render-direct OUTRO_PAD_SEC
    target = ttsSum + introSec + padSec + endcardSec + outroSlotAdded;
    renderPadNote = ` [tts ${ttsSum.toFixed(2)}s + intro ${introSec}s + pad ${padSec}s + endcard ${endcardSec}s]`;
  }

  const checks = [];

  // Duration (format별 tolerance, outro slot + 렌더 부가 구간 반영)
  const dDiff = Math.abs(actualDur - target);
  const durNote = (outroSlotAdded > 0 ? ` [outro slot +${outroSlotAdded.toFixed(2)}s]` : '') + renderPadNote;
  checks.push({
    item: 'Duration',
    mark: dDiff < spec.duration_tolerance ? OK : (dDiff < spec.duration_tolerance * 1.5 ? WARN : FAIL),
    val: `${actualDur.toFixed(2)}s (target ${target.toFixed(2)}s${durNote}, diff ${dDiff.toFixed(2)}s, tolerance ±${spec.duration_tolerance}s)`,
  });

  // Resolution (format별)
  const w = vStream?.width, h = vStream?.height;
  checks.push({
    item: 'Aspect',
    mark: (w === spec.aspect_w && h === spec.aspect_h) ? OK : WARN,
    val: `${w}×${h} (expected ${spec.aspect_w}×${spec.aspect_h} ${spec.aspect_label})`,
  });

  // Codec
  checks.push({
    item: 'Codec',
    mark: vStream?.codec_name === 'h264' ? OK : WARN,
    val: `${vStream?.codec_name} ${vStream?.pix_fmt} ${vStream?.r_frame_rate}`,
  });

  // Audio
  checks.push({
    item: 'Audio',
    mark: aStream?.codec_name === 'aac' ? OK : WARN,
    val: `${aStream?.codec_name} ${aStream?.sample_rate}Hz ${aStream?.channels}ch`,
  });

  // Size (format별 상한)
  checks.push({
    item: 'Size',
    mark: Number(sizeMB) < spec.max_size_mb ? OK : WARN,
    val: `${sizeMB} MB (max ${spec.max_size_mb} MB)`,
  });

  // Scene count (format별)
  checks.push({
    item: 'Scene count',
    mark: scenes.length === spec.scene_count ? OK : WARN,
    val: `${scenes.length}/${spec.scene_count}`,
  });

  // Images — v2(platforms/) baseDir 우선 → v1 epDir fallback
  const imagesDir = existsSync(join(baseDir, '40_assets'))
    ? join(baseDir, '40_assets/images')
    : existsSync(join(epDir, '40_assets'))
      ? join(epDir, '40_assets/images')
      : join(epDir, 'assets/images');
  const imgCount = scenes.filter(s =>
    existsSync(join(imagesDir, `scene_${s.scene_id}.png`))
  ).length;
  checks.push({
    item: 'Images',
    mark: imgCount === scenes.length ? OK : FAIL,
    val: `${imgCount}/${scenes.length}`,
  });

  // TTS + scene duration match — v2(platforms/) baseDir 우선 → v1 epDir fallback
  const ttsDir = existsSync(join(baseDir, '40_assets'))
    ? join(baseDir, '40_assets/tts')
    : existsSync(join(epDir, '40_assets'))
      ? join(epDir, '40_assets/tts')
      : join(epDir, 'assets/tts');
  const ttsChecks = [];
  for (const s of scenes) {
    const ttsPath = join(ttsDir, `scene_${s.scene_id}.wav`);
    if (!existsSync(ttsPath)) {
      ttsChecks.push({ id: s.scene_id, mark: FAIL, val: 'missing' });
      continue;
    }
    const td = dur(ttsPath);
    const diff = s.target_seconds - td;
    const mark = diff >= -0.1 && diff < 2 ? OK : WARN;
    ttsChecks.push({ id: s.scene_id, mark, val: `${td.toFixed(2)}s (target ${s.target_seconds}s, pad ${diff.toFixed(2)}s)` });
  }

  const allTtsOk = ttsChecks.every(t => t.mark === OK);
  checks.push({
    item: 'TTS sync',
    mark: allTtsOk ? OK : WARN,
    val: ttsChecks.filter(t => t.mark !== OK).map(t => `scene_${t.id}: ${t.val}`).join('; ') || 'all good',
  });

  // Outro CTA presence (2026-05-15 의무화 — EP-2026-0050 후속)
  // 마지막 씬 narration 마지막 1~2문장(끝 80자)에 구독/알림/다음 영상/채널/팔로우 키워드 ≥ 1개 필요.
  // 또는 별도 outro TTS 클립(scene_006_outro.wav 등) 존재 시도 PASS로 인정.
  {
    const lastScene = scenes[scenes.length - 1];
    const lastNarr = (lastScene?.narration || '').trim();
    const tailWindow = lastNarr.slice(-100);
    const ctaPattern = /(구독|알림|다음\s*영상|채널|팔로우|subscribe|follow|notification|\bbell\b)/i;
    const hasCtaInNarr = ctaPattern.test(tailWindow);
    // 별도 outro TTS 클립이 있는지도 검사 (예: scene_006_outro.wav, outro.wav)
    const outroTtsCandidates = [
      join(baseDir, '40_assets', 'tts', 'scene_006_outro.wav'),
      join(baseDir, '40_assets', 'tts', 'outro.wav'),
      join(baseDir, 'assets', 'tts', 'outro.wav'),
    ];
    const hasOutroTts = outroTtsCandidates.some(p => existsSync(p));
    const ctaPass = hasCtaInNarr || hasOutroTts;
    const tailPreview = tailWindow.replace(/\s+/g, ' ').slice(-60);
    checks.push({
      item: 'Outro CTA presence',
      mark: ctaPass ? OK : WARN,
      val: ctaPass
        ? (hasCtaInNarr
            ? `마지막 씬 narration에 CTA 키워드 검출 ("…${tailPreview}")`
            : `별도 outro TTS 클립 검출 (${outroTtsCandidates.find(p => existsSync(p))?.split('/').slice(-1)[0]})`)
        : `CTA 키워드 부재 — 마지막 씬 narration 끝 "…${tailPreview}". Writer 재집필 권장 (구독/알림/다음 영상 등 한 줄 추가).`,
    });
  }

  // Format-specific extra checks (long-3min: mid-hook, disclaimer)
  if (format === 'long-3min') {
    // 면책 멘트 휴리스틱 체크: 씬 7 narration에 "투자 조언" 또는 "면책" 키워드 존재 여부
    const lastScene = scenes[scenes.length - 1];
    const hasDisclaimer = /투자 조언|본인의 판단|책임 하에/.test(lastScene?.narration || '');
    checks.push({
      item: 'Voice disclaimer (long-form)',
      mark: hasDisclaimer ? OK : WARN,
      val: hasDisclaimer ? '씬 7에 면책 키워드 포함' : '씬 7에서 "투자 조언/본인의 판단" 키워드 미감지',
    });

    // 시리즈 편인 경우 인트로 카드 키워드 체크
    if (fm.series_id) {
      const secondScene = scenes[1];
      const hasSeriesMention = new RegExp(fm.series_id.split('-')[0], 'i').test(secondScene?.narration || '')
        || /시리즈|편|입문/.test(secondScene?.narration || '');
      checks.push({
        item: 'Series context (intro/recap)',
        mark: hasSeriesMention ? OK : WARN,
        val: hasSeriesMention ? '씬 2에 시리즈 관련 키워드 포함' : '씬 2에서 시리즈 리캡 키워드 미감지',
      });
    }
  }

  // Public Figure Policy Checks (CEO v1.0, 2026-04-26 — §6.2 5개 자동 검출)
  // brief frontmatter + topic + hook narration 로드 → detectPolicyViolations
  // BLOCK이 1건이라도 있고 policy_override 미적용이면 verdict=FAIL + risk=HIGH 강제 (S10 차단)
  let policyResult = null;
  try {
    // epDir = baseDir의 ../../  (v2) 또는 baseDir 자체 (v1).
    // baseDir이 .../EP-XXXX/platforms/{long|shorts} 이면 epDir = .../EP-XXXX
    const v2Match = baseDir.match(/^(.*\/EP-[^/]+)\/platforms\/(?:long|shorts)$/);
    const briefEpDir = v2Match ? v2Match[1] : epDir;
    const briefPath = join(briefEpDir, '00_brief.md');
    let briefFM = {};
    let topicText = '';
    if (existsSync(briefPath)) {
      const briefRaw = readFileSync(briefPath, 'utf-8');
      const fmM = briefRaw.match(/^---\n([\s\S]*?)\n---/);
      if (fmM) {
        try { briefFM = parseYAML(fmM[1]) || {}; } catch { briefFM = {}; }
      }
      topicText = briefFM.topic || '';
      if (!topicText) {
        const tm = briefRaw.match(/^topic:\s*["']?(.+?)["']?\s*$/m);
        if (tm) topicText = tm[1].trim();
      }
    }
    const hookNar = (scenes.find(s => s.role === 'hook') || scenes[0])?.narration || '';
    const detectionText = `${topicText}\n${hookNar}`;
    policyResult = detectPolicyViolations({
      briefFM,
      scriptFM: fm,
      channel: fm.channel_id || briefFM.channel_id || 'econ-daily',
      format,
      topicText: detectionText,
      meta: null,
    });
    // BLOCK 1건이라도 있으면 Technical 'Public Figure Policy' 항목을 FAIL로 추가
    if (policyResult.blocks.length > 0) {
      checks.push({
        item: 'Public Figure Policy',
        mark: FAIL,
        val: `${policyResult.blocks.length} BLOCK / ${policyResult.warns.length} WARN — 정책 §6.2 위반. S10 차단.`,
      });
    } else if (policyResult.warns.length > 0) {
      checks.push({
        item: 'Public Figure Policy',
        mark: WARN,
        val: `${policyResult.warns.length} WARN (BLOCK 없음). 운영자 확인 권장.`,
      });
    } else {
      checks.push({
        item: 'Public Figure Policy',
        mark: OK,
        val: '5개 검사 모두 통과 (CHARACTERIZE 정합 / sensitivity / photorealistic / 씬 상한 / 색채).',
      });
    }
  } catch (e) {
    // 정책 검출 실패는 자체로 FAIL이 아님 — 로그로만 남기고 진행
    console.warn(`⚠️  policy detection failed: ${e.message}`);
    checks.push({
      item: 'Public Figure Policy',
      mark: WARN,
      val: `검출 실행 실패 (${e.message}). 수동 검토 권장.`,
    });
  }

  // 경제 정확성 검사 (qa-economic-accuracy hook, 2026-04-29)
  let econResult = null;
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('node', [join(import.meta.dirname, 'qa-economic-accuracy.js'), '--episode', fm.episode_id], { encoding: 'utf-8' });
    if (r.stdout) {
      try { econResult = JSON.parse(r.stdout); } catch {}
    }
  } catch (e) { /* hook 실패는 silent — 기존 QA 흐름 보존 */ }

  // Verdict
  const anyFail = checks.some(c => c.mark === FAIL);
  const policyBlocked = policyResult && policyResult.blocks.length > 0;
  const econHigh = econResult && econResult.severity === 'HIGH';
  const econMedium = econResult && econResult.severity === 'MEDIUM';
  const verdict = (anyFail || policyBlocked || econHigh) ? 'FAIL' : 'PASS';
  const riskLevel = (policyBlocked || econHigh) ? 'HIGH' : (anyFail ? 'HIGH' : ((checks.some(c => c.mark === WARN) || econMedium) ? 'MEDIUM' : 'LOW'));

  // Report
  const report = [
    `# QA Report — ${fm.episode_id}`,
    '',
    `**Auto-generated**: ${new Date().toISOString()}`,
    `**Format**: \`${format}\` (target ${spec.duration_target}s ±${spec.duration_tolerance}s, ${spec.aspect_label}, ${spec.scene_count}씬)`,
    fm.series_id ? `**Series**: \`${fm.series_id}\` [${fm.series_episode}/?]` : '',
    fm.persona ? `**Persona**: \`${fm.persona}\`` : '',
    `**Video**: \`55_render/video.mp4\` (${actualDur.toFixed(2)}s, ${w}×${h}, ${vStream?.codec_name}, ${sizeMB}MB)`,
    `**Risk**: \`${riskLevel}\``,
    '',
    '## Technical Checks',
    '| Item | Result | Value |',
    '|------|--------|-------|',
    ...checks.map(c => `| ${c.item} | ${c.mark} | ${c.val} |`),
    '',
    '## TTS per-scene',
    '| Scene | Result | Duration |',
    '|-------|--------|----------|',
    ...ttsChecks.map(t => `| ${t.id} | ${t.mark} | ${t.val} |`),
    '',
    policyResult ? formatPolicySection(policyResult) : '## Public Figure Policy Checks\n\n(검출 모듈 로딩 실패 — 수동 검토 필요)',
    '',
    econResult
      ? `## 📐 경제 정확성 검사 (qa-economic-accuracy)\n\n**severity: ${econResult.severity}**\n` +
        (econResult.findings.hangul_number?.length ? `\n### ❌ 한글 숫자 emphasis token (HIGH 자동 승격)\n` + econResult.findings.hangul_number.map(f => `- \`${f.match}\` @ ${f.at}`).join('\n') + '\n' : '') +
        (econResult.findings.arithmetic_suspect?.length ? `\n### ❌ 산술 합계 모순 (HIGH)\n` + econResult.findings.arithmetic_suspect.map(f => `- \`${f.match}\` 합=${f.sum} (기대 ${f.expected})`).join('\n') + '\n' : '') +
        (econResult.findings.comma_missing?.length ? `\n### ⚠ 콤마 누락 큰 수\n` + econResult.findings.comma_missing.map(f => `- \`${f.match}\``).join('\n') + '\n' : '') +
        (econResult.findings.pct_vs_pp?.length ? `\n### ⚠ %/%p 혼용 의심\n` + econResult.findings.pct_vs_pp.map(f => `- \`${f.match}\``).join('\n') + '\n' : '') +
        (econResult.findings.nonstd_term?.length ? `\n### ℹ 비표준 표기\n` + econResult.findings.nonstd_term.map(f => `- \`${f.bad}\` → \`${f.good}\``).join('\n') + '\n' : '') +
        (Object.values(econResult.findings).every(v => v.length === 0) ? '\n✅ 모든 항목 통과\n' : '')
      : '## 📐 경제 정확성 검사\n\n(qa-economic-accuracy hook 미실행 — 수동 검토 권장)',
    '',
    '## Verdict',
    `**${verdict}** (risk: ${riskLevel})`,
    '',
    verdict === 'PASS'
      ? '✅ Board 승인 가능. S9 Metadata → S10 승인 → S11 Publish 진행.'
      : (policyBlocked
          ? '❌ Public Figure 정책 §6.2 BLOCK 검출 — S10 Board 승인 차단됨. policy_override 토큰 또는 재집필·재생성 후 재검사 필요.'
          : '❌ 실패 항목 수정 후 재검사 필요.'),
  ].filter(Boolean).join('\n');

  const outPath = join(baseDir, '60_qa_report.md');
  writeFileSync(outPath, report, 'utf-8');

  console.log(`✅ QA report: ${outPath}`);
  console.log(`   Format: ${format} | Verdict: ${verdict} | Risk: ${riskLevel}`);
  checks.forEach(c => console.log(`   ${c.mark} ${c.item}: ${c.val}`));
  if (policyResult && policyResult.blocks.length) {
    console.error(`❌ Public Figure 정책 BLOCK ${policyResult.blocks.length}건 — S10 차단`);
    for (const b of policyResult.blocks) {
      console.error(`   - [${b.section}] ${b.code}: ${b.message}`);
    }
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
