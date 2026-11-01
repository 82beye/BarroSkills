import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROUTE, ORIGINAL_COMPARISON, FIXED_COMPARISON, patchedBindingSource, patchBindingOrder } from '../scripts/automation/paperclip/patch-binding-order.js';

const fixtureSource = `
const nextAiBinding = aiConnectionBindingSchema.safeParse(requestedRuntimeConfig?.aiConnection ?? existing.runtimeConfig.aiConnection).data;
if (nextAiBinding) {
  ${ORIGINAL_COMPARISON}
  if (!isAiConnectionCompatible(nextAiBinding, requestedAdapterType)) throw new Error('incompatible');
  if (changed) await validateManagedAgentBinding(req, existing.companyId, existing.id, requestedAdapterType, aiConfig, nextAiBinding);
}
`;

test('patch is exactly one comparison change and keeps real binding validation', () => {
  const result = patchedBindingSource(fixtureSource);
  assert.equal(result.changed, true);
  assert.equal(result.source, fixtureSource.replace(ORIGINAL_COMPARISON, FIXED_COMPARISON));
  assert.equal(patchedBindingSource(result.source).changed, false);
  assert.throws(() => patchedBindingSource(fixtureSource + ORIGINAL_COMPARISON), /Unknown/);
  assert.throws(() => patchedBindingSource('unrecognized upstream implementation'), /Unknown/);
  assert.throws(() => patchedBindingSource(FIXED_COMPARISON), /Unknown/);
});

test('file patch backs up exact original bytes, is idempotent, and rejects unknown source without mutation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'paperclip-binding-patch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const routePath = join(dir, 'agents.js');
  const backupDir = join(dir, 'backups');
  writeFileSync(routePath, fixtureSource);
  const applied = patchBindingOrder({ routePath, backupDir });
  assert.equal(applied.changed, true);
  assert.equal(readFileSync(applied.backupPath, 'utf8'), fixtureSource);
  assert.equal(readFileSync(routePath, 'utf8'), patchedBindingSource(fixtureSource).source);
  assert.equal(patchBindingOrder({ routePath, backupDir }).changed, false);
  assert.equal(readdirSync(backupDir).length, 1);
  const unknown = join(dir, 'unknown.js');
  writeFileSync(unknown, 'new upstream implementation');
  assert.throws(() => patchBindingOrder({ routePath: unknown, backupDir }), /Unknown/);
  assert.equal(readFileSync(unknown, 'utf8'), 'new upstream implementation');
});

const schemaPath = join(dirname(DEFAULT_ROUTE), '../../../shared/dist/ai-connections.js');
test('installed Zod schema reproduces key-order bug while corrected comparison detects real account changes', { skip: !existsSync(schemaPath) }, async () => {
  const { aiConnectionBindingSchema } = await import(pathToFileURL(schemaPath).href);
  const dbBinding = { mode: 'responsible_user', method: 'subscription', provider: 'anthropic' };
  const parsed = aiConnectionBindingSchema.parse(dbBinding);
  const changed = new Function('nextAiBinding', 'existing', 'aiConnectionBindingSchema', `${FIXED_COMPARISON}\nreturn changed;`);
  assert.notEqual(JSON.stringify(parsed), JSON.stringify(dbBinding));
  assert.equal(changed(parsed, { runtimeConfig: { aiConnection: dbBinding } }, aiConnectionBindingSchema), false);
  for (const update of [{ provider: 'openai' }, { method: 'api_key' }]) {
    assert.equal(changed(aiConnectionBindingSchema.parse({ ...dbBinding, ...update }), { runtimeConfig: { aiConnection: dbBinding } }, aiConnectionBindingSchema), true);
  }
  const shared = { mode: 'shared', method: 'subscription', provider: 'anthropic', connectionId: '11111111-1111-4111-8111-111111111111', grantId: '22222222-2222-4222-8222-222222222222' };
  assert.equal(changed(aiConnectionBindingSchema.parse(shared), { runtimeConfig: { aiConnection: shared } }, aiConnectionBindingSchema), false);
  for (const update of [{ connectionId: '33333333-3333-4333-8333-333333333333' }, { grantId: '33333333-3333-4333-8333-333333333333' }, { mode: 'delegated' }]) {
    assert.equal(changed(aiConnectionBindingSchema.parse({ ...shared, ...update }), { runtimeConfig: { aiConnection: shared } }, aiConnectionBindingSchema), true);
  }
  assert.equal(changed(parsed, { runtimeConfig: {} }, aiConnectionBindingSchema), true);
});
