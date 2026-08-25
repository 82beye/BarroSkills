import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildBrandPromptBlock, detectCompaniesInText, findAliasIndex,
  loadBrandRegistry, resolveBrandsForTitle,
} from '../scripts/automation/lib/brand-entities.js';

const ROOT = join(import.meta.dirname, '..');
// loadAllowlist 는 CWD 기준 'workspace/channels/...' 를 읽는다(기존 규약). 테스트도 맞춰 준다.
process.chdir(ROOT);

const REGISTRY = loadBrandRegistry();
const MANIFEST_PATH = join(ROOT, 'workspace', 'assets', 'manifest.json');
const ALLOWLIST_PATH = join(ROOT, 'workspace', 'channels', 'econ-daily', 'policies', 'public-figures.md');
/** workspace 는 운영 데이터 심볼릭 링크다. 없는 머신에서는 자산 의존 테스트를 건너뛴다. */
const HAS_WORKSPACE = existsSync(MANIFEST_PATH) && existsSync(ALLOWLIST_PATH);

const fake = (over = {}) => ({
  id: 'acme', name_ko: '에이컴', name_en: 'Acme', aliases: ['에이컴', 'Acme'],
  logo_id: 'acme', figure_id: null, accent: '#123456', context_object: 'a single anvil',
  ...over,
});

test('레지스트리는 코드가 아니라 config/brand-entities.json 이다', () => {
  assert.ok(REGISTRY.companies.length >= 10, `기업이 너무 적다 (${REGISTRY.companies.length})`);
  const ids = REGISTRY.companies.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'id 가 중복되면 감지 결과가 덮어써진다');
  for (const c of REGISTRY.companies) {
    assert.ok(c.name_ko && c.name_en, `${c.id}: 표시 이름이 없다`);
    assert.ok(Array.isArray(c.aliases) && c.aliases.length, `${c.id}: aliases 가 비었다 — 영원히 감지되지 않는다`);
    assert.ok(c.accent, `${c.id}: accent 가 없다`);
  }
});

test('logo_id 는 manifest 의 brand_logos id 와 맞아야 한다', { skip: !HAS_WORKSPACE && 'workspace 심볼릭 링크 없음' }, () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const known = new Set((manifest.brand_logos || []).map(l => l.id));
  for (const c of REGISTRY.companies) {
    if (!c.logo_id) continue;
    assert.ok(known.has(c.logo_id), `${c.id}: manifest 에 없는 logo_id="${c.logo_id}" — CI 가 조용히 사라진다`);
  }
});

test('한국어는 조사·명사꼬리까지 붙어도 잡는다', () => {
  const reg = { companies: [fake({ aliases: ['엔비디아'] })] };
  for (const t of ['엔비디아', '엔비디아가 하락했다', '엔비디아는', '엔비디아의 실적', '엔비디아주가 급등', '엔비디아발 충격']) {
    assert.ok(detectCompaniesInText(reg, t).length === 1, `놓쳤다: "${t}"`);
  }
});

test('다른 낱말로 이어지면 잡지 않는다 — 오탐이 붙으면 엉뚱한 회사 로고가 찍힌다', () => {
  // "메타버스" 를 메타로 읽으면 페이스북 로고가 붙는다. 실제로 나갈 뻔한 실수라 못박아 둔다.
  assert.equal(detectCompaniesInText({ companies: [fake({ aliases: ['메타'] })] }, '메타버스는 왜 죽었나').length, 0);
  assert.equal(detectCompaniesInText({ companies: [fake({ aliases: ['카카오'] })] }, '카카오뱅크 상장 이후').length, 0);
  assert.equal(detectCompaniesInText({ companies: [fake({ aliases: ['LG'] })] }, 'LG에너지솔루션 유상증자').length, 0);
});

test('라틴 alias 는 단어 경계로 자른다', () => {
  assert.equal(findAliasIndex('AI intelligence 시대', 'intel'), -1, "'intelligence' 안의 intel");
  assert.equal(findAliasIndex('Nokia 실적 발표', 'kia'), -1, "'Nokia' 안의 kia");
  assert.ok(findAliasIndex('Intel 신규 팹', 'intel') >= 0, '대소문자는 무시해야 한다');
  assert.ok(findAliasIndex('TSMC가 발표했다', 'TSMC') >= 0, '라틴 뒤에 조사가 붙어도 잡는다');
});

