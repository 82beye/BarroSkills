import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseYAML, stringify } from 'yaml';
import {
  caricatureDescriptor, ensureCaricature, insertCaricatureClause, planCaricatureFix,
} from '../scripts/automation/lib/ensure-caricature.js';
import { loadAllowlist } from '../scripts/automation/lib/public-figures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HAS_REGISTRY = existsSync(join(ROOT, 'workspace', 'channels', 'econ-daily', 'policies', 'public-figures.md'));
const MASCOT = '[palette:bearish] 마시 the 바로경제 mascot (official character sheet for the character only — large round head), shocked, standing before a single cracked golden bar in the centre, face readable, one white mitten hand points at the bar.';
const prompt = (bg = 'deep navy abstract night sky') => `${MASCOT} BACKGROUND: ${bg}, bold illustrated line art, 9:16 vertical, no readable text or numbers.`;
const scenes = (hook) => [
  { scene_id: '001', role: 'hook', narration: hook, image_prompt: prompt() },
  { scene_id: '002', role: 'context', narration: '은은 육 퍼센트 가까이 빠졌습니다.', image_prompt: prompt('trading floor') },
  { scene_id: '003', role: 'insight', narration: '유가가 올랐고 금리가 뛰었습니다.', image_prompt: prompt('control room') },
];

test('캐리커처 묘사는 등록부 단서로 만들고 이름은 넣지 않는다', () => {
  assert.equal(caricatureDescriptor({
    aliases: ['Kim'], descriptor_short: 'Kim caricature: red hat, round glasses',
    descriptor_en: 'cartoon caricature of Kim as a tall man with red hat',
  }), 'a tall man with red hat, round glasses');
  assert.equal(caricatureDescriptor({ aliases: ['Lee'], descriptor_short: 'older woman with white bob hair (caricature)' }),
    'an older woman with white bob hair', '관사는 모음에 맞춘다');
  assert.equal(caricatureDescriptor({ aliases: ['Park'], descriptor_short: 'Park in a grey suit' }), null,
    '이름이 남으면 이미지 모델이 실명 요청으로 거절할 수 있다');
});

test('등록부 인물 전원이 이름 없는 묘사로 바뀐다', { skip: !HAS_REGISTRY && '워크스페이스 등록부 없음' }, () => {
  const { figures } = loadAllowlist('econ-daily');
  for (const f of figures.filter((x) => x.treatment === 'CHARACTERIZE')) {
    const d = caricatureDescriptor(f);
    assert.ok(d, `${f.id}: 묘사를 만들지 못했다`);
    for (const a of (f.aliases || []).filter((n) => /[a-z]/i.test(n))) {
      assert.ok(!d.toLowerCase().includes(String(a).toLowerCase()), `${f.id}: 이름(${a})이 남았다`);
    }
  }
  const trump = caricatureDescriptor(figures.find((f) => f.id === 'trump'));
  assert.match(trump, /^an older man with bouffant orange hair/);
  assert.match(trump, /red tie/);
});

test('캐리커처 절은 BACKGROUND 앞에, 씬의 중심 오브젝트 옆으로 넣는다', () => {
  const out = insertCaricatureClause(prompt(), 'an older man with a red tie');
  assert.match(out, /points at the bar\. WITH: a flat cartoon caricature of an older man with a red tie, same line-art style, similar scale, standing beside the bar\. BACKGROUND:/);
  assert.equal(insertCaricatureClause(out, 'x'), null, '이미 있으면 두 번 넣지 않는다');
  assert.equal(insertCaricatureClause('no background here', 'x'), null);
});

