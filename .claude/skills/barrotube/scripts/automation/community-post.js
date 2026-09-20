#!/usr/bin/env node
/**
 * community-post.js — 마켓맵 카드 10장을 유튜브 커뮤니티에 올린다.
 *
 * 왜 브라우저인가: 커뮤니티 게시는 공식 API 가 없다(2026-09 기준). 그래서 이미 로그인된
 * Chrome 을 Apple Events 로 몬다 — grok 모션과 같은 계열이다.
 *
 * 첨부가 되는 순서 (2026-09-18 실측으로 확립). 순서가 어긋나면 조용히 글만 올라간다:
 *   1. 카드는 gh-pages 에 먼저 올라가 있어야 한다. `access-control-allow-origin: *` 라
 *      페이지 JS 가 fetch 로 읽어 File 을 만들 수 있다 — 로컬 경로는 못 넘긴다.
 *   2. file input 은 **shadow DOM 을 재귀로** 훑어 ytd-backstage-multi-image-select-renderer
 *      안의 것을 잡는다. 겉 DOM 에 보이는 다른 input[type=file] 들은 미끼다.
 *   3. DataTransfer 로 files 를 채우고 change 를 쏜다 — 이것만으로는 화면이 안 바뀐다.
 *   4. HTMLInputElement.prototype.click 을 no-op 으로 갈아끼운 뒤 「이미지」 버튼을 누른다.
 *      네이티브 파일창은 안 열리고, YouTube 가 이미 채워진 input.files 를 읽어 편집기를 연다.
 *   5. 본문은 편집기가 위를 덮고 있어 execCommand 로 넣는다.
 *
 * 같은 판을 두 번 올리지 않는다: 성공하면 판 폴더에 posted.json 을 남기고, 있으면 건너뛴다.
 *
 * Usage:
 *   node community-post.js --edition morning
 *   node community-post.js --edition evening --dry-run   # 게시 직전까지만 (취소로 끝냄)
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openTab, closeTab, navigate, evalJS, evalJSON, sleep } from './lib/chrome-applescript.js';
import { resolveEdition, EDITIONS } from './lib/market-map.js';
import { facts } from './market-magazine.js';
import { sendTelegramText } from './notify.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'market-map.json'), 'utf-8'));
const GROWTH = JSON.parse(readFileSync(join(ROOT, 'config', 'growth.json'), 'utf-8'));
const SITE = (CFG.site_url ?? 'https://82beye.github.io/BarroSkills/').replace(/\/?$/, '/');
const CARDS = 10;

const fpct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/**
 * 게시글 본문. 숫자는 전부 facts() 에서 온다 — 카드와 글이 서로 다른 계산을 하면
 * 같은 판에서 다른 수치가 나간다.
 *
 * 종목은 카드와 같이 티커로 쓴다. 한글 종목명 표를 따로 두면 84개를 손으로 채워야 하고,
 * 틀린 이름이 섞이면 카드와 글이 어긋난다.
 */
