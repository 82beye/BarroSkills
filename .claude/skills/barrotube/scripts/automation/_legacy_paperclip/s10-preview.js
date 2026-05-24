#!/usr/bin/env node

/**
 * s10-preview.js — S10 Board 승인 게이트 사전 점검 및 인터랙티브 승인 (품질 권고 #5)
 *
 * 목적:
 *   S10(Board 승인) 진입 전 운영자가 1) 영상 메타 2) 썸네일 3) QA verdict
 *   4) 씬별 나레이션을 콘솔에서 한눈에 검토하고, 합의 시 PaperClip 이슈에
 *   approval 의견을 코멘트로 남기고 approve-episode.js 실행을 안내하는 헬퍼.
 *
 * Usage:
 *   node scripts/automation/s10-preview.js --ep EP-2026-0043
 *   node scripts/automation/s10-preview.js --ep EP-2026-0043 --platform shorts
 *   node scripts/automation/s10-preview.js --ep EP-2026-0043 --auto-approve --by "barrotube-producer" --note "..."
 *   node scripts/automation/s10-preview.js --ep EP-2026-0043 --json
 *
 * Options:
 *   --ep <id>           EP id (필수)
 *   --platform <id>     long | shorts (생략 시 brief frontmatter의 format)
 *   --json              체크 결과를 JSON으로 출력하고 종료 (인터랙티브 X)
 *   --skip-confirm      확인 프롬프트 생략 (스크립트용)
 *   --auto-approve      통과 시 approve-episode.js 자동 실행
 *   --by <name>         --auto-approve 시 actor 명
 *   --note <text>       --auto-approve 시 note
 *   --paperclip-issue <YOU-NN>  승인 코멘트를 추가할 PaperClip 이슈
 *   --help              이 도움말
 *
 * Exit code:
 *   0  통과 + (사용자 yes 또는 --auto-approve 성공)
 *   1  체크 실패 (산출물 누락/QA FAIL/메타 결함)
 *   2  사용자가 N 응답 (승인 거부)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parse as parseYAML } from 'yaml';
import { resolvePaths } from './paths.js';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(ROOT, 'workspace');
const COMPANY_ID = '46041d31-43ca-4135-8db6-8a84ba0d22de';
const PAPERCLIP_BASE = process.env.PAPERCLIP_BASE_URL || 'http://localhost:3100';

const HELP = `
s10-preview.js — S10 Board 승인 게이트 사전 점검

Usage:
  node scripts/automation/s10-preview.js --ep <EP-id> [--platform long|shorts]
                                         [--auto-approve --by <name> --note <text>]
                                         [--paperclip-issue YOU-NN]
                                         [--skip-confirm] [--json]

Checks:
  1) 영상 (55_render/video.mp4) 존재 + ffprobe duration·해상도·오디오 채널
  2) 썸네일 (47_thumbnail.png) 존재 + 해상도
  3) QA report (60_qa_report.md) PASS/FAIL
  4) 메타데이터 (70_publish_meta.json) title/description/tags 유효성
  5) 씬별 나레이션 미리보기 (앞 50자)

확인 프롬프트:
  "Board 승인 진행하시겠습니까? [y/N]"
  y → approve-episode.js 실행 안내 (또는 --auto-approve 시 자동 실행)
  N → 종료 (exit 2)

Exit code:
  0  통과 + 승인 (또는 --json 성공)
  1  체크 실패
  2  사용자 N 응답
`;

function probeVideo(videoPath) {
  // ffprobe로 duration / 해상도 / 오디오 채널
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    videoPath,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    return { ok: false, error: r.stderr || 'ffprobe failed' };
  }
  try {
    const data = JSON.parse(r.stdout);
    const v = (data.streams || []).find(s => s.codec_type === 'video');
    const a = (data.streams || []).find(s => s.codec_type === 'audio');
    return {
      ok: true,
      duration: parseFloat(data.format?.duration || '0'),
      width: v?.width || 0,
      height: v?.height || 0,
      vcodec: v?.codec_name || '?',
      pix_fmt: v?.pix_fmt || '?',
      acodec: a?.codec_name || null,
      audio_channels: a?.channels || 0,
      audio_rate: a?.sample_rate ? parseInt(a.sample_rate, 10) : 0,
      sizeBytes: parseInt(data.format?.size || '0', 10),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function probeImage(pngPath) {
  // ffprobe로 PNG 해상도 (ffprobe는 PNG도 지원)
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    pngPath,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    // fallback: stat만
    try {
      const st = statSync(pngPath);
      return { ok: true, width: 0, height: 0, sizeBytes: st.size, note: 'ffprobe unavailable' };
    } catch {
      return { ok: false, error: r.stderr || 'probe failed' };
    }
  }
  try {
    const data = JSON.parse(r.stdout);
    const v = (data.streams || [])[0] || {};
    const st = statSync(pngPath);
    return {
      ok: true,
      width: v.width || 0,
      height: v.height || 0,
      sizeBytes: st.size,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function parseQAReport(qaPath) {
  const md = readFileSync(qaPath, 'utf-8');
  const verdictMatch = md.match(/^\*\*(PASS|FAIL)\*\*/m);
  const riskMatch = md.match(/^\*\*Risk\*\*:\s*`?([A-Z]+)`?/m) ||
                    md.match(/Risk[:\s`]+`?([A-Z]+)`?/);
  const durationMatch = md.match(/Duration\s*\|[^|]*\|\s*([0-9.]+)s/);
  const aspectMatch = md.match(/Aspect\s*\|[^|]*\|\s*(\d+×\d+|\d+x\d+)/);
  return {
    raw: md,
    verdict: verdictMatch ? verdictMatch[1] : null,
    risk: riskMatch ? riskMatch[1] : null,
    duration: durationMatch ? parseFloat(durationMatch[1]) : null,
    aspect: aspectMatch ? aspectMatch[1] : null,
  };
}

function parseScriptScenes(scriptPath) {
  const md = readFileSync(scriptPath, 'utf-8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];
  let fm;
  try { fm = parseYAML(m[1]); } catch { return []; }
  if (!Array.isArray(fm.scenes)) return [];
  return fm.scenes.map(s => ({
    id: s.scene_id || '?',
    role: s.role || '?',
    target: s.target_seconds ?? null,
    narration: (s.narration || '').replace(/\s+/g, ' ').trim(),
  }));
}

function readBriefFormat(epDir) {
  const briefPath = join(epDir, '00_brief.md');
  if (!existsSync(briefPath)) return 'long-3min';
  try {
    const md = readFileSync(briefPath, 'utf-8');
    const m = md.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return 'long-3min';
    const fm = parseYAML(m[1]);
    return fm?.format || 'long-3min';
  } catch {
    return 'long-3min';
  }
}

function fmtBytes(n) {
  if (!n) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDuration(s) {
  if (!Number.isFinite(s)) return '?';
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(2);
  return `${m}분 ${sec}초`;
}

function evaluate(check) {
  // 종합 평가
  const failures = [];
  if (!check.video?.ok) failures.push(`video probe fail: ${check.video?.error || 'missing'}`);
  if (!check.thumbnail?.ok) failures.push(`thumbnail probe fail: ${check.thumbnail?.error || 'missing'}`);
  if (!check.qa) failures.push('QA report 누락');
  else if (check.qa.verdict !== 'PASS') failures.push(`QA verdict=${check.qa.verdict}`);
  if (!check.meta) failures.push('Metadata 누락');
  else if (!check.meta.title) failures.push('Metadata title 비어있음');
  if (!check.scenes || check.scenes.length === 0) failures.push('Script scenes 파싱 실패');
  return failures;
}

async function postPaperclipComment(issueIdOrIdentifier, body) {
  // 식별자 → id 조회 (by-identifier) 후 comment
  try {
    const url = /^[0-9a-f-]{36}$/i.test(issueIdOrIdentifier)
      ? `${PAPERCLIP_BASE}/api/issues/${issueIdOrIdentifier}/comments`
      : `${PAPERCLIP_BASE}/api/companies/${COMPANY_ID}/issues/by-identifier/${issueIdOrIdentifier}/comments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, agentId: 'barrotube-producer' }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ep:                { type: 'string' },
        platform:          { type: 'string' },
        json:              { type: 'boolean', default: false },
        'skip-confirm':    { type: 'boolean', default: false },
        'auto-approve':    { type: 'boolean', default: false },
        by:                { type: 'string' },
        note:              { type: 'string' },
        'paperclip-issue': { type: 'string' },
        help:              { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`[ERROR] 인자 파싱 실패: ${e.message}`);
    console.error(HELP);
    process.exit(1);
  }

  if (!values.ep) {
    console.error('[ERROR] --ep 는 필수입니다.\n');
    console.error(HELP);
    process.exit(1);
  }

  const epDir = join(WORKSPACE, 'episodes', values.ep);
  if (!existsSync(epDir)) {
    console.error(`[ERROR] EP 디렉토리가 없습니다: ${epDir}`);
    process.exit(1);
  }

  const briefFmt = readBriefFormat(epDir);
  const fmt = values.platform === 'shorts' ? 'shorts'
            : values.platform === 'long'   ? 'long-3min'
            : briefFmt;
  const p = resolvePaths(epDir, fmt);

  const check = {
    episode_id: values.ep,
    platform: p.platform,
    layout: p.isV2 ? 'v2' : 'v1',
  };

  // 1) 영상
  if (existsSync(p.video)) {
    check.video = probeVideo(p.video);
    check.video.path = p.video;
  } else {
    check.video = { ok: false, error: 'file not found', path: p.video };
  }

  // 2) 썸네일
  if (existsSync(p.thumbnail)) {
    check.thumbnail = probeImage(p.thumbnail);
    check.thumbnail.path = p.thumbnail;
  } else {
    check.thumbnail = { ok: false, error: 'file not found', path: p.thumbnail };
  }

  // 3) QA
  if (existsSync(p.qa)) {
    check.qa = parseQAReport(p.qa);
    check.qa.path = p.qa;
  } else {
    check.qa = null;
  }

  // 4) Metadata
  if (existsSync(p.meta)) {
    try {
      const meta = JSON.parse(readFileSync(p.meta, 'utf-8'));
      check.meta = {
        title: meta.title || null,
        description_length: (meta.description || '').length,
        tags_count: (meta.tags || []).length,
        privacyStatus: meta.privacyStatus || 'unknown',
        publishAt: meta.publishAt || null,
        path: p.meta,
      };
    } catch (e) {
      check.meta = { error: e.message, path: p.meta };
    }
  } else {
    check.meta = null;
  }

  // 5) Scenes
  if (existsSync(p.script)) {
    check.scenes = parseScriptScenes(p.script);
  } else {
    check.scenes = [];
  }

  const failures = evaluate(check);
  check.passed = failures.length === 0;
  check.failures = failures;

  if (values.json) {
    console.log(JSON.stringify(check, null, 2));
    process.exit(failures.length === 0 ? 0 : 1);
  }

  // 인터랙티브 출력
  console.log(`\nS10 Preview Gate — ${values.ep}`);
  console.log('━'.repeat(50));
  console.log(`platform: ${p.platform}, layout: ${check.layout}`);
  console.log('');

  // 영상
  if (check.video.ok) {
    console.log(`[OK] 영상: ${p.video.replace(ROOT + '/', '')}`);
    console.log(`     duration ${fmtDuration(check.video.duration)}, ${check.video.width}x${check.video.height}, ${check.video.vcodec}, ${fmtBytes(check.video.sizeBytes)}`);
    if (check.video.acodec) {
      console.log(`     audio ${check.video.acodec} ${check.video.audio_rate}Hz ${check.video.audio_channels}ch`);
    } else {
      console.log(`     audio: (없음)`);
    }
  } else {
    console.log(`[FAIL] 영상: ${check.video.error}`);
    console.log(`       expected: ${p.video}`);
  }

  // 썸네일
  if (check.thumbnail.ok) {
    const w = check.thumbnail.width;
    const h = check.thumbnail.height;
    const dim = (w && h) ? `${w}x${h}` : '(미상)';
    console.log(`[OK] 썸네일: ${p.thumbnail.replace(ROOT + '/', '')} (${dim}, ${fmtBytes(check.thumbnail.sizeBytes)})`);
  } else {
    console.log(`[FAIL] 썸네일: ${check.thumbnail.error}`);
  }

  // QA
  if (check.qa) {
    const tag = check.qa.verdict === 'PASS' ? '[OK]' : '[FAIL]';
    console.log(`${tag} QA: ${check.qa.verdict || '(verdict 미상)'}` +
                (check.qa.risk ? `, risk=${check.qa.risk}` : ''));
    if (check.qa.duration) console.log(`     QA duration ${check.qa.duration}s, aspect ${check.qa.aspect || '?'}`);
  } else {
    console.log(`[FAIL] QA report 없음: ${p.qa}`);
  }

  // Metadata
  if (check.meta && !check.meta.error) {
    console.log(`[OK] Metadata: title="${(check.meta.title || '').slice(0, 50)}"`);
    console.log(`     desc=${check.meta.description_length} chars, tags=${check.meta.tags_count}, privacy=${check.meta.privacyStatus}`);
    if (check.meta.publishAt) console.log(`     publishAt=${check.meta.publishAt}`);
  } else {
    console.log(`[FAIL] Metadata: ${check.meta?.error || 'missing'}`);
  }

  // 씬 미리보기
  if (check.scenes.length > 0) {
    console.log(`[OK] 나레이션 씬 미리보기 (${check.scenes.length}씬):`);
    for (const s of check.scenes) {
      const head = s.narration.length > 50 ? s.narration.slice(0, 50) + '…' : s.narration;
      const tgt = s.target ? `${s.target}s ` : '';
      console.log(`     ${s.id} [${s.role}, ${tgt}]: "${head}"`);
    }
  } else {
    console.log(`[FAIL] 씬 정보 없음 (script 파싱 실패 또는 빈 scenes)`);
  }

  console.log('');
  if (failures.length > 0) {
    console.log('[FAIL] S10 진입 차단:');
    for (const f of failures) console.log(`   - ${f}`);
    console.log('\n위 항목들을 해결한 후 재실행 하세요.');
    process.exit(1);
  }

  console.log('[OK] 모든 사전 점검 통과.');

  if (values['skip-confirm']) {
    console.log('--skip-confirm: 확인 프롬프트 생략.');
  } else {
    const rl = createInterface({ input, output });
    const ans = (await rl.question('\nBoard 승인 진행하시겠습니까? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('승인 거부 (운영자 N). 종료.');
      process.exit(2);
    }
  }

  // PaperClip 코멘트
  if (values['paperclip-issue']) {
    const body = [
      `S10 preview 통과 — ${values.ep}`,
      ``,
      `- 영상: ${fmtDuration(check.video.duration)}, ${check.video.width}x${check.video.height}`,
      `- 썸네일: ${check.thumbnail.width || '?'}x${check.thumbnail.height || '?'}`,
      `- QA: ${check.qa.verdict}, risk=${check.qa.risk || '?'}`,
      `- Metadata: title="${(check.meta.title || '').slice(0, 60)}", tags=${check.meta.tags_count}`,
      `- 씬 수: ${check.scenes.length}`,
      ``,
      values.note ? `note: ${values.note}` : '',
    ].filter(Boolean).join('\n');
    const r = await postPaperclipComment(values['paperclip-issue'], body);
    if (r.ok) console.log(`[OK] PaperClip 이슈 코멘트 추가: ${values['paperclip-issue']}`);
    else console.log(`[WARN] PaperClip 코멘트 실패: ${r.error || r.status}`);
  }

  // approve-episode.js 자동 실행 또는 안내
  if (values['auto-approve']) {
    const approveArgs = [
      'scripts/automation/approve-episode.js',
      '--episode', values.ep,
      '--platform', p.platform,
    ];
    if (values.by) approveArgs.push('--by', values.by);
    if (values.note) approveArgs.push('--note', values.note);

    console.log(`\n[RUN] approve-episode.js 자동 실행...`);
    const r = spawnSync('node', approveArgs, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`[FAIL] approve-episode 실패 (exit ${r.status})`);
      process.exit(r.status || 1);
    }
    console.log(`\n[OK] S10 승인 완료. 다음: node scripts/automation/run-episode.js --episode ${values.ep}`);
  } else {
    console.log(`\n다음 명령으로 승인 토큰 발급:`);
    console.log(`  node scripts/automation/approve-episode.js --episode ${values.ep} --platform ${p.platform} \\`);
    console.log(`    --by "<actor>" --note "<note>"`);
    console.log(`그 후:`);
    console.log(`  node scripts/automation/run-episode.js --episode ${values.ep}`);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  if (e.stack && process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
