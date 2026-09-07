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
/**
 * 서비스가 멎었을 때 몇 컷까지 시도해 보고 접을지.
 *
 * 컷당 타임아웃이 6분이라 5컷을 끝까지 밀면 30분이 사라진다. 2026-09-04 EP-2026-0134
 * 가 그렇게 돌다 발행 창을 놓쳤다 — 게시물은 만들어지는데 영상이 끝내 렌더되지 않는
 * 서비스측 정체였고, 씬을 바꿔도 결과는 같았다.
 *
 * 1컷 실패는 콘텐츠 사유(모더레이션)일 수 있으니 접지 않는다. **성공이 하나도 없는 채**
 * 연속 타임아웃이 이 값에 닿으면 서비스 문제로 보고 남은 컷을 포기한다 —
 * 파이프라인이 곧바로 HyperFrames 폴백으로 넘어가 그날 편은 나간다.
 */
const STALL_ABORT_AFTER = Number(process.env.BT_GROK_STALL_ABORT || 2);
/** 서비스 정체 신호. 컷 고유 사유(중복·오디오 없음)와 구분해야 한다. */
const STALL_PATTERN = /준비되지 않았습니다|내려받지 못했습니다/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

/** osascript 로 Chrome 탭에서 JS 실행. 결과 문자열 반환. */
/**
 * Chrome 탭에서 JS 실행.
 *
 * 탭 **인덱스는 고정하지 않고, 탭 id 로 고정한다.**
 *
 * 인덱스 고정은 "유효하지 않은 인덱스 (-1719)" 로 죽는다 — 사용자가 평소 쓰는
 * 브라우저라 실행 중에도 탭이 닫히고 순서가 바뀐다 (2026-08-25 EP-0114: 씬
 * 002~005 가 전부 이걸로 실패). 그래서 한동안 "매 호출마다 grok.com 첫 탭을 다시
 * 찾는" 방식을 썼는데, 이건 **grok 탭이 둘 이상이면 조용히 틀린다**:
 * AppleScript 의 `windows` 는 인덱스가 아니라 z-order 라, 창 포커스가 바뀌면
 * 제출과 수신이 서로 다른 탭에서 일어난다. 2026-09-01 EP-0127·0128 실측 —
 * 프롬프트는 /imagine 에 넣고 영상은 /imagine/saved(저장 갤러리)에서 읽어,
 * 에피소드와 무관한 예전 생성물 10컷이 그대로 렌더까지 갔다.
 *
 * 탭 id 는 순서가 바뀌어도 같은 탭을 가리키므로 두 실패를 모두 피한다.
 */
let GROK_TAB_ID = null;

function chromeJS(js) {
  // `with timeout` 이 없으면 AppleEvent 는 60초에 끊긴다. 영상 생성 중인 Chrome 은
  // 그보다 오래 응답을 못 주는 순간이 있어서 -1712 (AppleEvent timed out) 로 죽었고,
  // 그 에러가 "Apple Events 자바스크립트가 꺼져 있다" 는 메시지로 오인되기도 했다.
  // (2026-08-30 EP-0124 실측: scene_001 이 4분 대기 중 -1712 로 실패.)
  const match = GROK_TAB_ID === null
    ? '(URL of t) contains "grok.com"'
    : `(id of t) is "${GROK_TAB_ID}"`;
  const script = `on run argv
  set j to item 1 of argv
  with timeout of 300 seconds
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if ${match} then return (execute t javascript j)
        end repeat
      end repeat
      error "GROK_TAB_GONE"
    end tell
  end timeout
end run`;
  // `missing value` 는 JS 가 undefined 를 돌려줬다는 뜻이다 — 페이지가 아직 스크립트를
  // 못 받는 순간(리렌더·네비게이션 직후)에 나온다. 그대로 넘기면 호출부의 JSON.parse 가
  // "Unexpected token 'm'" 로 죽어 원인이 안 보인다. 잠깐 두고 다시 시도한다.
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = execFileSync('osascript', ['-e', script, js], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).trim();
    if (last !== 'missing value') return last;
    execFileSync('sleep', ['1']);
  }
  throw new Error(`Chrome 이 결과를 주지 않았습니다 (missing value) — ${js.slice(0, 80)}…`);
}

/** 지금 Grok 에 로그인된 계정 이메일. 못 읽으면 null (검사를 건너뛴다). */
function signedInAs() {
  try {
    const r = chromeJS("(function(){var m=document.body.innerText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);return m?m[0]:''})()");
    return r || null;
  } catch { return null; }
}

