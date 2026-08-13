import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * 프로덕션 코드만 훑는다.
 *
 * tests/ 는 제외한다 — channel-document.test.js 가 "개인 경로가 문서에서
 * 가려지는가"를 검증하려고 일부러 /Users/... 픽스처를 쓴다. 그건 하드코딩이
 * 아니라 redaction 테스트의 입력이다.
 * _legacy_paperclip/ 도 제외 — 봉인된 참조 구현이라 실행되지 않는다.
 */
function sourceFiles(dir = ROOT, acc = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'workspace', '.git', '_legacy_paperclip', 'logs', 'tests'].includes(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) sourceFiles(p, acc);
    else if (/\.(js|sh)$/.test(name)) acc.push(p);
  }
  return acc;
}

test('no source file hardcodes a personal home path', () => {
  // 다른 사용자·다른 머신에서 그대로 동작해야 한다.
  // 개인 경로는 폴백으로도 두지 않는다 — homedir() 로 푼다.
  const offenders = [];
  for (const f of sourceFiles()) {
    const src = readFileSync(f, 'utf-8');
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(\*|\/\/|#)/.test(line)) continue;      // 주석은 설명이라 허용
      if (/\/Users\/[a-z][a-z0-9_-]*\//i.test(line)) {
        offenders.push(`${f.replace(ROOT + '/', '')}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `hardcoded home path:\n${offenders.join('\n')}`);
});

test('data roots resolve from env first, then $HOME', () => {
  const files = sourceFiles().filter((f) => readFileSync(f, 'utf-8').includes('BARROTUBE_DATA'));
  assert.ok(files.length >= 5, 'several entry points must resolve the data root');
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    if (!/BARROTUBE_DATA\s*\|\|/.test(src)) continue;   // 읽기만 하는 곳은 통과
    assert.match(src, /homedir\(\)/,
      `${f.replace(ROOT + '/', '')} falls back without homedir()`);
  }
});

test('cron installer does not pin an nvm version', () => {
  // nvm 이 올라가면 죽은 경로가 된다. 실행 시점 해석이 정답.
  const src = readFileSync(join(ROOT, 'lib', 'install-cron.sh'), 'utf-8');
  assert.doesNotMatch(src, /\.nvm\/versions\/node\/v[0-9]/,
    'a pinned nvm version will break on upgrade');
  assert.match(src, /command -v node/, 'must discover node at install time');

  const guards = readFileSync(join(ROOT, 'lib', 'guards.sh'), 'utf-8');
  assert.match(guards, /ensure_node_on_path/, 'and again at run time');
});

test('the workspace symlink stays out of git', () => {
  // 심볼릭이 커밋되면 다른 머신에서 끊긴 링크가 된다.
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf-8');
  assert.match(ignore, /^workspace$/m, 'workspace must be gitignored');
  assert.match(ignore, /^\.env$/m, 'secrets must be gitignored');
});

test('doctor checks required agents by name, not by exact count', () => {
  // 개수 검사는 두 방향으로 틀린다: 에이전트가 늘면 멀쩡한데 RED 가 되고
  // (2026-08-13 실측 18/17), 엉뚱한 17개여도 통과한다.
  const src = readFileSync(join(ROOT, 'lib', 'doctor-cli.sh'), 'utf-8');
  assert.match(src, /REQUIRED_AGENTS/, 'must declare the required set');
  assert.match(src, /MISSING_AGENTS/, 'must report which one is missing');
  assert.doesNotMatch(src, /"\$AGENT_COUNT" = "1[0-9]"/,
    'an exact-count comparison breaks whenever an agent is added');

  // 필수 목록이 파이프라인 단계를 실제로 덮는지
  const required = /REQUIRED_AGENTS="([^"]+)"/s.exec(src);
  assert.ok(required, 'required list must be readable');
  const names = required[1].split(/\s+/).filter(Boolean);
  for (const core of ['ceo', 'writer', 'fact-checker', 'qa-reviewer', 'publisher']) {
    assert.ok(names.includes(core), `pipeline-critical agent missing from the list: ${core}`);
  }
});

test('docs no longer pin an agent count', () => {
  // 에이전트 문맥만 본다. SKILL.md 의 "12/12 게이트" 는 미디어 자산
  // (이미지 5 + 영상 5 + 인트로 + 썸네일) 이지 에이전트 수가 아니다.
  for (const f of ['README.md', 'SKILL.md', 'references/ARCHITECTURE.md', 'references/DOCTOR.md']) {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    assert.doesNotMatch(src, /\d+ ?(에이전트|agents)\b/i,
      `${f} pins an agent count that will drift`);
    assert.doesNotMatch(src, /Agents:\s*\d+\/\d+/i,
      `${f} shows a fixed agent ratio`);
  }
});
