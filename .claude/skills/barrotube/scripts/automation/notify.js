#!/usr/bin/env node

/**
 * BarroTube — 알림 모듈 (FR-S-004)
 * Telegram Bot + macOS Notification
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getSecret } from './config-loader.js';

const CONFIG_PATH = resolve(import.meta.dirname, '../../config/notifications.json');

/**
 * 알림 설정 로드
 */
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { notifications: {} };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

/**
 * Telegram Bot API로 알림 전송
 */
async function sendTelegram(botToken, chatId, message, parseMode = 'HTML') {
  return sendTelegramText(formatTelegramMessage(message), parseMode, { botToken, chatId });
}

export async function sendTelegramText(text, parseMode = 'HTML', {
  botToken, chatId,
} = {}) {
  if (process.env.DRY_RUN === '1' || process.env.BT_NO_NOTIFY === '1') return false;
  botToken ||= getSecret('TELEGRAM_BOT_TOKEN');
  chatId ||= getSecret('TELEGRAM_CHAT_ID');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken || '') || !chatId) throw new Error('Telegram credentials missing or invalid');
  await telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  }, botToken);
  return true;
}

export async function telegramRequest(method, body, botToken) {
  if (!['sendMessage', 'getUpdates'].includes(method) || !/^\d+:[A-Za-z0-9_-]+$/.test(botToken || '')) {
    throw new Error('Invalid Telegram request');
  }
  const waitSec = method === 'getUpdates' ? 50 : 15;

  // fetch 가 아니라 curl 을 쓴다. api.telegram.org 는 A·AAAA 를 둘 다 주는데 이 네트워크의
  // IPv6 경로가 죽어 있고, undici 는 --dns-result-order=ipv4first 도 무시해 ETIMEDOUT 이
  // 난다(2026-08-14 실측: node fetch 실패 / curl 200 / curl -4 302). lib/guards.sh 의
  // notify_telegram 도 같은 이유로 curl 이다 — 두 경로를 같은 방식으로 맞춘다.
  // URL contains the bot credential: pass configuration on stdin, never argv/ps.
  let out;
  try {
    out = execFileSync('curl', ['-sS', '-4', '-m', String(waitSec), '--config', '-'], {
      input: `url = ${JSON.stringify(`https://api.telegram.org/bot${botToken}/${method}`)}\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata = ${JSON.stringify(JSON.stringify(body))}\n`,
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: (waitSec + 5) * 1000,
    });
  } catch { throw new Error('Telegram transport failed'); }

  let result;
  try {
    result = JSON.parse(out);
  } catch {
    throw new Error('Telegram 응답을 파싱하지 못했다');
  }
  if (result.ok !== true) throw new Error(`Telegram API rejected message (${result.error_code || 'unknown'})`);
  return result;
}

/**
 * Telegram HTML 형식으로 메시지 포맷
 */
function formatTelegramMessage(message) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const epInfo = escapeHtml(message.episode_id || 'System');

  return [
    `<b>${escapeHtml(message.title)}</b>`,
    '',
    escapeHtml(message.body),
    '',
    `<i>📺 BarroTube | ${epInfo} | ${timestamp}</i>`,
  ].join('\n');
}

/**
 * HTML 특수문자 이스케이프
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 알림 유형별 메시지 생성
 */
function buildMessage(type, data) {
  const templates = {
    episode_complete: {
      title: `✅ 에피소드 완료: ${data.episode_id}`,
      body: `채널: ${data.channel_id}\n상태: 게시 준비 완료\nBoard 승인을 기다리고 있습니다.`,
    },
    episode_failed: {
      title: `❌ 에피소드 실패: ${data.episode_id}`,
      body: `채널: ${data.channel_id}\n단계: ${data.stage}\n오류: ${data.error}`,
    },
    board_approval_needed: {
      title: `⏳ 승인 대기: ${data.episode_id}`,
      body: `채널: ${data.channel_id}\n에피소드가 게시 승인을 기다리고 있습니다.\nPaperclip 대시보드에서 확인해주세요.`,
    },
    intel_ready: {
      title: `📡 경쟁 인텔 ${data.date}`,
      body: `갭 ${data.gaps} · 이상치 ${data.outliers} · 블루오션 ${data.blue_ocean}\n${data.top ? `주목: ${data.top}\n` : ''}승인: /intel approve ${data.date}`,
    },
    budget_alert: {
      title: `💰 예산 경고: ${data.role}`,
      body: `사용량: $${data.used} / $${data.limit} (${data.pct}%)\n${data.action}`,
    },
    daily_report: data.text ? {
      title: `📊 일일 보고서`,
      body: data.text,
    } : {
      title: `📊 일일 보고서`,
      body: `생성 에피소드: ${data.count}편\n총 비용: $${data.cost}\n성공률: ${data.success_rate}%`,
    },
  };

  const template = templates[type];
  if (!template) return null;
  return { ...template, episode_id: data.episode_id };
}

/**
 * 알림 전송 (메인 함수)
 */
export async function notify(type, data) {
  if (process.env.DRY_RUN === '1' || process.env.BT_NO_NOTIFY === '1') return false;
  const { notifications: config } = loadConfig();
  const message = buildMessage(type, data);

  if (!message) {
    console.error(`Unknown notification type: ${type}`);
    return false;
  }

  let sent = false;

  // Telegram
  if (config.telegram?.enabled) {
    try {
      const botToken = config.telegram.bot_token
        || getSecret('TELEGRAM_BOT_TOKEN');
      const chatId = config.telegram.chat_id
        || getSecret('TELEGRAM_CHAT_ID');

      if (botToken && chatId) {
        sent = await sendTelegram(botToken, chatId, message, config.telegram.parse_mode);
        if (sent) console.log(`📨 Telegram notification sent: ${message.title}`);
      } else {
        console.warn('[Telegram] bot_token 또는 chat_id가 설정되지 않았습니다.');
      }
    } catch (err) {
      console.error(`Telegram notification failed: ${err.message}`);
    }
  }

  // macOS 알림 (폴백)
  if (!sent && config.macos_notification?.enabled) {
    try {
      execFileSync('osascript', ['-e', 'on run argv\n display notification (item 1 of argv) with title "BarroTube" subtitle (item 2 of argv)\nend run', '--', message.body.slice(0, 200), message.title]);
      console.log(`🔔 macOS notification sent: ${message.title}`);
      sent = true;
    } catch {
      // silent fail
    }
  }

  return sent;
}

// CLI 직접 호출 지원
const scriptUrl = `file://${process.argv[1]}`;
if (import.meta.url === scriptUrl) {
  const [, , type, ...rest] = process.argv;
  if (!type) {
    console.log('Usage: node notify.js <type> [JSON data]');
    console.log('Types: episode_complete, episode_failed, board_approval_needed, intel_ready, budget_alert, daily_report');
    console.log('');
    console.log('Setup:');
    console.log('  security add-generic-password -a "$USER" -s "TELEGRAM_BOT_TOKEN" -w "YOUR_BOT_TOKEN"');
    console.log('  security add-generic-password -a "$USER" -s "TELEGRAM_CHAT_ID" -w "YOUR_CHAT_ID"');
    process.exit(0);
  }
  const data = rest.length > 0 ? JSON.parse(rest.join(' ')) : {};
  notify(type, data);
}
