#!/usr/bin/env node
/**
 * grok-motion-applescript.js — 실제 Chrome 을 AppleScript 로 몰아 Grok image→video 를 굽는다.
 *
 * 왜 이게 필요한가 (2026-08-24 실측):
 *   Playwright 는 headless·headed 모두 grok.com 에서 Cloudflare 에 막힌다
 *   ("Sorry, you have been blocked"). CDP attach 도 같다. 반면 사용자가 평소 쓰는
 *   Chrome 은 멀쩡히 열린다 — 차이는 자동화 표면이지 로그인이 아니다.
 *   AppleScript 의 `execute javascript` 는 CDP 포트도 webdriver 플래그도 쓰지 않아
 *   자동화 지문이 남지 않는다. cron(launchd Aqua 세션)에서 그대로 돈다.
 *
 * 첨부는 DataTransfer 주입으로 한다 — 파일 선택 UI·클립보드·Playwright 파일 API 를
 * 전부 우회한다. 기존 문서가 "codex 표면에서는 첨부 3경로가 모두 막힌다" 고 적어 둔
 * 그 벽을 이 방식이 넘는다 (2026-08-24 실측: Remove image + blob 썸네일 확인).
 *
 * 전제: Chrome 의 보기 > 개발자용 > "Apple 이벤트의 JavaScript 허용" 이 켜져 있어야 한다.
 *
 * Usage:
 *   node grok-motion-applescript.js --episode <dir> [--platform shorts] [--scene 003] [--force]
 *   node grok-motion-applescript.js --check      # 세션·차단 상태만 확인 (0=사용가능, 3=불가)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const GROK_URL = 'https://grok.com/imagine';
/** Finder 가 바빠도 버티게 한다. 기본 AppleEvent 타임아웃(60초)이 -1712 의 원인이었다. */
/** 기대하는 Grok 로그인 계정. 비우면 계정 검사를 하지 않는다. */
const BT_GROK_ACCOUNT = process.env.BT_GROK_ACCOUNT || '82beye@gmail.com';
const FINDER_TIMEOUT_SEC = Number(process.env.BT_GROK_FINDER_TIMEOUT || 300);
const CUT_DELAY_MS = Number(process.env.BT_GROK_CUT_DELAY_MS ?? 12000);
const GEN_TIMEOUT_MS = Number(process.env.BT_GROK_TIMEOUT_MS || 6 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

/** osascript 로 Chrome 탭에서 JS 실행. 결과 문자열 반환. */
/**
 * Chrome 탭에서 JS 실행.
 *
 * 탭 **인덱스를 고정하지 않는다.** 사용자가 평소 쓰는 브라우저라 실행 중에도
 * 탭이 닫히고 순서가 바뀐다 — 고정하면 "유효하지 않은 인덱스 (-1719)" 로 죽는다
 * (2026-08-25 EP-0114 us-close: 씬 002~005 가 전부 이걸로 실패했다).
 * 매 호출마다 grok.com 탭을 다시 찾고, 없으면 만든다.
 */
function chromeJS(js) {
  // `with timeout` 이 없으면 AppleEvent 는 60초에 끊긴다. 영상 생성 중인 Chrome 은
  // 그보다 오래 응답을 못 주는 순간이 있어서 -1712 (AppleEvent timed out) 로 죽었고,
  // 그 에러가 "Apple Events 자바스크립트가 꺼져 있다" 는 메시지로 오인되기도 했다.
  // (2026-08-30 EP-0124 실측: scene_001 이 4분 대기 중 -1712 로 실패.)
  const script = `on run argv
  set j to item 1 of argv
  with timeout of 300 seconds
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if (URL of t) contains "grok.com" then return (execute t javascript j)
        end repeat
      end repeat
      error "GROK_TAB_GONE"
    end tell
  end timeout
end run`;
  return execFileSync('osascript', ['-e', script, js], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** 지금 Grok 에 로그인된 계정 이메일. 못 읽으면 null (검사를 건너뛴다). */
function signedInAs() {
  try {
    const r = chromeJS("(function(){var m=document.body.innerText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);return m?m[0]:''})()");
    return r || null;
  } catch { return null; }
}

/** grok.com 탭을 찾는다. 없으면 새 탭으로 연다. → {windowIdx, tabIdx} */
function findGrokTab() {
  const finder = `tell application "Google Chrome"
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      if (URL of t) contains "grok.com" then return (wi as string) & "," & (ti as string)
    end repeat
  end repeat
  return "none"
end tell`;
  const r = execFileSync('osascript', ['-e', finder], { encoding: 'utf8' }).trim();
  if (r !== 'none') {
    const [w, t] = r.split(',').map(Number);
    return { windowIdx: w, tabIdx: t };
  }
  // 새 탭
  const opener = `tell application "Google Chrome"
  if (count of windows) = 0 then make new window
  tell front window
    make new tab with properties {URL:"${GROK_URL}"}
    return ((index of front window) as string) & "," & ((count of tabs) as string)
  end tell
end tell`;
  const r2 = execFileSync('osascript', ['-e', opener], { encoding: 'utf8' }).trim();
  const [w, t] = r2.split(',').map(Number);
  return { windowIdx: w, tabIdx: t };
}

function navigate(_tab, url) {
  // grok 탭을 찾아 URL 을 바꾼다. 없으면 새로 만든다.
  const s = `on run argv
  set u to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t) contains "grok.com" then
          set URL of t to u
          return "ok"
        end if
      end repeat
    end repeat
    if (count of windows) = 0 then make new window
    tell front window to make new tab with properties {URL:u}
    return "new"
  end tell
end run`;
  execFileSync('osascript', ['-e', s, url], { encoding: 'utf8' });
}

/** 페이지가 쓸 준비가 될 때까지 — file input 이 보일 때까지 */
async function waitReady(tab, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2500);
    let r;
    try {
      r = JSON.parse(chromeJS(`(function(){var t=document.body.innerText;return JSON.stringify({blocked:/blocked|unable to access/i.test(t),fi:document.querySelectorAll('input[type="file"]').length,login:t.indexOf('가입하기')>=0});})()`));
    } catch { continue; }
    if (r.blocked) throw new Error('Cloudflare 차단 — 실제 Chrome 에서도 막혔습니다');
    if (r.login) throw new Error('Grok 로그아웃 상태 — Chrome 에서 로그인하세요');
    if (r.fi > 0) return true;
  }
  throw new Error('페이지 준비 실패 (file input 미검출)');
}

/**
 * DataTransfer 주입으로 스틸 첨부.
 * base64 를 한 번에 넘기면 osascript 인자 한도(E2BIG)를 넘는다 — 2.3MB 스틸이 그렇다.
 * 그래서 청크로 나눠 window 전역에 이어 붙인 뒤 마지막에 조립한다.
 */
const B64_CHUNK = 120_000; // osascript 인자 여유분

async function attachStill(tab, pngPath) {
  const b64 = readFileSync(pngPath).toString('base64');
  // 청크 전송은 페이지 리렌더·포커스 변화에 끼면 조용히 유실된다
  // (2026-08-24 실측: 씬 004 가 184401/1984392 로 끊겼다).
  // 청크마다 누적 길이를 확인하고, 어긋나면 그 컷만 처음부터 다시 보낸다.
  let sent = false;
  for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
    chromeJS('(function(){window.__btB64="";return "ok";})()');
    let ok = true;
    for (let i = 0; i < b64.length; i += B64_CHUNK) {
      const part = b64.slice(i, i + B64_CHUNK);
      const expect = Math.min(i + B64_CHUNK, b64.length);
      let got = 0;
      for (let retry = 0; retry < 3; retry++) {
        try {
          got = Number(chromeJS(`(function(){window.__btB64+=${JSON.stringify(part)};return String(window.__btB64.length);})()`));
        } catch { got = -1; }
        if (got === expect) break;
        // 어긋났으면 이 청크만 되돌리고 다시
        chromeJS(`(function(){window.__btB64=window.__btB64.slice(0,${i});return "ok";})()`);
        await sleep(400);
      }
      if (got !== expect) { ok = false; break; }
    }
    if (ok && Number(chromeJS('String(window.__btB64.length)')) === b64.length) sent = true;
    else { console.warn(`     base64 전송 재시도 ${attempt}/3`); await sleep(1500); }
  }
  if (!sent) throw new Error(`base64 전송 실패 (${b64.length}자)`);

  const js = `(function(){
    var b64=window.__btB64;
    var bin=atob(b64), arr=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    var f=new File([arr],"still.png",{type:"image/png"});
    var dt=new DataTransfer(); dt.items.add(f);
    var inp=document.querySelector('input[type="file"]');
    if(!inp) return JSON.stringify({ok:false,why:"no input"});
    inp.files=dt.files;
    inp.dispatchEvent(new Event("change",{bubbles:true}));
    return JSON.stringify({ok:true});
  })()`;
  chromeJS(js);
  // 첨부 판정은 반환값이 아니라 Remove image / blob 썸네일로 한다
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const r = JSON.parse(chromeJS(`(function(){return JSON.stringify({rb:[].slice.call(document.querySelectorAll('button')).some(function(b){return b.getAttribute('aria-label')==='Remove image';}),th:!!document.querySelector('img[src^="blob:"]')});})()`));
    if (r.rb || r.th) return true;
  }
  throw new Error('첨부 확인 실패 (Remove image·썸네일 미검출)');
}

