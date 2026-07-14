#!/usr/bin/env node

/**
 * board-server.js — BarroTube 에피소드 관리 보드 로컬 브리지
 *
 * 정적 HTML(index.html) + 파일시스템 스캔 API + 화이트리스트 CLI 실행 API를
 * 127.0.0.1 에만 바인딩해 제공한다. (오늘묘 8932 브리지의 BarroTube 판)
 *
 * Usage:
 *   node tools/board/server.js [--port 8933] [--open]
 *   → http://127.0.0.1:8933
 *
 * 안전 규칙:
 *  - 127.0.0.1 바인딩 전용 (외부 노출 없음)
 *  - 실행 가능한 명령은 COMMANDS 화이트리스트뿐 (임의 쉘 실행 불가)
 *  - publish 는 되돌리기 어려우므로 confirm 토큰 필수
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '../..');          // .../skills/barrotube
const EPISODES_DIR = join(SKILL_ROOT, 'workspace', 'episodes');
const AUTOMATION = join(SKILL_ROOT, 'scripts', 'automation');

const { values: argv } = parseArgs({
  options: {
    port: { type: 'string', default: '8933' },
    open: { type: 'boolean', default: false },
  },
});
const PORT = Number(argv.port);

/* ─────────────────────────────────────────────
 * 1. 에피소드 스캔
 * ───────────────────────────────────────────── */

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function readTopic(briefPath) {
  if (!existsSync(briefPath)) return null;
  const md = readFileSync(briefPath, 'utf-8');
  // frontmatter topic: "..." 우선, 없으면 "## 주제" 다음 줄
  const fm = md.match(/^topic:\s*"?(.+?)"?\s*$/m);
  if (fm) return fm[1];
  const body = md.match(/##\s*주제\s*\n+(.+)/);
  return body ? body[1].trim() : null;
}

function readFormat(briefPath) {
  if (!existsSync(briefPath)) return null;
  const m = readFileSync(briefPath, 'utf-8').match(/^format:\s*"?([\w-]+)"?\s*$/m);
  return m ? m[1] : null;
}

/**
 * 발행 결과는 스키마가 3종 — 전부 파싱해야 한다.
 *   A) targets.youtube.videoId  (신형)
 *   B) targets.youtube.video_id (구형, 스네이크)
 *   C) 루트 videoId             (media-render 플로우, EP-0061)
 */
function readPublish(dir) {
  const j = readJson(join(dir, '80_publish_result.json'));
  if (!j) return null;
  const yt = j.targets?.youtube || {};
  const videoId = yt.videoId || yt.video_id || j.videoId || j.video_id || null;
  return {
    videoId,
    url: yt.url || j.url || (videoId ? `https://youtu.be/${videoId}` : null),
    status: j.status || yt.status || null,
    privacy: j.privacyStatus || yt.privacy_status || j.privacy_status || null,
  };
}

/** 플랫폼 폴더(v2) 또는 EP 루트(v1)에서 산출물 유무를 집계 */
function scanPlatform(dir) {
  // .prompt.txt / _bak 디렉터리가 섞여 있으므로 확장자로 실제 자산만 센다
  const countDir = (p, exts) => (existsSync(p)
    ? readdirSync(p).filter(f => exts.includes(extname(f).toLowerCase())).length
    : 0);
  return {
    script: existsSync(join(dir, '30_script.md')),
    factcheck: existsSync(join(dir, '35_factcheck.md')),
    images: countDir(join(dir, '40_assets', 'images'), ['.png', '.jpg', '.jpeg']),
    videos: countDir(join(dir, '40_assets', 'videos'), ['.mp4', '.mov']),
    tts: countDir(join(dir, '40_assets', 'tts'), ['.wav', '.mp3']),
    intro: existsSync(join(dir, '45_intro.png')),
    thumbnail: existsSync(join(dir, '47_thumbnail.png')),
    endcard: existsSync(join(dir, '48_endcard.png')),
    render: existsSync(join(dir, '55_render', 'video.mp4')),
    qa: existsSync(join(dir, '60_qa_report.md')),
    meta: existsSync(join(dir, '70_publish_meta.json')),
    approval: existsSync(join(dir, '75_board_approval.json')),
    publish: readPublish(dir),
  };
}

function scanEpisodes() {
  if (!existsSync(EPISODES_DIR)) return [];
  return readdirSync(EPISODES_DIR)
    .filter(n => /^EP-\d{4}-\d{4}$/.test(n))
    .sort()
    .reverse()
    .map(id => {
      const epDir = join(EPISODES_DIR, id);
      const status = readJson(join(epDir, '.episode_status.json'));
      const briefPath = join(epDir, '00_brief.md');
      const platformsDir = join(epDir, 'platforms');
      const platforms = {};

      if (existsSync(platformsDir)) {
        for (const p of readdirSync(platformsDir)) {
          const pDir = join(platformsDir, p);
          if (statSync(pDir).isDirectory()) platforms[p] = scanPlatform(pDir);
        }
      } else {
        platforms['(v1-flat)'] = scanPlatform(epDir); // 구 레이아웃
      }

      // 발행 판정: status 파일은 갱신 누락 사례가 있어 80_publish_result 를 우선하고,
      // 그 파일이 없는 경우(publish-youtube.js 단독 실행)에는 stage_history 의 youtube_url 로 보강한다.
      const histUrl = (status?.stage_history || [])
        .map(h => h.youtube_url).filter(Boolean).pop() || null;
      const published = Object.values(platforms).some(p => p.publish?.videoId) || !!histUrl;

      return {
        id,
        topic: readTopic(briefPath),
        format: readFormat(briefPath),
        layout: existsSync(platformsDir) ? 'v2' : 'v1',
        current_stage: status?.current_stage ?? null,
        status: status?.status ?? null,
        updated: status?.last_updated ?? null,
        platforms,
        published,
        history_url: histUrl,
      };
    });
}

/* ─────────────────────────────────────────────
 * 1-b. 자산 미리보기 (목록 + 바이트 서빙)
 *
 * 보드는 산출물을 점(dot)으로만 보여줬다 — 실제로 무엇이 만들어졌는지는
 * 파일을 열어봐야 알 수 있었다. 여기서 EP 폴더 안의 자산을 분류해 목록으로
 * 주고(/api/assets), 실제 바이트를 Range 지원으로 서빙한다(/api/asset/file).
 * 서빙 대상은 EPISODES_DIR 안쪽 + 허용 확장자로만 제한한다.
 * ───────────────────────────────────────────── */

const EP_RE = /^EP-\d{4}-\d{4}$/;

const PREVIEW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
};

