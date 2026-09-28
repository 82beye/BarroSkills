import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyTitle, titleCore } from '../scripts/automation/lib/title-types.js';
import {
  judgeCandidate, selectTitle, recentTitles, normalizeTitle, summaryLines,
} from '../scripts/automation/lib/title-select.js';
import { headlineNumberTokens, findHeadlineCollision } from '../scripts/automation/generate-metadata.js';
import { buildDirective, titleDirectives } from '../scripts/automation/growth-directives.js';
import { pickPrimaryKeyword, hasKoreanNumeral } from '../scripts/automation/seo-enhance.js';
import { findMeta } from '../scripts/automation/title-summary.js';

// ── 분류 — 2026-09-25 분석(공개 92편 10유형)과 같은 정의 ────────────────────────

test('제목 유형은 분석 때와 같은 우선순위로 나뉜다', () => {
  const cases = [
    ['[美마감] 국채금리 4.97%, 2023년 이후 최고치 찍었다', 'label'],
    ['코스피 6894 사상 최고인데 계좌는 왜 안 웃었나', 'account'],
    ['美韓 국채금리 동반 하락, 진짜 이유는 금리 아니라 유가였다', 'jinjja'],
    ['케빈 워시 매파 발언에 美 10년물 5% 돌파, 코스피만 웃은 이유', 'causal'],
    ['세종 아파트 매물 44% 급증…집값 언제 회복될까?', 'question'],
    ['하이닉스 하루 -15%, 무너진 건 실적이 아니라 수급', 'contrast'],
    ['케빈 워시 발언에 금리인상 확률 58%…금·나스닥 급락', 'figure'],
    ['연준은 동결, 금리는 2007년 최고', 'record'],
    ['SK하이닉스, 나스닥에서 알리바바를 넘었다', 'company'],
    ['ECB 금리 동결, 물가·경기 이중고 심화!', 'report'],
  ];
  for (const [t, want] of cases) assert.equal(classifyTitle(t).primary, want, t);
});

test('#Shorts 는 유형에도 비교에도 영향이 없다', () => {
  assert.equal(titleCore('코스피 급락 이유 #Shorts'), '코스피 급락 이유');
  assert.equal(normalizeTitle('코스피 급락 이유 #Shorts #Shorts'), '코스피 급락 이유 #Shorts');
  assert.equal(normalizeTitle('코스피 급락 이유 #Shorts', { shorts: false }), '코스피 급락 이유');
});

// ── 후보 판정 ─────────────────────────────────────────────────────────────

const RECENT = [
  { title: '유가는 4% 뛰었는데 금은 내렸다, 진짜 이유는 美 10년물 5.1%대 #Shorts', at: 3 },
  { title: '코스피 4거래일 연속 상승, 진짜 이유는 삼성전자·SK하이닉스 쏠림 #Shorts', at: 2 },
  { title: '美韓 국채금리 동반 하락, 진짜 이유는 금리 아니라 유가였다 #Shorts', at: 1 },
];

test('시황 라벨로 시작하면 거른다 — 롱폼 시리즈 배지는 예외', () => {
  assert.ok(judgeCandidate('[美마감] 나스닥이 왜 빠졌나').hard.includes('LABEL_PREFIX'));
  const badge = '[S&P500 입문 2/5]';
  assert.ok(!judgeCandidate(`${badge} 지수는 왜 오르나`, { shorts: false, seriesBadge: badge }).hard.includes('LABEL_PREFIX'));
});

test('"왜"가 없으면 거른다 — 정책이 꺼져 있으면 거르지 않는다', () => {
  assert.ok(judgeCandidate('SK하이닉스, 나스닥에서 알리바바를 넘었다').hard.includes('NO_WHY'));
  assert.ok(!judgeCandidate('SK하이닉스, 나스닥에서 알리바바를 넘었다', { requireWhy: false }).hard.includes('NO_WHY'));
  for (const ok of ['코스피는 왜 올랐나', '지수는 올랐는데 계좌는 그대로', '금리 아니라 유가였다', '반도체가 오른 이유']) {
    assert.ok(!judgeCandidate(ok).hard.includes('NO_WHY'), ok);
  }
});

