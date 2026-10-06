/**
 * incident-analysis — 회차가 멈추거나(halt) 실패했을 때(fail), 사람에게 넘기기 전에
 * 「무엇이 왜 멈췄고 어디를 어떻게 고치면 되는지」를 자동으로 정리하는 판단 함수들.
 *
 * 왜 (2026-10-07): 멈춤 알림은 「대본을 손보고 재개하세요」 한 줄이라, 원인을 찾는 일이 매번
 * 사람 몫이었다. EP-2026-0214 의 실제 원인은 대본이 아니라 팩트체커가 요약 원자료
 * (summary-us.json)를 받지 못한 것이었고, 그건 로그·원자료·코드를 대조해야 보였다.
 * 이 모듈은 그 대조(증거 묶음)를 결정론으로 만들고, 읽기 전용 LLM 이 원인과 수정 설계를 쓴다.
 *
 * 경계: 분석·설계까지다. 코드는 바꾸지 않는다 — 구현은 사람이 승인한 세션이 설계서를 보고 한다.
 * 순수 함수만 둔다(파일·네트워크·LLM 은 scripts/automation/incident-analyze.js).
 */

/** 코드로 고칠 일이 아닌 실패 — LLM 을 부르지 않고 바로 '환경' 으로 분류한다. */
export const ENV_PATTERNS = [
  // '402' 만 보면 「position 402」 같은 숫자에도 걸린다 — 결제 오류로 읽히는 꼴만.
  'Not logged in', '로그인이 필요', 'Gemini 402', 'HTTP 402', '402 Payment', 'RESOURCE_EXHAUSTED', 'prepayment credits', 'quota', 'rate limit',
  'usage limit', '세션 한도', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'DarkWake',
  '다른 EP 가 in-flight 락',
];

/** 분석할 가치가 없는 단계 — 가드(절전·킬스위치)와 게시 이후는 원인이 코드 밖이거나 사람 결정이다. */
export const SKIP_STAGES = ['Phase 0', 'Phase 9', 'Phase 10', 'Phase 11', 'Phase 12'];

export const CLASSES = ['code', 'data', 'env', 'transient'];

export function matchEnvFailure(text, patterns = ENV_PATTERNS) {
  const s = String(text || '');
  return patterns.find((p) => s.includes(p)) || null;
}

export function stageKey(stage) {
  return String(stage || '').match(/Phase \d+/)?.[0] || null;
}

export function shouldSkipStage(stage, skip = SKIP_STAGES) {
  const key = stageKey(stage);
  return !!key && skip.includes(key);
}

/** 로그에서 실패를 말하는 줄만 뽑는다 (뒤쪽 우선, 중복 제거). */
export function errorLines(text, max = 40) {
  const marker = /❌|⚠|🖐|Error|ERROR|FAIL|실패|위반|못 맞췄|중단|exit \d|Traceback/;
  const out = [];
  const seen = new Set();
  const lines = String(text || '').split('\n').reverse();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !marker.test(line)) continue;
    const key = line.replace(/\d+/g, '#');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.slice(0, 400));
    if (out.length >= max) break;
  }
  return out.reverse();
}

/**
 * 로그 줄에서 코드 검색용 고정 문자열을 뽑는다 — 이모지·숫자·변수 자리를 버리고 한글/영문 구간 하나.
 * 「❌ 수정본이 품질 계약 error 1건 — 원본을 남기고 중단한다」 → 「원본을 남기고 중단한다」
 */
export function needleOf(line) {
  return needlesOf(line)[0] ?? null;
}

/**
 * 한 줄의 검색 후보 전부(긴 것부터). 「❌ JSON parse failed (after fix-up): Unexpected non-whitespace…」 처럼
 * 가장 긴 구간이 엔진(V8) 메시지라 코드에 없을 때, 다음 후보(「JSON parse failed」)로 코드 위치를 찾는다.
 */