/** EPISODES_DIR 밖으로 나가는 경로(../, 절대경로, 심볼릭 링크 탈출)를 차단하고 실경로를 돌려준다. */
function safeEpisodePath(ep, rel) {
  if (!EP_RE.test(ep || '')) return null;
  if (!rel || isAbsolute(rel)) return null;
  const root = resolve(EPISODES_DIR, ep);
  const target = resolve(root, rel);
  const inside = relative(root, target);
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  if (!PREVIEW_MIME[extname(target).toLowerCase()]) return null;   // 허용 확장자만
  return target;
}

/** dir 안의 파일을 {rel,name,size} 로 (EP 루트 기준 상대경로) */
function listFiles(epRoot, subdir, exts) {
  const dir = join(epRoot, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => exts.includes(extname(f).toLowerCase()))
    .filter(f => !/\.bak\.|_bak/.test(f))          // 백업본은 미리보기에서 제외
    .sort()
    .map(f => {
      const p = join(dir, f);
      return { rel: join(subdir, f), name: f, size: statSync(p).size };
    });
}

function oneFile(epRoot, rel) {
  const p = join(epRoot, rel);
  if (!existsSync(p) || !statSync(p).isFile()) return [];
  return [{ rel, name: rel.split('/').pop(), size: statSync(p).size }];
}

/**
 * EP + 플랫폼의 자산을 종류별로 분류.
 * v2 는 platforms/<p>/ 아래, v1 은 EP 루트에 그대로 있다 → prefix 로 흡수.
 */
function listAssets(ep, platform) {
  const epRoot = join(EPISODES_DIR, ep);
  if (!existsSync(epRoot)) return null;
  const hasPlatforms = existsSync(join(epRoot, 'platforms'));
  const pfx = (hasPlatforms && platform && platform !== '(v1-flat)')
    ? join('platforms', platform) : '';
  const at = (sub) => (pfx ? join(pfx, sub) : sub);

  const IMG = ['.png', '.jpg', '.jpeg', '.webp'];
  return {
    ep,
    platform: pfx || '(v1-flat)',
    dir: pfx ? join(epRoot, pfx) : epRoot,
    groups: {
      script:  [...oneFile(epRoot, at('30_script.md')), ...oneFile(epRoot, at('35_factcheck.md')),
                ...oneFile(epRoot, '00_brief.md')],
      images:  listFiles(epRoot, at(join('40_assets', 'images')), IMG),
      videos:  listFiles(epRoot, at(join('40_assets', 'videos')), ['.mp4', '.mov']),
      tts:     listFiles(epRoot, at(join('40_assets', 'tts')), ['.wav', '.mp3', '.m4a']),
      cards:   [...oneFile(epRoot, at('45_intro.png')), ...oneFile(epRoot, at('47_thumbnail.png')),
                ...oneFile(epRoot, at('47_thumbnail.jpg')), ...oneFile(epRoot, at('48_endcard.png'))],
      render:  [...listFiles(epRoot, at('55_render'), ['.mp4', '.mov'])],
      reports: [...oneFile(epRoot, at('60_qa_report.md')), ...oneFile(epRoot, at('70_publish_meta.json')),
                ...oneFile(epRoot, at('75_board_approval.json')), ...oneFile(epRoot, at('80_publish_result.json'))],
    },
  };
}

