#!/usr/bin/env node

/**
 * telegram-bot.js — BarroSkills Telegram 커맨드 봇 (long-polling, standalone)
 *
 * Paperclip 0% 의존. ~/workspace/BarroSkills/scripts/automation/ 로컬 스크립트 직접 호출.
 * 인증된 TELEGRAM_CHAT_ID만 허용.
 *
 * 지원 명령:
 *   /start, /help           — 도움말
 *   /doctor                 — barrotube-doctor 실행 (시스템 진단)
 *   /list                   — 최근 EP 10개
 *   /status [EP-ID]         — 큐 분포 또는 단일 EP 상세
 *   /budget                 — 월 사용량
 *   /produce <topic>        — 신규 EP brief 생성 (S0, 무비용)
 *   /run EP-XXXX            — 풀 체인 dry-run (echo only)
 *   /run-exec EP-XXXX       — 풀 체인 실제 발행 (💰 비용)
 *   /approve EP-XXXX        — S10 Board 승인
 *   /publish EP-XXXX        — S11 publish (💰 영상 공개, S10 승인 토큰 검증)
 *   /cancel EP-XXXX         — EP cancel + in-flight lock release
 *   /cron                   — 설치된 cron 데몬 목록
 *
 * 실행 (foreground):
 *   PAPERCLIP_DISABLED=1 node scripts/automation/telegram-bot.js
 *
 * 데몬 설치 (launchd):
 *   bash .claude/skills/barrotube/lib/install-cron.sh install telegram-bot
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSecret } from './config-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');
const API = 'https://api.telegram.org';

const BOT_TOKEN = getSecret('TELEGRAM_BOT_TOKEN');
const AUTH_CHAT = String(getSecret('TELEGRAM_CHAT_ID') || '');

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN missing — set in .env or Keychain'); process.exit(1); }
if (!AUTH_CHAT) { console.error('❌ TELEGRAM_CHAT_ID missing — set in .env or Keychain'); process.exit(1); }

const LOGS_DIR = join(ROOT, 'logs');
const OFFSET_FILE = join(LOGS_DIR, 'telegram-offset.txt');
const BOT_LOG = join(LOGS_DIR, 'telegram-bot.log');
mkdirSync(LOGS_DIR, { recursive: true });

let offset = 0;
if (existsSync(OFFSET_FILE)) {
  offset = parseInt(readFileSync(OFFSET_FILE, 'utf-8').trim() || '0') || 0;
}

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { writeFileSync(BOT_LOG, line, { flag: 'a' }); } catch {}
  console.log(line.trim());
}

/**
 * fetch 가 아니라 curl 을 쓴다. api.telegram.org 는 A·AAAA 를 둘 다 주는데 이 네트워크의
 * IPv6 경로가 죽어 있고, undici 는 --dns-result-order=ipv4first 도 무시해 ETIMEDOUT 이
 * 난다(2026-08-14 실측). notify.js·lib/guards.sh 와 같은 이유·같은 방식이다.
 * fetch 로 두면 봇이 getUpdates 부터 못 돌아 데몬이 통째로 죽는다.
 *
 * getUpdates 는 long-polling(timeout 30s)이므로 curl 타임아웃을 그보다 넉넉히 잡는다.
 */
async function tg(method, body) {
  const waitSec = Number(body && body.timeout) || 0;
  const out = spawnSync('curl', [
    '-sS', '-4', '-m', String(waitSec + 20), '-X', 'POST',
    `${API}/bot${BOT_TOKEN}/${method}`,
    '-H', 'Content-Type: application/json',
    '--data-binary', '@-',
  ], { input: JSON.stringify(body), encoding: 'utf-8' });

  if (out.status !== 0) {
    throw new Error(`Telegram ${method}: curl exit ${out.status} ${(out.stderr || '').slice(0, 160)}`);
  }
  try {
    return JSON.parse(out.stdout);
  } catch {
    throw new Error(`Telegram ${method}: 응답 파싱 실패 ${String(out.stdout).slice(0, 160)}`);
  }
}

