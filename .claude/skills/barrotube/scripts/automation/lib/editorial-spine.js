import { PCT_TOKEN, countSpokenNumbers } from './script-quality-contract.js';

// This catches observable omissions and airtime spent reading lists. It cannot decide
// whether an economic interpretation is correct; source checking and editorial review remain necessary.
const filled = (value) => typeof value === 'string' && value.trim().length >= 5;

export function reviewSummarySpine(out, allowedRefs = []) {
  const problems = [];
  const scenes = out?.scenes || [];
  const spine = out?.editorial_spine;
  if (!spine || ['observation', 'mechanism', 'transmission', 'viewer_result', 'watch_signal']
    .some((key) => !filled(spine[key]))) {
    problems.push('editorial_spine: 관찰·원인/해석·전달 경로·시청자 결과·다음 확인 신호를 각각 구체적으로 적어라. 근거가 없는 연결은 unknown으로 표시하고 대본에 단정하지 마라');
  }
  if (spine && new Set(['observation', 'mechanism', 'transmission', 'viewer_result', 'watch_signal']
    .map((key) => String(spine[key] || '').replace(/\s+/g, ''))).size < 4) {
    problems.push('editorial_spine: 같은 문장을 다른 칸에 복사했다. 서로 다른 경제적 단계와 확인 신호를 작성하라');
  }
  const refs = spine?.evidence_refs;
  if (!Array.isArray(refs) || !refs.length || refs.some((ref) => !allowedRefs.includes(ref))) {
    problems.push('editorial_spine.evidence_refs: 입력에 실제 존재하는 근거 URL 또는 summary-us.json만 적어라');
  }
  const open = String(scenes[0]?.narration || '');
  const indices = ['다우', '나스닥', '에스앤피', 'S&P'].filter((name) => open.includes(name));
  if (indices.length >= 3 && [...open.matchAll(PCT_TOKEN)].length >= 2) {
    problems.push('씬 1: 3대 지수 등락률을 음성으로 나열했다. 지수 카드는 화면에 남기고 오늘 이야기의 사건·엇갈림을 먼저 말하라');
  }
  // 시세 목록은 어느 씬에서든 열거다 — 예전엔 macro 칸에서만 셌지만 칸이 이야기 단계로 바뀌었다(2026-10-15).
  const indicators = [/국채|채권|금리/, /유가|원유|서부텍사스|브렌트/, /달러|환율/, /금값|금은|금 가격/, /비트코인|가상자산/];
  scenes.forEach((scene, i) => {
    const text = String(scene.narration || '');
    if (indicators.filter((pattern) => pattern.test(text)).length >= 4 && countSpokenNumbers(text).length >= 4) {
      problems.push(`씬 ${i + 1}: 무관한 시세 네 종류 이상을 나열했다. 이 사건이 시청자에게 닿는 변수만 남기고 전달 경로를 설명하라`);
    }
  });
  // 마지막 씬(다음 장·일정)은 역할 이름이 바뀌어도(schedule → next) 같은 자리다.
  const next = String(scenes.at(-1)?.narration || '');
  if (/자료에는.*(?:없|특정할 수 없)|발표 시각.*없|일정.*없습니다/.test(next)) {
    problems.push('마지막 씬: 자료 부재를 낭독했다. 근거 있는 다음 확인 신호를 제시하거나, 이 이야기에서 가장 먼저 확인될 시장 신호를 고르라');
  }
  return problems;
}

/** A selected Korea/US contrast is part of the episode contract, not optional background. */
export function reviewSummaryBrief(out, briefTopic = '') {
  const topic = String(briefTopic || '');
  if (!/코스피/.test(topic) || !/(?:미국|S&P|나스닥)/i.test(topic)) return [];

  const scenes = out?.scenes || [];
  const narration = scenes.map((scene) => String(scene.narration || '')).join(' ');
  const subtitles = scenes.map((scene) => String(scene.subtitle_text || '')).join(' ');
  const problems = [];
  if (!String(scenes[0]?.narration || '').includes('코스피')) {
    problems.push('선정 토픽의 한·미 대비가 도입에서 사라졌다: 첫 씬에서 코스피를 음성으로 설명하라');
  }
  const kospiMove = topic.match(/코스피[^\n]{0,70}?(-\d+(?:\.\d+)?)\s*%/);
  if (kospiMove && !subtitles.includes(`${kospiMove[1]}%`)) {
    problems.push(`선정 토픽의 코스피 ${kospiMove[1]}%가 자막에 없다`);
  }
  if (/외국인[^\n]{0,80}?순매도/.test(topic) && !/외국인[^.!?]{0,80}?순매도|순매도[^.!?]{0,80}?외국인/.test(narration)) {
    problems.push('선정 토픽의 외국인 순매도가 대본에서 빠졌다');
  }
  const foreignAmount = topic.match(/외국인\s*(?:약\s*)?([\d.]+)\s*조/);
  if (foreignAmount && !subtitles.includes(`${foreignAmount[1]}조`)) {
    problems.push(`선정 토픽의 외국인 ${foreignAmount[1]}조 원이 자막에 없다`);
  }
  // A same-date Korean close precedes that evening's US regular session. The
  // contrast needs an explicit time cue so viewers do not infer reverse causation.
  if (!/(?:그날 밤|그날 저녁|한국 장 마감 뒤|한국장 마감 뒤|이후 열린 미국|뒤이어 열린 미국)/.test(narration)) {
    problems.push('한·미 같은 날짜 장의 순서를 밝혀라: 한국 장 마감 뒤 그날 밤 미국 장이 열렸다');
  }
  return problems;
}

/** Distribution copy may restate the video, but may not import facts from the brief alone. */
export function reviewSummaryMetadata(meta, scenes = []) {
  const spoken = scenes.map((scene) => String(scene.narration || '')).join(' ');
  const subtitles = scenes.map((scene) => String(scene.subtitle_text || '')).join(' ');
  const copy = [meta?.summary, meta?.description, meta?.platforms?.tiktok?.caption,
    meta?.platforms?.reels?.caption].filter(Boolean).join('\n');
  const problems = [];
  if (/외국인/.test(copy) && !/외국인/.test(spoken)) {
    problems.push('배포 문구에 외국인 수급이 있으나 영상 대본에는 없다');
  }
  const kospiPct = [...copy.matchAll(/코스피[^.!?\n]{0,35}?(\d+(?:\.\d+)?)\s*%/g)]
    .map((match) => match[1]);
  for (const pct of new Set(kospiPct)) {
    if (!subtitles.includes(`${pct}%`)) problems.push(`배포 문구의 코스피 ${pct}%가 영상 자막에는 없다`);
  }
  return problems;
}

/**
 * story_spine 에서 빠진 것들. 근거 URL 은 리서치 본문에 실제로 있는지로 본다 — 추출한 목록과 문자열로 대조하면
 * 표기(꼬리 문장부호·따옴표) 차이만으로 멀쩡한 리서치가 탈락한다.
 */
export function spineGaps(spine, researchText) {
  if (!spine) return ['story_spine'];
  const gaps = ['question', 'new_fact', 'observation', 'mechanism', 'transmission',
    'viewer_result', 'failure_condition', 'watch_signal'].filter((key) => !String(spine[key] || '').trim());
  if (!Array.isArray(spine.evidence_urls) || !spine.evidence_urls.length) gaps.push('evidence_urls');
  else for (const url of spine.evidence_urls) if (!researchText.includes(url)) gaps.push(`미인용 ${url}`);
  return gaps;
}