/** Range(206) 지원 — 영상은 seek 가 되어야 미리보기라 부를 수 있다. */
function serveFile(req, res, path) {
  const size = statSync(path).size;
  const type = PREVIEW_MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);

  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    return createReadStream(path, { start, end }).pipe(res);
  }

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  return createReadStream(path).pipe(res);
}

/* ─────────────────────────────────────────────
 * 2. 화이트리스트 명령
 *    args 는 문자열 배열로만 전달 (쉘 미경유 → 인젝션 불가)
 * ───────────────────────────────────────────── */

const COMMANDS = {
  'create-episode':   { script: 'create-episode.js',      label: '에피소드 생성 (S0)' },
  'script':           { script: 'generate-script.js',     label: '대본 (S4)' },
  'factcheck':        { script: 'run-factcheck.js',       label: '팩트체크 (S5)' },
  'tts':              { script: 'generate-tts.js',        label: 'TTS (S6a)' },
  'sync-durations':   { script: 'sync-durations.js',      label: '길이 동기화 (S6b)' },
  'images':           { script: 'generate-image-gemini.js', label: '씬 이미지 (S6c)' },
  'intro':            { script: 'generate-intro.js',      label: '인트로 카드 (S6d)' },
  'thumbnail':        { script: 'generate-thumbnail.js',  label: '썸네일 (S6e)' },
  'endcard':          { script: 'generate-endcard.js',    label: '엔드카드' },
  'render':           { script: 'render-direct.js',       label: '렌더 (S7)' },
  'qa':               { script: 'generate-qa-report.js',  label: 'QA 리포트 (S8)' },
  'metadata':         { script: 'generate-metadata.js',   label: '메타데이터 (S9)' },
  'approve':          { script: 'approve-episode.js',     label: '승인 (S10)' },
  'publish':          { script: 'publish-youtube.js',     label: '발행 (S11)', danger: true },
  'status':           { script: 'episode-status.js',      label: '상태 조회' },
};

function runCommand(key, args) {
  const cmd = COMMANDS[key];
  if (!cmd) return Promise.reject(new Error(`unknown command: ${key}`));
  const scriptPath = join(AUTOMATION, cmd.script);
  if (!existsSync(scriptPath)) return Promise.reject(new Error(`missing script: ${cmd.script}`));

  return new Promise((res) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd: SKILL_ROOT,
      env: process.env,
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => res({ code, stdout: out, stderr: err, cmd: `node ${cmd.script} ${args.join(' ')}` }));
  });
}

/* ─────────────────────────────────────────────
 * 3. HTTP
 * ───────────────────────────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function body(req) {
  return new Promise(res => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = join(__dirname, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return res.end(readFileSync(html));
  }

  if (url.pathname === '/api/episodes') {
    return json(res, 200, {
      episodes_dir: EPISODES_DIR,
      commands: Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, v.label])),
      episodes: scanEpisodes(),
    });
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    const b = await body(req);
    const key = b.command;
    const args = Array.isArray(b.args) ? b.args.map(String) : [];
    if (!COMMANDS[key]) return json(res, 400, { error: `허용되지 않은 명령: ${key}` });
    // 발행은 되돌리기 어렵다 — 명시적 확인 토큰 필수
    if (COMMANDS[key].danger && b.confirm !== 'PUBLISH') {
      return json(res, 428, { error: '발행은 confirm="PUBLISH" 가 필요합니다.' });
    }
    try {
      const r = await runCommand(key, args);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  // 자산 목록 — EP 폴더 안의 산출물을 종류별로
  if (url.pathname === '/api/assets') {
    const ep = url.searchParams.get('ep') || '';
    if (!EP_RE.test(ep)) return json(res, 400, { error: `잘못된 에피소드 id: ${ep}` });
    const a = listAssets(ep, url.searchParams.get('platform') || '');
    if (!a) return json(res, 404, { error: `없는 에피소드: ${ep}` });
    return json(res, 200, a);
  }

  // 자산 바이트 — 이미지/영상/오디오/텍스트. Range 지원(영상 seek)
  if (url.pathname === '/api/asset/file') {
    const p = safeEpisodePath(url.searchParams.get('ep') || '', url.searchParams.get('rel') || '');
    if (!p) return json(res, 400, { error: '허용되지 않은 경로입니다.' });
    return serveFile(req, res, p);
  }

  // 정적 파일 — __dirname 밖으로 나가지 못하게 명시적으로 가드
  const filePath = resolve(__dirname, url.pathname.replace(/^\//, ''));
  const insideBoard = relative(__dirname, filePath);
  if (!insideBoard.startsWith('..') && !isAbsolute(insideBoard)
      && existsSync(filePath) && statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    return res.end(readFileSync(filePath));
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`📋 BarroTube 에피소드 보드: ${url}`);
  console.log(`   episodes: ${EPISODES_DIR}`);
  console.log(`   (127.0.0.1 전용 · 화이트리스트 ${Object.keys(COMMANDS).length}개 명령만 실행 가능)`);
  if (argv.open) { try { execSync(`open "${url}"`); } catch { /* noop */ } }
});