async function reply(chatId, text, opts = {}) {
  try {
    return await tg('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts,
    });
  } catch (e) {
    console.error('reply failed:', e.message);
  }
}

function runNode(args, opts = {}) {
  const env = { ...process.env, PAPERCLIP_DISABLED: '1', BARROSKILLS_HOME: ROOT };
  const r = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: opts.timeout || 60000,
    env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runBash(cmd, opts = {}) {
  const env = { ...process.env, PAPERCLIP_DISABLED: '1', BARROSKILLS_HOME: ROOT };
  const r = spawnSync('bash', ['-c', cmd], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: opts.timeout || 60000,
    env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────

async function cmdHelp(chatId) {
  const help = [
    '<b>🎬 BarroSkills Telegram Bot</b>',
    '',
    '<b>진단·상태</b>',
    '/doctor             — 시스템 헬스 체크',
    '/list               — 최근 EP 10개',
    '/status [EP-XXXX]   — 큐 분포 또는 단일 EP 상세',
    '/budget             — 월 비용 사용량',
    '/cron               — cron 데몬 목록',
    '',
    '<b>경쟁 인텔</b>',
    '/intel [YYYY-MM-DD] — 갭·이상치·블루오션 요약',
    '/intel approve &lt;날짜&gt; — 시리즈 기획 등록 (planned)',
    '',
    '<b>EP 생성</b>',
    '/produce &lt;토픽&gt;     — 신규 EP brief (무비용)',
    '/run EP-XXXX        — 풀 체인 dry-run',
    '/run-exec EP-XXXX   — 풀 체인 실제 발행 💰',
    '',
    '<b>승인·발행</b>',
    '/approve EP-XXXX    — S10 Board 승인',
    '/publish EP-XXXX    — S11 publish 💰 (S10 승인 후)',
    '/cancel EP-XXXX     — cancel + lock release',
    '',
    '<b>auto-pipeline 제어</b>',
    '/reject EP-XXXX     — 30분 reject window 내 publish 차단',
    '/pause              — autonomy paused (모든 cron 중단)',
    '/resume             — autonomy active 복귀',
    '',
    '<i>💰 비용 발생 명령은 실행 전 확인 메시지 발송</i>',
  ].join('\n');
  return reply(chatId, help);
}

async function cmdDoctor(chatId) {
  await reply(chatId, '🩺 진단 중…');
  const doctorScript = join(ROOT, '.claude/skills/barrotube/lib/doctor-cli.sh');
  const r = runBash(`bash ${JSON.stringify(doctorScript)}`, { timeout: 30000 });
  const out = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(0, 3500);
  return reply(chatId, `<pre>${escapeHtml(out)}</pre>`);
}

async function cmdList(chatId) {
  const r = runNode(['scripts/automation/status-local.js', '--all'], { timeout: 20000 });
  const out = r.stdout.slice(0, 3500);
  return reply(chatId, `<pre>${escapeHtml(out)}</pre>`);
}

async function cmdStatus(chatId, args) {
  const target = args[0];
  if (target) {
    const r = runNode(['scripts/automation/status-local.js', '--episode', target], { timeout: 15000 });
    if (r.status !== 0) {
      return reply(chatId, `❌ ${target} 조회 실패\n<pre>${escapeHtml(r.stderr.slice(0, 1000))}</pre>`);
    }
    return reply(chatId, `<pre>${escapeHtml(r.stdout.slice(0, 3500))}</pre>`);
  }
  return cmdList(chatId);
}

async function cmdBudget(chatId) {
  const month = new Date().toISOString().slice(0, 7);
  const budgetFile = join(ROOT, 'logs/budget', `usage-${month}.json`);
  if (!existsSync(budgetFile)) {
    return reply(chatId, `💰 ${month} 사용 기록 없음 (아직 비용 발생 EP 없음)`);
  }
  try {
    const data = JSON.parse(readFileSync(budgetFile, 'utf-8'));
    let total = 0, calls = 0;
    const lines = [`<b>💰 ${month} 비용 사용량</b>`, ''];
    for (const [role, info] of Object.entries(data)) {
      if (typeof info === 'object' && info.total_usd != null) {
        total += info.total_usd; calls += info.calls || 0;
        lines.push(`  ${role}: $${info.total_usd.toFixed(2)} (${info.calls} calls)`);
      }
    }
    lines.push('', `<b>합계: $${total.toFixed(2)} / ${calls} calls</b>`);
    lines.push(`<i>월 한도: $770 (config/budget-policy.json)</i>`);
    return reply(chatId, lines.join('\n'));
  } catch (e) {
    return reply(chatId, `❌ budget 파일 파싱 실패: ${e.message}`);
  }
}

async function cmdCron(chatId) {
  const installScript = join(ROOT, '.claude/skills/barrotube/lib/install-cron.sh');
  const r = runBash(`bash ${JSON.stringify(installScript)} list`, { timeout: 10000 });
  return reply(chatId, `<pre>${escapeHtml(r.stdout.slice(0, 3500))}</pre>`);
}

async function cmdProduce(chatId, args) {
  if (args.length === 0) return reply(chatId, '사용법: /produce &lt;토픽&gt;\n예: <code>/produce 미국 금리 인하 시나리오</code>');
  const topic = args.join(' ');
  await reply(chatId, `📝 brief 생성 중… (무비용 — S0만)`);
  const r = runNode(['scripts/automation/create-episode.js', '--channel', 'econ-daily', '--topic', topic], { timeout: 30000 });
  const out = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(0, 3000);
  return reply(chatId, `<pre>${escapeHtml(out)}</pre>\n\n다음 단계:\n• <code>/run EP-XXXX</code> (dry-run)\n• <code>/run-exec EP-XXXX</code> 💰`);
}

async function cmdRun(chatId, args, execute = false) {
  if (!args[0]) return reply(chatId, `사용법: ${execute ? '/run-exec' : '/run'} EP-2026-XXXX`);
  const epId = args[0];
  if (execute) {
    await reply(chatId, `💰 <b>비용 발생 작업</b>\n${epId} 풀 체인 실행 중…\nTTS·Image·Render·QA·Meta 모두 진행 (약 $0.5~$1).`);
  } else {
    await reply(chatId, `🔍 ${epId} dry-run…`);
  }
  const cmdArgs = ['scripts/automation/run-episode.js', '--episode', epId];
  if (execute) cmdArgs.push('--execute');
  const r = runNode(cmdArgs, { timeout: 600000 });   // 10분 timeout
  const out = (r.stdout + (r.stderr ? '\n--err--\n' + r.stderr : '')).slice(-3500);
  return reply(chatId, `<pre>${escapeHtml(out)}</pre>`);
}

async function cmdApprove(chatId, args) {
  if (!args[0]) return reply(chatId, '사용법: /approve EP-2026-XXXX');
  const epId = args[0];
  const r = runNode(['scripts/automation/approve-episode.js', '--episode', epId, '--by', 'telegram-bot'], { timeout: 15000 });
  const out = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(0, 3000);
  return reply(chatId, `<pre>${escapeHtml(out)}</pre>\n\n다음:\n• <code>/publish ${epId}</code> 💰 (영상 공개)`);
}

async function cmdPublish(chatId, args) {
  if (!args[0]) return reply(chatId, '사용법: /publish EP-2026-XXXX');
  const epId = args[0];
  await reply(chatId, `📺 <b>${epId} 발행 중…</b>\nYouTube 업로드 + 썸네일 설정 (S10 승인 토큰 검증).`);
  const r = runNode(['scripts/automation/publish-youtube.js', '--episode', epId, '--execute'], { timeout: 600000 });
  const out = (r.stdout + (r.stderr ? '\n--err--\n' + r.stderr : '')).slice(-3500);
  return reply(chatId, `<pre>${escapeHtml(out)}</pre>`);
}

async function cmdCancel(chatId, args) {
  if (!args[0]) return reply(chatId, '사용법: /cancel EP-2026-XXXX');
  const epId = args[0];
  const r = runNode(['scripts/automation/in-flight-lock.js', 'release', '--episode', epId], { timeout: 10000 });
  return reply(chatId, `🗑 ${epId} cancel + lock release\n<pre>${escapeHtml(r.stdout.slice(0, 2000))}</pre>`);
}

async function cmdReject(chatId, args) {
  if (!args[0]) return reply(chatId, '사용법: /reject EP-2026-XXXX\nauto-pipeline의 30분 reject window 내 차단');
  const epId = args[0];
  const rejectDir = join(ROOT, 'workspace/.reject-window');
  mkdirSync(rejectDir, { recursive: true });
  const flagFile = join(rejectDir, `${epId}.flag`);
  writeFileSync(flagFile, new Date().toISOString(), 'utf-8');
  return reply(chatId, `🛑 ${epId} reject 등록\nauto-pipeline이 1분 내 감지하면 publish 중단됩니다.`);
}

async function cmdPause(chatId, args) {
  const autonomyFile = join(ROOT, 'config/autonomy-pause.json');
  if (!existsSync(autonomyFile)) return reply(chatId, '❌ autonomy-pause.json 없음');
  try {
    const data = JSON.parse(readFileSync(autonomyFile, 'utf-8'));
    data.status = 'paused';
    data.updated_at = new Date().toISOString();
    data.updated_by = 'telegram-bot';
    data.history = data.history || [];
    data.history.push({ at: data.updated_at, action: 'paused', by: 'telegram' });
    writeFileSync(autonomyFile, JSON.stringify(data, null, 2), 'utf-8');
    return reply(chatId, '🛑 <b>Autonomy paused</b>\n모든 cron + auto-pipeline 즉시 중단\n재개: <code>/resume</code>');
  } catch (e) {
    return reply(chatId, `❌ ${e.message}`);
  }
}

async function cmdResume(chatId, args) {
  const autonomyFile = join(ROOT, 'config/autonomy-pause.json');
  if (!existsSync(autonomyFile)) return reply(chatId, '❌ autonomy-pause.json 없음');
  try {
    const data = JSON.parse(readFileSync(autonomyFile, 'utf-8'));
    data.status = 'active';
    data.updated_at = new Date().toISOString();
    data.updated_by = 'telegram-bot';
    data.history = data.history || [];
    data.history.push({ at: data.updated_at, action: 'resumed', by: 'telegram' });
    writeFileSync(autonomyFile, JSON.stringify(data, null, 2), 'utf-8');
    return reply(chatId, '✅ <b>Autonomy resumed</b>\n다음 cron 사이클부터 정상 동작');
  } catch (e) {
    return reply(chatId, `❌ ${e.message}`);
  }
}

// ─────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────

/**
 * /intel [YYYY-MM-DD]          — 경쟁 인텔 분석 요약
 * /intel approve YYYY-MM-DD    — 승인 마커 생성 → Rule I2 (시리즈 planned 등록)
 */
async function cmdIntel(chatId, args) {
  const INTEL_DIR = join(ROOT, 'workspace', 'intel', 'competitors');

  if (args[0] === 'approve') {
    const date = args[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return reply(chatId, '⚠️ 사용법: <code>/intel approve YYYY-MM-DD</code>');
    }
    const r = spawnSync('node', [
      join(ROOT, 'scripts', 'automation', 'intel-handoff.js'), '--date', date, '--approve',
    ], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
    if (r.status !== 0) return reply(chatId, `❌ 승인 마커 생성 실패\n<pre>${escapeHtml(r.stderr || '')}</pre>`);

    const run = spawnSync('node', [
      join(ROOT, 'scripts', 'automation', 'intel-handoff.js'), '--date', date,
    ], { cwd: ROOT, encoding: 'utf-8', timeout: 300_000 });
    return reply(chatId, `✅ 승인 처리 ${escapeHtml(date)}\n<pre>${escapeHtml((run.stdout || '').slice(-1200))}</pre>`);
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(args[0] || '')
    ? args[0]
    : new Date().toISOString().slice(0, 10);

  const path = join(INTEL_DIR, `analysis-${date}.json`);
  if (!existsSync(path)) {
    return reply(chatId, `ℹ️ 분석 없음: <code>analysis-${escapeHtml(date)}.json</code>\n먼저 <code>bash lib/competitor-pipeline.sh</code> 를 돌리세요.`);
  }

  let a;
  try { a = JSON.parse(readFileSync(path, 'utf-8')); }
  catch (e) { return reply(chatId, `❌ 분석 파일 파싱 실패: ${escapeHtml(e.message)}`); }

  const lines = [`📡 <b>경쟁 인텔 ${escapeHtml(date)}</b>`, ''];
  lines.push(`채널 ${a.channel_count} · 갭 ${a.content_gaps.length} · 이상치 ${a.outliers.length} · 블루오션 ${a.blue_ocean_keywords.length}`);
  if (a.degraded) lines.push(`⚠️ degraded=${escapeHtml(a.degraded)}`);
  lines.push('');

  if (a.content_gaps.length) {
    lines.push('<b>콘텐츠 갭</b>');
    for (const g of a.content_gaps.slice(0, 5)) {
      lines.push(`• ${escapeHtml(g.term)} — ${g.comp_df}채널 / ${g.comp_views.toLocaleString()}회`);
    }
    lines.push('');
  }
  if (a.outliers.length) {
    lines.push('<b>이상치 (오늘 피할 주제)</b>');
    for (const o of a.outliers.slice(0, 3)) {
      lines.push(`• ${o.multiple}× ${escapeHtml(o.channel)} — ${escapeHtml(o.title.slice(0, 40))}`);
    }
    lines.push('');
  }
  if (a.blue_ocean_keywords.length) {
    lines.push('<b>블루오션</b>');
    for (const b of a.blue_ocean_keywords.slice(0, 5)) {
      lines.push(`• ${escapeHtml(b.keyword)} — score ${b.score} / 경쟁 ${b.competition}`);
    }
    lines.push('');
  }
  lines.push(`승인: <code>/intel approve ${escapeHtml(date)}</code>`);
  return reply(chatId, lines.join('\n'));
}

const COMMANDS = {
  '/start': cmdHelp,
  '/help': cmdHelp,
  '/intel': cmdIntel,
  '/doctor': cmdDoctor,
  '/list': cmdList,
  '/status': cmdStatus,
  '/budget': cmdBudget,
  '/cron': cmdCron,
  '/produce': cmdProduce,
  '/run': (chatId, args) => cmdRun(chatId, args, false),
  '/run-exec': (chatId, args) => cmdRun(chatId, args, true),
  '/approve': cmdApprove,
  '/publish': cmdPublish,
  '/cancel': cmdCancel,
  '/reject': cmdReject,
  '/pause': cmdPause,
  '/resume': cmdResume,
};

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  if (chatId !== AUTH_CHAT) {
    logLine(`⚠️ Unauthorized chat ${chatId} — ignored`);
    return;
  }

  const text = msg.text.trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@\w+$/, '').toLowerCase();
  const handler = COMMANDS[cmd];
  if (!handler) {
    return reply(chatId, `⚠️ 알 수 없는 명령: ${escapeHtml(rawCmd)}\n/help 참조.`);
  }

  logLine(`▶ ${chatId} ${cmd} ${args.join(' ')}`);
  try {
    await handler(chatId, args, msg);
  } catch (e) {
    logLine(`❌ ${cmd} failed: ${e.message}`);
    await reply(chatId, `❌ 오류: ${escapeHtml(e.message).slice(0, 500)}`);
  }
}

async function pollOnce() {
  const result = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'edited_message'] });
  if (!result.ok) throw new Error(`getUpdates failed: ${JSON.stringify(result).slice(0, 200)}`);
  for (const update of result.result) {
    offset = Math.max(offset, update.update_id + 1);
    await handleUpdate(update);
  }
  writeFileSync(OFFSET_FILE, String(offset), 'utf-8');
}

async function main() {
  logLine(`🤖 BarroSkills Telegram bot starting (chat: ${AUTH_CHAT}, offset: ${offset})`);
  while (true) {
    try {
      await pollOnce();
    } catch (e) {
      logLine(`poll error: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));   // 5s backoff
    }
  }
}

main().catch(e => { logLine(`FATAL: ${e.message}`); process.exit(1); });
