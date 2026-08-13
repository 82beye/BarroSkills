/**
 * script-quality-contract.js — 대본이 "분석"인지 판정하는 계약의 정본
 *
 * EP-2026-0091 이 이 모듈을 만든 계기다. 리서치에는 재료가 있었는데
 * (코히런트가 실적을 이기고도 -5%, BofA 의 엔비디아 신중론) 대본은 지수 세 개
 * 등락률을 소리 내어 읽고 "과열을 놓칠 수 있습니다" 로 끝났다. 세 곳이 겹쳐 그렇게 됐다:
 *
 *   1. TTS 정책 v3.0 상 narration 의 숫자는 한글 수사다. "+0.26%" 가 "영점이육 퍼센트"
 *      여덟 음절이 된다. 씬 2 는 87자 중 50자를 숫자 세 개에 썼는데, 그 숫자는
 *      subtitle_text 에 이미 아라비아 숫자로 떠 있었다. 화면이 공짜로 보여주는 걸
 *      입으로 다시 산 셈이다.
 *   2. S3 전략이 "확신도가 낮으니 두루뭉술하게 처리" 라고 직접 지시했다.
 *      확신이 낮을 때의 정답은 모호함이 아니라 정밀함이다 — 관찰은 좁게 단정하고
 *      해석은 해석이라고 말하면 된다.
 *   3. image_prompt·TTS·팩트체크에는 기계 게이트가 있는데 "이 대본이 무언가를
 *      말하고 있나" 는 아무도 보지 않았다.
 *
 * 그래서 image-prompt-contract.js 와 같은 모양으로 만든다 — 프롬프트에 넣을 문장과
 * 검증기가 쓸 수치를 한 파일에 두고, 갈라지면 테스트가 깨지게 한다.
 */

/** 한글 수사 음절. "영점이육", "천사백이십오" 처럼 이어 붙는다. */
const NUM = '[영공일이삼사오육칠팔구십백천만억조점]';

/** 수사 뒤에 붙어 "이건 수치다" 를 확정짓는 단위. */
const UNIT = '(?:퍼센트|프로|포인트|원|달러|엔|위안|년|개월|분기|배|억|조|만)';

/**
 * 구어 수치 하나를 세는 패턴.
 *
 * 수사 3음절 이상이면 그 자체로 수치고("삼점사"), 2음절 이하는 단위가 붙어야 수치다.
 * 1음절은 공백으로 떨어져 있을 때만 센다 — 안 그러면 "일명"·"유일" 같은 보통 낱말이
 * 수치로 잡힌다.
 */
export const SPOKEN_NUMBER = new RegExp(
  `${NUM}{3,}|${NUM}{2,}\\s*${UNIT}|${NUM}\\s+${UNIT}`,
  'g',
);

/**
 * 인과를 주장하는 말. 하나도 없으면 그 씬은 사실을 나란히 놓기만 한 것이다.
 * 넉넉하게 잡는다 — 이 규칙은 바닥이지 천장이 아니다.
 */
export const MECHANISM_MARKERS = [
  '때문', '덕분', '덕에', '탓', '이유', '영향', '여파', '반영', '이어', '이끌',
  '의미', '뜻', '신호', '셈', '결과', '따라서', '그래서', '바람에', '까닭',
];

/** 결론 자리를 차지하고 아무것도 말하지 않는 표현. */
export const HEDGE_MARKERS = [
  '수 있습니다', '수도 있습니다', '가능성이 있습니다', '보입니다', '풀이됩니다',
  '전망입니다', '듯합니다', '관측됩니다', '분석됩니다',
];

/**
 * 어느 종목·어느 날에 붙여도 말이 되는 조언 상투구.
 *
 * 인과 마커 목록만으로 "분석이 없다" 를 판정하려다 EP-2026-0073 의
 * "실적이 아니라, 주주환원의 숫자와 시점이 없었던 겁니다" 를 잡았다 — 훌륭한 인과인데
 * 한국어가 인과를 표현하는 방법이 키워드 목록보다 넓다. 그래서 없는 것(인과)을 찾는 대신
 * 있는 것(상투구)을 찾는다. 이쪽이 훨씬 정확하다.
 */
export const FILLER_PHRASES = [
  '신중한 접근', '신중하게 접근', '리스크 관리', '포트폴리오 점검', '포트폴리오를 점검',
  '주의가 필요', '관심이 필요', '대비가 필요', '점검이 필요', '지켜봐야', '눈여겨봐야',
  '예의주시', '면밀히', '묻지마 투자', '필요한 시점', '중요한 시점',
];

