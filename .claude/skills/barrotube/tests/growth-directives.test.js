import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDirective, titleDirectives, exhaustedTopics, cut } from '../scripts/automation/growth-directives.js';
import { isoWeek, judgeExperiment, nearestKpi } from '../scripts/automation/growth-weekly.js';

const ANALYSIS = {
  patterns: { title_features: [
    { feature: 'has_bracket', n_with: 87, n_without: 255, lift: 2.84, direction: 'positive' },
    { feature: 'has_number', n_with: 177, n_without: 165, lift: 1.86, direction: 'positive' },
    { feature: 'has_percent', n_with: 36, n_without: 306, lift: 1.45, direction: 'positive' },
    { feature: 'has_superlative', n_with: 56, n_without: 286, lift: 0.64, direction: 'negative' },
    { feature: 'has_split', n_with: 5, n_without: 300, lift: 0.1, direction: 'negative' }, // 표본<10 → 제외
  ] },
  content_gaps: [{ term: '관세', gap_score: 3.1, comp_df: 2, comp_views: 1526250, evidence: [] }],
  blue_ocean_keywords: [{ keyword: '매파적 워시', score: 0.75, competition: 0.25 }],
  outliers: [{ title: '워시 물가 2% 될 때까지 멈추지 않는다 어쩌고 매우 긴 제목이 여기 있다', channel: '오선', multiple: 21 }],
};

test('titleDirectives — positive 상위 2 + negative, 표본 10 미만 피처 제외', () => {
  const d = titleDirectives(ANALYSIS.patterns.title_features);
  assert.ok(d.some((l) => l.includes('피하기') && l.includes('최상급')));
  assert.equal(titleDirectives(undefined).length, 0);
});

/**
 * has_bracket 은 경쟁 채널 **조회** lift 로는 상위지만 처방하지 않는다.
 * 2026-09-16 우리 채널 **구독** 실측(2026-08-25~09-16, 26편): 대괄호가 붙은 19편은
 * 구독/1k뷰 0.77, 안 붙은 7편은 2.41. 태그가 제목 앞 8자를 먹으면서 '왜'를 말할 자리가
 * 사라졌고(story 동반율 86%→16%) 주간 순증 구독이 11→2 가 됐다.
 * 북극성이 weekly_net_subs 이므로 조회 처방과 충돌하면 구독 쪽을 따른다.
 */
test('titleDirectives — 대괄호는 경쟁 lift 가 높아도 쓰기 처방하지 않는다', () => {
  const d = titleDirectives([
    { feature: 'has_bracket', n_with: 120, n_without: 222, lift: 3.46, direction: 'positive' },
    { feature: 'has_number', n_with: 177, n_without: 165, lift: 1.86, direction: 'positive' },
  ]);
  assert.equal(d.some((l) => l.includes('쓰기') && l.includes('대괄호')), false,
    '대괄호를 쓰라고 처방하면 구독 전환이 무너진다');
  assert.ok(d.some((l) => l.includes('쓰기') && l.includes('수치')), '다른 positive 는 그대로 나온다');
});

test('titleDirectives — has_split 문구는 측정 문자(콜론·파이프·슬래시)를 지목한다', () => {
  const d = titleDirectives([
    { feature: 'has_split', n_with: 183, n_without: 159, lift: 0.55, direction: 'negative' },
  ]);
  assert.ok(d[0].includes('콜론') && d[0].includes('파이프'));
  assert.ok(!d[0].includes('대시') && !d[0].includes('물결'));
});

test('titleDirectives — 최상급이 positive 로 잡혀도 쓰기 처방하지 않는다 (클릭베이트 금지 충돌)', () => {
  const d = titleDirectives([
    { feature: 'has_superlative', n_with: 56, n_without: 286, lift: 2.1, direction: 'positive' },
    { feature: 'has_number', n_with: 177, n_without: 165, lift: 1.86, direction: 'positive' },
  ]);
  assert.ok(!d.some((l) => l.includes('쓰기') && l.includes('최상급')));
  assert.ok(d.some((l) => l.includes('쓰기') && l.includes('수치')));
});

