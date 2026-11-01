#!/usr/bin/env node
/**
 * repair-workspace.js — SRE 가 운영 코드를 고치는 유일한 길: 격리 사본 → 리뷰 승인 → 반영 → (필요하면) 롤백
 *
 * 2026-10-07 운영자 결정: 장애 수정·재개는 페이퍼클립 에이전트가 맡는다. 다만 에이전트가 운영 트리를 바로
 * 고치면 회차 도중 코드가 바뀌고, 무엇이 언제 바뀌었는지 남지 않는다. 그래서:
 *   start   운영 트리를 사본(tree)과 원본 스냅샷(base)으로 뜬다 — 커밋 여부와 무관하게 「지금 돌고 있는 코드」 기준
 *   diff    base→tree 패치·바뀐 파일·보호 경로를 만든다
 *   verdict 리뷰어가 승인/반려를 남긴다 — 패치 해시에 묶인다(리뷰 뒤에 바뀐 패치는 승인 무효)
 *   apply   승인·보호 경로·운영 파일 변경 여부·하루 한도·사본 전체 테스트를 확인하고 반영, 원본은 백업
 *   rollback 백업으로 되돌린다
 *   show    리뷰어에게 줄 경로들
 *
 * 작업장: workspace/ops/repairs/<id>/{tree,base,patch.diff,files.json,verdict.json,applied.json,backup/}
 * 비밀(.env*)은 사본에 들어가지 않는다.
 *
 * Usage: node scripts/automation/paperclip/repair-workspace.js <start|diff|show|verdict|apply|rollback> <id> [approve|reject "<사유>"]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { OPS, ROOT, kstParts, readJson, writeJsonAtomic } from './lib.js';

const COPY = ['lib', 'scripts', 'config', 'tests', 'references', 'docs', 'templates', 'schemas', 'SKILL.md', 'README.md', 'QUICKSTART.md', 'package.json', 'package-lock.json', '.gitignore'];
// 링크: 큰 폴더와 비밀. .env 는 복사하지 않고 링크로만 둔다 — 테스트 일부가 키 존재를 보지만, 사본·패치에 비밀이 남으면 안 된다.
const LINK = ['node_modules', 'assets', 'tools', 'workspace', '.env'];
const SKIP = /(^|\/)(\.env[^/]*|.*\.bak[^/]*|\.DS_Store)$/;
export const PROTECTED = [
  /^\.env/, /^config\/paperclip\//, /^scripts\/automation\/paperclip\//, /^lib\/install-cron\.sh$/,
  /oauth/i, /^scripts\/automation\/(publish-youtube|upload-direct)\.js$/,
  /^config\/(budget-policy|notifications|autonomy-pause)\.json$/,
];
export const DAILY_APPLY_LIMIT = 3;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const die = (msg, code = 1) => { console.error(`❌ ${msg}`); process.exit(code); };

export function isProtected(path) {
  return PROTECTED.some((re) => re.test(path));
}

function walk(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(base, p);
    if (SKIP.test(rel)) continue;
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p, base, out);
    else if (st.isFile()) out[rel] = sha(readFileSync(p));
  }
  return out;
}

function manifest(root) {
  const out = {};
  for (const top of COPY) {
    const p = join(root, top);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) Object.assign(out, walk(p, root));
    else out[top] = sha(readFileSync(p));
  }
  return out;
}

/** 두 매니페스트 차이 — 바뀐·추가·삭제 파일. */
export function changedFiles(base, tree) {
  const changed = [];
  for (const [f, h] of Object.entries(tree)) if (base[f] !== h) changed.push({ path: f, kind: base[f] ? 'modified' : 'added' });
  for (const f of Object.keys(base)) if (!(f in tree)) changed.push({ path: f, kind: 'deleted' });
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

function dirs(id) {
  if (!/^[A-Za-z0-9][\w.-]{2,80}$/.test(id ?? '')) die(`작업 ID 형식이 아니다: ${id}`, 2);
  const d = join(OPS, 'repairs', id);
  return { d, tree: join(d, 'tree'), base: join(d, 'base'), patch: join(d, 'patch.diff'), files: join(d, 'files.json'), verdict: join(d, 'verdict.json'), applied: join(d, 'applied.json'), backup: join(d, 'backup') };
}

function copyCode(dest) {
  mkdirSync(dest, { recursive: true });
  for (const top of COPY) {
    const src = join(ROOT, top);
    if (!existsSync(src)) continue;
    cpSync(src, join(dest, top), { recursive: true, dereference: false, filter: (s) => !SKIP.test(relative(ROOT, s)) });
  }
}

function start(id) {
  const p = dirs(id);
  if (existsSync(p.tree)) { console.log(`이미 있다 — 사본: ${p.tree}`); return; }
  copyCode(p.base);
  copyCode(p.tree);
  for (const l of LINK) if (existsSync(join(ROOT, l))) symlinkSync(join(ROOT, l), join(p.tree, l));
  mkdirSync(join(p.tree, 'logs'), { recursive: true });
  // 형제 스킬(../barrotube-media-render 등)을 읽는 테스트가 있다 — 사본의 부모에 같은 이름으로 링크한다.
  for (const sib of readdirSync(dirname(ROOT))) {
    const src = join(dirname(ROOT), sib);
    if (src === ROOT || existsSync(join(p.d, sib)) || !statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
    symlinkSync(src, join(p.d, sib));
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' });
  const dirty = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: ROOT, encoding: 'utf-8' });
  writeJsonAtomic(join(p.d, 'meta.json'), {
    id, startedAt: new Date().toISOString(), head: git.stdout.trim(), dirtyFiles: dirty.stdout.split('\n').filter(Boolean).length,
    by: process.env.PAPERCLIP_AGENT_ID ?? process.env.USER ?? null,
  });
  writeJsonAtomic(join(p.d, 'base-manifest.json'), manifest(p.base));
  console.log(`사본: ${p.tree}\n(여기서 고치고 테스트한 뒤 diff → 리뷰 요청)`);
}

function diff(id, { quiet = false } = {}) {
  const p = dirs(id);
  if (!existsSync(p.tree)) die('사본이 없다 — start 먼저');
  const base = readJson(join(p.d, 'base-manifest.json'));
  const changed = changedFiles(base, manifest(p.tree));
  const chunks = [];
  for (const c of changed) {
    const a = c.kind === 'added' ? '/dev/null' : join(p.base, c.path);
    const b = c.kind === 'deleted' ? '/dev/null' : join(p.tree, c.path);
    const r = spawnSync('diff', ['-u', '--label', `a/${c.path}`, '--label', `b/${c.path}`, a, b], { encoding: 'utf-8' });
    chunks.push(r.stdout);
  }
  const patch = chunks.join('');
  writeFileSync(p.patch, patch);
  const prot = changed.filter((c) => isProtected(c.path)).map((c) => c.path);
  writeJsonAtomic(p.files, { changed, protected: prot, patchSha: sha(Buffer.from(patch)), at: new Date().toISOString() });
  if (!quiet) {
    console.log(`패치: ${p.patch} (${changed.length}개 파일, ${patch.split('\n').length}줄)`);
    changed.forEach((c) => console.log(`  ${c.kind.padEnd(8)} ${c.path}${isProtected(c.path) ? '  ⛔ 보호 경로' : ''}`));
    if (prot.length) console.log('⛔ 보호 경로를 건드렸다 — 자동 반영 불가. 사람에게 넘긴다.');
  }
  return readJson(p.files);
}

function show(id) {
  const p = dirs(id);
  const f = readJson(p.files) ?? diff(id, { quiet: true });
  const inc = join(ROOT, 'workspace', 'growth', 'incidents', `${id}.md`);
  console.log([
    `패치: ${p.patch}`, `바뀐 파일: ${f.changed.map((c) => `${c.kind}:${c.path}`).join(', ') || '없음'}`,
    `보호 경로: ${f.protected.join(', ') || '없음'}`, `사본: ${p.tree}`, existsSync(inc) ? `설계서: ${inc}` : null,
    `판정: ${readJson(p.verdict)?.verdict ?? '없음'}`, `SRE 메모: ${join(p.d, 'notes.md')}${existsSync(join(p.d, 'notes.md')) ? '' : ' (없음)'}`,
  ].filter(Boolean).join('\n'));
}

function verdict(id, v, reason) {
  const p = dirs(id);
  if (!['approve', 'reject'].includes(v)) die('approve 또는 reject', 2);
  if (!reason) die('사유 한 줄이 필요하다', 2);
  const f = diff(id, { quiet: true });
  writeJsonAtomic(p.verdict, { verdict: v, reason, patchSha: f.patchSha, at: new Date().toISOString(), by: process.env.PAPERCLIP_AGENT_ID ?? process.env.USER ?? null });
  console.log(`판정 기록: ${v} — ${reason}`);
}

function appliedToday() {
  const root = join(OPS, 'repairs');
  if (!existsSync(root)) return 0;
  const today = kstParts().date;
  return readdirSync(root).filter((id) => {
    const a = readJson(join(root, id, 'applied.json'));
    return a && !a.rolledBackAt && kstParts(new Date(a.at)).date === today;
  }).length;
}

function apply(id) {
  const p = dirs(id);
  if (existsSync(p.applied) && !readJson(p.applied)?.rolledBackAt) die('이미 반영됐다');
  const f = diff(id, { quiet: true });
  const v = readJson(p.verdict);
  if (!f.changed.length) die('바뀐 파일이 없다');
  if (v?.verdict !== 'approve') die('리뷰 승인이 없다 (verdict approve 필요)', 3);
  if (v.patchSha !== f.patchSha) die('리뷰 뒤에 패치가 바뀌었다 — 다시 리뷰 받아야 한다', 3);
  if (f.protected.length && process.env.BT_REPAIR_ALLOW_PROTECTED !== '1') die(`보호 경로: ${f.protected.join(', ')} — 사람 승인 필요`, 3);
  if (appliedToday() >= DAILY_APPLY_LIMIT) die(`오늘 자동 반영 한도(${DAILY_APPLY_LIMIT}건)에 닿았다`, 3);
  const base = readJson(join(p.d, 'base-manifest.json'));
  const live = manifest(ROOT);
  const drifted = f.changed.filter((c) => (live[c.path] ?? null) !== (base[c.path] ?? null)).map((c) => c.path);
  if (drifted.length) die(`사본을 뜬 뒤 운영 트리에서 바뀐 파일: ${drifted.join(', ')} — 충돌, 사람에게 넘긴다`, 3);

  console.log('사본 전체 테스트 (npm test)…');
  const t = spawnSync('npm', ['test', '--silent'], { cwd: p.tree, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const summary = (t.stdout + t.stderr).split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join(' · ');
  if (t.status !== 0) die(`사본 테스트 실패 — 반영 안 함. ${summary}`, 3);

  mkdirSync(p.backup, { recursive: true });
  for (const c of f.changed) {
    const livePath = join(ROOT, c.path);
    if (c.kind !== 'added') { mkdirSync(dirname(join(p.backup, c.path)), { recursive: true }); copyFileSync(livePath, join(p.backup, c.path)); }
    if (c.kind === 'deleted') unlinkSync(livePath);
    else { mkdirSync(dirname(livePath), { recursive: true }); copyFileSync(join(p.tree, c.path), livePath); }
  }
  // 반영 직후 문법 점검 — 깨졌으면 바로 되돌린다.
  const broken = f.changed.filter((c) => c.kind !== 'deleted').filter((c) => {
    const lp = join(ROOT, c.path);
    if (c.path.endsWith('.js')) return spawnSync('node', ['--check', lp]).status !== 0;
    if (c.path.endsWith('.sh')) return spawnSync('bash', ['-n', lp]).status !== 0;
    if (c.path.endsWith('.json')) { try { JSON.parse(readFileSync(lp, 'utf-8')); return false; } catch { return true; } }
    return false;
  });
  writeJsonAtomic(p.applied, { at: new Date().toISOString(), files: f.changed, patchSha: f.patchSha, tests: summary, by: process.env.PAPERCLIP_AGENT_ID ?? process.env.USER ?? null });
  if (broken.length) { rollback(id); die(`반영 뒤 문법 오류(${broken.map((c) => c.path).join(', ')}) — 되돌렸다`, 3); }
  console.log(`✅ 반영 ${f.changed.length}개 파일 · ${summary}\n되돌리기: node scripts/automation/paperclip/repair-workspace.js rollback ${id}`);
}

function rollback(id) {
  const p = dirs(id);
  const a = readJson(p.applied);
  if (!a || a.rolledBackAt) die('반영 기록이 없거나 이미 되돌렸다');
  for (const c of a.files) {
    const livePath = join(ROOT, c.path);
    if (c.kind === 'added') { if (existsSync(livePath)) unlinkSync(livePath); continue; }
    mkdirSync(dirname(livePath), { recursive: true });
    copyFileSync(join(p.backup, c.path), livePath);
  }
  writeJsonAtomic(p.applied, { ...a, rolledBackAt: new Date().toISOString() });
  console.log(`↩ 되돌림 ${a.files.length}개 파일`);
}

function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'start': return start(id);
    case 'diff': return void diff(id);
    case 'show': return show(id);
    case 'verdict': return verdict(id, rest[0], rest.slice(1).join(' ').trim());
    case 'apply': return apply(id);
    case 'rollback': return rollback(id);
    case 'purge': { const p = dirs(id); rmSync(p.d, { recursive: true, force: true }); return console.log(`삭제: ${p.d}`); }
    default: die('Usage: repair-workspace.js <start|diff|show|verdict|apply|rollback|purge> <id> [...]', 2);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