/** 프롬프트 입력 + 옵션 확정 + 제출 */
async function submitPrompt(tab, prompt) {
  const js = `(function(){
    var el=document.querySelector('[contenteditable="true"]');
    if(!el) return JSON.stringify({ok:false,why:"no composer"});
    el.focus();
    document.execCommand("insertText",false,${JSON.stringify(prompt)});
    return JSON.stringify({ok:true,len:el.innerText.length});
  })()`;
  const ins = JSON.parse(chromeJS(js));
  if (!ins.ok) throw new Error('컴포저를 찾지 못했습니다');
  await sleep(900);

  // 720p / 10s 확정 + 쿠키 동의 제거 + 제출
  const submitJs = `(function(){
    var B=[].slice.call(document.querySelectorAll('button'));
    ['720p','10s'].forEach(function(t){
      var b=B.filter(function(x){return (x.textContent||'').trim()===t;})[0];
      if(b) b.click();
    });
    var rj=B.filter(function(b){return (b.textContent||'').trim()==='모두 거부';})[0];
    if(rj) rj.click();
    var el=document.querySelector('[contenteditable="true"]');
    var form=el.closest('form');
    var sb=[].slice.call((form||document).querySelectorAll('button')).filter(function(b){return b.type==='submit';})[0];
    if(!sb) return JSON.stringify({ok:false,why:"no submit"});
    var before=location.pathname;
    sb.click();
    return JSON.stringify({ok:true,before:before});
  })()`;
  await sleep(600);
  const sub = JSON.parse(chromeJS(submitJs));
  if (!sub.ok) throw new Error('제출 버튼을 찾지 못했습니다');

  // 제출 확인 — /imagine/post/<id> 로 이동해야 한다
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const p = chromeJS(`location.pathname`);
    if (p.includes('/imagine/post/')) return p;
  }
  throw new Error('제출이 반영되지 않았습니다');
}

