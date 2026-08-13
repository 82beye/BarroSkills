import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYAML } from 'yaml';
import {
  validateScript, countSpokenNumbers, spokenNumberCap, totalSpokenNumberCap,
  buildAnalystContractBlock,
} from '../scripts/automation/lib/script-quality-contract.js';

const ROOT = join(import.meta.dirname, '..');

const scene = (over = {}) => ({
  scene_id: '001', role: 'insight', target_seconds: 12,
  narration: '물가가 예상대로 나오자 돈이 인공지능 쪽으로 붙었다는 뜻입니다.', ...over,
});
const errorsOf = (scenes) => validateScript(scenes).filter((i) => i.severity === 'error').map((i) => i.rule);

test('spoken numbers are counted, index names spelled in Korean are not', () => {
  // 한글 수사 3음절 이상이면 수치다.
  assert.equal(countSpokenNumbers('영점이육 퍼센트 올랐습니다').length, 1);
  assert.equal(countSpokenNumbers('이만육천오백팔십팔로 마감했습니다').length, 1);
  assert.equal(countSpokenNumbers('십 년물 국채').length, 1, '단위가 붙으면 한 음절도 수치다');

  // "에스앤피오백이" 의 "오백이" 는 지수 이름이지 작성자가 말하기로 고른 수치가 아니다.
  // 매 미국장 EP 에 나오므로 세면 예산이 조용히 깎인다.
  assert.equal(countSpokenNumbers('에스앤피오백이 올랐습니다').length, 0);

  // 보통 낱말이 수사로 잡히면 안 된다.
  assert.equal(countSpokenNumbers('일명 그림자 금융이라 불립니다').length, 0);
  assert.equal(countSpokenNumbers('만일에 대비해야 합니다').length, 0);
});

test('a scene may speak only a couple of numbers — the screen shows the rest for free', () => {
  const three = scene({ narration: '에스앤피는 영점이육 퍼센트, 나스닥은 영점오사 퍼센트, 다우는 영점영사 퍼센트입니다.' });
  assert.ok(errorsOf([three]).includes('spoken-number-budget'));

  // 긴 씬은 하나 더 쓸 수 있다.
  assert.equal(spokenNumberCap(12), 2);
  assert.equal(spokenNumberCap(30), 3);
  assert.ok(!errorsOf([scene({ ...three, target_seconds: 30 })]).includes('spoken-number-budget'));
});

test('the whole script has a number budget, not just each scene', () => {
  // 씬마다 상한을 지켜도 전부 수치로 채우면 분석이 들어갈 자리가 없다.
  const scenes = Array.from({ length: 5 }, (_, i) => scene({
    scene_id: `00${i + 1}`, role: 'context',
    narration: '나스닥은 영점오사 퍼센트, 다우는 영점영사 퍼센트입니다.',
  }));
  assert.equal(totalSpokenNumberCap(5), 6);
  assert.ok(errorsOf(scenes).includes('spoken-number-total'));
});

test('generic advice that fits any day is an error, but real causation in any phrasing is not', () => {
  assert.ok(errorsOf([scene({ narration: '변동성이 커질 테니 포트폴리오 점검과 신중한 접근이 필요합니다.' })])
    .includes('filler-conclusion'));

  // EP-2026-0073 회귀: 인과 키워드 목록에는 없지만 이건 분명한 인과다.
  // 한국어가 인과를 표현하는 방법은 키워드보다 넓다 — 없는 것을 찾지 말고 있는 것을 찾는다.
  const good = scene({ narration: '사상 최대 실적을 내고도 급락했습니다. 실적이 아니라, 주주환원의 숫자와 시점이 없었던 겁니다.' });
  assert.deepEqual(errorsOf([good]), [], '구체적인 인과 서술을 error 로 잡으면 안 된다');
});

test('the prompt block and the validator read the same bounds', () => {
  // image_prompt 계약이 겪은 그 문제 — 프롬프트에 상한을 따로 적으면 검증기와 갈라진다.
  const block = buildAnalystContractBlock(5);
  assert.match(block, new RegExp(`최대 ${spokenNumberCap(10)}개`));
  assert.match(block, new RegExp(`최대 ${totalSpokenNumberCap(5)}개`));
});

