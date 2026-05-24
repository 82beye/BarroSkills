#!/usr/bin/env node
/**
 * sync-agents.js — Agent Prompt Sync Tool
 *
 * SoT (Source of Truth): `.claude/agents/0N-{role}.md` (13 files, frontmatter + monolithic body)
 *
 * Generates two derived locations:
 *  1) Mirror      : `claude-code/.claude/agents/0N-{role}.md` — byte-identical copy
 *  2) Paperclip   : `paperclip/package/agents/{role}/AGENTS.md` — body only (frontmatter stripped)
 *
 * Idempotent: Re-running with no upstream change emits "no changes".
 *
 * Usage:
 *   node scripts/automation/sync-agents.js              # apply changes
 *   node scripts/automation/sync-agents.js --dry-run    # preview only
 *
 * NOTE: Never touches `paperclip/package/agents/{role}/SOUL.md`,
 * `HEARTBEAT.md`, `TOOLS.md` — those follow a separate schema.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---- Configuration ---------------------------------------------------------

const SOT_DIR = join(REPO_ROOT, '.claude', 'agents');
const MIRROR_DIR = join(REPO_ROOT, 'claude-code', '.claude', 'agents');
const PAPERCLIP_AGENTS_ROOT = join(REPO_ROOT, 'paperclip', 'package', 'agents');
// 글로벌 위치: Claude Code subagent system은 세션 시작 시 ~/.claude/agents/를 스캔.
// --with-global 플래그 또는 BARROTUBE_SYNC_GLOBAL=1 환경변수 시 활성.
const GLOBAL_DIR = join(homedir(), '.claude', 'agents');

// filename prefix → paperclip role directory name
const ROLE_MAP = {
  '01-ceo': 'ceo',
  '02-producer': 'producer',
  '03-market-researcher': 'market-researcher',
  '04-strategist': 'strategist',
  '05-writer': 'writer',
  '06-fact-checker': 'fact-checker',
  '07-asset-pm': 'asset-pm',
  '08-image-generator': 'image-generator',
  '09-voice-engineer': 'voice-engineer',
  '10-capcut-composer': 'capcut-composer',
  '11-qa-reviewer': 'qa-reviewer',
  '12-metadata-writer': 'metadata-writer',
  '13-publisher': 'publisher',
};

// ---- Helpers ---------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SYNC_GLOBAL = args.includes('--with-global') || process.env.BARROTUBE_SYNC_GLOBAL === '1';

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
};
const c = (color, s) => `${colors[color]}${s}${colors.reset}`;

/**
 * Strip YAML frontmatter from an agent prompt.
 * Frontmatter must start with `---\n` on the first line and end with `---\n`.
 * Returns body only (no leading blank line).
 */
function stripFrontmatter(raw) {
  if (!raw.startsWith('---\n')) {
    // no frontmatter — return as-is
    return raw;
  }
  // find closing fence
  const closeIdx = raw.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    throw new Error('Frontmatter opened with --- but never closed');
  }
  // body starts after `\n---\n`
  let body = raw.slice(closeIdx + 5);
  // strip a single leading blank line (common case)
  if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    if (DRY_RUN) return;
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Compare two strings; if different (or target missing), write target.
 * Returns one of: 'created' | 'updated' | 'unchanged'.
 */
function syncFile(targetPath, newContent) {
  if (!existsSync(targetPath)) {
    if (!DRY_RUN) {
      ensureDir(dirname(targetPath));
      writeFileSync(targetPath, newContent, 'utf8');
    }
    return 'created';
  }
  const current = readFileSync(targetPath, 'utf8');
  if (current === newContent) {
    return 'unchanged';
  }
  if (!DRY_RUN) {
    writeFileSync(targetPath, newContent, 'utf8');
  }
  return 'updated';
}

function statusLabel(status) {
  switch (status) {
    case 'created':
      return c('green', '[ NEW ]    ');
    case 'updated':
      return c('yellow', '[ UPDATED ]');
    case 'unchanged':
      return c('dim', '[ SAME ]   ');
    default:
      return `[ ${status} ]`;
  }
}

// ---- Main ------------------------------------------------------------------