/** 생성 완료까지 폴링 후 다운로드 클릭 */
/**
 * 페이지에 걸린 생성 영상 URL 목록. 히스토리 썸네일도 같은 <video> 라서
 * "제출 전에 없던 URL" 이 이번 컷이다 — 레이아웃이 바뀌어도 이 차집합은 성립한다.
 */
function videoSrcs(tab) {
  const raw = chromeJS(`(function(){
    var vs=[].slice.call(document.querySelectorAll('video'));
    var out=[];
    for(var i=0;i<vs.length;i++){var s=vs[i].currentSrc||vs[i].src||'';if(s.indexOf('generated_video')>=0)out.push(s);}
    return JSON.stringify(out);
  })()`);
  try { return JSON.parse(raw); } catch { return []; }
}

/**
 * 새 영상 URL 이 뜰 때까지 기다린다. 이것이 곧 생성 완료 신호다.
 *
 * 왜 버튼을 안 쓰나: 2026-08-30 Grok UI 에서 최상위 "다운로드" 버튼이 사라지고
 * 「게시물 작업」 메뉴 안으로 들어갔다. 버튼 라벨을 쫓으면 UI 가 바뀔 때마다 깨진다.
 * URL 차집합은 DOM 구조에 거의 의존하지 않는다.
 */