export function postBody(f) {
  const three = (rows, key) => rows.slice(0, 3).map((r) => `${r[key]} ${fpct(r.pct)}`).join(', ');
  const usSpread = f.usTop[0].pct - f.usBot[0].pct;
  const krSpread = f.krTop[0].pct - f.krBot[0].pct;

  const us = {
    head: `📊 미국장 마감 (${md(f.usSession)})`,
    idx: `나스닥 ${fpct(f.idx.nasdaq?.pct ?? 0)}, S&P500 ${fpct(f.idx.sp500?.pct ?? 0)}. 지수 안에서 위아래가 ${usSpread.toFixed(1)}%p 벌어졌습니다.`,
    up: `오른 쪽 — ${three(f.usTop, 't')}`,
    down: `내린 쪽 — ${three(f.usBot, 't')}`,
    sector: `업종 평균으로 세우면 맨 위가 ${f.usLead.name} ${fpct(f.usLead.pct)}, 맨 아래가 ${f.usTail.name} ${fpct(f.usTail.pct)}.`,
    other: `같은 시각 코스피(${md(f.krLabel.date)} ${f.krLabel.text})는 맨 위가 ${f.krLead.name} ${fpct(f.krLead.pct)}, 맨 아래가 ${f.krTail.name} ${fpct(f.krTail.pct)}였습니다.`,
  };
  const kr = {
    head: `📊 코스피 마감 (${md(f.krLabel.date)})`,
    idx: `코스피 ${fpct(f.idx.kospi?.pct ?? 0)}, 코스닥 ${fpct(f.idx.kosdaq?.pct ?? 0)}. 지수 안에서 위아래가 ${krSpread.toFixed(1)}%p 벌어졌습니다.`,
    up: `오른 쪽 — ${three(f.krTop, 'label')}`,
    down: `내린 쪽 — ${three(f.krBot, 'label')}`,
    sector: `업종 평균으로 세우면 맨 위가 ${f.krLead.name} ${fpct(f.krLead.pct)}, 맨 아래가 ${f.krTail.name} ${fpct(f.krTail.pct)}.`,
    other: `직전 미국장(${md(f.usSession)} 마감)은 맨 위가 ${f.usLead.name} ${fpct(f.usLead.pct)}, 맨 아래가 ${f.usTail.name} ${fpct(f.usTail.pct)}였습니다.`,
  };
  const b = f.ed.leads === 'us' ? us : kr;
  return [b.head, '', b.idx, '', b.up, b.down, '', b.sector, '', b.other, '',
    `카드 ${CARDS}장으로 정리했습니다. 궁금한 종목 있으면 댓글로 남겨주세요 👇`].join('\n');
}

/**
 * gh-pages 에 올라간 카드가 방금 만든 로컬 카드와 같은 파일인지.
 *
 * push 직후에 바로 바뀌지 않는다 — GitHub Pages 는 CDN 전파에 보통 수십 초 걸린다.
 * 2026-09-18 20:00 석간이 여기서 죽었다: push 는 성공했는데 공개본은 아직 조간이었고
 * (로컬 65215B / 공개 66433B) 게시가 통째로 건너뛰어졌다. 그래서 「다르면 즉시 실패」가
 * 아니라 「같아질 때까지 기다렸다 실패」로 간다 — 직전 판을 올리는 사고는 그대로 막으면서.
 */
async function verifyPublished(cardsDir, { waitMs = 180_000 } = {}) {
  const want = [];
  for (let i = 1; i <= CARDS; i += 1) {
    const name = `card-${String(i).padStart(2, '0')}.png`;
    const local = join(cardsDir, name);
    if (!existsSync(local)) throw new Error(`카드 없음: ${local}`);
    want.push({ name, size: statSync(local).size, url: `${SITE}${name}` });
  }
  const t0 = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const stale = [];
    for (const w of want) {
      const r = await fetch(w.url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
      if (!r.ok) { stale.push(`${w.name} HTTP ${r.status}`); continue; }
      const remote = Number(r.headers.get('content-length'));
      if (remote !== w.size) stale.push(`${w.name} 공개 ${remote}B ≠ 로컬 ${w.size}B`);
    }
    if (!stale.length) return want.map((w) => w.url);
    if (Date.now() - t0 > waitMs) {
      throw new Error(`공개본이 이번 판과 다릅니다 (${stale.slice(0, 2).join(' / ')}) `
        + `— Pages 전파가 ${Math.round(waitMs / 1000)}초 안에 끝나지 않았습니다`);
    }
    if (attempt === 1) console.log(`   ⏳ 공개본 전파 대기 (${stale.length}장 아직 옛 판)`);
    await sleep(10_000);
  }
}

/* ── 페이지에서 돌 JS ────────────────────────────────────────────────── */

// shadow DOM 까지 훑는 선택기. YouTube 의 컴포저는 대부분 shadow 안에 있다.
const DEEP = `function(sel){var out=[];(function walk(r){out.push.apply(out,r.querySelectorAll(sel));
  var all=r.querySelectorAll('*');for(var i=0;i<all.length;i++)if(all[i].shadowRoot)walk(all[i].shadowRoot);})(document);return out;}`;