test('QA 와 같은 판정으로, 인물이 불린 씬에 캐리커처를 넣는다', { skip: !HAS_REGISTRY && '워크스페이스 등록부 없음' }, () => {
  // 2026-09-29 EP-2026-0193 재현: 토픽엔 없고 훅이 트럼프를 부른다.
  const briefFM = { topic: '위기 때 오른다던 금과 은이 하루 만에 급락했다' };
  const plan = planCaricatureFix({ briefFM, scriptFM: { scenes: scenes('어젯밤 트럼프 대통령이 이란의 재개안을 거부했는데 금이 빠졌습니다.') }, format: 'shorts' });
  assert.equal(plan.needed, true);
  assert.deepEqual(plan.changes.map((c) => [c.sceneId, c.figureId]), [['001', 'trump']]);
  assert.equal(plan.resolved, true, '보강 뒤에는 QA 판정이 풀려야 한다');
  assert.ok(!/trump/i.test(plan.scenes[0].image_prompt), '프롬프트에 실명을 넣지 않는다');

  const none = planCaricatureFix({ briefFM, scriptFM: { scenes: scenes('안전자산이라던 금이 사 퍼센트 넘게 빠졌습니다.') }, format: 'shorts' });
  assert.equal(none.needed, false, '인물이 없으면 손대지 않는다');
});

test('이미 구운 씬이면 스틸·클립을 치워 다시 굽게 한다', { skip: !HAS_REGISTRY && '워크스페이스 등록부 없음' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-caricature-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'platforms', 'shorts');
  mkdirSync(join(base, '40_assets', 'images'), { recursive: true });
  mkdirSync(join(base, '40_assets', 'videos'), { recursive: true });
  writeFileSync(join(dir, '00_brief.md'), '---\ntopic: "금과 은이 급락했다"\n---\n');
  const fm = { channel_id: 'econ-daily', format: 'shorts', revision: 3, scenes: scenes('어젯밤 트럼프 대통령이 재개안을 거부했습니다.') };
  writeFileSync(join(base, '30_script.md'), `---\n${stringify(fm)}---\n\n# body\n`);
  for (const id of ['001', '002']) {
    writeFileSync(join(base, '40_assets', 'images', `scene_${id}.png`), `png-${id}`);
    writeFileSync(join(base, '40_assets', 'videos', `scene_${id}.mp4`), `mp4-${id}`);
  }

  const r = ensureCaricature({ epDir: dir, platform: 'shorts' });
  assert.equal(r.resolved, true);
  const after = parseYAML(readFileSync(join(base, '30_script.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.match(after.scenes[0].image_prompt, /cartoon caricature/);
  assert.equal(after.revision, 3, '팩트체크 판본은 건드리지 않는다');
  assert.ok(readFileSync(join(base, '30_script.md'), 'utf8').includes('# body'), '본문은 그대로');
  assert.ok(!existsSync(join(base, '40_assets', 'images', 'scene_001.png')), '바뀐 씬의 옛 스틸은 치운다');
  assert.ok(existsSync(join(base, '40_assets', 'images', 'scene_001.pre-caricature.png')));
  assert.ok(!existsSync(join(base, '40_assets', 'videos', 'scene_001.mp4')));
  assert.ok(existsSync(join(base, '40_assets', 'images', 'scene_002.png')), '다른 씬은 그대로');

  assert.equal(ensureCaricature({ epDir: dir, platform: 'shorts' }).needed, false, '두 번째는 할 일이 없다');
});

test('파이프라인은 팩트체크 뒤·이미지 전에, 제작 스크립트는 S6c 전에 보강한다', () => {
  const auto = readFileSync(join(ROOT, 'lib', 'auto-pipeline.sh'), 'utf8');
  const fc = auto.indexOf('auto_pipeline_factcheck_recovered');
  const fix = auto.indexOf('node scripts/automation/ensure-caricature.js');
  const phase7 = auto.indexOf('MOTION_ENGINE="${BT_MOTION_ENGINE:-grok}"');
  assert.ok(fc > 0 && fc < fix && fix < phase7, '최종 대본에, 브라우저가 스틸을 굽기 전에 돌아야 한다');

  const produce = readFileSync(join(ROOT, 'scripts', 'automation', 'produce-episode.js'), 'utf8');
  assert.ok(produce.indexOf('ensureCaricature({') < produce.indexOf('// S6c Images'), 'S6c 이미지 전에 돌아야 한다');
});
