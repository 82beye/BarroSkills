#!/usr/bin/env node

/**
 * telegram-bot.js — BarroTube Telegram 커맨드 봇 (long-polling)
 *
 * 인증된 chat_id만 허용. 지원 커맨드:
 *   /help                      — 명령어 목록
 *   /news [date]               — 경제 뉴스 수집
 *   /topics [N]                — 뉴스 수집 후 Top N 후보 조회 (기본 5)
 *   /select <N1> [N2]...       — 선정된 번호로 에피소드 생성 (create-episode)
 *   /auto [N]                  — fetch+select+create 원샷 (기본 2개)
 *   /status [EP-ID]            — 에피소드 상태 조회
 *   /list                      — 진행 중 에피소드 목록
 *   /approve <EP-ID> [--note]  — Board 승인 (S10)
 *   /budget                    — 예산 현황
 *   /schedule                  — launchd 스케줄 상태
 *
 * 실행: node scripts/automation/telegram-bot.js
 * 데몬: bash scripts/automation/install-bot-daemon.sh
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { getSecret } from './config-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');
const API = 'https://api.telegram.org';

const BOT_TOKEN = getSecret('TELEGRAM_BOT_TOKEN');
const AUTH_CHAT = String(getSecret('TELEGRAM_CHAT_ID') || '');

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN 없음'); process.exit(1); }
if (!AUTH_CHAT) { console.error('❌ TELEGRAM_CHAT_ID 없음'); process.exit(1); }

const OFFSET_FILE = join(ROOT, 'logs', 'telegram-offset.txt');
let offset = existsSync(OFFSET_FILE) ? parseInt(readFileSync(OFFSET_FILE, 'utf-8').trim() || '0') : 0;

async function tg(method, body) {
  const res = await fetch(`${API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram ${method}: ${res.status} ${err.slice(0, 200)}`);
  }
  return res.json();
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

function runNode(args, { captureOutput = false } = {}) {
  const r = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ─────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────

async function cmdHelp(chatId) {
  const help = [
    '<b>🎬 BarroTube 봇 명령어 (수동 모드)</b>',
    '',
    '⚙️ Heartbeat 자동 실행 중지됨. 에피소드 생성 후 Claude Code에서 수동 진행.',
    '',
    '<b>주제·에피소드 생성</b>',
    '/news [date]        — 경제 뉴스 수집',
    '/topics [N]         — 상위 N개 자동 후보 (기본 5)',
    '/select N1 [N2...]  — 후보 번호로 에피소드 생성 (Brief만)',
    '/auto [N]           — fetch+select+create 원샷 (Brief만)',
    '/create &lt;주제어&gt;     — 주제어로 관련 뉴스 분석 + Brief 생성',
    '',
    '<b>영상 산출 (S4~S9 자동)</b>',
    '/produce EP-XXXX    — Script+TTS+Image+Render+QA+Meta 풀 체인',
    '',
    '<b>상태</b>',
    '/list               — 진행 중 에피소드',
    '/status EP-XXXX     — 특정 에피소드 상태',
    '/budget             — 예산 현황',
    '/schedule           — 스케줄 상태',
    '',
    '<b>승인·배포</b>',
    '/approve EP-XXXX    — Board 승인 + <b>S11 Publish 자동 실행</b>',
    '',
    '/help               — 이 도움말',
    '',
    '<b>예시</b>',
    '<code>/create AI 반도체 수출</code>',
    '<code>/create 코스피 5000</code>',
    '<code>/create 부동산 집값</code>',
  ].join('\n');
  await reply(chatId, help);
}

async function cmdNews(chatId, args) {
  const date = args[0] || new Date().toISOString().slice(0, 10);
  await reply(chatId, `📰 뉴스 수집 중... (${date})`);

  const r = runNode(['scripts/automation/fetch-daily-news.js', '--date', date], { captureOutput: true });
  if (r.status !== 0) {
    return reply(chatId, `❌ 수집 실패\n<pre>${r.stderr.slice(0, 500)}</pre>`);
  }
  // 총 개수 파싱
  const match = r.stdout.match(/Total: (\d+)/);
  await reply(chatId, `✅ 수집 완료: ${match?.[1] || '?'}개 기사\n경로: <code>workspace/daily-news/${date}/news.json</code>`);
}

async function cmdTopics(chatId, args) {
  const count = parseInt(args[0] || '5');
  const date = new Date().toISOString().slice(0, 10);

  await reply(chatId, `🔍 Top ${count} 후보 분석 중...`);

  // news.json 없으면 먼저 수집
  const newsPath = join(ROOT, 'workspace/daily-news', date, 'news.json');
  if (!existsSync(newsPath)) {
    const r = runNode(['scripts/automation/fetch-daily-news.js', '--date', date], { captureOutput: true });
    if (r.status !== 0) return reply(chatId, `❌ 뉴스 수집 실패`);
  }

  const r = runNode(['scripts/automation/ceo-select-topics.js', '--date', date, '--count', String(count)], { captureOutput: true });
  if (r.status !== 0) return reply(chatId, `❌ 주제 선정 실패\n<pre>${r.stderr.slice(0, 300)}</pre>`);

  const topicsPath = join(ROOT, 'workspace/daily-news', date, 'topics.json');
  const { topics } = JSON.parse(readFileSync(topicsPath, 'utf-8'));

  const lines = [`🏆 <b>${date} Top ${topics.length} 후보</b>`, ''];
  topics.forEach((t, i) => {
    lines.push(`<b>${i + 1}.</b> [${t.score}점] ${t.topic}`);
    lines.push(`   ${t.title.slice(0, 60)}`);
    if (t.matched_keywords?.length) lines.push(`   🏷 ${t.matched_keywords.join(', ')}`);
    lines.push('');
  });
  lines.push('👉 <code>/select 1 2</code> 로 에피소드 생성');
  await reply(chatId, lines.join('\n'));
}

async function cmdSelect(chatId, args) {
  if (!args.length) return reply(chatId, '사용법: /select 1 2');

  const date = new Date().toISOString().slice(0, 10);
  const topicsPath = join(ROOT, 'workspace/daily-news', date, 'topics.json');
  if (!existsSync(topicsPath)) {
    return reply(chatId, '❌ topics.json 없음. 먼저 /topics 실행.');
  }
  const { topics } = JSON.parse(readFileSync(topicsPath, 'utf-8'));

  const picks = args.map(a => parseInt(a) - 1).filter(i => i >= 0 && i < topics.length);
  if (!picks.length) return reply(chatId, '❌ 유효 번호 없음');

  const created = [];
  for (const idx of picks) {
    const t = topics[idx];
    const topicText = `${t.topic} — ${t.title.slice(0, 60)}`;
    const notes = `레퍼런스: ${t.source} / ${t.link || '-'}\n요약: ${t.summary || ''}`;
    const r = runNode([
      'scripts/automation/create-episode.js',
      '--channel', 'econ-daily',
      '--topic', topicText,
      '--length', '60',
      '--notes', notes,
    ], { captureOutput: true });
    if (r.status === 0) {
      const m = r.stdout.match(/EP-\d{4}-\d{4}/);
      if (m) created.push({ id: m[0], topic: t.topic });
    }
  }

  const lines = [`✅ ${created.length}개 에피소드 생성`, ''];
  created.forEach(e => lines.push(`• <code>${e.id}</code>: ${e.topic}`));
  lines.push('', '다음: Writer/Asset/Render 단계는 Claude Code CLI에서 진행');
  await reply(chatId, lines.join('\n'));
}

async function cmdAuto(chatId, args) {
  const n = parseInt(args[0] || '2');
  await reply(chatId, `🤖 자동 배치 시작 (상위 ${n}개 주제)`);
  const r = runNode(['scripts/automation/daily-episode-batch.js', '--count', String(n)], { captureOutput: true });
  if (r.status !== 0) return reply(chatId, `❌ 배치 실패\n<pre>${r.stderr.slice(0, 500)}</pre>`);
  // 결과 파싱
  const epIds = [...(r.stdout.matchAll(/EP-\d{4}-\d{4}/g))].map(m => m[0]);
  const unique = [...new Set(epIds)];
  await reply(chatId, `✅ ${unique.length}개 생성됨:\n${unique.map(id => `• <code>${id}</code>`).join('\n')}`);
}

async function cmdList(chatId) {
  const dir = join(ROOT, 'workspace/episodes');
  if (!existsSync(dir)) return reply(chatId, '에피소드 없음');
  const eps = readdirSync(dir)
    .filter(d => d.startsWith('EP-'))
    .sort()
    .slice(-10);

  const lines = ['<b>📋 최근 에피소드 (최대 10개)</b>', ''];
  for (const id of eps) {
    const st = join(dir, id, '.episode_status.json');
    let stage = 'S0';
    let status = '-';
    if (existsSync(st)) {
      const d = JSON.parse(readFileSync(st, 'utf-8'));
      stage = d.current_stage || '-';
      status = d.status || '-';
    }
    lines.push(`• <code>${id}</code> — ${stage} (${status})`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdStatus(chatId, args) {
  if (!args[0]) return reply(chatId, '사용법: /status EP-2026-0002');
  const id = args[0];
  const dir = join(ROOT, 'workspace/episodes', id);
  if (!existsSync(dir)) return reply(chatId, `❌ ${id} 없음`);

  const st = join(dir, '.episode_status.json');
  if (!existsSync(st)) return reply(chatId, `<code>${id}</code>: status 파일 없음`);
  const d = JSON.parse(readFileSync(st, 'utf-8'));

  const files = readdirSync(dir).filter(f => !f.startsWith('.'));
  const lines = [
    `<b>📊 ${id}</b>`,
    `Stage: ${d.current_stage} (${d.status})`,
    `Updated: ${d.last_updated}`,
    '',
    `<b>Files:</b>`,
    ...files.slice(0, 20).map(f => `• ${f}`),
  ];
  await reply(chatId, lines.join('\n'));
}

async function cmdApprove(chatId, args, msg) {
  if (!args[0]) return reply(chatId, '사용법: /approve EP-2026-0002');
  const id = args[0];
  const by = msg.from?.username || msg.from?.first_name || 'Telegram-Board';

  // 1. 승인 토큰 발행
  const r1 = runNode([
    'scripts/automation/approve-episode.js',
    '--episode', id, '--by', by,
    '--note', 'Telegram bot approval + auto-publish',
  ], { captureOutput: true });
  if (r1.status !== 0) return reply(chatId, `❌ 승인 실패\n<pre>${r1.stderr.slice(0, 400)}</pre>`);

  await reply(chatId, `✅ ${id} 승인됨 (by ${by})\n🚀 S11 Publish 자동 실행 중... (30~90초 소요)`);

  // 2. run-episode.js 자동 실행 (S11 publish 체인)
  const r2 = runNode([
    'scripts/automation/run-episode.js',
    '--episode', id,
  ], { captureOutput: true });

  // 3. 결과 파싱
  const stdout = r2.stdout || '';
  const stderr = r2.stderr || '';

  // publish_result.json에서 YouTube URL 추출
  let result = {};
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const resultPath = join(ROOT, 'workspace/episodes', id, '80_publish_result.json');
    if (existsSync(resultPath)) {
      result = JSON.parse(readFileSync(resultPath, 'utf-8'));
    }
  } catch {}

  const yt = result.targets?.youtube;
  const tiktokPath = result.targets?.tiktok?.package_path;
  const reelsPath = result.targets?.reels?.package_path;

  if (yt?.url) {
    const lines = [
      `🎉 <b>${id} 배포 완료!</b>`,
      ``,
      `🎬 <b>YouTube</b> (${yt.status})`,
      `  🔗 ${yt.url}`,
      `  🔒 ${yt.privacyStatus}`,
      ``,
      `📦 <b>수동 업로드 패키지</b>`,
      `  • TikTok: <code>${(tiktokPath||'').replace(ROOT+'/','')}</code>`,
      `  • Reels:  <code>${(reelsPath||'').replace(ROOT+'/','')}</code>`,
      ``,
      `각 디렉토리 내 <b>checklist.md</b> 따라 수동 업로드`,
    ];
    return reply(chatId, lines.join('\n'));
  }

  if (r2.status !== 0) {
    return reply(chatId, `⚠️ ${id} Publish 실패\n<pre>${(stderr || stdout).slice(-800)}</pre>\n\n수동 재시도: <code>node scripts/automation/run-episode.js --episode ${id}</code>`);
  }

  // 성공했지만 result JSON 없는 경우 (예: 이미 completed 체크포인트)
  return reply(chatId, `✅ ${id} run-episode 완료\n<pre>${stdout.slice(-600)}</pre>`);
}

async function cmdBudget(chatId) {
  const r = runNode(['scripts/automation/budget-report.js'], { captureOutput: true });
  const out = r.stdout.slice(-2000) || r.stderr.slice(-500) || '(no output)';
  await reply(chatId, `<pre>${out}</pre>`);
}

async function cmdCreate(chatId, args) {
  if (!args.length) {
    return reply(chatId, '사용법: <code>/create AI 반도체 수출</code>\n주제어를 입력하면 관련 최신 경제 뉴스를 분석해 에피소드를 즉시 생성합니다.');
  }
  const topic = args.join(' ').trim();
  await reply(chatId, `🎯 주제 분석 중: "<b>${topic}</b>"\n최근 3일치 관련 경제 뉴스 필터링 + 에피소드 생성...`);

  const r = runNode([
    'scripts/automation/topic-to-episode.js',
    '--topic', topic,
    '--channel', 'econ-daily',
    '--days', '3',
  ], { captureOutput: true });

  if (r.status !== 0) {
    return reply(chatId, `❌ 주제 기반 생성 실패\n<pre>${(r.stderr || r.stdout).slice(0, 500)}</pre>`);
  }

  // RESULT JSON 파싱
  const m = r.stdout.match(/<!--RESULT-->(.+?)<!--\/RESULT-->/s);
  let result = null;
  try { if (m) result = JSON.parse(m[1]); } catch {}

  if (!result) {
    // 폴백: EP ID만 추출
    const idMatch = r.stdout.match(/EP-\d{4}-\d{4}/);
    if (idMatch) {
      return reply(chatId, `✅ 생성됨: <code>${idMatch[0]}</code>\n(상세 결과 파싱 실패)`);
    }
    return reply(chatId, `⚠️ 생성은 됐지만 결과 파싱 실패\n<pre>${r.stdout.slice(-500)}</pre>`);
  }

  const lines = [
    `✅ <b>에피소드 생성 완료</b>`,
    ``,
    `📌 <code>${result.episode_id}</code>`,
    `🎯 주제: <b>${result.topic}</b>`,
    `🔍 확장 키워드: ${result.expanded_keywords.slice(0, 8).join(', ')}${result.expanded_keywords.length > 8 ? '...' : ''}`,
    ``,
    `<b>관련 기사 Top ${result.references_count}</b>`,
    ...result.references.map((ref, i) =>
      `${i + 1}. [${ref.score}점] ${ref.title.slice(0, 50)}\n   📰 ${ref.source}`
    ),
    ``,
    `📁 <code>workspace/episodes/${result.episode_id}/</code>`,
    `   · 00_brief.md`,
    `   · 05_topic_references.md (기사 5편 전문)`,
    ``,
    `<b>다음 단계</b>: Claude Code에서 Writer(S4) → Asset(S6) → Render(S7)`,
    `또는 봇에서 <code>/status ${result.episode_id}</code> 로 진행 확인`,
  ];
  await reply(chatId, lines.join('\n'));
}

async function cmdProduce(chatId, args) {
  if (!args[0]) return reply(chatId, '사용법: /produce EP-2026-0009');
  const id = args[0];
  await reply(chatId, `🎬 <b>${id}</b> S4~S9 풀 체인 실행 중...\n(Script → TTS → Sync → Image → Render → CapCut → QA → Meta → SEO)\n약 2~5분 소요`);

  const r = runNode(['scripts/automation/produce-episode.js', '--episode', id], { captureOutput: true });
  const out = (r.stdout || '') + (r.stderr || '');

  if (r.status !== 0) {
    return reply(chatId, `❌ ${id} Produce 실패\n<pre>${out.slice(-1000)}</pre>`);
  }

  // QA verdict 파싱
  const verdict = /Verdict:\s*(PASS|FAIL)/.exec(out)?.[1] || '?';
  const duration = /Duration:.*?\((\d+\.\d+s)/.exec(out)?.[1] || '?';
  const tags = /Tags:\s*(\d+)개/.exec(out)?.[1] || '?';
  const title = /Title:\s*([^\n]+)/.exec(out)?.[1] || '';

  const lines = [
    `✅ <b>${id} S4~S9 완료</b>`,
    ``,
    `📊 <b>결과</b>`,
    `  • QA: ${verdict}`,
    `  • Duration: ${duration}`,
    `  • Tags: ${tags}개`,
    title ? `  • Title: ${title.slice(0, 60)}` : '',
    ``,
    `<b>다음 단계</b>`,
    `<code>/approve ${id}</code> → S11 Publish 자동 실행`,
  ].filter(Boolean);
  return reply(chatId, lines.join('\n'));
}

async function cmdSchedule(chatId) {
  try {
    const out = execSync('launchctl list | grep com.barrotube || echo "not loaded"').toString();
    await reply(chatId, `<b>Scheduled tasks:</b>\n<pre>${out}</pre>`);
  } catch (e) {
    await reply(chatId, `launchctl: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────

async function dispatch(msg) {
  const chatId = String(msg.chat.id);
  if (chatId !== AUTH_CHAT) {
    console.warn(`⛔ Unauthorized chat ${chatId}`);
    return;
  }
  const text = (msg.text || '').trim();
  if (!text.startsWith('/')) return;

  const [cmd, ...args] = text.split(/\s+/);
  const base = cmd.split('@')[0]; // /cmd@BotName
  console.log(`[${new Date().toISOString()}] ${base} ${args.join(' ')}`);

  try {
    switch (base) {
      case '/start':
      case '/help':    await cmdHelp(chatId); break;
      case '/news':    await cmdNews(chatId, args); break;
      case '/topics':  await cmdTopics(chatId, args); break;
      case '/select':  await cmdSelect(chatId, args); break;
      case '/auto':    await cmdAuto(chatId, args); break;
      case '/create':  await cmdCreate(chatId, args); break;
      case '/produce': await cmdProduce(chatId, args); break;
      case '/list':    await cmdList(chatId); break;
      case '/status':  await cmdStatus(chatId, args); break;
      case '/approve': await cmdApprove(chatId, args, msg); break;
      case '/reject':  await cmdReject(chatId, args, msg); break;
      case '/blocked': await cmdBlocked(chatId); break;
      case '/budget':  await cmdBudget(chatId); break;
      case '/schedule': await cmdSchedule(chatId); break;
      default:
        await reply(chatId, `❓ 알 수 없는 명령: ${base}\n/help 로 목록 확인`);
    }
  } catch (e) {
    console.error(`cmd ${base} error:`, e);
    await reply(chatId, `❌ 에러: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────
// Main loop (long-polling)
// ─────────────────────────────────────────────────

async function main() {
  console.log(`🤖 BarroTube bot online (chat_id=${AUTH_CHAT})`);
  try { await tg('sendMessage', { chat_id: AUTH_CHAT, text: '🤖 BarroTube 봇 온라인.\n/help 로 시작하세요.', parse_mode: 'HTML' }); } catch {}

  while (true) {
    try {
      const { result } = await tg('getUpdates', { offset: offset + 1, timeout: 30, allowed_updates: ['message'] });
      for (const u of result || []) {
        offset = u.update_id;
        writeFileSync(OFFSET_FILE, String(offset), 'utf-8');
        if (u.message) await dispatch(u.message);
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

// ─────────────────────────────────────────────────
// 2026-04-29 신규: Publish reject window + 회사 큐 명령
// ─────────────────────────────────────────────────

const COMPANY_ID_AUTONOMY = '46041d31-43ca-4135-8db6-8a84ba0d22de';
const REJECT_LOG = join(ROOT, 'logs', 'autonomy', 'publish-rejects.jsonl');

// Publish 알림 — Publisher가 publish 직전 호출
export async function notifyPublishDecision(epId, ceoIssueId, meta = {}) {
  const text = [
    `🚀 <b>[Publish 알림]</b> ${epId}`,
    `제목: ${meta.title || '-'}`,
    `시리즈: ${meta.series || '-'}`,
    `QA: ${meta.qa_verdict || '-'} (${meta.qa_risk || '-'})`,
    `CEO 승인 이슈: ${ceoIssueId || '-'}`,
    '',
    `30분 reject window 시작 (${new Date().toISOString()})`,
    `반려: <code>/reject ${epId}</code>`,
    `즉시 승인: <code>/approve ${epId}</code> (window 종료)`,
    `무응답 시 자동 progress.`,
  ].join('\n');
  try {
    await tg('sendMessage', { chat_id: AUTH_CHAT, text, parse_mode: 'HTML' });
  } catch (e) { console.error('notifyPublishDecision failed:', e.message); }
}

import { mkdirSync as _mkdirSync, appendFileSync as _appendFileSync } from 'node:fs';

async function cmdReject(chatId, args) {
  const ep = args[0];
  if (!ep || !/^EP-\d{4}-\d{4}$/i.test(ep)) {
    return reply(chatId, '사용법: /reject EP-2026-0028 [사유]');
  }
  const reason = args.slice(1).join(' ').trim() || '운영자 반려 (무사유)';
  const entry = { at: new Date().toISOString(), episode: ep.toUpperCase(), reason, by: 'telegram-operator', chat_id: chatId };
  try {
    _mkdirSync(join(ROOT, 'logs', 'autonomy'), { recursive: true });
    _appendFileSync(REJECT_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (e) {
    return reply(chatId, `❌ reject 기록 실패: ${e.message}`);
  }
  // PaperClip 이슈 status=cancelled (best-effort)
  let issueClosed = false;
  try {
    const list = await fetch(`http://localhost:3100/api/companies/${COMPANY_ID_AUTONOMY}/issues?limit=400`).then(r => r.json());
    const items = (Array.isArray(list) ? list : list.items || []).filter(x => !x.hiddenAt);
    const found = items.find(x => (x.title || '').includes(ep) && /publish/i.test(x.title));
    if (found) {
      await fetch(`http://localhost:3100/api/issues/${found.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      await fetch(`http://localhost:3100/api/issues/${found.id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `## 🛑 Telegram /reject — ${ep}\n사유: ${reason}\nby: telegram-operator at ${entry.at}` }),
      });
      issueClosed = true;
    }
  } catch (e) { console.error('issue close failed:', e.message); }

  await reply(chatId, [
    `🛑 <b>Reject 등록</b>: ${ep}`,
    `사유: ${reason}`,
    `로그: <code>logs/autonomy/publish-rejects.jsonl</code>`,
    issueClosed ? '관련 이슈 status=cancelled 처리됨.' : '관련 이슈를 찾지 못함 (publish 진행 전이면 Publisher가 30분 sleep 안에서 감지).',
  ].join('\n'));
}

async function cmdBlocked(chatId) {
  try {
    const list = await fetch(`http://localhost:3100/api/companies/${COMPANY_ID_AUTONOMY}/issues?limit=400`).then(r => r.json());
    const items = (Array.isArray(list) ? list : list.items || []).filter(x => !x.hiddenAt && x.status === 'blocked');
    if (items.length === 0) return reply(chatId, '✅ blocked 이슈 없음.');
    const lines = ['🛑 <b>Blocked 이슈</b>', ''];
    for (const x of items.slice(0, 20)) {
      lines.push(`• <code>${x.identifier}</code> (${x.priority}) ${(x.title || '').slice(0, 60)}`);
    }
    await reply(chatId, lines.join('\n'));
  } catch (e) { await reply(chatId, `❌ ${e.message}`); }
}