const jsReady = `(function(){var deep=${DEEP};
  return JSON.stringify({
    composer: deep('ytd-backstage-post-dialog-renderer, #post-dialog').length,
    multiInput: deep('ytd-backstage-multi-image-select-renderer input[type=file]').length,
    signedOut: /로그인|Sign in/.test(document.querySelector('#buttons')?document.querySelector('#buttons').innerText:'')
  });})()`;

// AppleScript 의 execute 는 Promise 를 못 기다린다 — 결과 객체를 그대로 받으면
// "[object Object]" 가 온다. 그래서 비동기 작업은 전역에 결과를 남기고 따로 폴링한다.
const jsInjectStart = (urls) => `(function(){var deep=${DEEP};
  window.__btInject={state:'running'};
  (async function(){
    try{
      var urls=${JSON.stringify(urls)}, files=[];
      for (var i=0;i<urls.length;i++){
        var r=await fetch(urls[i],{cache:'no-store'});
        if(!r.ok) throw new Error('fetch '+urls[i]+' HTTP '+r.status);
        files.push(new File([await r.blob()], urls[i].split('/').pop(), {type:'image/png'}));
      }
      var inp=deep('ytd-backstage-multi-image-select-renderer input[type=file]').filter(function(x){return x.multiple;})[0];
      if(!inp) throw new Error('멀티이미지 input 없음');
      var dt=new DataTransfer(); files.forEach(function(f){dt.items.add(f);});
      inp.files=dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      // 네이티브 파일창이 열리지 않게 막아 둔다. 이 상태에서 「이미지」를 눌러야 편집기가 열린다.
      if(!window.__btClickStub){window.__btClickStub=HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click=function(){ if(this.type==='file') return; return window.__btClickStub.apply(this,arguments); };}
      var ed=deep('[contenteditable="true"]')[0]; if(ed) ed.focus();
      var btn=deep('button[aria-label="이미지 추가"]').filter(function(b){return b.getBoundingClientRect().width>0;})[0];
      if(!btn) throw new Error('「이미지」 버튼 없음');
      btn.click();
      window.__btInject={state:'done',injected:inp.files.length};
    }catch(e){ window.__btInject={state:'error',err:String(e && e.message || e)}; }
  })();
  return JSON.stringify({started:true});})()`;

const jsInjectState = `(function(){return JSON.stringify(window.__btInject||{state:'none'});})()`;

const jsEditorState = `(function(){var deep=${DEEP};
  var imgs=deep('ytd-backstage-multi-image-select-renderer img');
  var lens={}; imgs.forEach(function(i){lens[i.src.length]=1;});
  return JSON.stringify({unique:Object.keys(lens).length,total:imgs.length});})()`;

const jsPostState = `(function(){var deep=${DEEP};
  var ed=deep('[contenteditable="true"]')[0];
  var btns=deep('button[aria-label="게시"]').filter(function(b){return b.getBoundingClientRect().width>0;});
  return JSON.stringify({textLen:ed?ed.innerText.length:0,
    postable:btns.length?btns[0].getAttribute('aria-disabled')!=='true'&&!btns[0].disabled:false});})()`;

const jsClick = (label) => `(function(){var deep=${DEEP};
  var b=deep('button[aria-label=${JSON.stringify(label)}]').filter(function(x){return x.getBoundingClientRect().width>0;})[0];
  if(!b) return JSON.stringify({ok:false,err:'${label} 버튼 없음'});
  b.click(); return JSON.stringify({ok:true});})()`;

// 게시 전에 이미 있던 글의 링크를 찍어 둔다.
const jsLinks = `(function(){
  return JSON.stringify([].slice.call(
    document.querySelectorAll('ytd-backstage-post-thread-renderer a[href^="/post/"]'))
    .map(function(a){return a.getAttribute('href');}));})()`;

