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

  // 앞이 한글이면 그 한 음절은 수사가 아니라 조사다. 이걸 세면 멀쩡한 문장이
  // 씬 상한에 걸려 자동 재집필이 통째로 막힌다 (EP-2026-0128 실사례).
  assert.equal(countSpokenNumbers('수급 반전이 달러 재료를 압도했다').length, 0, '"…반전이 달러" 의 조사 이');
  assert.equal(countSpokenNumbers('전망이 원 단위로 갈린다').length, 0, '"…전망이 원" 의 조사 이');
  // 다만 진짜 수사는 문장 첫머리에서도 계속 세야 한다.
  assert.equal(countSpokenNumbers('이 퍼센트 올랐습니다').length, 1);
  assert.equal(countSpokenNumbers('금리는 오 퍼센트입니다').length, 1);
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


test('hook-too-long — 훅 10초 상한, 되돌리되 막지는 않는다', async () => {
  const { validateScript, HOOK_MAX_SECONDS } = await import('../scripts/automation/lib/script-quality-contract.js');
  const body = (over = {}) => ([
    { scene_id: '001', role: 'hook', narration: '코스피가 크게 올랐습니다. 왜일까요?', target_seconds: 9, ...over },
    { scene_id: '002', role: 'context', narration: '배경입니다.', target_seconds: 13 },
    { scene_id: '003', role: 'insight', narration: '수급 때문입니다.', target_seconds: 13 },
    { scene_id: '004', role: 'implication', narration: '그래서 이런 뜻입니다.', target_seconds: 13 },
    { scene_id: '005', role: 'cta', narration: '팔로우하세요.', target_seconds: 12 },
  ]);

  assert.equal(validateScript(body()).filter((i) => i.rule === 'hook-too-long').length, 0, '9초는 통과');

  const long = validateScript(body({ target_seconds: HOOK_MAX_SECONDS + 0.5 }))
    .filter((i) => i.rule === 'hook-too-long');
  assert.equal(long.length, 1, '상한 초과는 잡힌다');
  assert.equal(long[0].severity, 'warn', '게이트를 막지는 않는다');
  assert.equal(long[0].rewrite, true, '한 번은 되돌린다');

  // 3분 포맷은 표본이 2편뿐이라 이 규칙을 적용하지 않는다 — 근거 없는 확대 금지.
  const longFormat = [
    { scene_id: '001', role: 'hook', narration: '훅.', target_seconds: 24 },
    ...Array.from({ length: 6 }, (_, i) => ({
      scene_id: `00${i + 2}`, role: 'context', narration: '본문.', target_seconds: 25,
    })),
  ];
  assert.equal(
    validateScript(longFormat).filter((i) => i.rule === 'hook-too-long').length, 0,
    '총 90초 초과 대본에는 적용하지 않는다',
  );

  // 계약 블록의 숫자가 검증기와 갈라지면 안 된다
  const { buildAnalystContractBlock } = await import('../scripts/automation/lib/script-quality-contract.js');
  assert.match(buildAnalystContractBlock(5), new RegExp(`훅\\(씬 1\\)은 ${HOOK_MAX_SECONDS}초`));
});

/**
 * 조건부 인과 「X-면 … Y도/따라 …」는 이 채널의 주력 서술이다.
 * 2026-09-16 EP-2026-0156 씬 004 「미국 금리가 오르면 국내 은행채와 주담대 금리도 따라
 * 오르고」가 no-mechanism 으로 잡혔다 — 전이 메커니즘 그 자체인데 오탐이었다.
 * 조건 어미만으로는 과탐하므로 결과절 표지가 따라올 때만 인과로 센다.
 */
import { MECHANISM_CONDITIONAL, MECHANISM_MARKERS as MM, MECHANISM_VERB_JA as MV }
  from '../scripts/automation/lib/script-quality-contract.js';

const causal = (t) => MM.some((m) => t.includes(m)) || MV.test(t) || MECHANISM_CONDITIONAL.test(t);

test('조건부 인과를 인과로 센다', () => {
  assert.ok(causal('미국 금리가 오르면 국내 은행채와 주택담보대출 금리도 따라 오르고'));
  assert.ok(causal('유가가 오르면 항공주도 같이 눌립니다'));
  assert.ok(causal('금리가 뛰면 성장주가 덩달아 밀립니다'));
});

test('결과절 없는 조건 어미는 인과가 아니다 — 과탐 방지', () => {
  assert.equal(causal('어쩌면 좋을까요'), false);
  assert.equal(causal('이렇게 하면 됩니다'), false);
});

test('전이 계열 동사도 인과다', () => {
  assert.ok(causal('미 금리 상승이 국내로 전이됩니다'));
  assert.ok(causal('충격이 채권시장으로 옮겨붙었습니다'));
});

test('수치 나열은 여전히 인과가 아니다', () => {
  assert.equal(causal('코스피는 1.76% 내렸고 코스닥은 2.1% 내렸습니다'), false);
});

/**
 * 답할 자리에서 유보하면 회차가 껍데기가 된다.
 *
 * 2026-09-16 EP-2026-0157: 제목 「이란 휴전설에도 방산주가 급등한 이유」로 나갔는데
 * insight 씬이 「정확한 상승 배경은 후속 보도로 다시 확인이 필요합니다」였다.
 * 원본(rev0)에는 「휴전 뒤 중동 재건과 무기 현대화 수요가 열릴 거란 기대 때문에
 * 매수세가 몰렸습니다」라는 답이 있었는데 팩트체크 재작성이 지워 버렸다.
 * 팩트체크가 지울 것은 '틀린 것'이지 '검증 안 되는 것'이 아니다 —
 * 검증이 안 되면 해석으로 표시하면 된다("…라는 해석이 나옵니다").
 */