test('the writer gets the contract in its prompt and one chance to fix violations', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-script.js'), 'utf-8');

  // 계약을 프롬프트에 넣지 않으면 게이트는 사후 잔소리일 뿐이다.
  assert.match(src, /\$\{buildAnalystContractBlock\(sceneCount\)\}/, 'contract must be injected into the system prompt');

  // 위반을 되돌려 주지 않으면 모델은 같은 대본을 다시 낸다.
  assert.match(src, /재작성 지시/, 'violations must be fed back for one rewrite');
  assert.match(src, /attempt <= 2/, 'exactly one retry — not an unbounded loop');

  // 두 번째도 실패하면 숨기지 말고 남긴다.
  assert.match(src, /outFM\.quality_issues/, 'unresolved violations must survive into the artifact');
});

test('EP-2026-0091 — the episode that motivated this gate still fails it', () => {
  // 이 EP 는 지수 세 개 등락률을 소리 내어 읽고 "과열을 놓칠 수 있습니다" 로 끝났다.
  // 게이트가 이걸 통과시키면 게이트가 없는 것과 같다.
  //
  // 처음엔 workspace 의 실제 대본을 읽었는데, 그 EP 를 계약대로 다시 뽑자 통과해 버려서
  // 테스트가 깨졌다 — 고쳐야 할 대상을 픽스처로 삼은 게 잘못이었다. 원문을 여기에 박아 둔다.
  const scenes = [
    { scene_id: '001', role: 'hook', target_seconds: 11.4,
      narration: '나스닥이 이만육천오백팔십팔로 마감했는데 다우는 웃지 못했습니다. 같은 물가 뉴스에 왜 반도체 인프라만 뜨거웠는지 놓치면 장 분위기를 잘못 읽습니다.' },
    { scene_id: '002', role: 'context', target_seconds: 14.5,
      narration: '지금 상황은 에스앤피오백이 영점이육 퍼센트, 나스닥이 영점오사 퍼센트 올랐지만 다우는 영점영사 퍼센트 내렸습니다. 미국장 전체가 오른 게 아니라 성장주 쪽으로 온기가 뚜렷하게 몰린 겁니다.' },
    { scene_id: '003', role: 'insight', target_seconds: 13.2,
      narration: '칠월 소비자물가는 전월보다 영점일 퍼센트, 일 년 전보다 삼점사 퍼센트 올라 예상과 같았습니다. 코어위브와 슈퍼마이크로가 실적 전망을 올리며 급등해 인공지능 인프라주가 강했습니다.' },
    { scene_id: '004', role: 'implication', target_seconds: 13.5,
      narration: '당신이 볼 건 환율과 쏠림입니다. 원달러 환율은 천사백이십오 원대로 올라 환전 부담이 커졌습니다. 국내 반도체엔 훈풍 기대가 생길 수 있지만, 지수 상승을 시장 전체 회복으로 해석하면 과열을 놓칠 수 있습니다.' },
    { scene_id: '005', role: 'cta', target_seconds: 10.9,
      narration: '십 년물 국채 경매와 반도체 랠리 지속 여부가 다음 신호입니다. 지수보다 누가 올랐는지 먼저 보세요. 매일 이런 시장 온도차를 놓치기 싫다면 팔로우하세요.' },
  ];

  const rules = errorsOf(scenes);
  assert.ok(rules.includes('spoken-number-budget'), '씬 2·3 의 수치 낭독이 잡혀야 한다');
  assert.ok(rules.includes('spoken-number-total'), '대본 전체 수치 과다가 잡혀야 한다');
});

test('the gate accepts most of what the channel already ships', () => {
  // 전부 실패시키는 게이트는 꺼진다. 2026-08-13 측정: 91편 중 65편 통과.
  // 이 테스트는 규칙을 조이다 기존 대본을 무더기로 떨어뜨리는 변경을 막는다.
  const dir = join(ROOT, 'workspace', 'episodes');
  if (!existsSync(dir)) return;
  const files = execSync(`find ${JSON.stringify(dir)} -name 30_script.md`, { encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);
  if (files.length < 20) return;   // 표본이 작으면 판정하지 않는다

  let pass = 0;
  for (const f of files) {
    const match = readFileSync(f, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    let scenes;
    try { scenes = parseYAML(match[1])?.scenes; } catch { continue; }
    if (!Array.isArray(scenes)) continue;
    if (!errorsOf(scenes).length) pass++;
  }
  const rate = pass / files.length;
  assert.ok(rate > 0.5, `기존 대본 통과율이 ${Math.round(rate * 100)}% 로 떨어졌다 — 규칙이 과하다`);
});