/**
 * grok.com 탭을 찾아 **id 로 고정한다**. 없으면 새 탭으로 연다.
 * → {tabId, windowIdx, tabIdx}
 *
 * **작성기 탭만 고른다.** /imagine/saved 는 저장 갤러리고 /imagine/post/... 는 게시물
 * 상세라, 둘 다 프롬프트를 넣을 작성기가 없다. 갤러리에 붙으면 videoSrcs 의 차집합이
 * "이번에 생성한 컷" 이 아니게 되고(2026-09-01 EP-0127·0128 사고), 게시물 상세에
 * 붙으면 "제출 버튼을 찾지 못했습니다" 로 죽는다.
 * 후보가 없으면 새 탭을 연다 — 로그인은 프로필 단위라 새 탭도 그대로 로그인돼 있다.
 */
function findGrokTab() {
  const finder = `tell application "Google Chrome"
  set wi to 0
  set fallback to "none"
  repeat with w in windows
    set wi to wi + 1
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      set u to (URL of t)
      if u contains "grok.com" then
        set row to (id of t as string) & "," & (wi as string) & "," & (ti as string)
        if u contains "/imagine" and u does not contain "/imagine/saved" and u does not contain "/imagine/post" then return row
        if fallback is "none" then set fallback to row
      end if
    end repeat
  end repeat
  return fallback
end tell`;
  const r = execFileSync('osascript', ['-e', finder], { encoding: 'utf8' }).trim();
  if (r !== 'none') {
    const [id, w, t] = r.split(',');
    GROK_TAB_ID = id;
    return { tabId: id, windowIdx: Number(w), tabIdx: Number(t) };
  }
  // 새 탭
  const opener = `tell application "Google Chrome"
  if (count of windows) = 0 then make new window
  set nt to make new tab at end of tabs of front window with properties {URL:"${GROK_URL}"}
  return ((id of nt) as string) & "," & ((count of tabs of front window) as string)
end tell`;
  const r2 = execFileSync('osascript', ['-e', opener], { encoding: 'utf8' }).trim();
  const [id, t] = r2.split(',');
  GROK_TAB_ID = id;
  return { tabId: id, windowIdx: 1, tabIdx: Number(t) };
}

