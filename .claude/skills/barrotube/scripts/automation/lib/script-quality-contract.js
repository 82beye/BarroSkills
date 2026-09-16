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
 * 수치로 잡힌다. 앞이 한글이면 그 1음절은 조사다 — "반전이 달러"를 "이 달러"로 세면
 * 멀쩡한 문장이 수치 상한에 걸린다(EP-2026-0128 에서 자동 재집필이 두 번 죽은 원인).
 */
export const SPOKEN_NUMBER = new RegExp(
  `${NUM}{3,}|${NUM}{2,}\\s*${UNIT}|(?<![가-힣])${NUM}\\s+${UNIT}`,
  'g',
);

/**
 * 인과를 주장하는 말. 하나도 없으면 그 씬은 사실을 나란히 놓기만 한 것이다.
 * 넉넉하게 잡는다 — 이 규칙은 바닥이지 천장이 아니다.
 */
/**
 * 통념을 뒤집는 표지. 인과("A 때문에 B")와 짝을 이루는 다른 쪽 절반이다 —
 * "예상과 달랐다", "반대로 갔다", "진짜 이유는 따로 있다".
 *
 * 2026-09-16 영상별 구독 실측(2026-08-25~09-16, 26편): 제목·훅에 이 구조가 있으면
 * 구독/1k뷰 2.12, 없으면 0.63 (3.4배). 시기를 갈라도 유지된다(이전 2.61 vs 1.35,
 * 이후 0.91 vs 0.17). 조회는 수치 나열로도 받지만 구독은 안 따라온다 — 최근 8편 중
 * 7편이 수치 나열이었고 그 8편의 순증 구독 합이 1 이었다.
 */
/**
 * 책임 회피 문장 — 답할 자리에서 "나중에 확인하라"고 시청자를 다른 데로 보내는 말.
 *
 * 2026-09-16 EP-2026-0157 실측: 제목이 「이란 휴전설에도 방산주가 급등한 **이유**」인데
 * insight 씬이 「정확한 상승 배경은 후속 보도로 다시 확인이 필요합니다」로 나갔다.
 * 원본(rev0)에는 「휴전 뒤 중동 재건과 무기 현대화 수요가 열릴 거란 기대 때문에 매수세가
 * 몰렸습니다」라는 답이 있었는데, 팩트체크 재작성이 검증이 안 된다고 지워 버린 것이다.
 *
 * 제목은 답을 약속하고 본문은 안 갚는다 — 시청자 입장에서는 60초를 쓸 이유가 사라진다.
 * 검증이 안 되면 **지우지 말고 해석으로 표시**하는 게 맞다("~라는 해석이 나옵니다").
 * 그래서 이건 warn 이 아니라 error 다: 이 문장이 분석 씬에 있으면 그 회차는 내보내면 안 된다.
 */
/**
 * 지수 이름 — 이것이 훅의 주어가 되면 「오늘 지수가 몇 % 움직였다」 회차가 된다.
 * 운영자 지시(2026-09-16): "단순 영향이 없는 지수 수치는 에피소드 주제가 되면 안 된다."
 */
/** 일상 등락률의 하한. config/growth.json content_policy.index_move_thresholds.index_pct 와 같은 값. */
export const INDEX_MOVE_PCT_FLOOR = 2.0;

export const INDEX_NAMES = ['코스피', '코스닥', '나스닥', '다우', '에스앤피', 's&p', '스탠더드앤드푸어스'];

/**
 * 낭독체 소수 → 숫자. "일점삼칠" → 1.37
 * 훅이 말한 등락률이 임계를 넘는지 기계적으로 보려면 숫자로 바꿔야 한다.
 * 프롬프트 지시(generate-script 10a)만으로는 지켜지는지 확인할 방법이 없었다.
 */
