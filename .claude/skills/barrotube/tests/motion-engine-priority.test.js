// 모션 엔진 우선순위 계약 — Wan(옵션0, 기본) · Grok(옵션1) · local-only(폴백).
// 2026-09-02 뒤집었다. 어느 한 곳만 되돌아가면 호출 경로에 따라 다른 엔진으로 구워진다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('config/motion-engines.json — Wan 이 order 0 · 기본값이고 Grok 이 order 1', () => {
  const cfg = JSON.parse(read('config/motion-engines.json'));
  assert.equal(cfg.default, 'wan');
  const byOrder = Object.fromEntries(cfg.options.map((o) => [o.order, o.id]));
  assert.equal(byOrder[0], 'wan');
  assert.equal(byOrder[1], 'grok');
  const wan = cfg.options.find((o) => o.id === 'wan');
  assert.equal(wan.browser_required, false, 'Wan 은 헤드리스여야 기본값일 자격이 있다');
  const grok = cfg.options.find((o) => o.id === 'grok');
  assert.equal(grok.browser_required, true);
  // id 는 코드가 문자열로 비교한다 — 중복되면 분기가 갈린다
  const ids = cfg.options.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('셸과 JS 의 기본값이 같다 — 어긋나면 같은 EP 도 호출 경로에 따라 다른 엔진으로 구워진다', () => {
  const auto = read('lib/auto-pipeline.sh');
  const produce = read('scripts/automation/produce-episode.js');
  assert.match(auto, /MOTION_ENGINE="\$\{BT_MOTION_ENGINE:-wan\}"/);
  assert.match(auto, /local motion_engine="\$\{BT_MOTION_ENGINE:-wan\}"/);
  assert.match(produce, /process\.env\.BT_MOTION_ENGINE \|\| 'wan'/);
});

test('produce-episode S6c — wan 은 QA 루프 스크립트로, grok/local 은 각자 스크립트로 간다', () => {
  const s = read('scripts/automation/produce-episode.js');
  assert.match(s, /useWanMotion[\s\S]{0,400}generate-motion-wan\.js/, 'wan → generate-motion-wan.js');
  assert.match(s, /useLocalMotion[\s\S]{0,400}generate-motion\.js/, 'local-only → generate-motion.js');
  assert.match(s, /grok-motion\.js/, 'grok 경로는 남아 있어야 한다');
  // 시도 횟수를 운영자가 올릴 수 있어야 한다 — 결함이 잦은 씬은 3회로 안 끝난다
  assert.match(s, /BT_WAN_ATTEMPTS/);
});

test('브라우저는 grok 을 명시했을 때만 클립을 요구한다', () => {
  const auto = read('lib/auto-pipeline.sh');
  // media_assets_ready 의 클립 검사 건너뛰기 조건
  assert.match(auto, /\$motion_engine" != "grok"/,
    'grok 이 아니면 브라우저 게이트에서 클립을 요구하면 안 된다 (Phase 8 이 만든다)');
  // Grok 실행·halt 게이트
  const grokGates = auto.split('\n').filter((l) => /\$MOTION_ENGINE" = "grok"/.test(l));
  assert.ok(grokGates.length >= 3, `grok 전용 분기가 좁혀져 있어야 한다 (found ${grokGates.length})`);
});

test('조용한 폴백 경보는 정본 엔진 두 개(wan·grok) 모두에서 울린다', () => {
  const auto = read('lib/auto-pipeline.sh');
  const guard = auto.indexOf('"$MOTION_ENGINE" = "grok" ] || [ "$MOTION_ENGINE" = "wan"');
  const notify = auto.indexOf('motion_fallback_shipped');
  assert.ok(guard > 0, 'wan 으로 돌린 회차가 hyperframes 로 대체돼도 사람에게 알려야 한다');
  assert.ok(guard < notify);
});

test('generate-motion-wan.js — 에피소드 모드·매니페스트·QA 게이트를 갖춘다', () => {
  const s = read('scripts/automation/generate-motion-wan.js');
  assert.match(s, /--episode/);
  assert.match(s, /ENGINE_MANIFEST/, 'QA 보고서·폴백 감지가 읽을 매니페스트를 남겨야 한다');
  assert.match(s, /engine: 'wan2\.2-hf'/);
  assert.match(s, /qa-motion-frames\.js|QA\b/, 'QA 를 거치지 않고 채택하면 안 된다');
  // 검사 불가는 재시도하지 않는다 — 같은 이유로 실패하며 쿼터만 태운다
  assert.match(s, /uninspectable/);
  const cli = spawnSync('node', [join(ROOT, 'scripts/automation/generate-motion-wan.js')], { encoding: 'utf8' });
  assert.equal(cli.status, 2, '인자 없이 부르면 사용법과 함께 exit 2');
  assert.match(cli.stderr, /--episode/);
});

test('SKILL.md·MOTION.md 가 바뀐 기본값을 반영한다', () => {
  const skill = read('SKILL.md');
  const motion = read('references/MOTION.md');
  const both = `${skill}\n${motion}`;
  assert.match(both, /Wan 2\.2/, '문서가 새 정본 엔진을 설명해야 한다');
  assert.match(both, /BT_MOTION_ENGINE=grok/, 'Grok 을 옵션 1 로 쓰는 법이 적혀 있어야 한다');
});

test('Wan 이 통째로 실패하면 로컬 폴백으로 파이프라인을 살리고 경보를 남긴다', () => {
  // 익명 ZeroGPU 쿼터는 시간당 수 회에서 마른다 (2026-09-02 실측). 무인 회차가 클립 0개로
  // 렌더까지 못 가면 그날 발행이 통째로 빈다 — 폴백은 살리되 조용하면 안 된다.
  const s = read('scripts/automation/produce-episode.js');
  assert.match(s, /useWanMotion && !motionExists\(\)/, 'Wan 이 아무것도 못 구웠을 때만 폴백한다');
  assert.match(s, /HyperFrames 폴백/);
  const auto = read('lib/auto-pipeline.sh');
  assert.match(auto, /motion_fallback_shipped/, '폴백 사실이 경보로 사람에게 도착해야 한다');
});

test('쿼터 소진 오류가 원인을 말한다 — "Space 오류: null" 로 흘리지 않는다', () => {
  const s = read('scripts/automation/lib/wan-hf.js');
  assert.match(s, /ZeroGPU 쿼터 소진/);
  assert.match(s, /HF_TOKEN/);
});
