#!/usr/bin/env node

/**
 * grok-motion.js — Grok Imagine image→video 를 무인으로 굽는다 (2026-08-23)
 *
 * 왜 별도 스크립트인가
 * ────────────────────
 * Grok 모션은 **컷마다 다른 스틸**을 첨부해야 해서, ChatGPT 씬 이미지가 쓰는
 * "시드 대화" 우회(시트를 맨 위에 한 번만 붙임)가 성립하지 않는다. 그리고
 * codex 의 Chrome 표면은 세 경로가 전부 막혀 있다 — 숨은 input 주입(보안 정책),
 * 컴포저 파일 선택 UI(선택 이벤트 미발생), Cmd+V(썸네일 안 뜸). 2026-08-18 실측.
 * ChatGPT 확장의 「파일 URL 접근 허용」을 켜도 grok.com 에는 적용되지 않는다.
 *
 * 그래서 에이전트 표면을 거치지 않고 Playwright 로 직접 몬다. 이건 확장이 아니라
 * 프로그램이므로 위 제약을 받지 않는다.
 *
 * 세션
 * ────
 * 사용자의 일상 Chrome 프로필을 쓰지 않는다 — 프로필 락이 걸려 Chrome 을 닫아야 하고,
 * cron 과 충돌한다. 전용 user-data-dir 에 한 번 로그인해 두고 그걸 재사용한다.
 *
 *   node grok-motion.js --login        # 창이 열린다. 로그인하고 창을 닫으면 저장된다.
 *   node grok-motion.js --episode <dir> --platform shorts
 *   node grok-motion.js --episode <dir> --scene 003 --force
 *
 * 검증 (하나라도 실패하면 그 컷은 버린다)
 * ──────────────────────────────────────
 *  1) 제출 전 **비디오 모드** 확인 — 2026-08-21 EP-0107 씬 003 이 이미지로 나왔고,
 *     받은 파일 크기가 업로드한 스틸과 같아서 겨우 잡았다.
 *  2) 다운로드 파일이 **직전 컷과 다른지**(md5) — 좌표 클릭이 직전 클립을 다시 받는다.
 *  3) ffprobe 로 세로 h264 + 오디오 스트림.
 *
 * 실패해도 파이프라인을 세우지 않는다. 만든 만큼만 남기고 exit 1 —
 * auto-pipeline 이 남은 컷을 보고 HyperFrames 폴백/halt 를 결정한다.
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILE_DIR = process.env.BT_GROK_PROFILE
  || join(homedir(), '.barrotube', 'grok-profile');
const DOWNLOAD_DIR = join(homedir(), '.barrotube', 'grok-downloads');
const IMAGINE_URL = 'https://grok.com/imagine';
/** 컷 사이 대기(ms). 연속 요청이 Cloudflare 봇 탐지를 건드린다 —
 *  2026-08-24 실측: 헤드리스로 /imagine 을 4~5회 연속 호출해 프로필이 차단됨
 *  ("Sorry, you have been blocked"). 0 으로 두면 대기 없음. */
const CUT_DELAY_MS = Number(process.env.BT_GROK_CUT_DELAY_MS ?? 12000);

/** 컷당 상한. 실측 생성 30~90초 + 대기. */
const GEN_TIMEOUT_MS = Number(process.env.BT_GROK_TIMEOUT_MS || 6 * 60 * 1000);

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf-8' });
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

/**
 * 모션 프롬프트를 image_prompt 에서 기계적으로 만든다.
 *
 * image_prompt 는 "…no nose or ears), <동작 절> BACKGROUND: …" 꼴이라 동작 절만
 * 떼면 그대로 모션 지시가 된다. 여기에 두 줄을 고정으로 붙인다:
 *  - 정면 유지: 2026-08-19 EP-0100 에서 마지막 2초에 얼굴이 사라졌고, 운영자가 잡았다.
 *  - 화풍 고정: 안 붙이면 Grok 이 캐릭터를 다시 상상한다(ep04 6컷 중 4컷 드리프트).
 */