test('긴 alias 가 먼저 매칭되고 결과는 타이틀 등장 순서다', () => {
  const reg = {
    companies: [
      fake({ id: 'samsung', aliases: ['삼성전자', '삼성'] }),
      fake({ id: 'nvidia', aliases: ['엔비디아'] }),
    ],
  };
  const hits = detectCompaniesInText(reg, '엔비디아와 삼성전자가 손잡았다');
  assert.deepEqual(hits.map(h => h.company.id), ['nvidia', 'samsung'], '타이틀 순서');
  assert.equal(hits[1].alias, '삼성전자', '짧은 "삼성" 이 아니라 긴 alias 로 잡혀야 한다');
});

test('CI 는 모델에게 그리게 하지 않는다 — 프롬프트는 자리만 비우라고 말한다', () => {
  const brands = [{
    company: fake(), alias: 'Acme', logo: { id: 'acme', logo_path: 'brand-logos/acme.svg' },
    figure: null, treatment: 'NEUTRAL_MASCOT', sensitivity: 'low', blockReason: null, mode: 'CI_ONLY',
  }];
  const block = buildBrandPromptBlock(brands, { logoPosition: 'bottom-right' });
  assert.match(block, /DO NOT draw the logo/, '로고를 그리게 두면 글자·마크가 깨진다');
  assert.match(block, /BOTTOM-RIGHT/, '비울 모서리는 실제 합성 위치와 같아야 한다');
  assert.match(block, /do NOT draw a caricature of any real person/, 'CI-only 인데 인물을 그리면 정책 위반');
  assert.ok(!/ASSOCIATED FIGURE/.test(block), 'CI-only 에는 인물 절이 없어야 한다');
});