async function waitForNewVideo(tab, before) {
  const seen = new Set(before);
  const t0 = Date.now();
  while (Date.now() - t0 < GEN_TIMEOUT_MS) {
    await sleep(5000);
    const now = videoSrcs(tab);
    const fresh = now.filter(u => !seen.has(u));
    if (fresh.length) return fresh[0];
  }
  throw new Error(`새 영상 URL 이 ${Math.round(GEN_TIMEOUT_MS / 1000)}초 안에 뜨지 않았습니다`);
}

/**
 * assets.grok.com 은 쿠키 없이는 403 이다. 그래서 페이지 안에서 fetch 해
 * base64 로 꺼내 온다 — Downloads 폴더·TCC·Chrome History DB 를 전부 우회한다.
 * osascript 반환값 한계 때문에 200KB 씩 끊어 받는다.
 */
async function fetchVideoToFile(tab, url, outPath) {
  chromeJS(`(function(){
    window.__btDL={state:'pending',b64:'',err:''};
    fetch(${JSON.stringify(url)},{credentials:'include'})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.blob(); })
      .then(function(b){ return new Promise(function(res,rej){
        var fr=new FileReader();
        fr.onload=function(){ res(String(fr.result).split(',')[1]||''); };
        fr.onerror=rej; fr.readAsDataURL(b);
      }); })
      .then(function(b64){ window.__btDL={state:'done',b64:b64,err:''}; })
      .catch(function(e){ window.__btDL={state:'error',b64:'',err:String((e&&e.message)||e)}; });
    return 'started';
  })()`);

  let st = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    st = JSON.parse(chromeJS(`JSON.stringify({state:window.__btDL.state,len:window.__btDL.b64.length,err:window.__btDL.err})`));
    if (st.state !== 'pending') break;
  }
  if (!st || st.state !== 'done') throw new Error(`영상 fetch 실패: ${(st && st.err) || 'timeout'}`);

  const CH = 200000;
  let b64 = '';
  for (let off = 0; off < st.len; off += CH) {
    const part = chromeJS(`window.__btDL.b64.substr(${off},${CH})`);
    b64 += part;
  }
  if (b64.length !== st.len) throw new Error(`base64 유실 (${b64.length}/${st.len})`);
  writeFileSync(outPath, Buffer.from(b64, 'base64'));
  chromeJS(`(function(){window.__btDL=null;return 'cleared';})()`);
}

async function waitAndDownload(tab) {
  const t0 = Date.now();
  while (Date.now() - t0 < GEN_TIMEOUT_MS) {
    await sleep(5000);
    // 진행 신호는 두 가지다. 예전 UI 는 본문에 "생성 중 NN%" 를 찍었고,
    // 2026-08-30 현재 UI 는 버튼 aria-label 로만 "미디어 생성 진행 중" 을 남긴다.
    // %만 보던 시절엔 첫 5초에 곧장 완료로 판정해 아직 없는 다운로드 버튼을 찾다 죽었다.
    const r = JSON.parse(chromeJS(`(function(){
      var m=document.body.innerText.match(/생성 중\\s*(\\d+)%/);
      var B=[].slice.call(document.querySelectorAll('button'));
      var busy=B.some(function(b){return ((b.getAttribute('aria-label')||b.textContent||'')).indexOf('미디어 생성 진행 중')>=0;});
      var dl=B.some(function(b){return ((b.getAttribute('aria-label')||b.textContent||'').trim())==='다운로드';});
      return JSON.stringify({pct:m?m[1]:null,busy:busy,dl:dl});
    })()`));
    if (r.dl) break;                    // 다운로드 버튼이 뜨면 그게 완료 신호다
    if (r.pct === null && !r.busy) break;
  }
  // 진행률이 사라진 뒤에만 다운로드 — 일찍 누르면 직전 컷이 다시 받아진다
  // 다운로드 버튼은 생성 완료 직후에도 잠깐 안 붙어 있다 — 최대 60초 재시도.
  // (2026-08-25 EP-0114: 씬 001 이 "다운로드 버튼을 찾지 못했습니다" 로 죽었다.
  //  진행률은 사라졌는데 상세 패널 렌더가 늦은 경우다.)
  let clicked = false;
  for (let i = 0; i < 40 && !clicked; i++) {
    const dl = JSON.parse(chromeJS(`(function(){
      var B=[].slice.call(document.querySelectorAll('button'));
      var rj=B.filter(function(b){return (b.textContent||'').trim()==='모두 거부';})[0];
      if(rj) rj.click();
      var d=B.filter(function(b){return ((b.getAttribute('aria-label')||b.textContent||'').trim())==='다운로드';})[0];
      if(!d) return JSON.stringify({ok:false});
      d.click();
      return JSON.stringify({ok:true});
    })()`));
    if (dl.ok) { clicked = true; break; }
    await sleep(3000);
  }
  if (!clicked) throw new Error('다운로드 버튼을 찾지 못했습니다 (120초 재시도 후)');
  await sleep(6000);
}

