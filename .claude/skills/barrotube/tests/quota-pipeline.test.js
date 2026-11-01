import assert from 'node:assert/strict';
import test from 'node:test';
import { runEngineChain } from '../scripts/automation/lib/text-engine.js';
const quiet = { log() {}, warn() {}, error() {} };
const denied = () => { throw new Error('PAPERCLIP_RESERVE_GUARD: admission denied'); };
test('reserve denial skips unbudgeted providers while trying the other subscription', async () => {
  let external = 0;
  const result = await runEngineChain(['claude', 'gemini', 'codex'], {
    claude: denied, gemini: () => { external++; }, codex: () => ({ used: 'codex', json: '{}' }),
  }, quiet);
  assert.equal(external, 0); assert.equal(result.used, 'codex');
});
test('both subscription denials preserve the guard error without a paid fallback', async () => {
  let external = 0;
  await assert.rejects(runEngineChain(['claude', 'codex', 'gemini'], {
    claude: denied, codex: denied, gemini: () => { external++; },
  }, quiet), /PAPERCLIP_RESERVE_GUARD/);
  assert.equal(external, 0);
});
test('ordinary failures retain the existing configured engine fallback', async () => {
  const result = await runEngineChain(['claude', 'gemini'], {
    claude: () => { throw new Error('ordinary failure'); }, gemini: () => ({ used: 'gemini', json: '{}' }),
  }, quiet);
  assert.equal(result.used, 'gemini');
});