function main() {
  console.log(c('bold', `\n=== sync-agents${DRY_RUN ? ' (DRY-RUN)' : ''} ===`));
  console.log(c('dim', `  SoT      : ${SOT_DIR}`));
  console.log(c('dim', `  Mirror   : ${MIRROR_DIR}`));
  console.log(c('dim', `  Paperclip: ${PAPERCLIP_AGENTS_ROOT}`));
  console.log(c('dim', `  Global   : ${GLOBAL_DIR}${SYNC_GLOBAL ? ' (active)' : ' (skipped — use --with-global)'}\n`));

  if (!existsSync(SOT_DIR)) {
    console.error(c('red', `ERROR: Source of truth dir not found: ${SOT_DIR}`));
    process.exit(1);
  }

  const stats = {
    mirror: { created: 0, updated: 0, unchanged: 0 },
    paperclip: { created: 0, updated: 0, unchanged: 0 },
    global: { created: 0, updated: 0, unchanged: 0 },
  };
  const missingSources = [];

  for (const [prefix, role] of Object.entries(ROLE_MAP)) {
    const srcPath = join(SOT_DIR, `${prefix}.md`);
    if (!existsSync(srcPath)) {
      missingSources.push(srcPath);
      console.log(`${c('red', '[ MISSING ]')} ${prefix}.md (source not found, skipped)`);
      continue;
    }
    const raw = readFileSync(srcPath, 'utf8');

    // 1) Mirror — byte-identical copy
    const mirrorPath = join(MIRROR_DIR, `${prefix}.md`);
    const mirrorStatus = syncFile(mirrorPath, raw);
    stats.mirror[mirrorStatus]++;
    console.log(
      `${statusLabel(mirrorStatus)} mirror/${prefix}.md`
    );

    // 2) Paperclip — body only
    let body;
    try {
      body = stripFrontmatter(raw);
    } catch (err) {
      console.error(c('red', `  ERROR stripping frontmatter from ${prefix}.md: ${err.message}`));
      process.exit(1);
    }
    const paperclipPath = join(PAPERCLIP_AGENTS_ROOT, role, 'AGENTS.md');
    const paperclipStatus = syncFile(paperclipPath, body);
    stats.paperclip[paperclipStatus]++;
    console.log(
      `${statusLabel(paperclipStatus)} paperclip/${role}/AGENTS.md`
    );

    // 3) Global ~/.claude/agents/ — Claude Code subagent system이 스캔하는 위치
    //    --with-global 플래그 또는 BARROTUBE_SYNC_GLOBAL=1 시에만 활성.
    if (SYNC_GLOBAL) {
      const globalPath = join(GLOBAL_DIR, `${prefix}.md`);
      const globalStatus = syncFile(globalPath, raw);
      stats.global[globalStatus]++;
      console.log(
        `${statusLabel(globalStatus)} global ~/.claude/agents/${prefix}.md`
      );
    }
  }

  // ---- Summary -------------------------------------------------------------
  console.log('');
  console.log(c('bold', '--- Summary ---'));
  const fmt = (label, s) =>
    `  ${label.padEnd(11)} created=${s.created} updated=${s.updated} unchanged=${s.unchanged}`;
  console.log(fmt('mirror', stats.mirror));
  console.log(fmt('paperclip', stats.paperclip));
  if (SYNC_GLOBAL) console.log(fmt('global', stats.global));

  const totalChanges =
    stats.mirror.created +
    stats.mirror.updated +
    stats.paperclip.created +
    stats.paperclip.updated +
    stats.global.created +
    stats.global.updated;

  if (missingSources.length > 0) {
    console.log(c('red', `\n  ${missingSources.length} source file(s) missing — see above.`));
  }

  if (totalChanges === 0) {
    console.log(c('green', '\n  no changes — all targets are in sync.'));
  } else if (DRY_RUN) {
    console.log(
      c('yellow', `\n  DRY-RUN: ${totalChanges} file(s) would change. Re-run without --dry-run to apply.`)
    );
  } else {
    console.log(c('green', `\n  applied: ${totalChanges} file(s) updated.`));
  }
  console.log('');
}

main();