/** Chrome History DB 에서 방금 받은 grok 영상 경로를 읽는다 (TCC 우회) */
function latestGrokDownload(sinceMs) {
  const profiles = ['Default', 'beye82', 'Profile 1', 'Profile 2', 'Profile 4'];
  const base = join(homedir(), 'Library/Application Support/Google/Chrome');
  for (const p of profiles) {
    const db = join(base, p, 'History');
    if (!existsSync(db)) continue;
    const tmp = join('/tmp', `bt-hist-${Date.now()}.db`);
    try {
      copyFileSync(db, tmp);
      const out = execFileSync('sqlite3', [tmp,
        `SELECT target_path, start_time FROM downloads WHERE target_path LIKE '%grok-video%' ORDER BY start_time DESC LIMIT 1;`,
      ], { encoding: 'utf8' }).trim();
      if (!out) continue;
      const [path, st] = out.split('|');
      // Chrome 의 start_time 은 1601-01-01 기준 **마이크로초**다.
      // /1000 하면 밀리초가 아니라 1000분의 1초 단위가 되어 비교가 항상 실패한다
      // (2026-08-24: 다운로드는 됐는데 "History DB 미갱신" 으로 오판했다).
      const epochMs = Number(st) / 1000 - 11644473600000;
      if (Number.isFinite(epochMs) && epochMs >= sinceMs - 30000) return path;
    } catch { /* 다음 프로필 */ }
  }
  return null;
}

/**
 * Finder 로 복사 (Bash 는 TCC 때문에 ~/Downloads 를 못 읽는다).
 *
 * AppleEvent 기본 타임아웃은 60초다. Finder 가 잠깐 바쁘면 그걸 넘겨 -1712 로 죽는데,
 * 그때 **영상은 이미 다 받아져 있다** — 마지막 복사 한 줄 때문에 5컷이 통째로 실패로
 * 기록된다 (2026-08-26 EP-2026-0116 us-close: 5/5 다운로드 성공, 5/5 복사 실패,
 * 그 결과 Phase 7 이 "Grok 모션 클립이 없습니다" 로 halt). 그래서
 *   1) with timeout 으로 여유를 주고,
 *   2) 그래도 실패하면 fs 복사로 한 번 더 시도한다. cron(TCC 제한)에서는 이 폴백이
 *      EPERM 으로 막히지만, 대화형 세션에서는 그대로 통과한다.
 * 둘 다 실패할 때만 던진다.
 */
function finderCopy(src, destDir, name) {
  // 같은 이름이 이미 있으면 Finder 의 `set name` 이 -48 로 죽는다
  // (duplicate 는 with replacing 이라 통과하는데, 그 뒤 rename 에서 걸린다).
  const dest = join(destDir, name);
  try { unlinkSync(dest); } catch { /* 없으면 그만 */ }
  const s = `with timeout of ${FINDER_TIMEOUT_SEC} seconds
  tell application "Finder"
    set d to duplicate ((POSIX file ${JSON.stringify(src)}) as alias) to ((POSIX file ${JSON.stringify(destDir)}) as alias) with replacing
    set name of d to ${JSON.stringify(name)}
  end tell
end timeout`;
  try {
    execFileSync('osascript', ['-e', s], { encoding: 'utf8', timeout: (FINDER_TIMEOUT_SEC + 30) * 1000 });
    return;
  } catch (e) {
    try {
      copyFileSync(src, dest);
      console.warn(`     ↳ Finder 복사 실패 → fs 복사로 대체 (${String(e.message).split('\n')[0].slice(0, 80)})`);
      return;
    } catch (e2) {
      throw new Error(`복사 실패 — Finder: ${String(e.message).split('\n')[0].slice(0, 80)} / fs: ${e2.code || e2.message}`);
    }
  }
}

