import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildIndex,
  buildVectorizer,
  cosine,
  pickReuseSet,
  readTargetScenes,
  tokenize,
  isCurrentEra,
  hasCaricature,
  palettesConflict,
  DEFAULT_POLICY,
} from '../scripts/automation/lib/scene-asset-index.js';
import { isRealMotionClip } from '../scripts/automation/reuse-scene-assets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = join(ROOT, 'lib', 'auto-pipeline.sh');
const DOCTOR = join(ROOT, 'lib', 'doctor-cli.sh');
const DAY = 86400000;
const NOW = Date.parse('2026-09-22T02:00:00Z');

/**
 * 실제 image_prompt 의 골격(EP-2026-0171 s001, 751자 기준). 객체·배경만 갈리고 나머지는
 * 모든 컷이 공유하는 보일러플레이트다 — IDF 가 그걸 스스로 걸러내는지도 같이 검증한다.
 *
 * 길이는 image-prompt-contract.js 의 BOUNDS.minChars(640) 를 넘겨야 한다. 재사용은
 * 현행 화풍 컷만 후보로 보므로, 짧게 만들면 합성 후보가 전부 구세대로 판정돼 버린다.
 */
function prompt(palette, object, background) {
  const p = `[palette:${palette}] 마시 the 바로경제 mascot (official character sheet for the `
    + `character only — large round head on a slim capsule body with thin stick limbs, white `
    + `mitten hands and rounded shoe-feet, big solid black eyes with white highlights, orange `
    + `(#FF9A1F) blush cheeks, no nose or ears), alert, standing before a ${object} in the `
    + `centre, face readable, planting its rounded shoe-feet while one white mitten hand grips `
    + `the nearest edge, the unified composition holding the viewer on the central object. `
    + `BACKGROUND: deep navy ${background}, faint grid texture at low contrast, soft rim light `
    + `separating the mascot from the field, bold illustrated line art, 9:16 vertical, `
    + `no readable text or numbers.`;
  assert.ok(p.length >= 640, `합성 프롬프트가 계약 하한 미달이다: ${p.length}자`);
  return p;
}

function makeScript(dir, { episodeId, scenes }) {
  mkdirSync(dir, { recursive: true });
  const body = scenes.map((s) => [
    `  - scene_id: "${s.sceneId}"`,
    `    role: ${s.role}`,
    `    image_prompt: "${s.prompt.replace(/"/g, '\\"')}"`,
  ].join('\n')).join('\n');
  writeFileSync(join(dir, '30_script.md'),
    `---\nepisode_id: ${episodeId}\nchannel_id: econ-daily\nformat: shorts\nscenes:\n${body}\n---\n\n# body\n`);
}

/** 인덱스에 걸리려면 실제 파일이 있어야 한다. 내용은 바이트가 서로 달라야 한다. */
function placeAssets(dir, sceneIds, { ageDays = 60, withVideo = false, engine = null } = {}) {
  const images = join(dir, '40_assets', 'images');
  const videos = join(dir, '40_assets', 'videos');
  mkdirSync(images, { recursive: true });
  mkdirSync(videos, { recursive: true });
  const engines = {};
  for (const id of sceneIds) {
    const img = join(images, `scene_${id}.png`);
    writeFileSync(img, `png-${dir}-${id}`);
    const t = (NOW - ageDays * DAY) / 1000;
    utimesSync(img, t, t);
    if (withVideo) {
      writeFileSync(join(videos, `scene_${id}.mp4`), `mp4-${dir}-${id}`);
      if (engine) engines[id] = { engine };
    }
  }
  if (Object.keys(engines).length) {
    writeFileSync(join(videos, '_engines.json'), JSON.stringify(engines));
  }
}

test('IDF 는 모든 컷이 공유하는 보일러플레이트를 스스로 0 으로 만든다', () => {
  const docs = [
    prompt('explainer', 'single balance scale', 'trading floor'),
    prompt('explainer', 'single bar chart', 'market hall'),
    prompt('bullish', 'single microchip', 'circuit skyline'),
  ];
  const vectorize = buildVectorizer(docs);
  const v = vectorize(docs[0]);

  // 세 컷 모두에 있는 단어 = 변별력 0 → 벡터에서 빠진다.
  for (const w of ['mascot', 'capsule', 'mitten', 'navy', 'vertical', 'readable']) {
    assert.equal(v.get(w), undefined, `보일러플레이트 '${w}' 가 벡터에 남았다`);
  }
  // 한 컷에만 있는 변별어는 남는다.
  assert.ok(v.get('balance') > 0, 'balance 가 벡터에서 빠졌다');
  assert.ok(v.get('scale') > 0, 'scale 이 벡터에서 빠졌다');
});