/**
 * 인과를 요구하는 씬 역할.
 * hook 은 질문이어도 되고, context 는 스타일가이드상 데이터 제시가 본업이고,
 * cta 는 행동 유도다. "그래서 무슨 의미인가" 를 맡은 역할에만 요구한다.
 */
export const ANALYTIC_ROLES = ['insight', 'implication', 'cause', 'impact'];

/**
 * 한글로 풀어 쓰면 수사처럼 보이는 고유명사. 지수 이름은 매 미국장 EP 에 나온다
 * ("에스앤피오백이" → 오백이). 수치로 세면 작성자가 쓰지도 않은 예산이 깎인다.
 */
export const PROPER_NOUN_NUMERALS = ['에스앤피오백', '러셀이천', '유로스톡스오십', '니케이이백이십오'];

/**
 * 씬 하나가 말해도 되는 수치 개수.
 * 20초를 넘는 씬은 한 개 더 쓸 여유가 있다 — 롱폼까지 같은 규칙으로 덮는다.
 */
export function spokenNumberCap(targetSeconds) {
  return Number(targetSeconds) >= 20 ? 3 : 2;
}

/** 대본 전체 상한. 씬마다 평균 하나면 충분하고, 하나만 더 허용한다. */
export function totalSpokenNumberCap(sceneCount) {
  return sceneCount + 1;
}

export function countSpokenNumbers(narration) {
  let text = String(narration || '');
  for (const name of PROPER_NOUN_NUMERALS) text = text.split(name).join('');
  return text.match(SPOKEN_NUMBER) || [];
}

function hasMechanism(narration) {
  const text = String(narration || '');
  return MECHANISM_MARKERS.some((m) => text.includes(m));
}

function countHedges(narration) {
  const text = String(narration || '');
  return HEDGE_MARKERS.reduce((n, h) => n + text.split(h).length - 1, 0);
}

/**
 * 대본을 검증한다. severity 'error' 는 재생성 대상이고 'warn' 은 기록만 남긴다.
 *
 * 헤지를 error 로 두지 않는 이유: 팩트체크가 근거 부족을 이유로 톤을 낮추라고
 * 지시하는 경우가 정상 경로에 있다. 그때 헤지는 결함이 아니라 준수다.
 */
export function validateScript(scenes) {
  const issues = [];
  if (!Array.isArray(scenes) || scenes.length === 0) return issues;

  const totalCap = totalSpokenNumberCap(scenes.length);
  let totalNumbers = 0;
  let totalHedges = 0;
  const seenNumbers = new Set();

  for (const scene of scenes) {
    const id = scene.scene_id || '?';
    const role = String(scene.role || '');
    const narration = String(scene.narration || '');
    const numbers = countSpokenNumbers(narration);
    totalNumbers += numbers.length;
    totalHedges += countHedges(narration);

    const cap = spokenNumberCap(scene.target_seconds);
    if (numbers.length > cap) {
      issues.push({
        rule: 'spoken-number-budget', severity: 'error', scene_id: id,
        message: `씬 ${id}: 말한 수치 ${numbers.length}개 (상한 ${cap}) — ${numbers.join(', ')}`,
        suggestion: '가장 중요한 수치 하나만 말하고 나머지는 subtitle_text 로 옮겨라. 남는 초는 그 수치가 왜 그런지에 써라.',
      });
    }

    const filler = FILLER_PHRASES.filter((p) => narration.includes(p));
    if (filler.length && !hasMechanism(narration)) {
      issues.push({
        rule: 'filler-conclusion', severity: 'error', scene_id: id,
        message: `씬 ${id}: 어느 날에 붙여도 맞는 조언으로 끝났다 — "${filler.join('", "')}"`,
        suggestion: '이 문장을 오늘 이 뉴스에서만 할 수 있는 말로 바꿔라. 무엇을 왜 점검해야 하는지 오늘의 사실로 지목해라.',
      });
    }

    if (ANALYTIC_ROLES.includes(role) && !hasMechanism(narration) && !filler.length) {
      issues.push({
        rule: 'no-mechanism', severity: 'warn', scene_id: id,
        message: `씬 ${id}(${role}): 인과를 주장하는 표현이 없다 — 사실 나열일 수 있다`,
        suggestion: `"A 때문에 B" / "B 라는 뜻입니다" 처럼 왜 그런지를 한 문장으로 말해라 (${MECHANISM_MARKERS.slice(0, 6).join('·')} 등).`,
      });
    }

    for (const n of numbers) {
      if (seenNumbers.has(n) && ANALYTIC_ROLES.includes(role)) {
        issues.push({
          rule: 'number-restated', severity: 'warn', scene_id: id,
          message: `씬 ${id}: 앞 씬에서 이미 말한 수치 "${n}" 를 다시 말했다`,
          suggestion: '같은 수치를 두 번 말할 초가 없다. 두 번째는 그 수치의 함의로 바꿔라.',
        });
      }
      seenNumbers.add(n);
    }
  }

  if (totalNumbers > totalCap) {
    issues.push({
      rule: 'spoken-number-total', severity: 'error', scene_id: null,
      message: `대본 전체 말한 수치 ${totalNumbers}개 (상한 ${totalCap}) — 수치 낭독이 분석 자리를 먹었다`,
      suggestion: '씬마다 말할 수치를 하나로 줄이고, 확보한 초를 인과·함의에 배분해라.',
    });
  }

  const hedgeCap = scenes.length <= 5 ? 2 : 4;
  if (totalHedges > hedgeCap) {
    issues.push({
      rule: 'hedge-overuse', severity: 'warn', scene_id: null,
      message: `헤지 표현 ${totalHedges}회 (권장 ${hedgeCap} 이하)`,
      suggestion: '확신이 낮으면 모호하게 말하지 말고, 관찰을 좁게 단정하고 해석은 해석이라고 말해라.',
    });
  }

  return issues;
}