export function motionPromptFor(scene) {
  const flat = String(scene.image_prompt || '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/ears\),\s*(.*?)\s*BACKGROUND:/i);
  const action = (m ? m[1] : flat).replace(/\s*WITH:.*$/i, '').trim();
  return [
    'Animate the attached image.',
    action ? `${action.replace(/\.$/, '')}.` : 'Bring the scene to life with subtle motion.',
    'The mascot stays facing the camera, face fully visible in every frame.',
    'Slow push-in camera.',
    'Keep the character design, line art and colors exactly as in the attached image.',
  ].join(' ');
}

function loadScenes(baseDir) {
  const scriptPath = join(baseDir, '30_script.md');
  if (!existsSync(scriptPath)) throw new Error(`대본 없음: ${scriptPath}`);
  const fm = readFileSync(scriptPath, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
  if (!fm) throw new Error(`frontmatter 없음: ${scriptPath}`);
  const scenes = parseYAML(fm[1])?.scenes;
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('scenes 가 비었다');
  return scenes;
}

function verifyClip(p) {
  const r = sh('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration',
    '-of', 'default=nw=1', p]);
  if (r.status !== 0) return { ok: false, why: 'ffprobe 실패' };
  const out = r.stdout || '';
  const w = Number(out.match(/^width=(\d+)/m)?.[1] || 0);
  const h = Number(out.match(/^height=(\d+)/m)?.[1] || 0);
  const dur = Number(out.match(/^duration=([\d.]+)/m)?.[1] || 0);
  const hasAudio = /codec_type=audio/.test(out);
  if (!(h > w)) return { ok: false, why: `세로가 아니다 (${w}x${h})` };
  if (dur < 4) return { ok: false, why: `길이가 너무 짧다 (${dur}s)` };
  if (!hasAudio) return { ok: false, why: '오디오 스트림 없음 — Video audio 가 꺼져 있다' };
  return { ok: true, info: `${w}x${h} ${dur.toFixed(2)}s` };
}

/**
 * 프로필을 이미 다른 Chrome 이 쓰고 있으면 즉시 실패한다.
 * 겹쳐 열면 SingletonLock 때문에 새 인스턴스가 곧바로 죽고, Playwright 는
 * "Target page, context or browser has been closed" 라는 원인 불명 에러만 던진다
 * (2026-08-24 EP-0113: 무인 실행이 대화형 세션과 같은 프로필을 잡아 26초 만에 종료).
 */
function assertProfileFree() {
  try {
    const out = execSync(
      `pgrep -f ${JSON.stringify('user-data-dir=' + PROFILE_DIR)} || true`,
      { encoding: 'utf8' },
    ).trim();
    if (out) {
      throw new Error(
        `프로필을 다른 Chrome 이 사용 중입니다 (pid ${out.split('\n').join(', ')}): ${PROFILE_DIR}\n` +
        `   그 창을 닫거나, 무인 실행 전용 프로필을 BT_GROK_PROFILE 로 따로 지정하세요.`,
      );
    }
  } catch (e) {
    if (e && /사용 중입니다/.test(e.message)) throw e;
    // pgrep 자체가 실패하면 가드를 건너뛴다 — 여기서 파이프라인을 죽이지 않는다.
  }
}

async function openContext({ headless, login = false }) {
  assertProfileFree();
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    // Playwright 기본 인자에서 --use-mock-keychain 을 뺀다.
    // 이 인자가 붙으면 Chrome 이 가짜 키체인을 써서, 진짜 macOS 키체인
    // ("Chrome Safe Storage")으로 암호화된 쿠키를 복호화하지 못한다.
    // 그 탓에 일반 Chrome 으로 같은 프로필에 로그인해도 sso 쿠키가 통째로
    // 안 보였다 (2026-08-24 실측: 디스크엔 sso 있는데 ctx.cookies() 에는 없음).
    ignoreDefaultArgs: ['--use-mock-keychain'],
    // 로그인 창만 실제 창 크기로 띄운다. 고정 viewport 를 주면 창이 작게/뒤에 렌더돼
    // "창이 안 뜬다" 로 보이는 경우가 있다 (2026-08-24 실측).
    viewport: login ? null : { width: 1440, height: 900 },
    args: login ? ['--start-maximized'] : [],
    acceptDownloads: true,
    downloadsPath: DOWNLOAD_DIR,
  });
}

