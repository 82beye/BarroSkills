/**
 * cost-tracker.js — BarroTube role-level cost ledger
 *
 * Created 2026-04-27 to close gap discovered after EP-2026-0028 production:
 * budget-report.js read from logs/budget/usage-YYYY-MM.json but no script wrote there.
 * As a result, all roles showed $0 even after Gemini image (7+1+1) + ElevenLabs TTS (7) calls.
 *
 * Design goals:
 *  - Append-only monthly JSON ledger at logs/budget/usage-YYYY-MM.json
 *  - Best-effort: if cost calc fails or write fails, log warning + return — never throw
 *  - Per-call audit log line at logs/budget/calls-YYYY-MM.jsonl (debug + reconciliation)
 *  - Compatible with existing budget-report.js read shape:
 *      { roleId: { total_usd: number, calls: number } }
 *
 * Pricing constants are intentionally embedded here (rather than in budget-policy.json)
 * so we have a single source of truth and can update without ops file changes.
 *
 * Usage:
 *   import { recordCost } from './lib/cost-tracker.js';
 *   recordCost('image-generator', { model: 'gemini-3.1-flash-image-preview', images: 1, episode: 'EP-2026-0028' });
 *   recordCost('voice-engineer', { model: 'eleven_multilingual_v2', characters: 250, episode: 'EP-2026-0028' });
 *   recordCost('metadata-writer', { model: 'gemini-2.5-flash', input_tokens: 2000, output_tokens: 800, episode: 'EP-2026-0028' });
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const BUDGET_DIR = join(ROOT, 'logs/budget');

// USD pricing (rough, conservative — overstate slightly to protect budgets).
// Update when vendor pricing changes; record version in PRICING_VERSION.
export const PRICING = {
  // Gemini image generation — Nano Banana 2 family
  // Reference: $0.039 per image @ 1K, $0.078 @ 2K (rough). We use 1K.
  'gemini-3.1-flash-image-preview': { kind: 'image', usd_per_image: 0.04 },
  'gemini-image-default':           { kind: 'image', usd_per_image: 0.04 },

  // Gemini text — gemini-2.5-flash
  // Input ~$0.30/1M tok, Output ~$2.50/1M tok (conservative).
  'gemini-2.5-flash':               { kind: 'text', usd_per_input_1m: 0.30, usd_per_output_1m: 2.50 },
  'gemini-2.5-pro':                 { kind: 'text', usd_per_input_1m: 1.25, usd_per_output_1m: 10.0 },

  // ElevenLabs TTS — Multilingual v2
  // Roughly $0.30 per 1000 characters (Creator tier blended). Use 0.00030 / char.
  'eleven_multilingual_v2':         { kind: 'tts', usd_per_char: 0.00030 },
  'eleven_default':                 { kind: 'tts', usd_per_char: 0.00030 },
};

export const PRICING_VERSION = '2026-04-27';

/**
 * Compute USD cost for a given call. Returns 0 on unknown model (logged warning).
 *
 * @param {object} params
 * @param {string} params.model
 * @param {number} [params.images]          for image kind
 * @param {number} [params.characters]      for tts kind
 * @param {number} [params.input_tokens]    for text kind
 * @param {number} [params.output_tokens]   for text kind
 * @returns {number} usd
 */
export function computeCostUsd(params) {
  const { model } = params;
  if (!model) return 0;
  const p = PRICING[model] || PRICING[`${model.split('-')[0]}-default`];
  if (!p) {
    return 0;
  }
  if (p.kind === 'image') {
    return (Number(params.images) || 0) * p.usd_per_image;
  }
  if (p.kind === 'tts') {
    return (Number(params.characters) || 0) * p.usd_per_char;
  }
  if (p.kind === 'text') {
    const inU = (Number(params.input_tokens) || 0) * p.usd_per_input_1m / 1_000_000;
    const outU = (Number(params.output_tokens) || 0) * p.usd_per_output_1m / 1_000_000;
    return inU + outU;
  }
  return 0;
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readLedger(usagePath) {
  if (!existsSync(usagePath)) return {};
  try {
    return JSON.parse(readFileSync(usagePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Best-effort role-level cost record.
 *
 * Never throws. On any failure, prints a warning to stderr and returns silently —
 * production scripts must not fail because the cost ledger had a permission error.
 *
 * @param {string} role  — one of the roles in budget-policy.json (e.g. 'image-generator', 'voice-engineer', 'metadata-writer')
 * @param {object} call  — call metadata
 * @param {string} call.model
 * @param {number} [call.images]
 * @param {number} [call.characters]
 * @param {number} [call.input_tokens]
 * @param {number} [call.output_tokens]
 * @param {string} [call.episode]   — EP id for audit
 * @param {string} [call.stage]     — pipeline stage (S6c/S6d/...)
 * @param {string} [call.note]      — free text
 * @param {number} [call.usd]       — explicit override; if provided, skips computeCostUsd
 * @returns {{usd: number, role: string, model: string} | null}
 */
export function recordCost(role, call = {}) {
  try {
    const usd = typeof call.usd === 'number' && !Number.isNaN(call.usd)
      ? call.usd
      : computeCostUsd(call);

    if (!Number.isFinite(usd) || usd < 0) {
      return null;
    }

    const month = monthKey();
    ensureDir(BUDGET_DIR);
    const usagePath = join(BUDGET_DIR, `usage-${month}.json`);
    const ledger = readLedger(usagePath);

    const slot = ledger[role] || { total_usd: 0, calls: 0 };
    slot.total_usd = Math.round((slot.total_usd + usd) * 1_000_000) / 1_000_000;
    slot.calls = (slot.calls || 0) + 1;
    slot.last_at = new Date().toISOString();
    slot.last_model = call.model || slot.last_model || null;
    ledger[role] = slot;

    writeFileSync(usagePath, JSON.stringify(ledger, null, 2), 'utf-8');

    // Per-call audit jsonl
    const callsPath = join(BUDGET_DIR, `calls-${month}.jsonl`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      role,
      model: call.model || null,
      usd,
      episode: call.episode || null,
      stage: call.stage || null,
      images: call.images,
      characters: call.characters,
      input_tokens: call.input_tokens,
      output_tokens: call.output_tokens,
      note: call.note || null,
      pricing_version: PRICING_VERSION,
    }) + '\n';
    appendFileSync(callsPath, line, 'utf-8');

    return { usd, role, model: call.model || null };
  } catch (e) {
    try { console.warn(`  ⚠ cost-tracker: ${e.message}`); } catch {}
    return null;
  }
}

/**
 * Inspect current month ledger (read-only). Useful for tests + reconciliation.
 */
export function getCurrentLedger() {
  const month = monthKey();
  const usagePath = join(BUDGET_DIR, `usage-${month}.json`);
  return readLedger(usagePath);
}