test('토큰화는 palette 태그를 본문에서 제외한다 — 별도 facet 이기 때문', () => {
  assert.ok(!tokenize('[palette:bullish] a single lever').includes('bullish'));
  assert.ok(tokenize('[palette:bullish] a single lever').includes('lever'));
});

test('같은 객체를 가진 컷이 다른 객체보다 높은 점수를 받는다', () => {
  const docs = [
    prompt('explainer', 'single tilted balance scale', 'trading floor'),
    prompt('explainer', 'single steep bar chart', 'market hall'),
    prompt('bullish', 'single glowing microchip', 'circuit skyline'),
  ];
  const query = prompt('explainer', 'single lopsided balance scale', 'abstract floor');
  const vectorize = buildVectorizer([...docs, query]);
  const qv = vectorize(query);
  const scores = docs.map((d) => cosine(qv, vectorize(d)));
  assert.ok(scores[0] > scores[1] && scores[0] > scores[2],
    `저울 컷이 최고점이 아니다: ${JSON.stringify(scores)}`);
});

test('같은 원본 스틸이 두 씬에 배정되지 않는다 — 중복 바이트 게이트가 잡는 사고를 미리 막는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-dup-'));
  try {
    // 후보가 1컷뿐인데 대상은 2씬이다. 하나는 반드시 미배정이어야 한다.
    const src = join(dir, 'EP-2026-0001');
    makeScript(src, {
      episodeId: 'EP-2026-0001',
      scenes: [{ sceneId: '001', role: 'hook', prompt: prompt('explainer', 'single balance scale', 'floor') }],
    });
    placeAssets(src, ['001']);

    const candidates = buildIndex(dir, {});
    assert.equal(candidates.length, 1);

    const scenes = ['001', '002'].map((id) => ({
      sceneId: id, role: 'hook', palette: 'explainer',
      prompt: prompt('explainer', 'single balance scale', 'floor'),
    }));
    const { picks, unmatched } = pickReuseSet({ scenes, candidates, nowMs: NOW });

    assert.equal(picks.length, 1);
    assert.equal(unmatched.length, 1);
    assert.equal(new Set(picks.map((p) => p.source.image)).size, picks.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('한 원본 에피소드에서 max_per_source_episode 를 넘게 가져가지 않는다 — 옛 영상 재방송 방지', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-cap-'));
  try {
    const src = join(dir, 'EP-2026-0001');
    const ids = ['001', '002', '003', '004', '005'];
    makeScript(src, {
      episodeId: 'EP-2026-0001',
      scenes: ids.map((id) => ({ sceneId: id, role: 'hook', prompt: prompt('explainer', `single object ${id}`, 'floor') })),
    });
    placeAssets(src, ids);

    const candidates = buildIndex(dir, {});
    assert.equal(candidates.length, 5);

    const scenes = ids.map((id) => ({
      sceneId: id, role: 'hook', palette: 'explainer',
      prompt: prompt('explainer', `single object ${id}`, 'floor'),
    }));
    const { picks } = pickReuseSet({
      scenes, candidates, nowMs: NOW,
      policy: { max_per_source_episode: 2 },
    });

    assert.equal(picks.length, 2, '상한을 넘겨 배정했다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('min_source_age_days 보다 최근에 구운 컷은 후보에서 빠진다 — 시청자가 알아본다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-age-'));
  try {
    const fresh = join(dir, 'EP-2026-0100');
    makeScript(fresh, {
      episodeId: 'EP-2026-0100',
      scenes: [{ sceneId: '001', role: 'hook', prompt: prompt('explainer', 'single balance scale', 'floor') }],
    });
    placeAssets(fresh, ['001'], { ageDays: 2 });

    const candidates = buildIndex(dir, {});
    assert.equal(candidates.length, 1, '인덱스 자체에는 들어와야 한다');

    const scenes = [{ sceneId: '001', role: 'hook', palette: 'explainer', prompt: prompt('explainer', 'single balance scale', 'floor') }];
    const { picks, unmatched } = pickReuseSet({
      scenes, candidates, nowMs: NOW,
      policy: { min_source_age_days: 10 },
    });
    assert.equal(picks.length, 0);
    assert.deepEqual(unmatched, ['001']);

    // 조건을 풀면 같은 컷이 후보로 돌아온다 — 운영자가 halt 안내대로 풀 수 있어야 한다.
    const loosened = pickReuseSet({
      scenes, candidates, nowMs: NOW,
      policy: { min_source_age_days: 1 },
    });
    assert.equal(loosened.picks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('원장에 쿨다운 기간 내 기록이 있으면 같은 원본을 다시 쓰지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-cool-'));
  try {
    const src = join(dir, 'EP-2026-0001');
    makeScript(src, {
      episodeId: 'EP-2026-0001',
      scenes: [{ sceneId: '001', role: 'hook', prompt: prompt('explainer', 'single balance scale', 'floor') }],
    });
    placeAssets(src, ['001']);
    const candidates = buildIndex(dir, {});
    const scenes = [{ sceneId: '001', role: 'hook', palette: 'explainer', prompt: prompt('explainer', 'single balance scale', 'floor') }];

    const ledger = [{
      source_dir: candidates[0].sceneDir,
      source_scene_id: '001',
      used_at: new Date(NOW - 3 * DAY).toISOString(),
    }];
    const blocked = pickReuseSet({ scenes, candidates, ledger, nowMs: NOW, policy: { cooldown_days: 30 } });
    assert.deepEqual(blocked.unmatched, ['001'], '쿨다운이 걸리지 않았다');

    // 쿨다운이 지난 기록은 막지 않는다.
    const expired = [{ ...ledger[0], used_at: new Date(NOW - 40 * DAY).toISOString() }];
    const allowed = pickReuseSet({ scenes, candidates, ledger: expired, nowMs: NOW, policy: { cooldown_days: 30 } });
    assert.equal(allowed.picks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('min_score 아래면 weak 로 표시하되 배정은 한다 — 멈추지 않는 것이 폴백의 목적', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-weak-'));
  try {
    const src = join(dir, 'EP-2026-0001');
    makeScript(src, {
      episodeId: 'EP-2026-0001',
      scenes: [{ sceneId: '001', role: 'cta', prompt: prompt('bearish', 'single rusty anchor', 'harbour') }],
    });
    placeAssets(src, ['001']);
    const candidates = buildIndex(dir, {});

    const scenes = [{
      sceneId: '001', role: 'hook', palette: 'explainer',
      prompt: prompt('explainer', 'single glowing microchip', 'circuit skyline'),
    }];
    const { picks, unmatched } = pickReuseSet({ scenes, candidates, nowMs: NOW, policy: { min_score: 0.9 } });

    assert.equal(unmatched.length, 0, '점수가 낮다고 미배정으로 돌리면 파이프라인이 선다');
    assert.equal(picks.length, 1);
    assert.equal(picks[0].weak, true, 'weak 표시가 없으면 운영자가 모른다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTargetScenes 는 자산이 없는 에피소드의 씬도 돌려준다', () => {
  // 대상 에피소드는 정의상 자산이 없다. indexScriptDir 과 같은 필터를 쓰면
  // 대상 씬이 전부 버려져 조용히 0컷을 배정한다.
  const dir = mkdtempSync(join(tmpdir(), 'reuse-target-'));
  try {
    makeScript(dir, {
      episodeId: 'EP-2026-9999',
      scenes: [
        { sceneId: '001', role: 'hook', prompt: prompt('explainer', 'single lever', 'floor') },
        { sceneId: '002', role: 'cta', prompt: prompt('bullish', 'single ladder', 'sky') },
      ],
    });
    const scenes = readTargetScenes(join(dir, '30_script.md'));
    assert.equal(scenes.length, 2);
    assert.deepEqual(scenes.map((s) => s.sceneId), ['001', '002']);
    assert.equal(scenes[0].palette, 'explainer');
    assert.equal(scenes[1].role, 'cta');
    // 같은 경로를 인덱스로 읽으면 자산이 없으니 0 이어야 한다.
    assert.equal(buildIndex(dir, {}).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isRealMotionClip 은 _engines.json 의 hyperframes 기록을 거른다', () => {
  // HyperFrames 클립은 스틸에서 로컬로 무과금 재생성이 되므로 복사할 이유가 없다.
  const dir = mkdtempSync(join(tmpdir(), 'reuse-clip-'));
  try {
    const videos = join(dir, '40_assets', 'videos');
    mkdirSync(videos, { recursive: true });
    writeFileSync(join(videos, 'scene_001.mp4'), 'x');
    writeFileSync(join(videos, 'scene_002.mp4'), 'x');
    writeFileSync(join(videos, '_engines.json'), JSON.stringify({
      '001': { engine: 'hyperframes' },
      '002': { engine: 'grok' },
    }));
    assert.equal(isRealMotionClip(join(videos, 'scene_001.mp4')), false);
    assert.equal(isRealMotionClip(join(videos, 'scene_002.mp4')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('파이프라인은 재사용을 생성 폴백 뒤·halt 앞에 둔다', () => {
  const source = readFileSync(AUTO, 'utf8');
  assert.equal(spawnSync('bash', ['-n', AUTO], { encoding: 'utf8' }).status, 0);

  const codex = source.indexOf('codex imagegen 폴백 (브라우저·API 크레딧 불필요)');
  const api = source.indexOf('API 폴백 (gpt-image-1 + 캐릭터 시트)');
  const reuse = source.indexOf('자산 재사용 폴백 (생성 호출 0회)');
  // Phase 7 의 halt 는 7곳이다. 폴백 사슬 끝의 것만 유일하게 $HALT_DETAIL 을 넘긴다.
  const halt = source.indexOf('halt_for_human "Phase 7 media-render" "$HALT_DETAIL"');

  assert.ok(codex > 0 && api > 0 && reuse > 0 && halt > 0, '단계 중 하나가 사라졌다');
  // 순서를 올리면 신선한 컷을 구울 수 있는 날에도 재활용이 나간다.
  assert.ok(codex < api && api < reuse && reuse < halt,
    `폴백 순서가 깨졌다: codex=${codex} api=${api} reuse=${reuse} halt=${halt}`);
});

test('재사용 정책은 config/asset-reuse.json 이 정본이고 코드 기본값과 어긋나지 않는다', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'asset-reuse.json'), 'utf8'));
  for (const [key, fallback] of Object.entries(DEFAULT_POLICY)) {
    assert.ok(key in cfg.policy, `config 에 ${key} 가 없다 — 코드 기본값과 갈라진다`);
    assert.equal(typeof cfg.policy[key], typeof fallback, `${key} 의 타입이 갈라졌다`);
  }
  assert.equal(cfg.enabled, true);
  // 가드는 기본으로 켜져 있어야 한다 — 꺼두면 무인 실행에서 화풍·인물 사고가 그대로 나간다.
  assert.equal(cfg.policy.require_current_era, true);
  assert.equal(cfg.policy.block_caricature, true);
  assert.equal(cfg.policy.block_palette_conflict, true);
});

test('구세대 화풍 컷은 후보에서 빠진다 — 한 영상 안에서 그림체가 갈리면 못 쓴다', () => {
  // 2026-09-22 EP-0172 1차 실측: 씬 003 이 EP-2026-0050(176자 구세대 템플릿)로 배정돼
  // 평면 미니멀 화풍이 편집일러스트 컷들 사이에 섞였다. 점수는 0.357 로 멀쩡했다.
  const legacy = 'vertical 9:16, cartoon stick figure presenting four cards on a table, bold line art';
  assert.equal(isCurrentEra(legacy), false, '구세대 프롬프트가 현행으로 판정됐다');
  assert.equal(isCurrentEra(prompt('explainer', 'single balance scale', 'trading floor')), true);

  const dir = mkdtempSync(join(tmpdir(), 'reuse-era-'));
  try {
    const src = join(dir, 'EP-2026-0050');
    makeScript(src, { episodeId: 'EP-2026-0050', scenes: [{ sceneId: '001', role: 'hook', prompt: legacy }] });
    placeAssets(src, ['001']);
    const candidates = buildIndex(dir, {});
    assert.equal(candidates.length, 1, '인덱스에는 들어와야 한다 — 걸러내는 건 배정 단계다');

    const scenes = [{ sceneId: '001', role: 'hook', palette: 'explainer', prompt: prompt('explainer', 'single balance scale', 'floor') }];
    assert.deepEqual(pickReuseSet({ scenes, candidates, nowMs: NOW }).unmatched, ['001']);
    // 정책을 끄면 다시 후보가 된다 (회귀 진단용 스위치가 살아있는지 확인).
    assert.equal(pickReuseSet({ scenes, candidates, nowMs: NOW, policy: { require_current_era: false } }).picks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('공인 캐리커처가 든 컷은 재사용하지 않는다 — 인물 오귀속 방지', () => {
  // 2026-09-22 EP-0172 2차 실측: 씬 005 가 EP-2026-0128 s001 로 배정됐고 그 컷에는
  // 실존 인물 캐리커처가 있었다. 대본은 다른 인물을 말한다.
  const withFace = `${prompt('bearish', 'single tall podium microphone', 'press hall')}`
    + ' WITH: a flat cartoon caricature of a middle-aged man with short neatly combed dark hair.';
  assert.equal(hasCaricature(withFace), true);
  assert.equal(hasCaricature(prompt('bearish', 'single tall podium microphone', 'press hall')), false);

  const dir = mkdtempSync(join(tmpdir(), 'reuse-face-'));
  try {
    const src = join(dir, 'EP-2026-0001');
    makeScript(src, { episodeId: 'EP-2026-0001', scenes: [{ sceneId: '001', role: 'cta', prompt: withFace }] });
    placeAssets(src, ['001']);
    const candidates = buildIndex(dir, {});
    const scenes = [{
      sceneId: '001', role: 'cta', palette: 'bearish',
      prompt: prompt('bearish', 'single tall podium microphone', 'press hall'),
    }];
    assert.deepEqual(pickReuseSet({ scenes, candidates, nowMs: NOW }).unmatched, ['001'],
      '캐리커처 컷이 배정됐다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bullish 그림이 bearish 대본에 붙지 않는다', () => {
  assert.equal(palettesConflict('bullish', 'bearish'), true);
  assert.equal(palettesConflict('bearish', 'bullish'), true);
  // 중립·미지정은 모순이 아니다 — 섞여도 된다.
  assert.equal(palettesConflict('explainer', 'bearish'), false);
  assert.equal(palettesConflict('cta', 'bullish'), false);
  assert.equal(palettesConflict(undefined, 'bullish'), false);
  assert.equal(palettesConflict('bearish', 'bearish'), false);

  const dir = mkdtempSync(join(tmpdir(), 'reuse-pal-'));
  try {
    const src = join(dir, 'EP-2026-0001');
    // 객체가 완전히 같아 점수는 최고인데 방향만 반대인 컷. 점수만 보면 반드시 뽑힌다.
    makeScript(src, {
      episodeId: 'EP-2026-0001',
      scenes: [{ sceneId: '001', role: 'hook', prompt: prompt('bullish', 'single steep price chart', 'trading floor') }],
    });
    placeAssets(src, ['001']);
    const candidates = buildIndex(dir, {});
    const scenes = [{
      sceneId: '001', role: 'hook', palette: 'bearish',
      prompt: prompt('bearish', 'single steep price chart', 'trading floor'),
    }];
    assert.deepEqual(pickReuseSet({ scenes, candidates, nowMs: NOW }).unmatched, ['001']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor 는 재사용으로 발행된 편수와 약한 매칭 컷을 보고한다', () => {
  // 텔레그램은 재사용 순간에 한 번만 울린다. "며칠째 재활용으로 버티는 중"은
  // 지속 관측이 없으면 아무도 모른다 — 재사용은 쿼터가 마른 증상이기 때문이다.
  const source = readFileSync(DOCTOR, 'utf8');
  assert.equal(spawnSync('bash', ['-n', DOCTOR], { encoding: 'utf8' }).status, 0);
  assert.ok(source.includes("emit('asset_reuse'"), 'asset_reuse 점검이 없다');
  assert.ok(source.includes('_reuse.json'), '재사용 명세를 읽지 않는다');
  // 약한 매칭을 세지 않으면 "5컷 재사용"만 보이고 품질 신호가 사라진다.
  assert.ok(/weak_cuts/.test(source), '약한 매칭 컷을 세지 않는다');
});

test('재사용 CLI 는 한 컷이라도 못 채우면 0 이 아닌 종료코드를 낸다', () => {
  // 종료코드 0 이면 로그만 보는 운영자가 성공으로 읽는다.
  const source = readFileSync(join(ROOT, 'scripts', 'automation', 'reuse-scene-assets.js'), 'utf8');
  assert.ok(/if \(unmatched\.length\) process\.exit\(1\)/.test(source),
    '미배정이 있어도 종료코드 0 으로 끝난다');
});
