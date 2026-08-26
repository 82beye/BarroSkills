import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveContentMode } from '../scripts/automation/fetch-market-snapshot.js';
import { parseFactcheckFindings } from '../scripts/automation/revise-script-factcheck.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = join(ROOT, 'lib', 'auto-pipeline.sh');
const INSTALL = join(ROOT, 'lib', 'install-cron.sh');
const PRODUCE = join(ROOT, 'scripts', 'automation', 'produce-episode.js');
const ROUTINES = join(ROOT, 'config', 'routines.json');
const RESEARCH = join(ROOT, 'scripts', 'automation', 'research-brief.js');
const SCRIPT = join(ROOT, 'scripts', 'automation', 'generate-script.js');
const FACTCHECK = join(ROOT, 'scripts', 'automation', 'run-factcheck.js');

test('cron pipeline keeps browser assets, render, and publish in fail-closed order', () => {
  const source = readFileSync(AUTO, 'utf8');
  const syntax = spawnSync('bash', ['-n', AUTO], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const chatgpt = source.indexOf('1. Chrome의 ChatGPT');
  const render = source.indexOf('run_or_echo node scripts/automation/produce-episode.js');
  const publish = source.indexOf('run_or_echo node scripts/automation/run-episode.js');
  assert.ok(chatgpt >= 0 && chatgpt < render && render < publish);

  // 2026-08-14: 모션 정본은 Grok 이다 — 피사체가 실제로 움직여야 화면이 산다.
  // 로컬 HyperFrames 는 브라우저가 막혔을 때 파이프라인이 멈추지 않게 하는 폴백이고,
  // produce-episode 의 S6c 가 클립이 비어 있을 때만 돌린다.
  // 기본값이 로컬로 뒤집히면 매일 정지 화면 같은 영상이 나간다.
  assert.match(source, /MOTION_ENGINE="\$\{BT_MOTION_ENGINE:-grok\}"/,
    '기본 모션 엔진은 Grok 이어야 한다');
  assert.ok(source.includes('2. 위 이미지가 모두 저장된 뒤에만 Chrome의 Grok'),
    '브라우저에 Grok 클립을 요구하는 절차가 있어야 한다');
  assert.ok(source.includes('로컬 HyperFrames 가 만든다'),
    'local-only 로 돌릴 때의 안내도 남아 있어야 한다');

  for (const required of [
    '40_assets/images/scene_${id}.png',
    '40_assets/videos/scene_${id}.mp4',
    '45_intro.png',
    '47_thumbnail.png',
    '바로경제_캐릭터시트.png',
    'MED 부정확 또는 미접지(grounded=false)',
    'ffprobe -v error',
    '-select_streams a:0',
    'shasum -a 256',
    'duplicate bytes',
    'Video audio 버튼이 aria-pressed=true',
    'Remove image/thumbnail',
    // 저장 방법은 "폴백"이 아니라 정본이다 — ChatGPT 미디어 뷰어에 다운로드 버튼이 없어서
    // 버튼을 찾던 에이전트가 marker 만 반복 생성하며 루프에 빠졌다(2026-08-17 EP-0097).
    "i.alt))",
    "await r.blob()",
    'marker보다 새 파일만 수락한다',
    '같은 허용을 다시 묻지 말고 계속한다',
    '프로필+composer',
    'S10 사람 승인 대기',
    'publish_remains_human_only',
    'exec --ephemeral',
    '--episode "$EP_ID" --platform "$PLATFORM" --from S11',
    '10_market_research.md',
    '20_strategy.md',
  ]) assert.ok(source.includes(required), `missing cron contract: ${required}`);
  assert.doesNotMatch(source, /scheduled-auto|S10 자율 승인/);

  const install = readFileSync(INSTALL, 'utf8');
  assert.match(install, /CODEX_BIN=.*which codex/);
  assert.doesNotMatch(install, /^\s*auto-pipeline\)$/m,
    'generic routine without --slot must not be installable');

  const produce = readFileSync(PRODUCE, 'utf8');
  assert.match(produce, /sceneIds\.every\(id => exists\(join\(p\.assetsDir, 'videos'/);
  assert.match(produce, /'--platform', platform/);

  // S6c 는 이미지가 다 있고 클립만 없을 때 로컬 엔진을 먼저 돌린 뒤에야 멈춘다.
  // 예전에는 그 자리에서 바로 exit 3 이었고, 무인 실행이 사람을 기다리며 끝났다.
  const motionRun = produce.indexOf('generate-motion.js');
  const exit3 = produce.indexOf('process.exit(3)');
  assert.ok(motionRun > 0 && motionRun < exit3,
    '로컬 모션 엔진 시도가 exit 3 보다 앞서야 한다');
  assert.match(produce, /!stillsReady \|\| motionDone \|\| platform !== 'shorts' \|\| motionEngine === 'none'/);
  assert.match(produce, /motionDone = motionExists\(\)/,
    '엔진을 돌린 뒤 파일을 다시 확인해야 한다 — 성공 여부를 에이전트 응답으로 믿지 않는다');

  // 모션 생성은 sceneEngine 분기 **밖**에 있어야 한다. media-render 분기 안에 갇혀 있던
  // 탓에 BT_IMAGE_ENGINE=openai 로 우회하면 videos/ 가 빈 채로 통과했고, S7 이 정지 이미지
  // 슬라이드쇼를 만들 뻔했다(2026-08-15 EP-2026-0094). 스틸을 브라우저가 구웠든 API 가
  // 구웠든 shorts 는 클립이 있어야 한다.
  const ensureFirst = produce.indexOf('ensureMotion();');
  const mediaRenderBranch = produce.indexOf("if (sceneEngine === 'media-render')");
  assert.ok(ensureFirst > 0 && mediaRenderBranch > 0 && ensureFirst < mediaRenderBranch,
    'ensureMotion() 이 sceneEngine 분기보다 앞서야 한다 (API 경로에서도 클립을 만든다)');
  assert.ok(produce.indexOf('ensureMotion();', ensureFirst + 1) > mediaRenderBranch,
    'API 로 스틸을 구운 직후에도 ensureMotion() 을 다시 불러야 한다 — 첫 호출은 스틸이 없어 지나간다');

  // S7 은 자막 층을 고른다. 기본은 Grok 모션 렌더 위에 HyperFrames 자막(references/CAPTIONS.md).
  // 어느 쪽이든 산출물이 55_render/video.mp4 라 QA·승인·게시는 그대로다.
  assert.match(produce, /BT_CAPTION_ENGINE \|\| 'hyperframes'/);
  assert.match(produce, /render-with-captions\.js/);
  assert.match(produce, /captionEngine === 'hyperframes'/);
  const capIdx = produce.indexOf('render-with-captions.js');
  const pilIdx = produce.indexOf('render-direct.js');
  assert.ok(capIdx > 0 && pilIdx > 0, '두 경로가 모두 살아 있어야 한다');
});

test('factcheck findings drive a rewrite loop before a human is paged', () => {
  // guards.factcheck_max_rewrites 와 AUTO-PIPELINE.md 는 오래전부터 "2회 시도 후 escalation" 이라
  // 적어 뒀는데 정작 루프가 코드에 없었다. 그래서 8/16·8/17 EP 가 Phase 6 에서 바로 멈췄다.
  // 설정·문서만 남고 코드가 사라지는 그 실패 모드를 여기서 고정한다.
  const guards = JSON.parse(readFileSync(join(ROOT, 'config', 'autonomy-pause.json'), 'utf8')).guards;
  assert.equal(typeof guards.factcheck_max_rewrites, 'number');

  const source = readFileSync(AUTO, 'utf8');
  assert.match(source, /factcheck_max_rewrites/, '재작성 상한을 설정에서 읽어야 한다');
  assert.match(source, /while factcheck_gate_blocks; do/, '게이트가 걸리면 루프를 돌아야 한다');
  assert.match(source, /revise-script-factcheck\.js/);
  assert.match(source, /run-factcheck\.js[\s\S]{0,120}--force/, '재작성 뒤 팩트체크를 다시 굴려야 한다');

  // run-factcheck 는 pass:false(HIGH 존재)여도 exit 0 이다 — 게이트가 high_risk_count 를
  // 직접 보지 않으면 근거 없는 주장이 그대로 렌더·게시까지 간다.
  assert.match(source, /high_risk_count/, 'HIGH 를 게이트가 직접 세야 한다');
  assert.match(source, /if \[ "\$high" -gt 0 \]; then return 0; fi/);

  // 상한에 닿기 전에 halt 하면 루프가 있으나 마나다.
  const loopStart = source.indexOf('while factcheck_gate_blocks; do');
  const haltInLoop = source.indexOf('halt_for_human "Phase 6 factcheck"', loopStart);
  const guardCheck = source.indexOf('"$FC_REWRITES" -ge "$FC_MAX_REWRITES"', loopStart);
  assert.ok(guardCheck > loopStart && guardCheck < haltInLoop,
    'halt 은 재작성 상한을 넘긴 뒤에만 일어나야 한다');

  // 리바이저는 심각도가 아니라 판정으로 고른다 — LOW 부정확이 남으면 게이트는 계속 걸리는데
  // 고칠 대상이 없어 루프가 상한까지 헛돈다.
  const reviser = readFileSync(join(ROOT, 'scripts', 'automation', 'revise-script-factcheck.js'), 'utf8');
  assert.match(reviser, /FIXABLE_VERDICTS = \['부정확', '미확인'\]/);
});

test('the browser pass pins the logged-in Chrome extension, not the runtime default', () => {
  // codex 의 브라우저 런타임 기본값은 in-app browser 를 우선하는데 거기엔 ChatGPT 세션이
  // 없다. 2026-08-18 EP-0098 무인 실행이 통째로 실패한 원인이 이것이다 — Chrome 은 계속
  // 떠 있었고 로그인도 유지돼 있었는데 에이전트는 로그인 화면을 봤다.
  const source = readFileSync(AUTO, 'utf8');
  assert.match(source, /agent\.browsers\.get\(\\?"extension\\?"\)/,
    'extension 브라우저를 명시적으로 잡아야 한다');
  assert.match(source, /getDefault\(\) 를 쓰지 마라|getDefault\(\) 는 in-app/,
    'getDefault 금지가 프롬프트에 있어야 한다');

  // 실패 원인이 halt 문구에 크레딧보다 먼저 와야 한다 — 브라우저가 정본이기 때문이다.
  assert.match(source, /BROWSER_FAIL_REASON/);
  const reason = source.indexOf('🌐 브라우저 실패 원인');
  const credit = source.indexOf('⛔ 이미지 API 크레딧 고갈');
  assert.ok(reason > 0 && credit > 0 && reason < credit,
    '브라우저 원인이 크레딧 안내보다 앞서야 한다');
});

test('browser output is captured by file redirect, never by a pipe', () => {
  // `| tee` 로 잡으면 타임아웃이 무력화된다 — codex 가 죽어도 그 자식(브라우저 호스트)이
  // 파이프의 쓰기단을 물고 있어 tee 가 안 끝나고, run_with_timeout 의 감시 대상은 codex 라
  // 아무도 그 대기를 깨지 못한다. 2026-08-18 EP-0098 이 25분을 이 상태로 멈춰 있었다.
  const source = readFileSync(AUTO, 'utf8');
  assert.match(source, /exec --ephemeral "\$MEDIA_PROMPT" > "\$BROWSER_LOG" 2>&1/);
  assert.ok(!/\| tee "\$BROWSER_LOG"/.test(source),
    'tee 파이프가 돌아오면 브라우저 단계가 타임아웃을 넘겨 매달린다');
});

test('Grok motion is canon — a missing clip halts instead of silently falling back', () => {
  // HyperFrames 는 스틸에 팬·줌을 걸 뿐이고 피사체가 움직이지 않는다. 조용히 대체되면
  // 덜 사는 화면이 매일 나간다 — EP-0096·0097·0098 이 전부 그렇게 게시됐고 운영자가
  // 육안으로 발견했다. 폴백으로 내보내려면 BT_MOTION_ENGINE=local-only 로 명시해야 한다.
  const source = readFileSync(AUTO, 'utf8');
  assert.match(source, /grok_motion_missing/);
  assert.match(source, /halt_for_human "Phase 7 Grok 모션"/);
  assert.match(source, /BT_MOTION_ENGINE=local-only/, '명시적 탈출구가 있어야 한다');

  // 멈출 때는 **무엇을 보라고** 알려 줘야 한다. 예전 문구는 Playwright/Cloudflare 를
  // 원인으로 지목했는데, 2026-08-26 EP-0116 의 실제 원인은 Finder 복사 타임아웃이었고
  // 클립 5개는 이미 ~/Downloads 에 받아져 있었다. 진단을 30분 태운 문구다.
  assert.match(source, /logs\/cron\/\$\{CRON_LOG_NAME\}\.err/,
    '컷별 실패 사유는 stdout 이 아니라 stderr 에 있다 — 어디를 볼지 알려 줘야 한다');
  assert.match(source, /~\/Downloads/,
    '이미 받아진 클립이 있는지 먼저 보게 해야 한다 (재생성은 쿼터·20분이다)');
  assert.ok(!/XAI_API_KEY/.test(source),
    '읽는 코드가 없는 키를 설정하라고 안내하면 안 된다');

  // 게이트는 motion 모드여야 한다. 기본값(full)은 인트로·썸네일까지 요구하는데 그 둘은
  // Phase 8 의 산출물이라, Phase 7 이 영원히 통과할 수 없다 —
  // EP-0114·EP-0116·EP-0117 이 이미지·클립 5/5 인 채로 이것 때문에 halt 했다.
  const motionGates = source.split('\n')
    .filter((l) => l.includes('media_assets_ready "$MEDIA_BASE"') && l.includes('local-only'));
  assert.equal(motionGates.length, 2, 'Grok 게이트는 시도 전·후 두 곳이다');
  for (const g of motionGates) {
    assert.match(g, /media_assets_ready "\$MEDIA_BASE" motion/,
      'Grok 게이트가 full 로 떨어지면 Phase 8 산출물을 요구해 영원히 멈춘다');
  }

  // 브라우저에 모션을 요구하는 지시가 살아 있어야 한다 — 이걸 끄면 애초에 Grok 을 안 연다.
  assert.match(source, /Grok Imagine에서 각 scene_NNN\.png를 첨부해 영상 5개를/);
  assert.ok(!/BT_GROK_MOTION/.test(source),
    '모션을 opt-in 으로 두면 정본이 폴백으로 뒤집힌다');
});

test('the Grok image pass is opt-in because this surface cannot attach', () => {
  // Grok 이미지 절차의 2단계가 "숨은 file input 에 시트 주입" 이라 이 표면에서는 반드시
  // 실패하는데, 켜 두면 BT_GROK_IMAGE_TIMEOUT(1800s)을 통째로 태우고 "Grok 으로 재시도"
  // 텔레그램까지 나가 사람을 오도한다 (2026-08-17 EP-0097 실측).
  const source = readFileSync(AUTO, 'utf8');
  assert.match(source, /BT_GROK_IMAGE:-0.*!= "1"/, '기본은 건너뛰기여야 한다');
  assert.match(source, /media_render_grok_skipped/);
  assert.ok(!/BT_SKIP_GROK_IMAGE/.test(source), '반전된 옛 플래그가 남으면 의미가 뒤집힌다');

  // 시트를 클립보드에 미리 올리던 블록은 죽은 코드다 — 첨부 자체를 안 한다.
  assert.ok(!/캐릭터 시트를 클립보드에 적재/.test(source),
    '오도하는 "적재 완료" 로그가 남으면 안 된다');
});

test('the browser pass reuses a seeded conversation instead of attaching the sheet', () => {
  // 이 Chrome 표면은 로컬 파일 첨부가 구조적으로 막혀 있다 — 숨은 input 주입·컴포저 파일
  // 선택 UI·Cmd+V 가 전부 실패하고(EP-0096·0097, 서로 다른 실행에서 반복), control-chrome
  // 스킬이 외부 Playwright MCP 사용도 금지한다. 첨부를 전제한 절차는 무인 실행에서 반드시 선다.
  const source = readFileSync(AUTO, 'utf8');
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'image-engines.json'), 'utf8'));

  assert.match(cfg.media_render.chatgpt_seed_conversation, /^https:\/\/chatgpt\.com\/c\//,
    '시트가 첨부된 시드 대화 URL 이 설정에 있어야 한다');
  assert.match(source, /chatgpt_seed_conversation/, '파이프라인이 설정에서 시드 URL 을 읽어야 한다');
  assert.match(source, /CHATGPT_SEED_CONVERSATION/);

  // 첨부를 다시 요구하는 문구가 살아나면 같은 실패로 돌아간다.
  assert.ok(!/setInputFiles/.test(source),
    '첨부 절차가 프롬프트에 남아 있으면 에이전트가 다시 첨부를 시도하다 멈춘다');
  assert.match(source, /파일을 첨부하지 마라/);

  // 시드가 없으면 조용히 진행하지 말고 멈춰야 한다 — 시트 없이 그리면 마시가 드리프트한다.
  const guard = source.indexOf('if [ -z "$CHATGPT_SEED_CONVERSATION" ]');
  assert.ok(guard > 0, '시드 미설정 시 halt 해야 한다');
});

