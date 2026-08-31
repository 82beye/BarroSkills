// 성장 루프 배선 계약 — 어느 한 조각이 조용히 빠지면 루프 전체가 관상용이 된다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('growth-pipeline.sh — bash 문법 유효, 항상 exit 0, 텔레그램 정책 존재', () => {
  const syntax = spawnSync('bash', ['-n', join(ROOT, 'lib/growth-pipeline.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const src = read('lib/growth-pipeline.sh');
  assert.ok(src.trimEnd().endsWith('exit 0'), '마지막은 exit 0 고정');
  assert.ok(src.includes('notify_telegram'));
  // 주간 회고는 directives *앞* — 뒤면 월요일에 방금 종료된 실험이 그날 EP 에 주입된다
  const weekly = src.indexOf('growth-weekly.js');
  const directives = src.indexOf('growth-directives.js');
  assert.ok(weekly > 0 && weekly < directives, '주간 회고가 처방 생성보다 앞');
  assert.ok(src.includes('--if-due'), '월요일 회차 유실 시 화~일 아침 만회');
  // 알림 게이트는 OVERALL= 줄 존재 기준 — KPI 실패 시 빈 등급 알림 방지 (리뷰 2026-08-31)
  assert.ok(src.includes('[ -n "$OVERALL_LINE" ]'));
  // parse_mode=HTML 이라 <·& 이스케이프 없이는 메시지가 조용히 소실된다
  assert.ok(src.includes('tg_escape'));
});

test('auto-pipeline.sh — 성장 처방을 Phase 0 에서 정의하고 Phase 3 에서 설치한다', () => {
  const src = read('lib/auto-pipeline.sh');
  const hoist = src.indexOf('GROWTH_DIRECTIVES_MD=');
  const install = src.indexOf('06_growth_directives.md');
  assert.ok(hoist > 0, 'Phase 0 hoist (set -u 대비)');
  assert.ok(install > hoist, 'Phase 3 설치');
  // desk briefing 과 같은 소프트 정책 — 없으면 건너뛰지 fail_with_alert 하지 않는다
  const block = src.slice(install - 400, install + 200);
  assert.ok(!block.includes('fail_with_alert'), '성장 처방 부재가 파이프라인을 세우면 안 된다');
  // FORCE_TOPIC(STRATEGY_MD="") 경로에도 설치돼야 실험 대상에서 안 빠진다 (리뷰 2026-08-31)
  assert.ok(src.includes('STRATEGY_MD 블록 밖에서 설치'), 'FORCE_TOPIC 경로 포함 마커');
});

test('대본·메타데이터가 성장 처방을 소비한다 (경계 지시 포함)', () => {
  const script = read('scripts/automation/generate-script.js');
  assert.ok(script.includes('06_growth_directives.md'));
  assert.ok(script.includes('GROWTH DIRECTIVES'));
  assert.ok(/왜곡하지 마라/.test(script), '사실 왜곡 금지 경계');
  const meta = read('scripts/automation/generate-metadata.js');
  assert.ok(meta.includes('06_growth_directives.md'));
  assert.ok(meta.includes('그쪽이 항상 우선'), '표기 규칙·공인 SEO 우선순위 명시');
  assert.ok(meta.includes('클릭베이트 금지 규칙'), '클릭베이트 금지가 tiebreaker 에 포함');
  assert.ok(meta.includes('적용 대상이 제목'), '실험 적용 대상 제한');
  assert.ok(script.includes('적용 대상이 대본'), '대본 쪽 실험 적용 대상 제한');
});

test('install-cron.sh — growth 루틴이 등록돼 있다', () => {
  const src = read('lib/install-cron.sh');
  assert.ok(src.includes('growth-pipeline.sh'));
  assert.ok(/growth\)/.test(src));
});

test('OAuth SCOPE 는 자동화가 넓히지 않는다 — analytics 스코프는 운영자 재동의 전용', () => {
  // renew-youtube-oauth.js 는 크론에서 AppleScript 로 동의 화면을 자동 클릭한다.
  // 여기 SCOPE 에 yt-analytics 가 섞이면 운영자 모르게 권한이 넓어진다 — 금지.
  for (const f of ['scripts/automation/setup-youtube-oauth.js', 'scripts/automation/renew-youtube-oauth.js']) {
    const m = read(f).match(/const SCOPE = '([^']+)'/);
    assert.ok(m, `${f} SCOPE 상수`);
    assert.ok(!m[1].includes('yt-analytics'), `${f} 가 analytics 스코프를 자동 요청하면 안 된다`);
  }
  // 수집기는 스코프 없음(401/403)을 조용히 강등해야 한다
  const fetcher = read('scripts/automation/fetch-channel-stats.js');
  assert.ok(fetcher.includes('403'));
  assert.ok(fetcher.includes("process.exit(0)"), '관측 실패는 exit 0');
});

test('config/growth.json — KPI 정의와 실험 백로그가 유효하다', () => {
  const cfg = JSON.parse(read('config/growth.json'));
  assert.equal(cfg.north_star, 'weekly_net_subs');
  for (const [id, k] of Object.entries(cfg.kpis)) {
    assert.ok(Number.isFinite(k.green) && Number.isFinite(k.yellow), `${id} 임계`);
    assert.ok(k.label, `${id} 라벨`);
  }
  assert.ok(cfg.kpis.publish_consistency_7d.planned_per_week === 13, 'us7+kr5+re1');
  const ids = cfg.experiments.backlog.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, '실험 id 중복 금지');
  assert.ok(cfg.experiments.backlog.every((b) => b.directive));
  // 실험은 단일 변수 판정이라 적용면(제목/대본)이 명시돼야 한다 (리뷰 2026-08-31)
  assert.ok(cfg.experiments.backlog.every((b) => ['metadata', 'script'].includes(b.target)));
  // 처방 문구는 측정 정의와 1:1 — bracket 은 선두(^[), split 은 콜론·파이프·슬래시
  const e1 = cfg.experiments.backlog.find((b) => b.id === 'EXP-01-title-bracket');
  assert.ok(/시작|맨 앞/.test(e1.directive));
  const e4 = cfg.experiments.backlog.find((b) => b.id === 'EXP-04-no-split-title');
  assert.ok(e4.directive.includes('콜론') && !e4.directive.includes('물결'));
  // 죽은 설정 키 금지 — notify 정책은 growth-pipeline.sh 하드코딩이 정본
  assert.equal(cfg.notify, undefined);
});
