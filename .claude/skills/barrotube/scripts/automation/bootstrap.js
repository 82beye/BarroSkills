#!/usr/bin/env node

/**
 * BarroTube Bootstrap Script
 * PRD §15: Paperclip 부트스트랩 체크리스트
 *
 * 시스템 전체 설정을 검증하고 초기화한다.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { getSecret, validateSecrets } from './config-loader.js';

const ROOT = resolve(import.meta.dirname, '../..');

const checks = [];

function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, status: result ? 'PASS' : 'FAIL', result });
  } catch (err) {
    checks.push({ name, status: 'FAIL', error: err.message });
  }
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log(`\n🚀 BarroTube Bootstrap Check`);
  console.log(`   Project: ${ROOT}`);
  console.log(`${'═'.repeat(60)}\n`);

  // 1. Node.js 버전 확인
  check('Node.js >= 20', () => {
    const version = process.versions.node;
    const major = parseInt(version.split('.')[0], 10);
    console.log(`   Node.js: v${version}`);
    return major >= 20;
  });

  // 2. 디렉터리 구조
  check('Directory structure', () => {
    const required = [
      'paperclip/config',
      'paperclip/seeds',
      'paperclip/extensions',
      'claude-code/.claude/agents',
      'workspace/channels',
      'workspace/episodes',
      'tools/capcut-builder',
      'scripts/automation',
      'schemas',
      'logs',
    ];

    let allExist = true;
    for (const dir of required) {
      const path = join(ROOT, dir);
      if (!existsSync(path)) {
        console.log(`   ❌ Missing: ${dir}`);
        allExist = false;
      }
    }
    return allExist;
  });

  // 3. 에이전트 프롬프트 파일
  check('Agent prompts (13 files)', () => {
    const agentsDir = join(ROOT, 'claude-code/.claude/agents');
    const files = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    console.log(`   Found: ${files.length} agent prompts`);
    return files.length >= 13;
  });

  // 4. 설정 파일
  check('Configuration files', () => {
    const configs = [
      'paperclip/config/company.json',
      'paperclip/config/budget-policy.json',
      'paperclip/config/governance.json',
      'paperclip/config/domain-whitelist.json',
      'paperclip/config/llm-fallback.json',
      'paperclip/config/notifications.json',
    ];

    let allExist = true;
    for (const cfg of configs) {
      if (!existsSync(join(ROOT, cfg))) {
        console.log(`   ❌ Missing: ${cfg}`);
        allExist = false;
      }
    }
    return allExist;
  });

  // 5. 스키마 파일
  check('JSON Schemas', () => {
    const schemas = readdirSync(join(ROOT, 'schemas')).filter(f => f.endsWith('.json'));
    console.log(`   Found: ${schemas.length} schemas`);
    return schemas.length >= 4;
  });

  // 6. 채널 설정
  check('Channel configuration (econ-daily)', () => {
    const channelDir = join(ROOT, 'workspace/channels/econ-daily');
    const hasBrand = existsSync(join(channelDir, 'brand.md'));
    const hasStyle = existsSync(join(channelDir, 'style-guide.md'));
    return hasBrand && hasStyle;
  });

  // 7. 외부 도구
  check('ffmpeg installed', () => commandExists('ffmpeg'));
  check('caffeinate available', () => commandExists('caffeinate'));

  check('yt-dlp installed', () => {
    const installed = commandExists('yt-dlp');
    if (!installed) {
      console.log(`   ⚠ Install: brew install yt-dlp`);
    }
    return installed;
  });

  // 8. API 키 (.env → 환경변수 → Keychain)
  check('API Keys (.env / env / Keychain)', () => {
    const required = ['ELEVENLABS_API_KEY', 'FAL_API_KEY', 'YOUTUBE_DATA_API_KEY'];
    const optional = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'REPLICATE_API_KEY'];

    const result = validateSecrets([...required, ...optional]);

    for (const [key, source] of Object.entries(result.sources)) {
      const icon = { '.env': '📄', env: '🌍', keychain: '🔐' }[source];
      console.log(`   ${icon} ${key} [${source}]`);
    }
    for (const key of result.missing) {
      const isRequired = required.includes(key);
      console.log(`   ${isRequired ? '❌' : '⚠'} ${key} [missing${isRequired ? ' — 필수' : ''}]`);
    }

    const requiredMissing = required.filter(k => result.missing.includes(k));
    console.log(`   Found: ${Object.keys(result.sources).length}/${required.length + optional.length} | Required missing: ${requiredMissing.length}`);
    return requiredMissing.length === 0;
  });

  // Results summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`\n📊 Results:\n`);

  let passed = 0;
  let failed = 0;

  for (const c of checks) {
    const icon = c.status === 'PASS' ? '✅' : '❌';
    console.log(`   ${icon} ${c.name}`);
    if (c.status === 'PASS') passed++;
    else failed++;
  }

  console.log(`\n   Total: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log(`\n🎉 All checks passed! BarroTube is ready.`);
    console.log(`\n📋 Quick start:`);
    console.log(`   1. Create episode:`);
    console.log(`      node scripts/automation/create-episode.js -c econ-daily -t "오늘의 경제 브리핑"`);
    console.log(`   2. Run episode:`);
    console.log(`      node scripts/automation/run-episode.js -e EP-2026-0001`);
    console.log(`   3. Install daily schedule:`);
    console.log(`      node scripts/automation/install-schedule.js -c econ-daily -t "06:00"`);
  } else {
    console.log(`\n⚠ Fix the failing checks above before proceeding.`);
  }
}

main();