/**
 * 새 글이 목록 맨 위에 뜨기까지는 시간이 걸린다. 그 사이의 맨 위는 **직전 판**이고 그것도
 * 카드 10장짜리라, 「맨 위를 본다」는 검증은 게시가 실패해도 통과한다. 2026-09-18 석간이
 * 그랬다 — 게시는 됐는데 posted.json 에 조간 URL 이 적혔다. 그래서 없던 링크가 나타날
 * 때까지 기다린다.
 *
 * 이미지 수는 DOM 으로 센다. `__data.data` 는 게시 직후 그 순간에만 채워져 있고 새로 로드한
 * 페이지에서는 비어 있다 (실측: 같은 글이 byData 0 / byRenderer 10).
 */
const jsVerifyNew = (known) => `(function(){
  var known=${JSON.stringify(known)};
  var ps=[].slice.call(document.querySelectorAll('ytd-backstage-post-thread-renderer'));
  for(var i=0;i<ps.length;i++){
    var a=ps[i].querySelector('a[href^="/post/"]');
    if(!a) continue;
    var href=a.getAttribute('href');
    if(known.indexOf(href)>=0) continue;
    var r=ps[i].querySelector('ytd-post-multi-image-renderer');
    var d=r&&(r.__data&&r.__data.data||r.data);
    var n=r?Math.max(r.querySelectorAll('ytd-backstage-image-renderer').length,
                     d&&d.images?d.images.length:0):0;
    var t=ps[i].querySelector('#content-text');
    return JSON.stringify({ok:true,link:href,images:n,textLen:t?t.innerText.length:0});
  }
  return JSON.stringify({ok:false,err:'새 게시물이 아직 목록에 없음'});})()`;

/* ── 실행 ────────────────────────────────────────────────────────────── */

