#!/usr/bin/env node

/**
 * BarroTube — 알림 모듈 (FR-S-004)
 * Telegram Bot + macOS Notification
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { getSecret } from './config-loader.js';

const CONFIG_PATH = resolve(import.meta.dirname, '../../paperclip/config/notifications.json');

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
  const text = formatTelegramMessage(message);

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram API ${response.status}: ${err}`);
  }

  const result = await response.json();
  return result.ok;
}

/**
 * Telegram HTML 형식으로 메시지 포맷
 */
function formatTelegramMessage(message) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const epInfo = message.episode_id || 'System';

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
      execSync(
        `osascript -e 'display notification "${message.body.slice(0, 200).replace(/"/g, '\\"')}" with title "BarroTube" subtitle "${message.title.replace(/"/g, '\\"')}"'`
      );
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
    console.log('Types: episode_complete, episode_failed, board_approval_needed, budget_alert, daily_report');
    console.log('');
    console.log('Setup:');
    console.log('  security add-generic-password -a "$USER" -s "TELEGRAM_BOT_TOKEN" -w "YOUR_BOT_TOKEN"');
    console.log('  security add-generic-password -a "$USER" -s "TELEGRAM_CHAT_ID" -w "YOUR_CHAT_ID"');
    process.exit(0);
  }
  const data = rest.length > 0 ? JSON.parse(rest.join(' ')) : {};
  notify(type, data);
}