test('최근 3일 제목과 같은 수치를 쓰면 거른다', () => {
  const j = judgeCandidate('금값이 빠진 이유, 美 10년물 5.1%대가 눌렀다', { recent: RECENT });
  assert.ok(j.hard.includes('NUMBER_REPEAT'));
  assert.ok(!judgeCandidate('원/달러 1,380원인데 왜 외국인은 샀나', { recent: RECENT }).hard.includes('NUMBER_REPEAT'));
});

test('최근 3편에 "진짜"가 있으면 "진짜"를 거른다 — 더 오래된 것만 있으면 허용', () => {
  assert.ok(judgeCandidate('금값이 오른 진짜 이유', { recent: RECENT }).hard.includes('JINJJA_RECENT'));
  const older = [{ title: '코스피 왜 올랐나', at: 3 }, { title: '환율은 왜 내렸나', at: 2 }, { title: '금리 아니라 유가였다', at: 1 }, ...RECENT];
  assert.ok(!judgeCandidate('금값이 오른 진짜 이유', { recent: older }).hard.includes('JINJJA_RECENT'));
});

test('최근 제목과 같으면 거르고, 길이 상한을 넘으면 거른다', () => {
  assert.ok(judgeCandidate(RECENT[0].title, { recent: RECENT }).hard.includes('DUPLICATE'));
  assert.ok(judgeCandidate(`${'가'.repeat(95)} 왜`).hard.includes('TOO_LONG'));
});

test('바로 앞 제목과 같은 유형은 뒤로 민다 (막지는 않는다)', () => {
  const recent = [{ title: '코스피 올랐는데 계좌는 그대로인 이유', at: 1 }];
  const same = judgeCandidate('나스닥 최고인데 내 계좌는 왜 빠졌나', { recent });
  assert.equal(same.type, 'account');
  assert.deepEqual(same.hard, []);
  assert.ok(same.soft.includes('SAME_TYPE_AS_LAST'));
});

test('기록만 앞세운 유형과 메인 인물 누락은 뒤로 민다', () => {
  assert.ok(judgeCandidate('美 10년물 5% 돌파, 2007년 이후 최고 왜', { requireWhy: true }).soft.length >= 0);
  const fig = judgeCandidate('유가가 100달러 아래로 내려간 이유는 이란과의 대화 가능성 때문이라는 분석, 도널드 트럼프 발언', { figure: '도널드 트럼프' });
  assert.ok(fig.soft.includes('FIGURE_NOT_FRONT'));
});

// ── 선택 ──────────────────────────────────────────────────────────────────

test('규칙을 지킨 후보 중에서 고른다 — 걸린 후보는 앞에 있어도 건너뛴다', () => {
  const pick = selectTitle([
    { type: 'causal', title: '금값이 빠진 진짜 이유는 美 10년물' },              // JINJJA_RECENT
    { type: 'contrast', title: '금리 5.1%대인데 금값은 내렸다' },                  // NUMBER_REPEAT
    { type: 'account', title: '전쟁 뉴스에도 금 통장은 왜 손해였나' },
    { type: 'question', title: '안전자산이라던 금은 왜 전쟁에 약했나?' },
  ], { recent: RECENT });
  assert.equal(pick.fallback, false);
  assert.equal(pick.chosen.type, 'account');
  assert.match(pick.chosen.title, /#Shorts$/);
});

test('바로 앞과 같은 유형보다 다른 유형을 고른다', () => {
  const recent = [{ title: '코스피 올랐는데 계좌는 그대로인 이유', at: 1 }];
  const pick = selectTitle([
    { type: 'account', title: '나스닥 최고인데 내 계좌는 왜 빠졌나' },
    { type: 'contrast', title: '나스닥은 최고인데 반도체는 내렸다' },
  ], { recent });
  assert.equal(pick.chosen.type, 'contrast');
});

test('모든 후보가 규칙을 어기면 가장 덜 어긴 것을 고르고 차선으로 표시한다', () => {
  const pick = selectTitle([
    { title: '[속보] 코스피 5.1%대 급락' },
    { title: '코스피 급락, 외국인 매도' },
  ], { recent: RECENT });
  assert.equal(pick.fallback, true);
  assert.equal(pick.chosen.title, '코스피 급락, 외국인 매도 #Shorts');
});

test('옛 형식(title 하나)만 와도 판정해 고른다', () => {
  const pick = selectTitle([{ title: '반도체가 오른 이유' }], {});
  assert.equal(pick.chosen.title, '반도체가 오른 이유 #Shorts');
});

// ── 최근 제목 수집 ─────────────────────────────────────────────────────────

test('최근 제목 — 채널 인덱스 + 업로드된 로컬 회차만, 현재 회차 제외, 중복 제거', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bt-recent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (ep, meta, published = true) => {
    const d = join(root, ep, 'platforms', 'shorts');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '70_publish_meta.json'), JSON.stringify(meta));
    if (published) writeFileSync(join(d, '80_publish_result.json'), '{}');
  };
  const now = new Date('2026-09-26T09:00:00Z');
  put('EP-2026-0183', { title: '오늘 아침 업로드 #Shorts', publishAt: '2026-09-25T23:00:00Z' });
  put('EP-2026-0184', { title: '업로드 안 된 초안' }, false);
  put('EP-2026-0185', { title: '지금 만드는 회차' });
  const idx = { videos: {
    a: { title: '어제 영상 #Shorts', publishedAt: '2026-09-25T09:00:00Z' },
    b: { title: '오늘 아침 업로드 #Shorts', publishedAt: '2026-09-25T23:00:00Z' },
    c: { title: '닷새 전 영상', publishedAt: '2026-09-21T09:00:00Z' },
  } };
  const r = recentTitles({ videosIndex: idx, episodesRoot: root, excludeEpisode: 'EP-2026-0185', now });
  assert.deepEqual(r.map((x) => titleCore(x.title)), ['오늘 아침 업로드', '어제 영상']);
});

