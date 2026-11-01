#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

const routeSuffix = 'lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/routes/agents.js';
const routeCandidates = [
  resolve(dirname(process.execPath), '..', routeSuffix),
  join(userInfo().homedir, '.nvm/versions/node/v24.11.1', routeSuffix),
];
export const DEFAULT_ROUTE = routeCandidates.find(existsSync) ?? routeCandidates[0];
export const ORIGINAL_COMPARISON = 'const changed = JSON.stringify(nextAiBinding) !== JSON.stringify(existing.runtimeConfig.aiConnection);';
export const FIXED_COMPARISON = 'const changed = JSON.stringify(nextAiBinding) !== JSON.stringify(aiConnectionBindingSchema.safeParse(existing.runtimeConfig.aiConnection).data);';
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** Compare two Zod-normalized bindings; preserve compatibility and changed-binding validation. */
export function patchedBindingSource(source) {
  const originals = source.split(ORIGINAL_COMPARISON).length - 1;
  const patched = source.split(FIXED_COMPARISON).length - 1;
  if (!source.includes('const nextAiBinding = aiConnectionBindingSchema.safeParse(')
      || !source.includes('await validateManagedAgentBinding(req, existing.companyId, existing.id,')) {
    throw new Error('Unknown native binding comparison format; no files were changed');
  }
  if (originals === 0 && patched === 1) return { changed: false, source };
  if (originals !== 1 || patched !== 0) throw new Error('Unknown native binding comparison format; no files were changed');
  return { changed: true, source: source.replace(ORIGINAL_COMPARISON, FIXED_COMPARISON) };
}

/** Apply on disk only. The currently running server is never signalled or restarted. */
export function patchBindingOrder({ routePath = DEFAULT_ROUTE, backupDir = join(userInfo().homedir, '.paperclip/instances/default/backups/binding-order') } = {}) {
  const before = readFileSync(routePath, 'utf8');
  const result = patchedBindingSource(before);
  const beforeHash = sha256(before);
  if (!result.changed) return { changed: false, routePath, sha256: beforeHash, restartRequiredForLoadedServer: true };
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `agents.${beforeHash}.before.js`);
  if (existsSync(backupPath)) {
    if (sha256(readFileSync(backupPath, 'utf8')) !== beforeHash) throw new Error('Native backup content mismatch; no target change made');
  } else writeFileSync(backupPath, before, { flag: 'wx', mode: 0o600 });
  const mode = statSync(routePath).mode & 0o777;
  const temporary = `${routePath}.binding-order.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, result.source, { flag: 'wx', mode });
    if (readFileSync(routePath, 'utf8') !== before) throw new Error('Native route changed concurrently; no target change made');
    renameSync(temporary, routePath);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { changed: true, routePath, backupPath, beforeSha256: beforeHash, afterSha256: sha256(result.source), restartRequiredForLoadedServer: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    while (args.length) {
      const key = args.shift();
      if (!['--target', '--backup-dir'].includes(key) || !args[0]) throw new Error('Usage: patch-binding-order.js [--target agents.js] [--backup-dir directory]');
      options[key === '--target' ? 'routePath' : 'backupDir'] = resolve(args.shift());
    }
    console.log(JSON.stringify(patchBindingOrder(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