test('shipping HyperFrames motion when Grok is canon reaches a human', () => {
  // Grok 은 피사체가 실제로 움직이고 HyperFrames 는 스틸에 팬·줌을 걸 뿐이다.
  // 폴백으로 나가도 QA 는 "hyperframes 5" 라고 적기만 해서 아무도 모른 채 게시됐다.
  const source = readFileSync(AUTO, 'utf8');
  assert.match(source, /_engines\.json/, '모션 엔진 매니페스트를 읽어야 한다');
  assert.match(source, /motion_fallback_shipped/);
  assert.match(source, /notify_telegram "🎞/, '폴백 사실이 사람에게 도착해야 한다');

  // 정본이 grok 일 때만 경고한다 — local-only 로 의도해서 돌린 회차까지 울리면 소음이 된다.
  const guard = source.indexOf('"$MOTION_ENGINE" = "grok"');
  const notify = source.indexOf('motion_fallback_shipped');
  assert.ok(guard > 0 && guard < notify);
});

test('a missing media-render thumbnail falls back instead of halting the render', () => {
  // 씬 이미지는 시트를 붙여 그려야 해서 브라우저가 정본이지만, 썸네일은 이미 만들어 둔
  // 씬 스틸을 배경으로 쓰고 글자는 로컬 합성이다 — 모델이 그릴 게 없으니 멈출 이유도 없다.
  // 2026-08-17 EP-0096: 씬·모션·인트로를 다 만들어 놓고 여기서 exit 3 이 나 렌더를 못 했다.
  const produce = readFileSync(PRODUCE, 'utf8');
  const branch = produce.indexOf("if (thumbEngine === 'media-render')");
  assert.ok(branch > 0);
  const tail = produce.slice(branch, branch + 1400);
  assert.match(tail, /S6e Thumbnail \(씬 스틸 폴백\)/, '누락 시 결정론 합성으로 이어져야 한다');
  assert.ok(!/process\.exit\(3\)/.test(tail), 'media-render 썸네일 누락이 더는 파이프라인을 세우면 안 된다');

  // 그 폴백이 성립하는 근거: 숫자는 헤드라인과 같은 씬에서만 뽑는다.
  const thumb = readFileSync(join(ROOT, 'scripts', 'automation', 'generate-thumbnail.js'), 'utf8');
  assert.match(thumb, /scenes\.find\(s => s\.role === 'hook'\)/);
  assert.ok(!/\.map\(s => s\.subtitle_text \|\| ''\)\.join\(' '\)/.test(thumb),
    '전 씬 subtitle 을 이어붙여 숫자를 고르면 다른 주장의 수치가 헤드라인에 붙는다');
});

test('a browser pass that runs out of context is topped up scene by scene', () => {
  // codex 한 번의 호출로 7개 자산을 다 만들라고 하면 컨텍스트를 다 쓰고 남은 컷 없이 끝난다
  // (2026-08-17 EP-0096: 170k 토큰으로 1/5장). 실패가 아니라 예산 소진이라 이어 만들면 된다.
  const source = readFileSync(AUTO, 'utf8');

  const bigPass = source.indexOf('exec --ephemeral "$MEDIA_PROMPT"');
  const topup = source.indexOf('media_render_chatgpt_topup');
  const grok = source.indexOf('media_render_grok_pass');
  assert.ok(bigPass > 0 && topup > bigPass && grok > topup,
    'top-up 은 큰 패스 뒤, Grok 패스 앞에 있어야 한다');

  // 무진전이면 멈춰야 한다 — 같은 씬에 codex 를 무한히 던지면 타임아웃까지 태운다.
  assert.match(source, /TOPUP_STALLED" -lt 2/);
  assert.match(source, /BT_CHATGPT_TOPUP_MAX:-6/);
  // 한 번에 한 씬만. 프롬프트가 다시 커지면 같은 소진에 빠진다.
  assert.match(source, /씬 \$\{NEXT_SCENE\} 이미지 한 장만/);
});

test('every autonomy guard is either read by the live pipeline or classified', () => {
  // 이 레포는 "설정에 노브가 있는데 읽는 코드가 없다" 를 두 번 겪었고, 둘 다 무인 운영
  // 중에만 드러났다: factcheck_max_rewrites(8/16·8/17 이틀 정지), budget_alert_threshold_pct
  // (90% 벽에 부딪힐 때까지 무경고). 노브를 추가하면 여기서 분류를 강제한다.
  const guards = Object.keys(JSON.parse(readFileSync(join(ROOT, 'config', 'autonomy-pause.json'), 'utf8')).guards);
  const live = ['lib/guards.sh', 'lib/auto-pipeline.sh']
    .map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');

  // 안전한 쪽이 하드코딩돼 있어 끄는 경로가 없는 항목. 노브는 무효지만 동작은 항상 켜져 있다.
  const hardcodedOn = {
    publish_requires_telegram_window: 'wait_telegram_reject_window 를 무조건 통과시킨다',
    publish_telegram_notify: 'notify_telegram 을 무조건 호출한다',
    serial_processing_enforced: 'guard_in_flight 락이 항상 직렬을 강제한다',
  };
  // Paperclip 전용. PAPERCLIP_DISABLED=1 이라 현행 크론 경로에서는 죽은 노브다.
  const legacyOnly = ['max_publish_per_day', 'max_new_series_per_day', 'accept_new_issues'];

  const unclassified = guards.filter((k) =>
    !live.includes(k) && !(k in hardcodedOn) && !legacyOnly.includes(k));
  assert.deepEqual(unclassified, [],
    `guard 가 늘었는데 읽는 코드도 분류도 없다: ${unclassified.join(', ')}`);

  // 분류가 낡지 않게 — legacy 로 미룬 노브가 실제로 legacy 에서만 읽히는지 확인한다.
  for (const k of legacyOnly) {
    assert.ok(!live.includes(k), `${k} 가 이제 라이브 코드에서 읽힌다 — legacyOnly 에서 빼라`);
  }
  // 무인 운영의 생명줄 둘은 반드시 라이브 코드가 읽어야 한다.
  for (const k of ['factcheck_max_rewrites', 'budget_alert_threshold_pct']) {
    assert.ok(live.includes(k), `${k} 를 읽는 코드가 사라졌다`);
  }
});

test('factcheck reviser reads real reports and skips verified claims', () => {
  const md = [
    '### [MED] Scene 001: "지수는 오늘 내렸습니다"',
    '- **주장**: 지수는 오늘 내렸습니다',
    '- **검증 결과**: 부정확',
    '- **근거**: 실제로는 지난 금요일 마감이다',
    '- **수정 제안**: "지수는 지난 금요일 내렸습니다."',
    '- **위험 사유**: 방영일과 거래일이 다르다',
    '',
    '### [MED] Scene 003: "안도감이 심리를 밀어 올렸습니다"',
    '- **주장**: 안도감이 심리를 밀어 올렸습니다',
    '- **검증 결과**: 미확인',
    '- **수정 제안**: "~라는 해석이 나옵니다."',
    '',
    '### [LOW] Scene 002: "에스앤피는 영점일칠 퍼센트 빠졌습니다"',
    '- **주장**: 에스앤피는 영점일칠 퍼센트 빠졌습니다',
    '- **검증 결과**: 사실',
    '- **근거**: 교차 확인됨',
  ].join('\n');

  const found = parseFactcheckFindings(md);
  assert.equal(found.length, 2, '사실로 판정된 주장은 고치지 않는다');
  assert.deepEqual(found.map((f) => f.scene_id), ['001', '003']);
  assert.deepEqual(found.map((f) => f.verdict), ['부정확', '미확인']);
  assert.equal(found[0].suggestion, '지수는 지난 금요일 내렸습니다.', '수정 제안의 감싼 따옴표를 벗겨야 한다');
  assert.match(found[0].evidence, /지난 금요일 마감/);
});

test('closed markets switch research to current issues and Sunday pre-open mode', () => {
  const routines = JSON.parse(readFileSync(ROUTINES, 'utf8'));
  for (const slot of Object.values(routines.slots)) {
    assert.match(slot.closed_market_policy, /최신 주식·경제 이슈/);
    assert.match(slot.closed_market_policy, /토요일/);
    assert.match(slot.closed_market_policy, /일요일/);
  }

  const research = readFileSync(RESEARCH, 'utf8');
  assert.match(research, /휴장일·주말 대체 규칙/);
  assert.match(research, /content_mode.*sunday_preopen/);
  assert.match(research, /traded_at/);
  assert.match(research, /strategy-\$\{slotName\}\.md/);

  const script = readFileSync(SCRIPT, 'utf8');
  assert.match(script, /\[MARKET RESEARCH\]/);
  assert.match(script, /\[CONTENT STRATEGY\]/);

  const pipeline = readFileSync(AUTO, 'utf8');
  assert.match(pipeline, /최신 주식·경제 이슈:/);
  assert.match(pipeline, /다음 장 전 이슈 정리:/);
  assert.match(pipeline, /auto_pipeline_content_mode/);
});

test('research fallback always creates S2 and S3 inputs from collected data', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'barrotube-research-'));
  try {
    writeFileSync(join(outDir, 'market-us-close.json'), JSON.stringify({
      content_mode: 'closed_market_issue',
      quotes: [{ symbol: '.INX', name: 'S&P 500', price_text: '1,234.56', change_pct: 0.5, traded_at: '2026-08-07' }],
    }));
    writeFileSync(join(outDir, 'news.json'), JSON.stringify({
      sources: [{ items: [{ title: 'Weekend market issue', link: 'https://example.com/issue', description: 'A sourced summary.' }] }],
    }));

    const result = spawnSync('node', [RESEARCH, '--slot', 'us-close', '--date', '2026-08-08', '--out-dir', outDir, '--fallback'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(outDir, 'research-us-close.md'), 'utf8'), /Weekend market issue/);
    assert.match(readFileSync(join(outDir, 'strategy-us-close.md'), 'utf8'), /# 콘텐츠 전략/);
    const topic = JSON.parse(readFileSync(join(outDir, 'topic-us-close.json'), 'utf8'));
    assert.equal(topic.content_mode, 'closed_market_issue');
    assert.equal(topic.fallback, true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('factcheck binds market claims to the episode research date', () => {
  const source = readFileSync(FACTCHECK, 'utf8');
  assert.match(source, /\[AUTHORITATIVE PIPELINE MARKET RESEARCH\]/);
  assert.match(source, /10_market_research\.md/);
  assert.match(source, /exact date\/traded_at/);
  assert.match(source, /Never substitute the previous trading day's close/);
});

test('market snapshot resolves weekends and exchange holidays without a calendar dependency', () => {
  const required = ['.INX', '.IXIC', '.DJI'];
  const quotes = (date) => required.map((symbol) => ({ symbol, traded_at: `${date}T16:00:00-04:00` }));

  assert.equal(resolveContentMode('us-close', '2026-08-08', quotes('2026-08-07'), required).content_mode, 'closed_market_issue');
  assert.equal(resolveContentMode('us-close', '2026-08-09', quotes('2026-08-07'), required).content_mode, 'sunday_preopen');
  assert.equal(resolveContentMode('us-close', '2026-08-11', quotes('2026-08-10'), required).content_mode, 'market_close');
  assert.equal(resolveContentMode('us-close', '2026-09-08', quotes('2026-09-04'), required).content_mode, 'closed_market_issue');

  // 월요일 06:00 KST 는 직전 세션이 일요일 — 새 종가가 없다. 금요일 종가는 토요일 편이 이미 썼다.
  // 여기서 market_close 로 새면 대본이 이틀 묵은 수치를 "오늘"이라 쓴다 (EP-2026-0096).
  assert.equal(resolveContentMode('us-close', '2026-08-17', quotes('2026-08-14'), required).content_mode, 'closed_market_issue');
  assert.equal(resolveContentMode('us-close', '2026-08-18', quotes('2026-08-17'), required).content_mode, 'market_close');
  assert.equal(resolveContentMode('kr-close', '2026-08-17', [
    { symbol: 'KOSPI', traded_at: '2026-08-14T18:59:00+09:00' },
    { symbol: 'KOSDAQ', traded_at: '2026-08-14T18:59:00+09:00' },
  ], ['KOSPI', 'KOSDAQ']).content_mode, 'closed_market_issue');
});

test('competitor intel runs before research and never blocks the pipeline', () => {
  const source = readFileSync(AUTO, 'utf8');

  // Phase 1 catch-up: 수집 → 분석 → (이후) 리서치 순서
  const fetchIdx = source.indexOf('fetch-competitor-stats.js');
  const analyzeIdx = source.indexOf('analyze-competitors.js');
  const researchIdx = source.indexOf('research-brief.js');
  assert.ok(fetchIdx >= 0, 'auto-pipeline must reference the competitor fetcher');
  assert.ok(fetchIdx < analyzeIdx, 'fetch must precede analyze');
  assert.ok(analyzeIdx < researchIdx, 'intel must land before research consumes it');

  // fail-soft: 경쟁 블록 안에는 fail_with_alert 가 없어야 한다.
  // 인텔은 EP 생산의 보조 입력이지 선행 조건이 아니다.
  // (앞뒤 단계는 fail-closed 라 블록 경계를 정확히 잘라야 한다)
  // COMPETITOR_SCAN 은 로그 줄에도 등장하므로 fetch 지점에서 역방향으로 if 문을 찾는다
  const scanStart = source.lastIndexOf('if [ "$COMPETITOR_SCAN"', fetchIdx);
  const scanEnd = source.indexOf('Phase 2', fetchIdx);
  assert.ok(scanStart >= 0 && scanEnd > scanStart, 'competitor scan block must be locatable');
  assert.doesNotMatch(source.slice(scanStart, scanEnd), /fail_with_alert/,
    'intel failure must not halt the pipeline');

  // 05:20 정기 스캔 산출물이 있으면 재사용해 쿼터를 이중 지출하지 않는다
  assert.match(source, /analysis-\$\{TODAY\}\.json/);
  assert.match(source, /경쟁 인텔 재사용/);
});

test('competitor-scan routine is installable and runs fail-soft', () => {
  const install = readFileSync(INSTALL, 'utf8');
  assert.match(install, /^\s*competitor-scan\)$/m, 'install-cron must know the routine');
  assert.match(install, /competitor-pipeline\.sh/);
  assert.match(install, /사용 가능:.*competitor-scan/, 'usage text must list it');

  const pipeline = join(ROOT, 'lib', 'competitor-pipeline.sh');
  const syntax = spawnSync('bash', ['-n', pipeline], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const src = readFileSync(pipeline, 'utf8');
  assert.match(src, /exit 0\s*$/m, 'pipeline must end with a hard exit 0');
  // 관측(수집·분석)은 autonomy-pause 와 무관하게 돈다 — 게이트는 핸드오프에만 있다
  assert.doesNotMatch(src, /^\s*guard_master_switch \|\| exit 0/m,
    'collection must not be gated by the publish pause; the gate belongs in intel-handoff.js');
});

test('intel handoff gates on autonomy-pause and stays off the Paperclip API', () => {
  const handoff = join(ROOT, 'scripts', 'automation', 'intel-handoff.js');
  const src = readFileSync(handoff, 'utf8');
  assert.match(src, /autonomy-pause\.json/, 'handoff must read the pause switch');
  assert.match(src, /queue\.jsonl/, 'handoff must record idempotency keys');
  assert.match(src, /status:\s*'planned'|planned/, 'series must land as planned, never auto-produced');
});

test('new competitor scripts never leak the Paperclip control-plane URL', () => {
  // doctor-cli.sh 가 격리 밖의 localhost:3100 을 YELLOW 로 판정한다.
  for (const f of ['analyze-competitors.js', 'intel-handoff.js', 'fetch-competitor-stats.js',
                   'resolve-competitor-channels.js', 'lib/competitor-analytics.js']) {
    const src = readFileSync(join(ROOT, 'scripts', 'automation', f), 'utf8');
    assert.doesNotMatch(src, /(localhost|127\.0\.0\.1):3100/, `${f} leaks the Paperclip API`);
  }
});

test('research-brief consumes competitor intel and records what it used', () => {
  const src = readFileSync(RESEARCH, 'utf8');
  assert.match(src, /경쟁 인텔 분석/, 'analysis file must be a declared input');
  assert.match(src, /content_gaps/, 'prompt must direct the model at the gaps');
  assert.match(src, /competitor_gap_used/, 'topic json must record the gap it acted on');
  assert.match(src, /avoided_duplicates/);
  assert.match(src, /competitor_intel_at/);
});

test('install-cron supports multiple daily times via a StartCalendarInterval array', () => {
  // launchd 는 dict 배열도 받는다. 인자가 같은 루틴은 라벨을 나눌 필요가 없다.
  const src = readFileSync(INSTALL, 'utf8');
  assert.match(src, /StartCalendarInterval<\/key>\s*\n\s*<array>/,
    'array form must be generated for comma-separated times');
  assert.match(src, /time_display/, 'the original spec must survive for output');
  assert.doesNotMatch(src, /schedule: \$time_spec/,
    'the __multi__ sentinel must never reach the operator');
});

test('competitor-scan runs twice daily, ahead of both briefing slots', () => {
  const policy = JSON.parse(readFileSync(join(ROOT, 'config', 'competitor-channels.json'), 'utf8'));
  const times = policy.tracking?.scan_times_kst ?? [];
  assert.deepEqual(times, ['05:20', '15:20'], 'one scan before each slot');

  const routines = JSON.parse(readFileSync(ROUTINES, 'utf8'));
  const slots = routines.routines ?? routines.slots ?? {};
  for (const [slot, cfg] of Object.entries(slots)) {
    const publishHour = parseInt(String(cfg.publish_at ?? '').slice(0, 2), 10);
    if (!Number.isFinite(publishHour)) continue;
    // 각 슬롯보다 앞선 스캔이 하나는 있어야 인텔이 그날 리서치에 닿는다
    const cronHour = slot === 'us-close' ? 6 : 16;
    assert.ok(times.some((t) => parseInt(t.slice(0, 2), 10) < cronHour),
      `no scan precedes ${slot} (cron ${cronHour}:00)`);
  }
});

test('quota target accounts for the twice-daily cadence', () => {
  const metrics = readFileSync(join(ROOT, 'scripts', 'automation', 'intel-metrics.js'), 'utf8');
  const m = /quota_per_day:\s*\{\s*max:\s*(\d+)/.exec(metrics);
  assert.ok(m, 'quota target must be declared');
  const target = Number(m[1]);
  const policy = JSON.parse(readFileSync(join(ROOT, 'config', 'competitor-channels.json'), 'utf8'));
  const channels = (policy.channels ?? []).filter((c) => c.active !== false).length;
  const perDay = channels * 3 * (policy.tracking?.scan_times_kst?.length ?? 1);
  assert.ok(target >= perDay,
    `target ${target} must cover the routine cost ${perDay} (${channels}ch × 3u × ${policy.tracking.scan_times_kst.length} scans)`);
  assert.ok(perDay < policy.quota.daily_cap_units, 'routine cost must stay under the self-imposed cap');
});

test('publishing cadence is 2 on weekdays and 1 on weekends', () => {
  const routines = JSON.parse(readFileSync(ROUTINES, 'utf8'));
  assert.deepEqual(
    { weekday: routines.publishing_cadence?.weekday, weekend: routines.publishing_cadence?.weekend },
    { weekday: 2, weekend: 1 });

  // us-close 는 매일 (토=금요일 미국장, 일=sunday_preopen)
  assert.equal(routines.slots['us-close'].cron, '06:00');
  // kr-close 는 평일만 — 토요일 16:00 은 이미 하루 지난 금요일 종가라 새 정보가 없다
  assert.equal(routines.slots['kr-close'].cron, 'Mon-Fri 16:00');
});

test('install-cron expands a weekday range without bash 4 associative arrays', () => {
  // macOS 기본 bash 는 3.2 다. declare -A 를 쓰면 조용히 분기를 건너뛴다 (실측).
  const src = readFileSync(INSTALL, 'utf8');
  assert.match(src, /weekday_index\(\)/, 'range mapping must use a case-based helper');
  assert.doesNotMatch(src, /local -A |declare -A /, 'bash 3.2 has no associative arrays');
  assert.match(src, /Mon\|Tue\|Wed\|Thu\|Fri\|Sat\|Sun\)-\(/, 'range form must be parsed');
});

test('a weekday-ranged install produces one calendar entry per day', () => {
  const out = mkdtempSync(join(tmpdir(), 'bt-cron-'));
  try {
    const r = spawnSync('bash', [INSTALL, 'install', 'kr-close', 'Mon-Fri 16:00'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, DRY_RUN: '1', HOME: out },
    });
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(
      join(out, 'Library', 'LaunchAgents', 'com.barroskills.barrotube.kr-close.plist'), 'utf8');
    assert.match(plist, /<array>/, 'must emit an array, not a single dict');
    const weekdays = [...plist.matchAll(/<key>Weekday<\/key>\s*<integer>(\d)<\/integer>/g)].map((m) => m[1]);
    assert.deepEqual(weekdays, ['1', '2', '3', '4', '5'], 'Mon..Fri');
    assert.doesNotMatch(plist, /__multi__/, 'the sentinel must not leak into the plist');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('cron scripts resolve node at runtime, not from a baked-in nvm path', () => {
  // launchd 는 PATH 가 비어 있고, install-cron.sh 가 박아 넣은 절대경로는
  // nvm 버전이 올라가는 순간 죽는다 (v24.11.1 → v26 이면 끝).
  const guards = readFileSync(join(ROOT, 'lib', 'guards.sh'), 'utf8');
  assert.match(guards, /ensure_node_on_path/, 'guards must resolve node itself');
  assert.match(guards, /nvm\/alias\/default/, 'must follow the nvm default alias');
  assert.match(guards, /opt\/homebrew\/bin/, 'must fall back beyond nvm');

  // node 스크립트는 래퍼를 거쳐야 같은 보정을 받는다
  const install = readFileSync(INSTALL, 'utf8');
  assert.match(install, /run-node\.sh/, 'node scripts must go through the wrapper');
  assert.doesNotMatch(install, /<string>\$\{NODE_BIN\}<\/string>\s*\n\s*<string>\$\{script_path\}/,
    'a baked node path must not be the direct executable');
});

test('the pipeline survives a bare launchd PATH', () => {
  const r = spawnSync('bash', [join(ROOT, 'lib', 'competitor-pipeline.sh')], {
    encoding: 'utf8', timeout: 120_000,
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', DRY_RUN: '1' },
  });
  assert.equal(r.status, 0, `must exit 0 under a bare PATH: ${r.stderr}`);
  assert.match(r.stdout, /경쟁 인텔 루틴/);
  assert.doesNotMatch(r.stdout + r.stderr, /node: command not found|node 를 찾을 수 없습니다/);
});
