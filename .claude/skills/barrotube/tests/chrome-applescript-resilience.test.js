import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'automation', 'lib', 'chrome-applescript.js'), 'utf8');

test('창 id 가 무효해지면 탭 id 로 전체 창을 다시 훑는다', () => {
  // 2026-09-25 마켓맵 커뮤니티 게시가 -1728 로 죽었다. 9창 94탭 환경에서 창 id 를
  // 바로 집으면 창이 닫히거나 순서가 바뀔 때 참조가 깨진다. 탭 id 는 유지된다.
  assert.match(SRC, /catch \(e\) \{\s*\n\s*target = null;/, '탭 재탐색 폴백이 없다');
  assert.match(SRC, /String\(ts\[j\]\.id\(\)\) === String\(argv\[3\]\)/, '탭 id 로 찾지 않는다');
  assert.match(SRC, /탭을 찾지 못했습니다/, '못 찾았을 때 사유가 불분명하다');
});

test('-1728 은 재시도하고 권한 오류(-1743)는 재시도하지 않는다', () => {
  // 권한은 다시 불러도 같다 — 재시도하면 시간만 버린다.
  assert.match(SRC, /const STALE_OBJECT = \/\\\(-1728\\\)\//);
  assert.match(SRC, /if \(!denied && STALE_OBJECT\.test\(stderr\) && attempt < 3\)/,
    '재시도 조건이 권한 오류를 걸러내지 않는다');
  assert.match(SRC, /err\.code = 'CHROME_STALE_OBJECT'/, '소진 후에도 원인이 코드로 안 드러난다');
});

test('재시도는 유한하다', () => {
  // 무한 재시도는 크론을 붙잡아 다음 회차까지 밀어낸다.
  const m = SRC.match(/attempt < (\d+)/);
  assert.ok(m, '재시도 상한이 없다');
  assert.ok(Number(m[1]) >= 2 && Number(m[1]) <= 5, `상한이 비정상: ${m[1]}`);
  assert.match(SRC, /attempt: attempt \+ 1/, '시도 횟수가 증가하지 않는다 — 무한 루프');
});

test('JXA 스크립트가 문법적으로 유효하다', () => {
  // 이 문자열은 osascript 로만 평가돼 node --check 가 못 잡는다.
  const m = SRC.match(/const SCRIPT = `([\s\S]*?)`;/);
  assert.ok(m, 'SCRIPT 상수가 사라졌다');
  const body = m[1];
  // 괄호·중괄호 균형만이라도 확인한다.
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    const o = (body.match(new RegExp(`\\${open}`, 'g')) || []).length;
    const c = (body.match(new RegExp(`\\${close}`, 'g')) || []).length;
    assert.equal(o, c, `${open}${close} 불균형: ${o} vs ${c}`);
  }
  assert.match(body, /action === 'open'/);
});