const DIGIT = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
export function spokenToNumber(token) {
  const m = String(token).match(/^([영공일이삼사오육칠팔구십]+)점([영공일이삼사오육칠팔구]+)$/);
  if (!m) return null;
  const whole = m[1] === '십' ? 10
    : m[1].includes('십')
      ? (DIGIT[m[1][0]] ?? 1) * 10 + (DIGIT[m[1].slice(-1)] ?? 0)
      : [...m[1]].reduce((n, c) => (DIGIT[c] === undefined ? n : n * 10 + DIGIT[c]), 0);
  const frac = [...m[2]].map((c) => DIGIT[c]).join('');
  const v = Number(`${whole}.${frac}`);
  return Number.isFinite(v) ? v : null;
}

export const DODGE_PHRASES = [
  '확인이 필요', '다시 확인', '후속 보도', '지켜봐야 알', '알 수 없습니다',
  '확인해야 합니다', '재확인이 필요', '판단하기 이릅', '단정하기 어렵',
];

export const CONTRAST_MARKERS = [
  '왜', '진짜 이유', '아니라', '인데도', '에도 불구', '지만', '는데', '반대로', '오히려',
  '예상과', '통념', '역전', '역주행', '틀렸', '착각', '의외', '숨은', '정작', '그런데도',
];

export const MECHANISM_MARKERS = [
  '때문', '덕분', '덕에', '탓', '이유', '영향', '여파', '반영', '이어', '이끌',
  '의미', '뜻', '신호', '셈', '결과', '따라서', '그래서', '바람에', '까닭',
  // 2026-09-05 추가: 실제 대본이 쓰는데 목록에 없어 오탐하던 연결어미.
  // "고용이 잘 나오자 확률이 뛰었다"(EP-0138 씬003)는 명백한 인과인데 걸렸다.
  '면서', '겹쳐', '겹치', '상쇄', '작용', '로 인', '에 힘입', '끌어내', '끌어올', '촉발',
  // 2026-09-16 추가: 이 채널의 주력 서술인 '전이' 계열. 미국 금리가 국내로 옮겨붙는
  // 이야기를 매 회차 하는데 목록에 없었다.
  '전이', '옮겨가', '옮겨붙', '번지', '퍼지', '전가',
];

/** "…나오자 / 터지자" 처럼 용언 + '자' 로 붙는 인과. 감탄사 "자," 와 구분해야 한다. */
/**
 * 조건부 인과: 「X-면 … Y도/따라 …」.
 *
 * 2026-09-16 EP-2026-0156 씬 004: 「미국 금리가 오르면 국내 은행채와 주택담보대출
 * 금리도 따라 오르고」 — 이 채널이 파는 전이 메커니즘 그 자체인데 no-mechanism 으로
 * 잡혔다. '면서' 는 목록에 있는데 '-으면'(조건)이 없었다.
 * 조건 어미만으로는 과탐한다("어쩌면", "하면 됩니다") — 뒤에 **결과절 표지**가
 * 따라올 때만 인과로 센다.
 */
export const MECHANISM_CONDITIONAL = /(?:으면|면)\s[^.!?]{0,40}?(?:도\s|따라|덩달아|같이\s|함께\s|이어서)/;

export const MECHANISM_VERB_JA = /(?:되|하|오|나오|가|뛰|빠지|오르|내리|터지|꺾이|풀리|막히)자[\s,]/;

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
 * 훅(씬 1)이 써도 되는 초. 60초 포맷 기준.
 *
 * 근거 — 2026-09-10 YouTube Analytics 실측(60초 포맷 15편):
 *   훅 ≥ 10초 : 3편, 평균 시청률 56.5%
 *   훅 <  10초 : 12편, 평균 시청률 70.4%
 * 리텐션 곡선을 보면 승부는 영상 길이의 5~20% 구간, 즉 3~12초에서 갈린다.
 * 상위 2편은 그 구간에서 30~35%p 를 잃는데 하위 2편은 47~48%p 를 잃는다.
 * 훅이 길어질수록 그 구간을 훅 하나로 다 쓰게 되고, 시청자는 다음 장면을 보기 전에 떠난다.
 *
 * 이 채널은 유입의 96.9% 가 Shorts 피드다 — 시청률이 곧 노출이고, 노출이 곧 조회다.
 */
export const HOOK_MAX_SECONDS = 10;