import { validateScript as vs, DODGE_PHRASES } from '../scripts/automation/lib/script-quality-contract.js';

const dodgeScene = (role, narration) => ({
  scene_id: '003', role, narration, target_seconds: 12, subtitle_text: '', emphasis_tokens: ['a'],
});
const dodgeIssues = (s) => vs([s]).filter((i) => i.rule === 'dodge-in-analysis');

test('분석 씬의 유보 문장은 error 다 — 게시를 막는다', () => {
  const bad = dodgeScene('insight', '방산주가 오늘 큰 폭으로 올랐습니다. 정확한 상승 배경은 후속 보도로 다시 확인이 필요합니다.');
  const hits = dodgeIssues(bad);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'error', 'warn 이면 그대로 나간다 — EP-0157 이 그렇게 나갔다');
});

test('해석으로 표시한 설명은 통과한다 — 이게 올바른 수정 방향', () => {
  const good = dodgeScene('insight', '휴전 뒤 재건과 무기 현대화 수요가 열릴 거란 기대가 작용했다는 해석이 나옵니다.');
  assert.equal(dodgeIssues(good).length, 0);
  const good2 = dodgeScene('insight', '시장은 종전보다 재건 수요를 먼저 본 것으로 보입니다.');
  assert.equal(dodgeIssues(good2).length, 0);
});

test('훅의 유보는 잡지 않는다 — 훅은 질문을 던지는 자리다', () => {
  const hook = dodgeScene('hook', '왜 올랐는지는 아직 알 수 없습니다. 그런데 시장은 이미 답을 냈습니다.');
  assert.equal(dodgeIssues(hook).length, 0);
});

test('유보 문구 목록이 실제 사고 문장을 덮는다', () => {
  const real = '정확한 상승 배경은 후속 보도로 다시 확인이 필요합니다';
  assert.ok(DODGE_PHRASES.some((d) => real.includes(d)), '실제로 나간 문장을 못 잡으면 의미가 없다');
});

/**
 * 「오늘 지수가 몇 % 움직였다」로 훅을 열면 이 채널이 파는 게 사라진다.
 * 운영자 지시(2026-09-16): "단순 영향이 없는 지수 수치는 에피소드 주제가 되면 안 된다."
 *
 * generate-script 의 규칙 10a/10b 는 프롬프트 지시일 뿐이라 지켜졌는지 확인할 수단이 없었다.
 * 레벨 돌파·N년래 최고는 등락률이 아니라 사건이므로 예외다.
 */
import { spokenToNumber, INDEX_MOVE_PCT_FLOOR } from '../scripts/automation/lib/script-quality-contract.js';

const hook = (n) => ({ scene_id: '001', role: 'hook', narration: n, target_seconds: 10, subtitle_text: '', emphasis_tokens: ['a'] });
const idxIssues = (n) => vs([hook(n)]).filter((i) => i.rule === 'index-move-as-subject');

test('낭독체 소수를 숫자로 읽는다', () => {
  assert.equal(spokenToNumber('일점삼칠'), 1.37);
  assert.equal(spokenToNumber('사점구칠'), 4.97);
  assert.equal(spokenToNumber('십점칠영'), 10.7);
  assert.equal(spokenToNumber('그냥말'), null);
});

test('임계 미만 지수 등락으로 훅을 열면 되돌린다', () => {
  const hits = idxIssues('코스피가 오늘 일점삼칠 퍼센트 올랐습니다. 그런데 개인은 팔았습니다.');
  assert.equal(hits.length, 1, `1.37% 는 임계 ${INDEX_MOVE_PCT_FLOOR}% 미만이라 주제가 못 된다`);
  assert.equal(hits[0].rewrite, true, '막지는 않되 한 번 되돌린다');
});

test('임계를 넘는 등락은 통과한다', () => {
  assert.equal(idxIssues('코스피가 오늘 삼점이육 퍼센트 빠졌습니다.').length, 0, '3.26% 는 실제 사건이다');
});

test('레벨 돌파·N년래 최고는 등락률이 아니라 사건이다', () => {
  assert.equal(idxIssues('미국 국채금리가 오 퍼센트를 뚫으면서 주식이 밀렸습니다.').length, 0);
  assert.equal(idxIssues('코스피가 삼 년 만에 최고를 찍었습니다.').length, 0);
});

test('지수가 주어가 아니면 걸리지 않는다', () => {
  assert.equal(idxIssues('개인이 일조 칠천억을 파는 동안 기관 혼자 사들였습니다.').length, 0);
});

/**
 * 대조의 앞쪽 절로 쓰인 수치는 '주어'가 아니다.
 * 2026-09-16 EP-2026-0158 실측 오탐: 「코스피가 1.37% 올랐지만 개인도 외국인도 팔았습니다」의
 * 주제는 등락률이 아니라 괴리인데 검사기가 잡았다. 이걸 안 빼면 멀쩡한 훅이 재작성을 한 번 태운다.
 */
test('대조 구문의 지수 수치는 주어가 아니다', () => {
  assert.equal(idxIssues('코스피가 오늘 일점삼칠 퍼센트 올랐지만 개인도 외국인도 주식을 팔았습니다.').length, 0);
  assert.equal(idxIssues('코스피가 오늘 일점삼칠 퍼센트 올랐는데 개인 계좌는 그대로였습니다.').length, 0);
});

test('대조 없이 등락률만 나열하면 여전히 걸린다', () => {
  assert.equal(idxIssues('코스피가 오늘 일점삼칠 퍼센트 올랐습니다. 상승 마감했습니다.').length, 1);
});
