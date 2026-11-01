/**
 * chrome-applescript.js — 사용자가 평소 쓰는 Chrome 을 Apple Events 로 몬다.
 *
 * 왜 Playwright 가 아닌가: 유튜브 커뮤니티 게시는 로그인 세션이 필요하다. 별도 프로필을
 * 새로 로그인시키는 대신 이미 로그인돼 있는 창을 쓴다. grok-motion-applescript.js 가
 * 같은 이유로 쓰는 방식인데, 그쪽은 grok 전용 탭 선택 규칙이 박혀 있어 여기서는
 * 일반형으로 다시 썼다.
 *
 * 탭은 **id 로 고정한다**. 인덱스는 사용자가 탭을 닫거나 창 포커스를 바꾸면 그대로
 * 어긋나고(-1719), `windows` 는 인덱스가 아니라 z-order 라 엉뚱한 탭에 쓰게 된다.
 *
 * 전제: Chrome 의 보기 > 개발자용 > "Apple 이벤트의 JavaScript 허용" 이 켜져 있어야 한다.
 */
import { execFileSync } from 'node:child_process';

let CHROME_PID = null;

/** 로그인된 '일반' Chrome 하나. Playwright 가 띄운 Chrome 과 섞이지 않게 플래그로 거른다. */
export function chromePid() {
  if (CHROME_PID !== null) return CHROME_PID;
  const candidates = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
    .split('\n').map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .filter(([, , cmd]) => /^\/.*\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$)/.test(cmd)
      && !/(?:^|\s)--(?:user-data-dir|remote-debugging-port|remote-debugging-pipe|headless)(?:[=\s]|$)/.test(cmd));
  if (candidates.length !== 1) {
    throw new Error(`로그인된 일반 Chrome 프로세스를 하나로 확인할 수 없습니다 (${candidates.length}개)`);
  }
  CHROME_PID = Number(candidates[0][1]);
  return CHROME_PID;
}

const SCRIPT = `function run(argv) {
  var chrome = Application(Number(argv[0])), action = argv[1], value = argv[4];
  if (action === 'open') {
    var ws = chrome.windows();
    if (!ws.length) throw new Error('일반 Chrome 창이 없습니다');
    var tab = chrome.Tab({url: value});
    ws[0].tabs.push(tab);
    return JSON.stringify({windowId: ws[0].id(), tabId: tab.id()});
  }
  // 창 id 로 바로 집으면 그 창이 닫히거나 순서가 바뀌었을 때 -1728 로 죽는다.
  // 9창 94탭 환경에서 실제로 났다(2026-09-25 마켓맵 커뮤니티 게시). 탭 id 는 창이
  // 바뀌어도 유지되므로, 실패하면 전체 창을 훑어 같은 탭을 다시 찾는다.
  var target = null;
  try { target = chrome.windows.byId(argv[2]).tabs.byId(argv[3]); target.url(); }
  catch (e) {
    target = null;
    var all = chrome.windows();
    for (var i = 0; i < all.length && !target; i++) {
      var ts = all[i].tabs();
      for (var j = 0; j < ts.length; j++) {
        if (String(ts[j].id()) === String(argv[3])) { target = ts[j]; break; }
      }
    }
    if (!target) throw new Error('탭을 찾지 못했습니다 (id=' + argv[3] + ') — 창이 닫혔을 수 있습니다');
  }
  if (action === 'eval') return target.execute({javascript: value});
  if (action === 'url') return target.url();
  if (action === 'navigate') { target.url = value; return 'ok'; }
  if (action === 'close') { target.close(); return 'ok'; }
  throw new Error('알 수 없는 action: ' + action);
}`;

/**
 * -1728 = "대상체를 가져올 수 없습니다". 창·탭 참조가 실행 중 무효해졌다는 뜻이고,
 * 사람이 창을 닫거나 Chrome 이 창 순서를 바꾸면 난다. 일시적이라 다시 부르면 대개 풀린다 —
 * 2026-09-25 마켓맵 커뮤니티 게시가 이걸로 죽었고 재시도가 없어 그날 게시가 통째로 빠졌다.
 */
const STALE_OBJECT = /\(-1728\)/;

function run(action, ids, value = '', { attempt = 1 } = {}) {
  try {
    return execFileSync('osascript', ['-l', 'JavaScript', '-e', SCRIPT,
      String(chromePid()), action, ids?.windowId ?? '', ids?.tabId ?? '', value], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000,
    }).trim();
  } catch (e) {
    const stderr = String(e.stderr || '');
    const denied = /(?:JavaScript|자바스크립트).*(?:disabled|꺼져)|\(-1743\)/is.test(stderr);

    // 권한 문제는 다시 불러도 같다 — 재시도하지 않는다.
    if (!denied && STALE_OBJECT.test(stderr) && attempt < 3) {
      execFileSync('sleep', ['1']);
      return run(action, ids, value, { attempt: attempt + 1 });
    }

    const err = new Error(denied
      ? 'Chrome 자동화 권한 필요 — 보기 > 개발자용 > "Apple 이벤트의 JavaScript 허용" 과 macOS 자동화 권한을 확인하세요'
      : (stderr.trim().slice(-500) || `Chrome Apple Events 실패 (${e.code || e.status})`));
    if (denied) err.code = 'BROWSER_PERMISSION';
    if (STALE_OBJECT.test(stderr)) err.code = 'CHROME_STALE_OBJECT';
    throw err;
  }
}

/** 새 탭을 연다. 사용자가 보던 탭은 건드리지 않는다 — 끝나면 closeTab 으로 되돌린다. */
export const openTab = (url) => JSON.parse(run('open', null, url));
export const closeTab = (ids) => run('close', ids);
export const navigate = (ids, url) => run('navigate', ids, url);
export const tabUrl = (ids) => run('url', ids);

/**
 * 탭에서 JS 실행. `missing value` 는 JS 가 undefined 를 돌려줬다는 뜻으로, 리렌더·네비게이션
 * 직후에 나온다. 그대로 넘기면 호출부의 JSON.parse 가 엉뚱한 자리에서 죽어 원인이 안 보인다.
 */
export function evalJS(ids, js, { retries = 3 } = {}) {
  let last = '';
  for (let a = 1; a <= retries; a += 1) {
    last = run('eval', ids, js);
    if (last !== 'missing value') return last;
    execFileSync('sleep', ['1']);
  }
  throw new Error(`Chrome 이 결과를 주지 않았습니다 (missing value) — ${js.slice(0, 80)}…`);
}

/** JSON 을 돌려주는 JS 를 실행한다. */
export const evalJSON = (ids, js, opts) => JSON.parse(evalJS(ids, js, opts));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