/** 이 상한을 적용할 대본 길이. 3분 포맷은 표본이 2편뿐이라 단정하지 않는다. */
export const HOOK_RULE_MAX_TOTAL_SECONDS = 90;

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
  return MECHANISM_MARKERS.some((m) => text.includes(m))
    || MECHANISM_VERB_JA.test(text)
    || MECHANISM_CONDITIONAL.test(text);
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
  const totalSeconds = scenes.reduce((n, sc) => n + (Number(sc.target_seconds) || 0), 0);
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

    if (role === 'hook' && Number(scene.target_seconds) > HOOK_MAX_SECONDS && totalSeconds <= HOOK_RULE_MAX_TOTAL_SECONDS) {
      issues.push({
        rule: 'hook-too-long', severity: 'warn', rewrite: true, scene_id: id,
        message: `씬 ${id}(hook): ${scene.target_seconds}초 — 상한 ${HOOK_MAX_SECONDS}초`,
        suggestion: '훅에서 배경 설명을 빼고 한 문장으로 줄여라. 시청자는 3~12초 안에 계속 볼지 정한다 — 그 구간을 훅 하나로 쓰면 다음 장면까지 못 간다.',
      });
    }

    // 훅이 '무슨 일이 있었다'만 말하고 '왜 그게 중요한가'를 말하지 않으면 조회는 와도
    // 구독으로 이어지지 않는다. 막지는 않되(severity=warn) 한 번 되돌린다 — 훅은
    // 시청자가 3~12초 안에 채널을 판단하는 자리라 여기서 지수만 읊으면 다른 채널과 같아진다.
    if (role === 'hook' && !hasMechanism(narration)
        && !CONTRAST_MARKERS.some((m) => narration.includes(m))) {
      issues.push({
        rule: 'hook-no-why', severity: 'warn', rewrite: true, scene_id: id,
        message: `씬 ${id}(hook): 인과도 반전도 없다 — 지수·사실 나열만으로 열었다`,
        suggestion: '훅의 주어를 수치에서 "왜"로 바꿔라. 통념과 어긋난 것, 반대로 움직인 것, 숨은 원인 중 하나를 첫 문장에서 주장하라. 수치는 그 주장의 근거로 뒤에 붙이거나 subtitle_text 로 옮겨라.',
      });
    }

    // 훅이 '지수가 몇 % 움직였다'로 열리면 이 채널이 파는 게 사라진다.
    // 프롬프트 규칙(generate-script 10a/10b)만 있고 기계 검사가 없어서 확인이 안 됐다.
    // 레벨 돌파·N년래 최고 같은 사건은 예외다 — 그건 등락률이 아니라 사건이다.
    if (role === 'hook') {
      const head = narration.slice(0, 40);
      const idx = INDEX_NAMES.find((n) => head.includes(n));
      const pct = head.match(/([영공일이삼사오육칠팔구십]+점[영공일이삼사오육칠팔구]+)\s*퍼센트/);
      const eventful = /돌파|뚫|붕괴|최고|최저|이후 처음|만에|연속/.test(narration);
      // 대조의 앞쪽 절로 쓰인 수치는 '주어'가 아니다.
      // 「코스피가 1.37% 올랐**지만** 개인도 외국인도 팔았습니다」의 주제는 등락률이 아니라 괴리다.
      // 2026-09-16 EP-2026-0158 실측 오탐 — 이걸 안 빼면 멀쩡한 훅이 재작성을 한 번 태운다.
      const contrasted = CONTRAST_MARKERS.some((m) => narration.includes(m));
      if (idx && pct && !eventful && !contrasted) {
        const v = spokenToNumber(pct[1]);
        if (v !== null && v < INDEX_MOVE_PCT_FLOOR) {
          issues.push({
            rule: 'index-move-as-subject', severity: 'warn', rewrite: true, scene_id: id,
            message: `씬 ${id}(hook): ${idx} ${v}% 로 열었다 — 일상 등락률은 주제가 못 된다 (임계 ${INDEX_MOVE_PCT_FLOOR}%)`,
            suggestion: '훅의 주어를 등락률에서 사건으로 바꿔라 — 누가 샀나/무엇이 통념과 달랐나/그래서 시청자에게 무슨 뜻인가. 지수 수치는 근거로 뒤에 붙이거나 subtitle_text 로 옮겨라.',
          });
        }
      }
    }

    // 분석 씬이 "왜"를 말할 자리에서 "나중에 확인하라"로 끝내면 회차가 껍데기가 된다.
    // hook 은 제외한다 — 훅은 질문을 던지는 자리라 유보가 허용된다.
    if (ANALYTIC_ROLES.includes(role)) {
      const dodge = DODGE_PHRASES.filter((d) => narration.includes(d));
      if (dodge.length) {
        issues.push({
          rule: 'dodge-in-analysis', severity: 'error', scene_id: id,
          message: `씬 ${id}(${role}): 답할 자리에서 유보했다 — "${dodge[0]}"`,
          suggestion: '검증이 안 되는 설명은 지우지 말고 해석으로 표시하라 — "…라는 해석이 나옵니다", "시장은 …로 본 것으로 보입니다". 시청자를 다른 곳으로 보내는 문장은 쓰지 마라.',
        });
      }
    }

    const filler = FILLER_PHRASES.filter((p) => narration.includes(p));
    if (filler.length && !hasMechanism(narration)) {
      issues.push({
        rule: 'filler-conclusion', severity: 'error', scene_id: id,
        message: `씬 ${id}: 어느 날에 붙여도 맞는 조언으로 끝났다 — "${filler.join('", "')}"`,
        suggestion: '이 문장을 오늘 이 뉴스에서만 할 수 있는 말로 바꿔라. 무엇을 왜 점검해야 하는지 오늘의 사실로 지목해라.',
      });
    }

    // rewrite:true 인 이유 — severity 는 warn 그대로 둔다.
    // warn 이던 동안 이 규칙은 한 번도 재작성을 부르지 못했다(생성기 루프가 error 에서만
    // 되돌린다). 2026-09-05 실측: 최근 8회차가 전부 이 경고를 달고 나갔고, 분석 씬
    // 301개 중 169개(56%)가 인과를 말하지 않았다 — 계약 B·D 가 문서로만 남아 있었다.
    // 그렇다고 error 로 올리면 기존 대본 129편 중 94편이 막혀 게이트가 꺼진다
    // (tests/script-quality-contract.js 의 "통과율 50%" 가드레일이 이걸 잡는다).
    // 그래서 '막지는 않되 한 번 되돌린다' 로 나눴다. 재작성 후에도 남으면 기록하고 진행한다.
    if (ANALYTIC_ROLES.includes(role) && !hasMechanism(narration) && !filler.length) {
      issues.push({
        rule: 'no-mechanism', severity: 'warn', rewrite: true, scene_id: id,
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

0. 훅(씬 1)은 ${HOOK_MAX_SECONDS}초를 넘기지 마라. 시청자는 3~12초 안에 계속 볼지 정한다
   (2026-09-10 실측: 훅 10초 이상 3편 시청률 56.5% vs 10초 미만 12편 70.4%).
   배경 설명은 씬 2로 넘기고, 훅은 "무엇이 이상한가" 한 문장이면 된다.

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
   **지수·수치는 주어가 아니라 근거다.** 등락이 평소 폭을 넘지 못했으면 아예 말하지 마라.
   넘었으면 그때도 "무엇이 그렇게 만들었나"를 주어로 놓고, 수치는 그 주장의 근거로 뒤에 붙여라.
   2026-09-16 실측: 수치를 나열한 편은 조회는 받아도 구독/1k뷰가 0.63, 인과·반전으로 연 편은
   2.12 였다(26편). 이 채널이 파는 건 숫자가 아니라 "그래서 왜"다.
`;
}

/** 사람이 읽는 한 줄. 검증기·생성기·테스트가 같은 문구를 쓴다. */
export function formatIssue(issue) {
  const where = issue.scene_id ? `[씬 ${issue.scene_id}]` : '[전체]';
  return `${issue.severity === 'error' ? '❌' : '⚠️ '} ${where} ${issue.rule}: ${issue.message}`;
}