// ── 거부창 요약 ────────────────────────────────────────────────────────────

test('거부창 요약은 제목·유형·경고를 싣고 HTML 을 이스케이프한다', () => {
  const lines = summaryLines({
    title: '금리 <5%> 아래인데 왜 & #Shorts',
    title_selection: { chosen_type: 'causal', candidates: [1, 2, 3], fallback: true, chosen_hard: ['NUMBER_REPEAT'] },
    headline_conflict: { shared: ['5%'] },
  });
  assert.equal(lines[0], '제목: 금리 &lt;5%&gt; 아래인데 왜 &amp; #Shorts');
  assert.ok(lines.some((l) => l.includes('후보 3개')));
  assert.ok(lines.some((l) => l.includes('차선') && l.includes('수치')));
  assert.ok(lines.some((l) => l.includes('수치 겹침')));
  assert.deepEqual(summaryLines(null), []);
});

test('거부창 요약은 회차 폴더에서 메타를 찾는다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bt-sum-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const d = join(root, 'workspace', 'episodes', 'EP-2026-0001', 'platforms', 'shorts');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '70_publish_meta.json'), JSON.stringify({ title: 'x' }));
  assert.equal(findMeta('EP-2026-0001', root).title, 'x');
  assert.equal(findMeta('EP-2026-0002', root), null);
});

// ── 메타 프롬프트 · 성장 지시문 ────────────────────────────────────────────

test('메타 프롬프트 — 후보 5유형을 요구하고 「진짜 이유는」 예시를 주지 않는다', () => {
  const src = readFileSync(new URL('../scripts/automation/generate-metadata.js', import.meta.url), 'utf8');
  assert.ok(src.includes('title_candidates'));
  for (const k of ['company', 'account', 'question', 'contrast', 'causal']) assert.ok(src.includes(`· ${k}`), k);
  assert.ok(!src.includes('"진짜 이유는 …"'), '예시 문구가 남아 있으면 모델이 그대로 복제한다');
  assert.ok(src.includes('[최근 제목'), '최근 제목을 프롬프트에 넣는다');
});

test('수치 충돌 함수는 generate-metadata 에서 계속 불러올 수 있다', () => {
  assert.deepEqual([...headlineNumberTokens('유가 108 달러')], ['108달러']);
  assert.equal(typeof findHeadlineCollision, 'function');
});

test('성장 지시문 — 제목 규칙 예시에 「진짜 이유는」이 없다', () => {
  const md = buildDirective({ date: '2026-09-26', slot: 'us-close', analysis: null, kpi: null, experiment: null, policy: { title_requires_causal_clause: true, index_move_thresholds: {} } });
  assert.ok(md.includes('제목 규칙'));
  assert.ok(!md.includes('진짜 이유는'));
});