test('인물 절에는 이름을 쓰지 말라는 지시와 실사 금지가 함께 붙는다', () => {
  const brands = [{
    company: fake(), alias: 'Acme', logo: null,
    figure: { id: 'x', display_name_ko: '아무개', descriptor_en: 'cartoon caricature of a person', trademark_cues: ['hair'] },
    treatment: 'CHARACTERIZE', sensitivity: 'high', blockReason: null, mode: 'PERSON_AND_CI',
  }];
  const block = buildBrandPromptBlock(brands, {});
  assert.match(block, /ASSOCIATED FIGURE/);
  assert.match(block, /no photorealistic skin/, '정책 §4.2 — 실사풍 금지');
  assert.match(block, /NEVER write the person's name/, '정책 RULE 11 — 이미지에 이름 금지');
  assert.match(block, /무표정 or serious only/, 'sensitivity=high 표정 규칙 (정책 §3.2)');
  assert.ok(!/BRAND CI:/.test(block), '로고 자산이 없으면 CI 문구도 없어야 한다');
});

test('logoPosition 은 합성 좌표와 프롬프트 문구에 동시에 반영된다', { skip: !HAS_WORKSPACE && 'workspace 심볼릭 링크 없음' }, () => {
  const title = '엔비디아가 7일 연속 하락한 이유';
  const bottom = resolveBrandsForTitle('econ-daily', {}, title, { logoPosition: 'bottom-right' });
  assert.equal(bottom.logoSpecs[0]?.position, 'bottom-right');
  assert.match(bottom.promptBlock, /BOTTOM-RIGHT/);
  const top = resolveBrandsForTitle('econ-daily', {}, title, { logoPosition: 'top-right' });
  assert.equal(top.logoSpecs[0]?.position, 'top-right');
  assert.match(top.promptBlock, /TOP-RIGHT/);
});

test('외국 CEO 는 인물+CI, 미승인 한국 기업은 CI 만 (정책 §2)', { skip: !HAS_WORKSPACE && 'workspace 심볼릭 링크 없음' }, () => {
  const nv = resolveBrandsForTitle('econ-daily', { sensitivity: 'low' }, '엔비디아가 7일 연속 하락한 이유');
  assert.equal(nv.brands[0].mode, 'PERSON_AND_CI');
  assert.equal(nv.brands[0].figure.id, 'huang', '엔비디아 → 젠슨 황');

  // 한국 CEO 는 REQUIRES_LEGAL_REVIEW 라 allowlist 시드가 없고, 있더라도 승인 토큰 없이는 강등된다.
  const ss = resolveBrandsForTitle('econ-daily', { sensitivity: 'low' }, '삼성전자 주가가 8만원을 넘었다');
  assert.equal(ss.brands[0].mode, 'CI_ONLY', '한국 기업에 인물을 붙이면 명예훼손 리스크를 그대로 진다');
  assert.ok(ss.notes.length, '왜 CI 만 나가는지 운영자에게 남겨야 한다');
  assert.ok(!/ASSOCIATED FIGURE/.test(ss.promptBlock));
});

test('allowlist descriptor_en 은 전원이 같은 화풍 문법을 쓴다 (§0.3)', { skip: !HAS_WORKSPACE && 'workspace 심볼릭 링크 없음' }, async () => {
  // 화풍은 프롬프트 조립부가 아니라 descriptor_en 에서 샌다. huang 만 "detailed editorial
  // caricature … expressive shading and depth" 였고, 기업 자동 감지로 그가 썸네일에 나오기
  // 시작하자 채널의 플랫 라인아트가 아니라 사실적 초상이 나왔다 (2026-08-25). 여기서 막는다.
  const { loadAllowlist } = await import('../scripts/automation/lib/public-figures.js');
  const { figures } = loadAllowlist('econ-daily');
  assert.ok(figures.length >= 9, `시드가 너무 적다 (${figures.length})`);
  for (const f of figures) {
    const d = f.descriptor_en || '';
    assert.match(d, /^cartoon(-style)? caricature/, `${f.id}: "cartoon caricature" 로 시작해야 한다`);
    assert.match(d, /stylized cartoon only/, `${f.id}: §4.2 실사풍 금지 문구가 없다`);
    assert.match(d, /mascot-line proportions/, `${f.id}: 채널 라인아트 비율 지시가 없다`);
  }
});

test('타이틀에 기업이 없으면 아무것도 주입하지 않는다', () => {
  const r = resolveBrandsForTitle('econ-daily', {}, '오늘의 경제 한 컷');
  assert.deepEqual(r.brands, []);
  assert.equal(r.promptBlock, null);
  assert.deepEqual(r.logoSpecs, []);
});

test('인트로·썸네일·카드 세 경로가 모두 브랜드를 태운다', () => {
  const intro = readFileSync(join(ROOT, 'scripts/automation/generate-intro.js'), 'utf-8');
  const thumb = readFileSync(join(ROOT, 'scripts/automation/generate-thumbnail.js'), 'utf-8');
  const cards = readFileSync(join(ROOT, 'scripts/automation/generate-cards.js'), 'utf-8');

  // 인트로: 프롬프트에 블록을 넣고, 합성 spec 에 로고를 넣는다. 둘 중 하나만 있으면 반쪽이다.
  assert.match(intro, /brandBlock: brands\.promptBlock/, '인트로 프롬프트에 브랜드 블록 주입');
  assert.match(intro, /v2spec\.brand_logos = brands\.logoSpecs/, '인트로 합성에 CI 주입');
  assert.match(intro, /logoPosition: 'bottom-right'/, '인트로 헤드라인은 화면 맨 위라 로고는 아래로 간다');

  // 썸네일: 타이틀이 회사만 말할 때 그 회사의 인물을 세운다.
  assert.match(thumb, /brands\.primary\?\.mode === 'PERSON_AND_CI'/, '기업 → 인물 폴백');
  assert.match(thumb, /brands\.logoSpecs\.length \? brands\.logoSpecs : null/, '수동 지정이 없을 때만 자동 채움');

  // 카드(기본 경로): 씬 스틸을 쓰므로 CI 를 얹을 표면이 여기뿐이다.
  assert.match(cards, /stampIntroBrand/, '인트로 카드에 CI 합성');
});