export function needlesOf(line) {
  const parts = String(line || '')
    .replace(/[\u{1F300}-\u{1FAFF}☀-➿❌⚠🖐↻✅]/gu, ' ')
    .split(/[0-9'"`$(){}\[\]<>|:=—–·/\\,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && /[가-힣A-Za-z]/.test(s));
  parts.sort((a, b) => b.length - a.length);
  return [...new Set(parts.map((p) => p.slice(0, 48)))];
}

/**
 * 실패 문구를 내는 코드 위치를 찾는다. files = [{path, text}].
 * 같은 파일·근처 줄은 하나로 친다. 앞선 needle(=더 직접적인 메시지)이 먼저 온다.
 */
export function findMessageSources(needles, files, max = 4) {
  const hits = [];
  const isComment = (l) => /^\s*(\/\/|\*|\/\*|#)/.test(l);
  for (const needle of needles) {
    // 공백 없는 짧은 단어(「Metadata」)는 아무 파일에나 걸려 발췌 자리를 먹는다.
    if (!needle || (!/\s/.test(needle) && needle.length < 12)) continue;
    for (const f of files) {
      // 주석이 그 문구를 인용한 자리가 아니라, 문구를 내는 코드 줄을 찾는다.
      const lines = f.text.split('\n');
      const i = lines.findIndex((l) => l.includes(needle) && !isComment(l));
      if (i < 0) continue;
      const line = i + 1;
      if (!hits.some((h) => h.path === f.path && Math.abs(h.line - line) < 40)) hits.push({ path: f.path, line, needle });
      break;   // 문구 하나에 위치 하나 — 가장 먼저 찾은 곳
    }
    if (hits.length >= max) return hits;
  }
  return hits;
}

/**
 * 크론 로그는 날마다 이어 쓴다 — 이번 회차 구간만 잘라야 지난 회차의 오류가 섞이지 않는다.
 * EP 를 처음 언급한 줄부터(앞 lead 줄 포함). EP 가 없으면(에피소드 생성 전 실패) 꼬리 fallback 줄.
 */
export function runSlice(text, ep, { lead = 0, fallback = 80, until = null, stopAt = null } = {}) {
  const lines = String(text || '').split('\n');
  const first = ep ? lines.findIndex((l) => l.includes(ep)) : -1;
  if (first < 0) return lines.slice(-fallback).join('\n');
  // 지난 회차를 소급 분석할 때는 다음 회차가 시작하기 전까지만 (until = 다음 회차의 첫 줄 패턴),
  // 그리고 그 회차를 끝낸 실패 줄(stopAt = 「FAIL at <단계>」 등)까지만 — 뒤에 이어 쓴 수동 재개 줄이 섞이지 않게.
  let end = lines.length;
  if (until) {
    const next = lines.findIndex((l, i) => i > first && until.test(l) && !l.includes(ep));
    if (next > 0) end = next;
  }
  if (stopAt) {
    const stop = lines.findIndex((l, i) => i > first && i < end && stopAt.some((m) => l.includes(m)));
    if (stop > 0) end = stop + 1;
  }
  return lines.slice(Math.max(0, first - lead), end).join('\n');
}

/** fail_with_alert·halt_for_human 이 stderr 에 남기는 그 회차의 마지막 줄. */
export function stopMarkers(stage) {
  return [`FAIL at ${stage}`, `🖐  ${stage}`];
}

/** 크론 로그에서 다음 회차의 시작으로 보는 줄 — stdout 은 Phase 0 배너, stderr 는 다른 EP 의 팩트체크. */
export const NEXT_RUN = { log: /🚦 Phase 0 —/, err: /Factcheck: EP-\d{4}-\d{4}/ };

export function codeExcerpt(text, line, radius = 30) {
  const lines = String(text).split('\n');
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(`${String(i).padStart(5)}  ${lines[i - 1]}`);
  return out.join('\n');
}

/** 감사 로그에서 같은 단계의 최근 멈춤·실패 이력. */
export function sameStageHistory(events, stage) {
  const key = stageKey(stage);
  if (!key) return [];
  return events
    .filter((e) => e.event === 'auto_pipeline_halt' || e.event === 'auto_pipeline_fail')
    .filter((e) => String(e.detail || '').includes(`stage=${key}`))
    .map((e) => ({
      at: e.at,
      kind: e.event === 'auto_pipeline_halt' ? 'halt' : 'fail',
      detail: String(e.detail || '').slice(0, 300),
    }));
}

export function incidentId(now = new Date()) {
  const k = new Date(now.getTime() + 9 * 3600e3).toISOString();
  return `IR-${k.slice(0, 10).replace(/-/g, '')}-${k.slice(11, 16).replace(':', '')}`;
}

export function buildAnalysisPrompt({ incident, errLines, logTail, excerpts, history, previous, stageCode, readable = [] }) {
  const system = [
    '너는 BarroTube(유튜브 경제 채널 「바로경제」 자동 제작 파이프라인)의 장애 분석가다.',
    '회차가 멈췄다. 아래 증거(로그·코드 발췌·같은 단계 이력)로 원인을 찾고, 고칠 자리와 방법을 설계하라.',
    '',
    '규칙:',
    '- 증거 묶음과 「읽어 볼 파일」(읽기 전용)에 있는 것만 근거로 쓴다. 로그에 없는 일을 지어내지 마라. 모르면 confidence 를 낮추고 그렇다고 써라.',
    '- 막힌 판정(팩트체크 HIGH·계약 위반 등)이 옳았는지부터 확인하라. 지적된 수치·주장을 원자료(daily-news·리서치)와 대조해,',
    '  맞는 내용이 잘못 막혔다면 원인은 「판정기가 근거를 못 받았다/잘못 읽었다」 쪽이다. 증상을 낸 마지막 단계만 보지 마라.',
    '- 증상(멈춘 메시지)과 원인(왜 그 상태가 됐나)을 구분하라. 원인은 「무엇이 무엇을 못 받았다/잘못 판정했다」처럼 구체적으로.',
    '- class: code(코드·계약·프롬프트가 원인) · data(입력 데이터가 비었거나 틀림) · env(로그인·한도·네트워크·절전) · transient(같은 입력으로 다시 돌리면 통과할 우연).',
    '- 품질 게이트(팩트체크 HIGH 차단, QA, 계약 검사)를 끄거나 느슨하게 하는 것은 수정이 아니다. 막힌 이유를 고치는 설계를 내라.',
    '- fix.files 는 저장소 기준 경로(예: scripts/automation/run-factcheck.js). 바꿀 함수·조건을 짚어라.',
    '- fix.test 는 이 장애를 재현하는 회귀 테스트 한 줄 설계.',
    '- resume: 고친 뒤 이 회차를 RESUME_EP 로 이어 가면 되는지, 아니면 다른 조치(리포트 재생성 등)가 먼저인지.',
    '- 지난 사건일 수 있다. 「실패 문구를 내는 코드」는 지금 코드다 — 이미 대책이 들어가 있으면(주석의 날짜·EP 확인)',
    '  status=already_fixed 로 쓰고 어느 줄이 막는지 evidence 에 적어라. 아니면 status=open.',
    '',
    '출력: JSON 하나만.',
    '{"root_cause":"…","class":"code|data|env|transient","status":"open|already_fixed","confidence":0.0,',
    ' "evidence":["근거가 된 로그 줄 또는 코드 위치"],',
    ' "fix":{"summary":"…","files":["…"],"steps":["…"],"test":"…"},',
    ' "resume":"…"}',
  ].join('\n');

  const user = [
    '## 사건',
    JSON.stringify(incident, null, 1),
    '',
    `## 볼 코드 (단계 지도)\n${stageCode || '(지도 없음)'}`,
    '',
    '## 읽어 볼 파일 (저장소 기준 경로, 읽기 전용)',
    readable.length ? readable.map((p) => `- ${p}`).join('\n') : '(없음)',
    '',
    '## 실패를 말하는 로그 줄 (뒤쪽이 최신)',
    errLines.length ? errLines.map((l) => `- ${l}`).join('\n') : '(없음)',
    '',
    '## 로그 꼬리',
    '```', logTail || '(없음)', '```',
    '',
    '## 실패 문구를 내는 코드',
    ...(excerpts.length ? excerpts.flatMap((x) => [`### ${x.path}:${x.line} (「${x.needle}」)`, '```', x.excerpt, '```']) : ['(찾지 못함)']),
    '',
    '## 같은 단계 최근 이력 (14일)',
    history.length ? history.map((h) => `- ${h.at} ${h.kind} ${h.detail}`).join('\n') : '(없음)',
    '',
    '## 같은 단계 이전 분석',
    previous.length ? previous.map((p) => `- ${p.id} ${p.class}: ${p.root_cause}${p.resolution ? ` → 처리 ${p.resolution}` : ''}`).join('\n') : '(없음)',
  ].join('\n');
  return { system, user };
}

/** LLM JSON 을 검증·정규화한다. 쓸 수 없으면 null. */
export function parseAnalysis(raw) {
  let d = raw;
  if (typeof raw === 'string') {
    try { d = JSON.parse(raw); } catch { return null; }
  }
  if (!d || typeof d !== 'object' || typeof d.root_cause !== 'string' || !d.root_cause.trim()) return null;
  const fix = d.fix && typeof d.fix === 'object' ? d.fix : {};
  const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);
  const conf = Number(d.confidence);
  return {
    root_cause: d.root_cause.trim().slice(0, 600),
    class: CLASSES.includes(d.class) ? d.class : 'code',
    status: d.status === 'already_fixed' ? 'already_fixed' : 'open',
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
    evidence: list(d.evidence).slice(0, 8),
    fix: {
      summary: String(fix.summary || '').trim().slice(0, 600),
      files: list(fix.files).slice(0, 8),
      steps: list(fix.steps).slice(0, 8),
      test: String(fix.test || '').trim().slice(0, 400),
    },
    resume: String(d.resume || '').trim().slice(0, 400),
  };
}

export function envAnalysis(pattern) {
  return {
    root_cause: `실행 환경 문제로 보인다 — 로그에 「${pattern}」. 코드가 아니라 로그인·한도·네트워크·절전 상태를 확인할 일이다.`,
    class: 'env', status: 'open', confidence: 0.8, evidence: [pattern],
    fix: { summary: '환경을 복구한 뒤 같은 회차를 재개한다.', files: [], steps: [], test: '' },
    resume: '환경 복구 뒤 RESUME_EP 로 재개',
  };
}

export function incidentMarkdown(id, incident, analysis, { excerpts = [], history = [], engine = null } = {}) {
  const a = analysis;
  const lines = [
    `# 장애 분석 ${id} — ${incident.ep || '?'} ${incident.stage}`,
    '',
    `- 슬롯: ${incident.slot || '-'} · 종류: ${incident.kind} · 시각: ${incident.at}`,
    `- 메시지: ${incident.detail}`,
    `- 분류: **${a.class}**${a.status === 'already_fixed' ? ' · **이미 고쳐짐**' : ''}${a.confidence != null ? ` · 확신 ${a.confidence}` : ''}${engine ? ` · 분석 ${engine}` : ''}`,
    '',
    '## 원인', '', a.root_cause, '',
  ];
  if (a.evidence.length) lines.push('## 근거', '', ...a.evidence.map((e) => `- ${e}`), '');
  if (a.fix.summary || a.fix.files.length) {
    lines.push('## 수정 설계', '', a.fix.summary || '-', '');
    if (a.fix.files.length) lines.push('고칠 파일:', ...a.fix.files.map((f) => `- \`${f}\``), '');
    if (a.fix.steps.length) lines.push('단계:', ...a.fix.steps.map((s, i) => `${i + 1}. ${s}`), '');
    if (a.fix.test) lines.push(`회귀 테스트: ${a.fix.test}`, '');
  }
  if (a.resume) lines.push('## 재개', '', a.resume, '');
  if (history.length) lines.push('## 같은 단계 최근 이력', '', ...history.map((h) => `- ${h.at} ${h.kind} — ${h.detail}`), '');
  if (excerpts.length) lines.push('## 찾은 코드 위치', '', ...excerpts.map((x) => `- ${x.path}:${x.line} 「${x.needle}」`), '');
  if (a.class === 'code' && a.status !== 'already_fixed') {
    const resume = incident.ep && incident.slot ? ` 고친 뒤 RESUME_EP=${incident.ep} --slot ${incident.slot} 로 이어 가.` : '';
    lines.push('## 구현 요청 (승인 세션에 그대로 붙여 넣기)', '', '```',
      `workspace/growth/incidents/${id}.md 를 읽고 설계대로 고쳐. 회귀 테스트를 먼저 쓰고 전체 테스트를 통과시킨 뒤,${resume} 고친 원인은 remediations.json resolved 에 적어.`,
      '```', '');
  }
  lines.push('---', '이 문서는 자동 분석이다. 코드는 바뀌지 않았다 — 구현은 이 설계서를 보고 승인한 세션이 한다.');
  return lines.join('\n');
}

/** 텔레그램 멈춤 알림에 붙일 한 줄. */
export function alertLine(id, a) {
  const tag = { code: '코드', data: '데이터', env: '환경', transient: '일시' }[a.class] || a.class;
  const fix = a.fix.files.length ? ` → 고칠 곳 ${a.fix.files.slice(0, 2).join(', ')}` : '';
  const done = a.status === 'already_fixed' ? ' (이미 고쳐짐)' : '';
  return `자동 분석(${tag})${done}: ${a.root_cause.slice(0, 160)}${fix} · 설계서 growth/incidents/${id}.md`;
}