test('성장 지시문 — 롱폼 기준 "짧은 제목 피하기"는 처방하지 않는다', () => {
  const d = titleDirectives([{ feature: 'title_short', n_with: 40, n_without: 300, lift: 0.72, direction: 'negative' }]);
  assert.ok(!d.some((l) => l.includes('짧은 제목')));
});

test('성장 지시문 — 잘된 예시는 유형이 겹치지 않게 두 개', () => {
  const md = buildDirective({
    date: '2026-09-26', slot: 'us-close', analysis: null, experiment: null,
    kpi: { kpis: [], top_videos: [
      { title: '유가는 4% 뛰었는데 금은 내렸다, 진짜 이유는 美 10년물 5.1%대', vpd: 416 },
      { title: '美韓 국채금리 동반 하락, 진짜 이유는 금리 아니라 유가였다', vpd: 365 },
      { title: '코스피 6894 사상 최고인데 계좌는 왜 안 웃었나', vpd: 300 },
    ] },
  });
  const good = md.split('\n').filter((l) => l.startsWith('- 잘된 것'));
  assert.equal(good.length, 2);
  assert.equal(good.filter((l) => l.includes('진짜')).length, 1, '같은 틀을 두 번 올리지 않는다');
  assert.ok(good.some((l) => l.includes('계좌')));
});

// ── SEO ───────────────────────────────────────────────────────────────────

test('SEO 주 키워드 — 소수점에서 자르지 않고, 긴 구절은 서술어 앞에서 끊는다', () => {
  assert.equal(pickPrimaryKeyword([], '미 10년물 2007년 이후 최고 5.12%인데 환헤지 안 한 계좌가 덜 아팠던 진짜 이유 #Shorts'), '미 10년물 2007년 이후 최고');
  assert.equal(pickPrimaryKeyword(['팔십오 주'], '서울 아파트 85주 연속 올랐는데 강남3구는 내렸다, 평균이 가린 진짜 신호'), '서울 아파트 85주 연속');
  assert.equal(pickPrimaryKeyword([], '코스피 4거래일 연속 상승, 진짜 이유는 쏠림'), '코스피 4거래일 연속 상승');
});

test('SEO — 한글 수사 표기만 거르고 일반 낱말은 남긴다', () => {
  for (const s of ['팔십오 주', '영점일구 퍼센트', '십년물', '이천칠년', '삼 퍼센트', '칠천선']) assert.ok(hasKoreanNumeral(s), s);
  for (const s of ['삼성전자', '사상 최고', '이란', '사주', '구조조정', '강남3구', '5.12%', '85주']) assert.ok(!hasKoreanNumeral(s), s);
});

test('SEO 태그 — LLM 태그를 살리고, 신뢰도 순으로 채워 25개에서 자른다', async () => {
  const { mergeTags, MAX_TAGS } = await import('../scripts/automation/seo-enhance.js');
  const llmTags = Array.from({ length: 22 }, (_, i) => `태그${i}`);
  const tags = mergeTags({
    primary: '미 10년물',
    llmTags: [...llmTags, '팔십오 주'],
    secondary: ['해석', '시대'],
    longTails: ['미 10년물 왜'],
    related: ['한국은행'],
    brand: ['BarroTube', 'Shorts'],
  });
  assert.equal(tags.length, MAX_TAGS);
  assert.equal(tags[0], '미 10년물');
  assert.equal(tags[1], '태그0', 'LLM 태그가 주 키워드 바로 뒤');
  assert.ok(!tags.includes('팔십오 주'), '한글 수사는 LLM 태그라도 거른다');
  assert.ok(!tags.includes('해석') && !tags.includes('한국은행'), '넘치면 낮은 출처부터 떨어진다');

  const few = mergeTags({ primary: 'p', llmTags: [], secondary: ['금리'], longTails: ['p 왜'], related: ['연준'], brand: ['BarroTube'] });
  assert.deepEqual(few, ['p', 'BarroTube', '금리', 'p 왜', '연준'], 'LLM 태그가 없으면 뒤쪽 출처가 채운다');
});