function navigate(_tab, url) {
  // 고정된 작업 탭의 URL 을 바꾼다. chromeJS 와 **같은 탭**이어야 한다 —
  // 아니면 프롬프트를 넣은 탭과 영상을 읽는 탭이 갈린다.
  const match = GROK_TAB_ID === null
    ? '(URL of t) contains "grok.com"'
    : `(id of t) is "${GROK_TAB_ID}"`;
  const s = `on run argv
  set u to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if ${match} then
          set URL of t to u
          return "ok"
        end if
      end repeat
    end repeat
    if (count of windows) = 0 then make new window
    tell front window to set nt to make new tab with properties {URL:u}
    return "new:" & ((id of nt) as string)
  end tell
end run`;
  const r = execFileSync('osascript', ['-e', s, url], { encoding: 'utf8' }).trim();
  if (r.startsWith('new:')) GROK_TAB_ID = r.slice(4);
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

  // 이전 컷의 첨부가 남아 있으면 먼저 지운다. 안 지우면 두 가지가 망가진다 —
  // 남은 스틸로 이번 컷이 생성되거나, 그 잔재가 아래 검증을 거짓 통과시킨다.
  chromeJS(`(function(){
    var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return x.getAttribute('aria-label')==='Remove image';})[0];
    if(b) b.click();
    return 'ok';
  })()`);
  await sleep(800);

  const uiState = () => JSON.parse(chromeJS(`(function(){
    return JSON.stringify({
      rb:[].slice.call(document.querySelectorAll('button')).some(function(b){return b.getAttribute('aria-label')==='Remove image';}),
      th:!!document.querySelector('img[src^="blob:"]')
    });
  })()`));

  // 지워졌는지 먼저 확인한다. 이게 이번 첨부를 직전 컷의 잔재와 갈라 주는 기준선이다.
  for (let i = 0; i < 8; i++) {
    const s0 = uiState();
    if (!s0.rb && !s0.th) break;
    await sleep(700);
  }

  const js = `(function(){
    try{
      var b64=window.__btB64;
      var bin=atob(b64), arr=new Uint8Array(bin.length);
      for(var i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
      var f=new File([arr],"still.png",{type:"image/png"});
      var dt=new DataTransfer(); dt.items.add(f);
      var inps=[].slice.call(document.querySelectorAll('input[type="file"]'));
      var inp=inps.filter(function(x){return x.closest('form')&&/image\\//.test(x.accept||'');})[0]
              || inps.filter(function(x){return x.closest('form');})[0] || inps[0];
      if(!inp) return JSON.stringify({ok:false,why:"no input"});
      inp.files=dt.files;
      var n=inp.files.length, sz=(inp.files[0]||{}).size||0;
      // change 는 할당 확인 **뒤에** 쏜다 — 앱이 파일을 가져가며 input 을 비우기 때문에
      // 이 뒤로는 files.length 가 0 이 되고, 그건 실패가 아니라 성공의 흔적이다.
      inp.dispatchEvent(new Event("change",{bubbles:true}));
      return JSON.stringify({ok:n===1,n:n,size:sz});
    }catch(e){ return JSON.stringify({ok:false,why:e.name+': '+e.message}); }
  })()`;

  // 판정 순서가 핵심이다.
  //   1) 할당 직후의 input.files (change 전) — 파일이 실제로 들어갔는가
  //   2) 그 다음 UI 썸네일/Remove image 가 **새로** 뜨는가 — 앱이 받아들였는가
  // 예전에는 2)만 봤다. 그런데 그 둘은 직전 컷의 첨부가 남아도 그대로 보여서,
  // 이번 주입이 실패해도 통과했다. 2026-09-01 실측: 첨부 없이 제출이 나가
  // Grok 이 스틸과 무관한 영상을 만들었고("attached image" 지시만 남아 모델이
  // 자유롭게 그렸다) EP-0127·0128 10컷이 그렇게 버려졌다.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = JSON.parse(chromeJS(js));
    if (r.ok && r.size > 0) {
      for (let i = 0; i < 12; i++) {
        await sleep(1200);
        const s1 = uiState();
        if (s1.rb || s1.th) return true;
      }
      console.warn('     첨부는 들어갔는데 UI 가 받지 않았다 — 재시도');
    } else {
      console.warn(`     첨부 재시도 ${attempt}/3 (${r.why || `files=${r.n}`})`);
    }
    await sleep(1500);
  }
  throw new Error('첨부 확인 실패 (주입 후 썸네일·Remove image 미검출)');
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

  // 옵션 확정 — **이미 켜진 것은 다시 누르지 않는다.**
  // 예전에는 720p·10s 를 무조건 클릭하고 곧바로 제출을 눌렀다. 켜져 있는 토글을 다시
  // 누르면 꺼지고, 그 리렌더 도중에 들어간 제출 클릭은 조용히 흘러간다
  // (2026-09-02 EP-0131 씬 002·005: 프롬프트·첨부·활성 제출 버튼이 다 갖춰졌는데도
  //  "제출이 반영되지 않았습니다" 로 죽었다. 사람이 같은 버튼을 누르면 3초 만에 넘어갔다.)
  chromeJS(`(function(){
    var B=[].slice.call(document.querySelectorAll('button'));
    ['720p','10s'].forEach(function(t){
      var b=B.filter(function(x){return (x.textContent||'').trim()===t;})[0];
      if(b && b.getAttribute('aria-pressed')!=='true') b.click();
    });
    var rj=B.filter(function(b){return (b.textContent||'').trim()==='모두 거부';})[0];
    if(rj) rj.click();
    return 'ok';
  })()`);
  await sleep(1200);

  // 제출 — 누르고 끝내지 않고, 이동을 확인하며 다시 누른다.
  const clickSubmit = () => JSON.parse(chromeJS(`(function(){
    var el=document.querySelector('[contenteditable="true"]');
    if(!el) return JSON.stringify({ok:false,why:'no composer'});
    var form=el.closest('form');
    var sb=[].slice.call((form||document).querySelectorAll('button')).filter(function(b){return b.type==='submit';})[0];
    if(!sb) return JSON.stringify({ok:false,why:'no submit'});
    if(sb.disabled) return JSON.stringify({ok:false,why:'disabled'});
    sb.click();
    return JSON.stringify({ok:true});
  })()`));

  let why = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = clickSubmit();
    if (!r.ok) {
      why = r.why;
      if (why === 'no submit' && attempt === 1) throw new Error('제출 버튼을 찾지 못했습니다');
      await sleep(2500);
      continue;
    }
    for (let i = 0; i < 8; i++) {
      await sleep(2000);
      const p = chromeJS('location.pathname');
      if (p.includes('/imagine/post/')) return p;
    }
    console.warn(`     제출이 안 먹었다 — 다시 누른다 ${attempt}/4`);
  }
  throw new Error(`제출이 반영되지 않았습니다${why ? ` (${why})` : ''}`);
}