/** 쿠키 동의창은 매번 뜰 수 있다. 개인정보 보호 우선 — 「모두 거부」. */
async function dismissConsent(page) {
  for (const label of ['모두 거부', 'Reject all', '필수만 허용']) {
    const btn = page.getByRole('button', { name: label });
    if (await btn.count().catch(() => 0)) {
      await btn.first().click().catch(() => {});
      await page.waitForTimeout(1200);
      return true;
    }
  }
  return false;
}

/** 옵션 바가 「비디오」인지 확인한다. 이미지 모드로 제출하면 스틸이 되돌아온다. */
async function assertVideoMode(page) {
  const txt = await page.locator('body').innerText().catch(() => '');
  if (!/비디오|Video/.test(txt)) throw new Error('컴포저가 비디오 모드가 아니다');
}

async function renderOne(page, { still, prompt, outPath, knownHashes }) {
  await page.goto(IMAGINE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await dismissConsent(page);

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30_000 });
  await fileInput.setInputFiles(still);
  await page.waitForTimeout(2500);

  await assertVideoMode(page);

  // 컴포저는 contenteditable 이라 type() 이 먹히지 않는다 — execCommand 로 넣는다.
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.evaluate((el, text) => {
    el.focus();
    document.execCommand('insertText', false, text);
  }, prompt);
  await page.waitForTimeout(600);

  // 제출. Enter 는 자주 씹힌다 — 컴포저가 contenteditable 이라 focus 가 빠지면
  // 키 이벤트가 페이지로 새고, 프롬프트·첨부가 그대로 남은 채 아무 일도 안 일어난다
  // (2026-08-24 실측: 5컷 중 3컷이 Enter 로는 제출되지 않았다).
  // 확실한 경로는 aria-label="동영상 만들기" 버튼을 DOM 으로 누르는 것이다.
  // 쿠키 동의 패널은 컷마다 다시 뜨고 클릭을 가로채므로 제출 직전에 한 번 더 지운다.
  await dismissConsent(page);
  const submitted = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => ((b.getAttribute('aria-label') || b.textContent || '').trim()) === '동영상 만들기');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!submitted) {
    // 라벨이 바뀌었을 때의 폴백 — 기존 경로 유지.
    await composer.click();
    await page.keyboard.press('Enter');
  }

  // 진행률이 사라지고 다운로드 버튼이 생길 때까지.
  const deadline = Date.now() + GEN_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`생성 타임아웃 (${GEN_TIMEOUT_MS / 1000}s)`);
    await page.waitForTimeout(5000);
    const body = await page.locator('body').innerText().catch(() => '');
    if (/생성 중\s*\d+%/.test(body)) continue;
    const dl = page.getByRole('button', { name: '다운로드' });
    if (await dl.count().catch(() => 0)) break;
  }

  // 좌표가 아니라 이름으로 누른다 — 좌표 클릭은 직전 컷을 다시 받는다(실측).
  // 쿠키 패널이 다시 떠 있으면 다운로드 버튼 클릭이 그대로 삼켜진다
  // (2026-08-24 실측: 씬 003·004 다운로드가 조용히 유실됐다).
  await dismissConsent(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByRole('button', { name: '다운로드' }).first().click(),
  ]);
  const tmp = join(DOWNLOAD_DIR, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(tmp);

  if (!/\.mp4$/i.test(tmp)) throw new Error(`영상이 아니라 ${tmp.split('.').pop()} 를 받았다 — 이미지 모드로 생성됐다`);
  const hash = md5(tmp);
  if (knownHashes.has(hash)) throw new Error('직전 컷과 같은 파일을 받았다 (중복 다운로드)');
  const v = verifyClip(tmp);
  if (!v.ok) throw new Error(v.why);

  copyFileSync(tmp, outPath);
  knownHashes.add(hash);
  return v.info;
}

