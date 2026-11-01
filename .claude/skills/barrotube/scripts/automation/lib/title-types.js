/**
 * title-types.js — 제목 유형 분류 (2026-09-26)
 *
 * 공개 영상 92편을 "클릭을 부르는 주 장치" 기준으로 10유형으로 나눈 분석과, 제목 후보를
 * 고르는 선택기(title-select.js)가 **같은 정의**를 쓰도록 여기 한 곳에 둔다. 분석과 생성의
 * 분류가 갈리면 "최근에 이 유형을 너무 많이 썼다"는 판단이 성립하지 않는다.
 *
 * 한 제목이 여러 장치를 겹쳐 쓰는 일이 흔해서 **우선순위**로 주 유형 하나를 정하고
 * 나머지는 보조 태그로 남긴다. 순서는 분석 때와 같다.
 *
 * 2026-09-25 실측(조회 중앙값, 쇼츠는 이틀이면 조회가 멈춰 누적으로 비교 가능):
 *   종목·기업 1,295 · 질문 1,259 · 인물 979 · 인과 962 · 계좌 948 · 역설 819
 *   "진짜 이유" 729 · 수치 보도 680 · [라벨] 578 · 기록·돌파 단독 275
 * 09-16 이후 15편 중 9편이 "진짜 이유"형으로 쏠렸고, 그 틀은 드물게 쓰던 07~08월 중앙값
 * 약 1,170 에서 기본값이 된 뒤 549 로 내려갔다.
 */

export const TITLE_TYPES = [
  { key: 'label', label: '[라벨] 시황형', re: /^\s*\[/ },
  { key: 'account', label: '내 계좌·내 돈형', re: /계좌|통장|내 대출|대출이자|당신의|세금 폭탄|내 돈|월급|포트폴리오/ },
  { key: 'jinjja', label: '"진짜 이유"형', re: /진짜/ },
  { key: 'causal', label: '인과형 (이유·왜)', re: /이유|왜/ },
  { key: 'question', label: '질문형', re: /\?/ },
  { key: 'contrast', label: '역설·반전형', re: /인데|는데|에도|지만|아니라|아닌|반대|오히려|역주행|\bvs\b|만 웃|거꾸로/ },
  { key: 'figure', label: '인물형', re: /트럼프|워시|베센트|젠슨 황|아셴브레너|파월|월러|머스크|이창용/ },
  { key: 'record', label: '기록·돌파형', re: /사상|최고|최저|돌파|붕괴|연속|역대|최대|\d+\s*년\s*(만|래|來|이후)|시대|전고점|탈환/ },
  { key: 'company', label: '종목·기업형', re: /삼성|하이닉스|엔비디아|테슬라|메타|샌디스크|알리바바|실적|자사주|주주환원|영업이익/ },
  { key: 'report', label: '수치 보도·해설형', re: /[\s\S]*/ },
];

export const TYPE_LABEL = Object.fromEntries(TITLE_TYPES.map((t) => [t.key, t.label]));

/** 비교용 본문 — 제목 끝 #Shorts 는 유형과 무관하다. */
export function titleCore(title) {
  return String(title ?? '').replace(/\s*#Shorts\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** 주 유형 하나 + 겹친 장치(보조 태그). */
export function classifyTitle(title) {
  const core = titleCore(title);
  const hits = TITLE_TYPES.filter((t) => t.re.test(core)).map((t) => t.key);
  return { primary: hits[0], tags: hits.slice(1).filter((k) => k !== 'report') };
}

export default { TITLE_TYPES, TYPE_LABEL, titleCore, classifyTitle };