/**
 * 프롬프트에 들어갈 계약 블록. 수치는 위 함수들과 같은 출처를 쓴다 —
 * 여기에 상한을 다시 적으면 검증기와 갈라진다(image_prompt 계약이 겪은 그 문제다).
 */
export function buildAnalystContractBlock(sceneCount) {
  return `
RULE 4-CONTRACT — 분석 밀도 (machine-checked by validate-script-quality.js):

A. 말할 수치는 비싸다. narration 의 숫자는 한글 수사로 읽힌다 — "+0.26%" 는
   "영점이육 퍼센트" 여덟 음절이고, 60초 대본의 2%다. 같은 숫자가 subtitle_text 에는
   아라비아 숫자로 공짜로 뜬다.
   - 한 씬에서 말할 수치: 최대 ${spokenNumberCap(10)}개 (target_seconds 20초 이상이면 ${spokenNumberCap(20)}개).
   - 대본 전체: 최대 ${totalSpokenNumberCap(sceneCount)}개.
   - 나머지 수치는 전부 subtitle_text 로 보내라. 화면이 보여주는 걸 입으로 다시 사지 마라.

B. ${ANALYTIC_ROLES.join('/')} 역할의 씬은 인과를 한 문장으로 주장해라.
   사실 두 개를 나란히 놓는 건 분석이 아니다.
   - BAD:  "CPI 는 예상과 같았습니다. AI 인프라주가 강했습니다." (두 사실, 인과 없음)
   - GOOD: "물가가 예상대로 나오자 돈은 실적이 아니라 AI 수요 쪽으로 붙었습니다." (메커니즘)

C. 확신이 낮을 때 두루뭉술하게 말하지 마라. 관찰을 좁게 단정하고, 해석은 해석이라고 말해라.
   - BAD:  "일부 대형주는 상대적으로 잠잠했습니다." (아무 말도 안 한 문장)
   - GOOD: "실적을 이기고도 5% 빠진 종목이 나왔습니다. 시장이 실적보다 AI 수요를 보고 있다는 뜻입니다."
   관찰(빠졌다)은 근거가 있어 단정하고, 해석(뜻입니다)은 해석으로 표시했다. 둘 다 정확하다.

D. 리서치가 준 가장 흥미로운 사실을 버리지 마라. 통념과 어긋나는 사실, 반대 방향으로
   움직인 것, 전문가들 사이 이견 — 시청자가 다른 채널에서 못 듣는 건 이것뿐이다.
   지수 등락률은 어디에나 있다.
`;
}

/** 사람이 읽는 한 줄. 검증기·생성기·테스트가 같은 문구를 쓴다. */
export function formatIssue(issue) {
  const where = issue.scene_id ? `[씬 ${issue.scene_id}]` : '[전체]';
  return `${issue.severity === 'error' ? '❌' : '⚠️ '} ${where} ${issue.rule}: ${issue.message}`;
}