async function main() {
  const { values } = parseArgs({
    options: {
      episode: { type: 'string', short: 'e' },
      platform: { type: 'string', short: 'p', default: 'shorts' },
      scene: { type: 'string' },
      force: { type: 'boolean', default: false },
      login: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },   // 하위호환 (기본이 headed 라 사실상 무의미)
      headless: { type: 'boolean', default: false }, // 헤드리스가 필요할 때만 명시
    },
  });

  if (values.status) {
    // 로그인 여부만 확인한다. auto-pipeline 이 Grok 을 시도하기 전에 이걸로 게이트한다 —
    // 예전에는 프로필 "디렉터리 존재"만 보고 시도해서, 로그인 안 된 프로필로 매일
    // RED halt 를 냈다 (2026-08-17·20·23·24 실측 4건).
    if (!existsSync(PROFILE_DIR)) {
      console.error(`❌ 프로필 없음: ${PROFILE_DIR}`);
      process.exit(3);
    }
    assertProfileFree();
    const ctx = await openContext({ headless: true });
    try {
      const cs = await ctx.cookies('https://grok.com');
      const ok = cs.some(c => c.name === 'sso' && c.value);
      console.log(ok
        ? `✅ Grok 로그인됨 (sso 확인) — ${PROFILE_DIR}`
        : `❌ Grok 미로그인 (sso 없음) — ${PROFILE_DIR}`);
      if (!ok) {
        console.error('   로그인: node scripts/automation/grok-motion.js --login');
        console.error('   ⚠ 일반 Chrome 으로 같은 프로필에 로그인해도 넘어오지 않는 버그가');
        console.error('     있었다(--use-mock-keychain). 2026-08-24 수정됨.');
      }
      process.exit(ok ? 0 : 3);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  if (values.login) {
    console.log('🔑 Grok 로그인 — 창에서 로그인한 뒤 창을 닫으세요.');
    console.log(`   프로필: ${PROFILE_DIR}`);
    console.log('   ⚠ 반드시 "이 창 안에서" 로그인하세요.');
    console.log('     일반 Chrome 으로 같은 프로필을 열어 로그인하면 넘어오지 않습니다 —');
    console.log('     Playwright 는 --use-mock-keychain 으로 뜨기 때문에 진짜 키체인으로');
    console.log('     암호화된 인증 쿠키(sso)를 복호화하지 못합니다 (2026-08-24 실측).');
    const ctx = await openContext({ headless: false, login: true });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(IMAGINE_URL);
    await page.bringToFront();

    // 로그인 성공을 쿠키로 감지해 알려준다 — 언제 닫아도 되는지 사람이 알 수 있다.
    let announced = false;
    const watcher = setInterval(async () => {
      try {
        const cs = await ctx.cookies('https://grok.com');
        if (!announced && cs.some(c => c.name === 'sso' && c.value)) {
          announced = true;
          console.log('✅ 로그인 감지됨 (sso 쿠키 확인) — 이제 창을 닫으셔도 됩니다.');
        }
      } catch { /* 창이 닫히는 중 */ }
    }, 3000);

    await ctx.waitForEvent('close', { timeout: 0 });
    clearInterval(watcher);
    console.log('✅ 세션 저장됨');
    return;
  }

  if (!values.episode) {
    console.error('Usage: grok-motion.js --login | --episode <dir> [--platform shorts] [--scene 003] [--force] [--headless]');
    process.exit(1);
  }
  if (!existsSync(PROFILE_DIR)) {
    console.error(`❌ Grok 프로필이 없습니다: ${PROFILE_DIR}`);
    console.error('   먼저 실행: node scripts/automation/grok-motion.js --login');
    process.exit(2);
  }

  const epDir = resolve(values.episode);
  const baseDir = existsSync(join(epDir, 'platforms', values.platform, '30_script.md'))
    ? join(epDir, 'platforms', values.platform)
    : epDir;
  const imagesDir = join(baseDir, '40_assets', 'images');
  const videosDir = join(baseDir, '40_assets', 'videos');
  mkdirSync(videosDir, { recursive: true });

  const scenes = loadScenes(baseDir);
  const wanted = values.scene
    ? scenes.filter((s) => String(s.scene_id).padStart(3, '0') === String(values.scene).padStart(3, '0'))
    : scenes;

  // 이미 있는 클립의 해시를 미리 넣어 둔다 — 재실행이 같은 파일을 다시 받아도 잡힌다.
  const knownHashes = new Set(
    readdirSync(videosDir).filter((f) => f.endsWith('.mp4'))
      .map((f) => { try { return md5(join(videosDir, f)); } catch { return null; } })
      .filter(Boolean),
  );

  // headless 결정: --headless / --headed 가 명시되면 그대로. 없으면 TTY 유무로 가른다.
  //   대화형(TTY)  → headed. 헤드리스 연속 호출이 Cloudflare 봇 탐지에 걸린다(2026-08-24).
  //   무인(cron)   → headless. launchd 백그라운드에서 창을 띄우면 세션이 불안정해
  //                  "Target page, context or browser has been closed" 로 죽는다
  //                  (2026-08-24 EP-0113 kr-close 실측 — 첫 컷에서 26초 만에 종료).
  const headlessResolved = values.headless === true ? true
    : values.headed === true ? false
    : !process.stdout.isTTY;
  console.log(`🖥  모드: ${headlessResolved ? 'headless (무인)' : 'headed (대화형)'}`);
  const ctx = await openContext({ headless: headlessResolved });
  const page = ctx.pages()[0] || await ctx.newPage();

  let made = 0; let failed = 0;
  try {
    for (const [i, scene] of wanted.entries()) {
      const id = String(scene.scene_id).padStart(3, '0');
      const still = join(imagesDir, `scene_${id}.png`);
      const outPath = join(videosDir, `scene_${id}.mp4`);
      if (!existsSync(still)) { console.warn(`  ⏭  씬 ${id}: 스틸 없음 — 건너뜀`); continue; }
      if (existsSync(outPath) && !values.force) { console.log(`  ⏭  씬 ${id}: 이미 있음`); continue; }

      try {
        const info = await renderOne(page, {
          still, prompt: motionPromptFor(scene), outPath, knownHashes,
        });
        made += 1;
        console.log(`  ✅ 씬 ${id} → ${info}`);
      } catch (e) {
        failed += 1;
        console.warn(`  ❌ 씬 ${id}: ${e.message}`);
      }

      // 실제로 요청을 보낸 컷 뒤에만 쉰다. 위의 continue 들은 네트워크를 타지 않는다.
      if (CUT_DELAY_MS > 0 && i < wanted.length - 1) {
        console.log(`  ⏳ 다음 컷까지 ${Math.round(CUT_DELAY_MS / 1000)}초 대기`);
        await page.waitForTimeout(CUT_DELAY_MS);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log(`\n🎬 Grok 모션: 신규 ${made}컷${failed ? `, 실패 ${failed}컷` : ''} → ${videosDir}`);
  // 한 컷이라도 실패하면 비정상 종료. 파이프라인이 폴백/halt 를 판단한다.
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