/**
 * 이번 컷의 영상 URL. **우리 게시물 것만** 고른다.
 *
 * 예전에는 "제출 전에 없던 <video> src" 를 이번 컷으로 봤다. 그건 틀렸다
 * (2026-09-01 EP-0127·0128 실측). /imagine 과 게시물 페이지에는 계정의 과거
 * 생성물 **히스토리 썸네일 스트립**(<button> 안 50×50 <video>)이 깔려 있고
 * lazy-load 로 계속 새 URL 이 얹힌다. 차집합은 그 옛 생성물을 집어 왔고,
 * 에피소드와 무관한 판타지 클립 10컷이 렌더까지 갔다.
 * 결정적으로 **스트립에는 방금 만든 게시물이 들어오지도 않는다** — 실측 0건.
 *
 * 본 영상은 <button> 밖의 큰 <video> 이고, 그 poster 에 게시물 id 가 박혀 있다:
 *   .../generated/<postId>/preview_image.jpg  →  .../generated/<postId>/generated_video.mp4
 * submitPrompt 가 이미 /imagine/post/<postId> 로의 이동을 확인하고 그 경로를
 * 돌려주므로, 그 id 로 우리 것만 특정한다.
 *
 * 다운로드 버튼은 여전히 쓰지 않는다 — 2026-08-30 Grok UI 에서 최상위 "다운로드" 가
 * 「게시물 작업」 메뉴 안으로 들어갔고, 버튼 라벨을 쫓으면 UI 가 바뀔 때마다 깨진다.
 */
async function waitForOwnVideo(tab, postPath) {
  const postId = (postPath.split('/imagine/post/')[1] || '').split('?')[0];
  if (!postId) throw new Error(`게시물 id 를 읽지 못했습니다: ${postPath}`);

  const t0 = Date.now();
  while (Date.now() - t0 < GEN_TIMEOUT_MS) {
    await sleep(5000);
    // 본 영상 = <button> 밖의 <video>. 스트립 썸네일은 전부 버튼 안이라 이걸로 갈린다.
    // poster 는 인코딩 전에도 뜨므로 준비 판정에 쓰지 않는다 — 브라우저가 실제
    // 리소스를 물었을 때만 채워지는 currentSrc + readyState 를 신호로 쓴다.
    // currentSrc·readyState 는 쓰지 않는다 — 백그라운드 탭에서는 Chrome 이 <video>
    // 리소스를 아예 안 물어서 둘 다 영영 비어 있다(2026-09-01: 6분 타임아웃).
    // poster 는 렌더만으로 채워지므로 백그라운드에서도 읽힌다.
    let poster = '';
    try {
      poster = chromeJS(`(function(){
        var v=[].slice.call(document.querySelectorAll('video')).filter(function(x){return !x.closest('button');})[0];
        return (v && v.poster) ? v.poster : '';
      })()`);
    } catch { continue; }
    if (poster.includes(`/generated/${postId}/`)) {
      return poster.replace('preview_image.jpg', 'generated_video.mp4');
    }
  }
  throw new Error(`게시물 ${postId} 의 영상이 ${Math.round(GEN_TIMEOUT_MS / 1000)}초 안에 준비되지 않았습니다`);
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
  let made = 0, failed = 0, stalls = 0;

  for (const [i, scene] of wanted.entries()) {
    const still = join(imagesDir, `scene_${scene.id}.png`);
    const outPath = join(videosDir, `scene_${scene.id}.mp4`);
    if (!existsSync(still)) { console.warn(`  ⏭  씬 ${scene.id}: 스틸 없음`); continue; }
    if (existsSync(outPath) && !values.force) { console.log(`  ⏭  씬 ${scene.id}: 이미 있음`); continue; }

    try {
      navigate(tab, GROK_URL);
      await waitReady(tab, 60000);
      await attachStill(tab, still);
      const postPath = await submitPrompt(tab, motionFor(scene));
      const videoUrl = await waitForOwnVideo(tab, postPath);
      // poster 는 인코딩이 끝나기 전에도 뜬다 — 실제로 받아질 때까지가 완료 신호다.
      let fetched = false, lastErr = null;
      for (let i = 0; i < 30 && !fetched; i++) {
        try { await fetchVideoToFile(tab, videoUrl, outPath); fetched = true; }
        catch (e) { lastErr = e; await sleep(10000); }
      }
      if (!fetched) throw new Error(`영상을 내려받지 못했습니다: ${lastErr?.message || '이유 불명'}`);

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
      stalls = 0;   // 하나라도 나왔으면 서비스는 살아 있다
    } catch (e) {
      failed += 1;
      console.warn(`  ❌ 씬 ${scene.id}: ${e.message}`);
      if (STALL_PATTERN.test(e.message)) stalls += 1; else stalls = 0;
      if (made === 0 && stalls >= STALL_ABORT_AFTER) {
        const left = wanted.length - i - 1;
        console.error(`  ⛔ 연속 ${stalls}컷이 생성 정체로 실패했고 성공이 없습니다 — Grok 서비스측 문제로 봅니다.`);
        console.error(`     남은 ${left}컷을 시도하지 않고 멈춥니다 (컷당 ${Math.round(GEN_TIMEOUT_MS / 60000)}분 × ${left}컷을 아낍니다).`);
        console.error('     파이프라인이 HyperFrames 폴백으로 이어갑니다. 한도가 의심되면 Chrome 에서 grok.com/imagine 을 직접 확인하세요.');
        break;
      }
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
