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

test('config/motion-engines.json — Wan 이 order 0 · 기본값이다', () => {
  // 2026-09-02 4엔진을 같은 씬으로 실측한 결과다. 배경이 살아있는가(상단 40% 프레임간
  // 움직임)와 구도를 지키는가(끝/첫 얼굴면적) 두 축을 모두 만족한 건 Wan 뿐이었다:
  //   Wan 1.689/1.01 · Grok 1.647/1.22 · LTX 1.321/0.74 · HyperFrames 0.439/1.18
  // 순서를 바꾸려면 그 측정을 다시 하고 근거를 config 의 note 에 남길 것.
  const cfg = JSON.parse(read('config/motion-engines.json'));
  assert.equal(cfg.default, 'wan');
  const byOrder = Object.fromEntries(cfg.options.map((o) => [o.order, o.id]));
  assert.equal(byOrder[0], 'wan');
  const wan = cfg.options.find((o) => o.id === 'wan');
  assert.equal(wan.browser_required, false, 'Wan 은 헤드리스여야 기본값일 자격이 있다');
  const grok = cfg.options.find((o) => o.id === 'grok');
  assert.equal(grok.browser_required, true);
  // LTX 는 규격이 우월한데도 밀렸다 — 그 이유가 config 에 남아 있어야 재논의를 막는다
  const ltx = cfg.options.find((o) => o.id === 'ltx');
  assert.ok(ltx, 'LTX 는 옵션으로 남아 있어야 한다');
  assert.match(ltx.limitation ?? '', /축소|스케일/, 'LTX 의 스케일 드리프트 근거를 기록할 것');
  // id 는 코드가 문자열로 비교한다 — 중복되면 분기가 갈린다
  const ids = cfg.options.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  // order 도 유일해야 한다 — 같은 순번이 둘이면 '옵션 N' 이 뭘 가리키는지 모른다
  const orders = cfg.options.map((o) => o.order);
  assert.equal(new Set(orders).size, orders.length);
});

test('Wan 기본 길이는 4초다 — 5초는 얼굴 결함이 늘었다', () => {
  // 실측: 4초는 재시도 2회에 결함 0, 5초는 3회를 태워도 3~5개가 남았다(2회 반복 확인).
  // 슬로모션(1.63~2.83배)이 짧은 얼굴 붕괴보다 낫다는 판단이다.
  const lib = read('scripts/automation/lib/wan-hf.js');
  assert.match(lib, /DEFAULT_DURATION = 4/);
  assert.match(lib, /MAX_DURATION = 5/);
  const gen = read('scripts/automation/generate-motion-wan.js');
  assert.match(gen, /wan\.DEFAULT_DURATION/, '에피소드 경로가 기본 길이를 써야 한다');
});

test('QA 시트 밀도는 조정 가능하고 기본이 60타일이다', () => {
  // 24타일 131초 vs 60타일 26초, 검출 결함 수 동일. 에피소드당 QA 40분 → 8분.
  const qa = read('scripts/automation/qa-motion-frames.js');
  assert.match(qa, /BT_QA_PER_SHEET\) \|\| 60/);
  assert.match(qa, /BT_QA_SHEET_COLS\) \|\| 10/);
});

test('비전 판정기 호출은 재시도한다 — 단발 플레이크가 크론을 세우면 안 된다', () => {
  // 2026-09-02 5씬 검증에서 마지막 씬의 시트 하나가 CLI 실패로 죽어, 클립은 멀쩡한데
  // 전체가 '검사 불가'로 중단됐다. 판정 실패를 통과로 오해하는 건 여전히 금지다.
  const qa = read('scripts/automation/qa-motion-frames.js');
  assert.match(qa, /tries = 3/);
  assert.match(qa, /비전 판정 재시도/);
});

test('QA 는 얼굴을 못 찾아도 기권하지 않고 직전 ROI 로 판정한다', () => {
  // findHeadRoi 는 '눈 2개'로 얼굴을 찾는데, 피처가 지워진 프레임엔 눈이 없다 —
  // 그게 바로 잡으려는 결함이다. null 을 돌리면 결함이 많을수록 '검사 불가'로
  // 빠져나가는 구멍이 된다 (2026-09-02: 5초 클립이 ROI 미검출 26% 로 통째로 기권).
  const qa = read('scripts/automation/qa-motion-frames.js');
  assert.match(qa, /fallbackRoi/);
  assert.match(qa, /roiCarried/);
  assert.match(qa, /let lastRoi = ref\.roi/);
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

test('Phase 7 브라우저 작업은 image-engines.json 이 정한다 — 설정과 어긋나면 화풍이 섞인다', () => {
  // 2026-08-20 에 씬·인트로·썸네일을 전부 codex 로 옮겼는데 Phase 7 프롬프트가 안 따라와서,
  // 시드 대화가 깨져 있던 동안에만 우연히 조용했다. 2026-09-02 재시드로 브라우저가 되살아나자
  // EP-0133 에서 앞 2컷을 가로채 한 편 안에 두 화풍이 섞였다(브라우저 1080×1920 · codex 941×1672).
  const auto = read('lib/auto-pipeline.sh');
  assert.match(auto, /image-engines\.json/, 'Phase 7 이 이미지 엔진 설정을 읽어야 한다');
  for (const v of ['BROWSER_SCENES', 'BROWSER_INTRO', 'BROWSER_THUMB', 'BROWSER_MOTION', 'BROWSER_WORK']) {
    assert.ok(auto.includes(v), `${v} 게이트가 있어야 한다`);
  }
  // 브라우저가 만들 게 없으면 아예 열지 않는다 — 열면 같은 자산을 다른 화풍으로 덮어쓴다
  assert.match(auto, /BROWSER_WORK" = "0"/);
  // 씬 이미지 요청은 media-render 로 지정했을 때만 성립한다
  assert.match(auto, /scene_engine" = "media-render"/);
});