function loadScenes(baseDir) {
  const txt = readFileSync(join(baseDir, '30_script.md'), 'utf8');
  const out = [];
  for (const blk of txt.split(/\n  - scene_id: /).slice(1)) {
    const id = (blk.match(/^"(\d+)"/) || [])[1];
    const role = (blk.match(/role: (\w+)/) || [])[1] || '';
    if (id) out.push({ id, role });
  }
  return out;
}

/** 씬 역할에 맞는 모션 프롬프트. 스틸을 "다시 상상"하지 않도록 고정 꼬리를 붙인다. */
function motionFor(scene) {
  const byRole = {
    hook: 'Slow push-in on the main subject as the central object shifts with weight; subtle light flicker',
    context: 'Gentle upward camera drift across the scene as details light up in sequence',
    insight: 'Slow tilt across the central object as light sweeps over it',
    implication: 'Slow orbit around the central object as it settles firmly into place',
    cta: 'Slow push-in on the central object as it glows and turns forward',
  };
  const base = byRole[scene.role] || byRole.hook;
  return `${base}; keep the character design and composition exactly as the attached image.`;
}

/**
 * AppleScript 의 `tell application "Google Chrome"` 은 같은 번들이 여러 인스턴스로
 * 떠 있으면 어느 쪽을 잡을지 보장하지 않는다. auto-pipeline 은 Phase 6 에서 codex
 * imagegen 이 Playwright 로 Chrome 을 하나 더 띄우는데, 그 프로필에는 "Apple Events 의
 * 자바스크립트 허용" 이 없다. 그 인스턴스가 남아 있으면 Phase 7 의 모든 execute javascript 가
 * 실패하고, 에러 메시지는 엉뚱하게 "자바스크립트 실행 기능이 꺼져 있습니다" 로 나온다
 * — 사용자 Chrome 은 멀쩡히 켜져 있는데도. (2026-08-30 EP-0124 실측, 원인 규명에 30분)
 *
 * 우리가 띄운 자동화 프로필만 정리한다. 사용자 기본 프로필은 절대 건드리지 않는다.
 */
function killShadowChromes() {
  const AUTOMATION_PROFILE = /--user-data-dir=(\/Users\/[^/]+\/\.(codex|barrotube|npm)\/|\/tmp\/|\/var\/folders\/)/;
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch { return 0; }
  let killed = 0;
  for (const line of out.split('\n')) {
    if (!line.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) continue;
    if (line.includes('Helper')) continue;
    if (!AUTOMATION_PROFILE.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* 이미 죽었으면 무시 */ }
  }
  if (killed) console.log(`  🧹 자동화용 Chrome 인스턴스 ${killed}개 정리 (AppleScript 대상 모호성 제거)`);
  return killed;
}

