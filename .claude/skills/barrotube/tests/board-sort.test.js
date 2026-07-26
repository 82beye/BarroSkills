import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// 에피소드 보드(tools/board/index.html)의 정렬 계약:
//  1) 단계 정렬은 문자열이 아니라 진행 순서를 따른다 — "S10" > "S9b" > "S9" > "S8"
//  2) 기본값은 EP 번호 내림차순
//  3) updated 미기록(null) EP 는 내림차순에서 항상 뒤로 밀린다
// 보드는 빌드 단계가 없는 단일 HTML 이라, 정렬 블록만 잘라내 sandbox 에서 평가한다.

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, '..', 'tools', 'board', 'index.html');

function loadSortModule() {
  const html = readFileSync(BOARD, 'utf-8');
  const start = html.indexOf('/* ── 정렬 ──');
  const end = html.indexOf('function render(){', start);
  assert.ok(start > 0 && end > start, 'index.html 에서 정렬 블록을 찾지 못했습니다');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

const eps = (...specs) => specs.map(s => ({
  id: s.id, topic: s.topic ?? null,
  current_stage: s.stage ?? null, updated: s.updated ?? null,
}));
const ids = list => list.map(e => e.id);

test('stageRank: 문자열 비교로는 틀리는 순서를 바로잡는다', () => {
  const { stageRank } = loadSortModule();
  assert.ok(stageRank('S10') > stageRank('S9b'), 'S10 이 S9b 보다 뒤 단계');
  assert.ok(stageRank('S9b') > stageRank('S9'), 'S9b 가 S9 보다 뒤 단계');
  assert.ok(stageRank('S9') > stageRank('S8'));
  assert.ok(stageRank('S12') > stageRank('S11'));
  assert.equal(stageRank(null), -1, '단계 미기록은 최하위');
  assert.equal(stageRank('알수없음'), -1);
});

test('기본값 = EP 번호 내림차순', () => {
  const { sortEpisodes } = loadSortModule();
  const list = eps({ id: 'EP-2026-0007' }, { id: 'EP-2026-0065' }, { id: 'EP-2026-0012' });
  assert.deepEqual(ids(sortEpisodes(list, 'id', 'desc')),
    ['EP-2026-0065', 'EP-2026-0012', 'EP-2026-0007']);
});

test('오름차순 전환', () => {
  const { sortEpisodes } = loadSortModule();
  const list = eps({ id: 'EP-2026-0007' }, { id: 'EP-2026-0065' }, { id: 'EP-2026-0012' });
  assert.deepEqual(ids(sortEpisodes(list, 'id', 'asc')),
    ['EP-2026-0007', 'EP-2026-0012', 'EP-2026-0065']);
});

test('단계 정렬은 진행 순서를 따른다', () => {
  const { sortEpisodes } = loadSortModule();
  const list = eps(
    { id: 'EP-2026-0001', stage: 'S9' },
    { id: 'EP-2026-0002', stage: 'S10' },
    { id: 'EP-2026-0003', stage: 'S9b' },
    { id: 'EP-2026-0004', stage: 'S8' },
  );
  assert.deepEqual(ids(sortEpisodes(list, 'stage', 'desc')),
    ['EP-2026-0002', 'EP-2026-0003', 'EP-2026-0001', 'EP-2026-0004']);
});

test('updated 미기록 EP 는 내림차순에서 뒤로 밀린다', () => {
  const { sortEpisodes } = loadSortModule();
  const list = eps(
    { id: 'EP-2026-0001', updated: null },
    { id: 'EP-2026-0002', updated: '2026-04-24T15:35:47.148Z' },
    { id: 'EP-2026-0003', updated: '2026-07-25T10:00:00.000Z' },
  );
  assert.deepEqual(ids(sortEpisodes(list, 'updated', 'desc')),
    ['EP-2026-0003', 'EP-2026-0002', 'EP-2026-0001']);
});

test('동점은 EP 번호로 갈음한다 (정렬 방향 유지)', () => {
  const { sortEpisodes } = loadSortModule();
  const list = eps(
    { id: 'EP-2026-0010', stage: 'S11' },
    { id: 'EP-2026-0044', stage: 'S11' },
    { id: 'EP-2026-0027', stage: 'S11' },
  );
  assert.deepEqual(ids(sortEpisodes(list, 'stage', 'desc')),
    ['EP-2026-0044', 'EP-2026-0027', 'EP-2026-0010']);
  assert.deepEqual(ids(sortEpisodes(list, 'stage', 'asc')),
    ['EP-2026-0010', 'EP-2026-0027', 'EP-2026-0044']);
});

test('주제는 한글 가나다순으로 비교한다', () => {
  const { sortEpisodes } = loadSortModule();
  const list = eps(
    { id: 'EP-2026-0001', topic: '테슬라 쇼크' },
    { id: 'EP-2026-0002', topic: '금리 인하' },
    { id: 'EP-2026-0003', topic: null },
  );
  assert.deepEqual(ids(sortEpisodes(list, 'topic', 'asc')),
    ['EP-2026-0003', 'EP-2026-0002', 'EP-2026-0001']);
});