async function main() {
  const { values } = parseArgs({ options: {
    edition: { type: 'string' },
    date: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'print-body': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  } });
  const date = values.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const edition = values.edition || resolveEdition();
  if (!EDITIONS[edition]) throw new Error(`알 수 없는 판: ${edition} (morning | evening)`);

  const dir = join(ROOT, CFG.output_dir, date, edition);
  const cardsDir = join(dir, 'cards');
  const marker = join(dir, 'posted.json');
  if (existsSync(marker) && !values.force && !values['dry-run']) {
    const m = JSON.parse(readFileSync(marker, 'utf-8'));
    console.log(`⏭  이미 올린 판입니다 — ${m.url} (다시 올리려면 --force)`);
    return;
  }

  const dataPath = join(dir, 'data.json');
  if (!existsSync(dataPath)) throw new Error(`data.json 이 없습니다: ${dataPath}`);
  const d = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const f = facts(d, statSync(dataPath).mtime, edition);
  const body = postBody(f);

  if (values['print-body']) { console.log(body); return; }

  console.log(`📮 ${date} ${f.ed.label}판 커뮤니티 게시${values['dry-run'] ? ' (dry-run)' : ''}`);
  const urls = await verifyPublished(cardsDir);
  console.log(`   카드 ${urls.length}장 공개본 일치 확인`);

  const tab = openTab(`https://www.youtube.com/channel/${GROWTH.channel_id}/posts`);
  let posted = null;
  try {
    // 1) 컴포저가 뜰 때까지
    let ready = null;
    for (let i = 0; i < 20; i += 1) {
      await sleep(1500);
      try { ready = evalJSON(tab, jsReady); } catch { continue; }
      if (ready.composer && ready.multiInput) break;
    }
    if (!ready?.composer) throw new Error('커뮤니티 컴포저를 찾지 못했습니다 — Chrome 에서 채널에 로그인돼 있는지 확인하세요');

    // 2) 카드 주입 + 편집기 열기
    evalJSON(tab, jsInjectStart(urls));
    let inj = { state: 'running' };
    for (let i = 0; i < 40; i += 1) {
      await sleep(1000);
      inj = evalJSON(tab, jsInjectState);
      if (inj.state !== 'running') break;
    }
    if (inj.state !== 'done') throw new Error(`카드 주입 실패: ${inj.err || inj.state}`);
    let state = { unique: 0 };
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      state = evalJSON(tab, jsEditorState);
      if (state.unique >= CARDS) break;
    }
    if (state.unique < CARDS) throw new Error(`편집기에 카드가 ${state.unique}/${CARDS}장만 붙었습니다`);
    console.log(`   카드 ${state.unique}장 첨부됨`);

    // 3) 본문
    const typed = evalJSON(tab, insertTextJS(body));
    if (!typed.ok) throw new Error(`본문 입력 실패: ${typed.err}`);
    const ps = evalJSON(tab, jsPostState);
    if (!ps.postable) throw new Error(`「게시」가 아직 비활성입니다 (본문 ${ps.textLen}자)`);
    console.log(`   본문 ${ps.textLen}자 입력됨`);

    if (values['dry-run']) {
      evalJSON(tab, jsClick('취소'));
      console.log('🧪 dry-run — 게시하지 않고 취소했습니다');
      return;
    }

    // 4) 게시 + 확인. 「없던 링크」로 새 글을 찾는다 — 직전 판을 새 글로 오인하지 않게.
    const known = evalJSON(tab, jsLinks);
    const clicked = evalJSON(tab, jsClick('게시'));
    if (!clicked.ok) throw new Error(`게시 버튼: ${clicked.err}`);
    for (let i = 0; i < 40; i += 1) {
      await sleep(2000);
      // 목록이 스스로 안 갱신되는 경우가 있어 중간에 한 번 새로고침한다.
      if (i === 20) { navigate(tab, `https://www.youtube.com/channel/${GROWTH.channel_id}/posts`); await sleep(5000); }
      const v = evalJSON(tab, jsVerifyNew(known));
      if (v.ok && v.images >= CARDS) { posted = v; break; }
    }
    if (!posted) throw new Error('게시는 눌렀는데 카드 10장짜리 새 게시물을 확인하지 못했습니다 — 채널을 직접 확인하세요');

    const url = `https://www.youtube.com${posted.link}`;
    writeFileSync(marker, `${JSON.stringify({ url, images: posted.images, at: new Date().toISOString() }, null, 2)}\n`);
    console.log(`✅ 게시 완료 — 카드 ${posted.images}장`);
    console.log(`🔗 ${url}`);
  } finally {
    try { closeTab(tab); } catch { /* 사용자가 닫았으면 그만이다 */ }
  }
}

/** execCommand 로 한 줄씩 넣는다. insertText 는 개행을 안 만들어 줄바꿈은 따로 넣는다. */
function insertTextJS(text) {
  const lines = text.split('\n');
  return `(function(){var deep=${DEEP};
    var ed=deep('[contenteditable="true"]')[0];
    if(!ed) return JSON.stringify({ok:false,err:'본문 입력칸 없음'});
    ed.focus();
    var sel=window.getSelection(), rg=document.createRange();
    rg.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(rg);
    document.execCommand('delete');
    var lines=${JSON.stringify(lines)};
    for(var i=0;i<lines.length;i++){
      if(i) document.execCommand('insertLineBreak');
      if(lines[i]) document.execCommand('insertText',false,lines[i]);
    }
    return JSON.stringify({ok:true,len:ed.innerText.length});})()`;
}

// 테스트가 postBody 를 import 할 수 있게 main 을 막는다.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (e) => {
    console.error('❌', e.message);
    // 08시·20시 무인 실행이라 이 로그를 아무도 보지 않는다. 실패는 텔레그램으로 알린다 —
    // 카드 10장은 직전 메시지로 이미 가 있으니 사람이 손으로 올릴 수 있다.
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
      await sendTelegramText(`⚠️ 마켓맵 커뮤니티 게시 실패\n${esc(e.message)}\n\n위 카드 10장을 커뮤니티에 직접 올려주세요.`);
    } catch { /* 알림까지 실패하면 cron 로그가 마지막 기록이다 */ }
    process.exit(1);
  });
}