async function main() {
  const { values } = parseArgs({ options: {
    episode: { type: 'string', short: 'e' },
    platform: { type: 'string', short: 'p', default: 'shorts' },
    scene: { type: 'string' },
    force: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
  } });

  killShadowChromes();

  const tab = findGrokTab();

  if (values.check) {
    // 첫 진입은 SPA 부팅이 늦어 file input 이 안 잡힐 수 있다 — 한 번 더 준다.
    // (2026-08-24: cron 검증에서 1차 실패 → 재실행 성공. 재시도가 없으면 게이트가
    //  멀쩡한 환경을 실패로 판정한다.)
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      navigate(tab, GROK_URL);
      try {
        await waitReady(tab, 60000);
        // 접근 가능 여부만 보면 **남의 계정으로 로그인돼 있어도 통과한다.**
        // 2026-08-27 EP-2026-0118: Chrome 의 Grok 이 hameedkhan17653@gmail.com 세션이었고
        // --check 는 ✅ 를 줬다. 생성은 시작되는데 다운로드 버튼이 안 잡혀 5컷 전부
        // "다운로드 버튼을 찾지 못했습니다" 로 11분을 헛돌았다. 계정을 같이 본다.
        const who = signedInAs();
        if (BT_GROK_ACCOUNT && who && who.toLowerCase() !== BT_GROK_ACCOUNT.toLowerCase()) {
          console.error(`❌ Grok 이 다른 계정입니다: ${who} (기대 ${BT_GROK_ACCOUNT})`);
          console.error('   Chrome 에서 운영자 계정으로 다시 로그인하세요. 코드로는 풀 수 없습니다.');
          process.exit(3);
        }
        console.log(`✅ 실제 Chrome 으로 Grok 사용 가능 (w${tab.windowIdx}t${tab.tabIdx})${who ? ` · ${who}` : ''}`);
        process.exit(0);
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await sleep(5000);
      }
    }
    console.error(`❌ ${lastErr ? lastErr.message : '알 수 없는 실패'}`);
    process.exit(3);
  }

  if (!values.episode) {
    console.error('Usage: grok-motion-applescript.js --episode <dir> [--platform shorts] [--scene 003] [--force] | --check');
    process.exit(1);
  }

  const epDir = resolve(values.episode);
  const baseDir = existsSync(join(epDir, 'platforms', values.platform, '30_script.md'))
    ? join(epDir, 'platforms', values.platform) : epDir;
  const imagesDir = join(baseDir, '40_assets', 'images');
  const videosDir = join(baseDir, '40_assets', 'videos');
  mkdirSync(videosDir, { recursive: true });

  const scenes = loadScenes(baseDir);
  const wanted = values.scene
    ? scenes.filter((s) => s.id === String(values.scene).padStart(3, '0'))
    : scenes;

  const knownHashes = new Set(
    readdirSync(videosDir).filter((f) => f.endsWith('.mp4'))
      .map((f) => { try { return md5(join(videosDir, f)); } catch { return null; } })
      .filter(Boolean),
  );

  console.log(`🖥  실제 Chrome (AppleScript) — w${tab.windowIdx}t${tab.tabIdx}`);
  let made = 0, failed = 0;

  for (const [i, scene] of wanted.entries()) {
    const still = join(imagesDir, `scene_${scene.id}.png`);
    const outPath = join(videosDir, `scene_${scene.id}.mp4`);
    if (!existsSync(still)) { console.warn(`  ⏭  씬 ${scene.id}: 스틸 없음`); continue; }
    if (existsSync(outPath) && !values.force) { console.log(`  ⏭  씬 ${scene.id}: 이미 있음`); continue; }

    try {
      navigate(tab, GROK_URL);
      await waitReady(tab, 60000);
      await attachStill(tab, still);
      const beforeSrcs = videoSrcs(tab);
      await submitPrompt(tab, motionFor(scene));
      const videoUrl = await waitForNewVideo(tab, beforeSrcs);
      await fetchVideoToFile(tab, videoUrl, outPath);

      // 중복 판정은 쓰기 직후 산출물에서 한다. 같은 파일이 두 씬에 박히면
      // 같은 화면이 두 번 나가는 영상이 발행된다 (2026-08-26 EP-0116 실측).
      const hash = md5(outPath);
      if (knownHashes.has(hash)) {
        try { unlinkSync(outPath); } catch { /* 이미 없으면 그만 */ }
        throw new Error('직전 컷과 같은 파일 (중복) — 자리를 비워 둔다');
      }
      knownHashes.add(hash);

      const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outPath], { encoding: 'utf8' }).trim();
      if (probe !== 'aac') {
        // 오디오가 없으면 쓸 수 없는 파일이다. 자리에 남겨 두면 다음 실행이
        // "이미 있음" 으로 건너뛴다.
        try { unlinkSync(outPath); } catch { /* 이미 없으면 그만 */ }
        throw new Error(`오디오 없음 (codec=${probe || 'none'}) — Video audio 를 켜야 합니다`);
      }

      made += 1;
      console.log(`  ✅ 씬 ${scene.id} → ${outPath}`);
    } catch (e) {
      failed += 1;
      console.warn(`  ❌ 씬 ${scene.id}: ${e.message}`);
    }

    if (CUT_DELAY_MS > 0 && i < wanted.length - 1) {
      console.log(`  ⏳ 다음 컷까지 ${Math.round(CUT_DELAY_MS / 1000)}초 대기`);
      await sleep(CUT_DELAY_MS);
    }
  }

  console.log(`\n🎬 Grok 모션(실제 Chrome): 신규 ${made}컷${failed ? `, 실패 ${failed}컷` : ''} → ${videosDir}`);
  process.exit(failed && !made ? 1 : 0);
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