test('cut — 서로게이트 페어(이모지) 한가운데를 자르지 않는다', () => {
  const s = 'a📉b';           // 📉 는 UTF-16 2유닛
  assert.equal(cut(s, 2), 'a'); // 반쪽 절단 대신 페어 전체 제거
  assert.equal(cut(s, 3), 'a📉');
  assert.equal(cut('abc', 2), 'ab');
});

test('buildDirective — 실험이 맨 위, 상한 준수, 왜곡 금지 문구 포함', () => {
  const md = buildDirective({
    date: '2026-08-31', slot: 'us-close', analysis: ANALYSIS,
    kpi: { kpis: [{ id: 'x', label: '히트율(7d)', grade: 'RED', display: '5%' }], top_videos: [{ title: '잘된 영상', vpd: 900 }] },
    experiment: { id: 'EXP-01-title-bracket', directive: '제목을 [대괄호 태그]로 시작한다', target: 'metadata' },
  });
  assert.ok(md.length <= 3400);
  const expIdx = md.indexOf('이번 주 실험');
  const titleIdx = md.indexOf('제목 패키징');
  assert.ok(expIdx > 0 && expIdx < titleIdx, '실험 지시가 제목 패키징보다 앞');
  assert.ok(md.includes('적용 대상: 제목(메타데이터)'), '실험 적용 대상 표기');
  assert.ok(md.includes('소진된 화제'));
  assert.ok(md.includes('왜곡'));
  assert.ok(md.includes('🔴 히트율'));
});

test('buildDirective — 분석·KPI 전무여도 유효한 문서를 낸다 (성장 루프 실패일)', () => {
  const md = buildDirective({ date: '2026-08-31', slot: 'kr-close', analysis: null, kpi: null, experiment: null });
  assert.ok(md.startsWith('# 성장 지시'));
  assert.ok(md.includes('왜곡'));
});

test('exhaustedTopics — 제목을 45자로 자른다', () => {
  const [line] = exhaustedTopics(ANALYSIS.outliers);
  assert.ok(line.includes('오선'));
  assert.ok(line.length < 80);
});

test('isoWeek — 연 경계 포함', () => {
  assert.equal(isoWeek(new Date('2026-08-31T12:00:00Z')), '2026-W36');
  assert.equal(isoWeek(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  assert.equal(isoWeek(new Date('2027-01-01T12:00:00Z')), '2026-W53'); // 2027-01-01 은 금요일 → ISO 로는 전년 53주
});

test('judgeExperiment — 20% 개선=success, 20% 악화=fail, 표본 없음=inconclusive', () => {
  const kpi = (hit, like) => ({ kpis: [
    { id: 'video_hit_rate_7d', value: hit }, { id: 'like_rate_7d', value: like },
  ] });
  assert.equal(judgeExperiment(kpi(0.10, 0.010), kpi(0.15, 0.010)).verdict, 'success');
  assert.equal(judgeExperiment(kpi(0.10, 0.010), kpi(0.07, 0.010)).verdict, 'fail');
  assert.equal(judgeExperiment(kpi(0.10, 0.010), kpi(0.11, 0.010)).verdict, 'inconclusive');
  assert.equal(judgeExperiment(kpi(null, null), kpi(0.2, 0.02)).verdict, 'inconclusive');
  // 하나 개선 + 하나 12% 악화 → success 아님 (guard)
  assert.equal(judgeExperiment(kpi(0.10, 0.010), kpi(0.15, 0.0088)).verdict, 'inconclusive');
});

test('nearestKpi — date 이전 가장 가까운 파일', () => {
  const files = ['2026-08-20.json', '2026-08-25.json', '2026-08-31.json', 'junk.txt'];
  assert.equal(nearestKpi('/nonexistent', '2026-08-26', files), '2026-08-25');
  assert.equal(nearestKpi('/nonexistent', '2026-08-31', files), '2026-08-31');
  assert.equal(nearestKpi('/nonexistent', '2026-08-01', files), null);
});
