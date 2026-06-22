import { resolveImageEngine } from './lib/image-engine-config.js';

// config를 명시 주입해 결정적으로 검증 (실제 config/image-engines.json 값과 무관).
const AUTO = { global: 'auto', stages: { S6d_intro: 'auto', S6e_thumbnail: 'auto' } };
const GLOBAL_OPENAI = { global: 'openai', stages: { S6d_intro: 'auto', S6e_thumbnail: 'auto' } };
const K = { OPENAI_API_KEY: 'sk-x' };   // 키 있음
const NK = {};                          // 키 없음
const A = (env, extra) => ({ env, config: AUTO, ...extra });

const cases = [
  // [라벨, stage, opts, 기대 engine, 기대 downgraded]
  // auto(현행 호환)
  ['intro auto + key → openai',      'S6d_intro',     A(K),  'openai', false],
  ['intro auto + no key → gemini',   'S6d_intro',     A(NK), 'gemini', false],
  ['thumb auto (key) → gemini',      'S6e_thumbnail', A(K),  'gemini', false],
  ['thumb auto (no key) → gemini',   'S6e_thumbnail', A(NK), 'gemini', false],

  // 전역 스위치 BT_IMAGE_ENGINE (env)
  ['global env=openai → intro openai',   'S6d_intro',     A({ ...K, BT_IMAGE_ENGINE: 'openai' }), 'openai', false],
  ['global env=openai → thumb openai',   'S6e_thumbnail', A({ ...K, BT_IMAGE_ENGINE: 'openai' }), 'openai', false],
  ['global env=openai no key → downgrade','S6e_thumbnail', A({ BT_IMAGE_ENGINE: 'openai' }),       'gemini', true],
  ['global env=gemini → intro gemini',   'S6d_intro',     A({ ...K, BT_IMAGE_ENGINE: 'gemini' }),  'gemini', false],

  // config.global=openai (env 없을 때 파일이 전역 활성화) — 실제 배포 설정과 동일
  ['config.global=openai → thumb openai', 'S6e_thumbnail', { env: K, config: GLOBAL_OPENAI }, 'openai', false],
  ['config.global=openai → intro openai', 'S6d_intro',     { env: K, config: GLOBAL_OPENAI }, 'openai', false],
  ['config.global=openai no key → downgrade', 'S6e_thumbnail', { env: NK, config: GLOBAL_OPENAI }, 'gemini', true],
  ['env beats config.global',             'S6e_thumbnail', { env: { ...K, BT_THUMBNAIL_ENGINE: 'gemini' }, config: GLOBAL_OPENAI }, 'gemini', false],

  // 단계별 env override (전역보다 우선)
  ['stage env wins over global env', 'S6e_thumbnail', A({ ...K, BT_IMAGE_ENGINE: 'gemini', BT_THUMBNAIL_ENGINE: 'openai' }), 'openai', false],
  ['intro stage env',                'S6d_intro',     A({ ...K, BT_INTRO_ENGINE: 'gemini' }), 'gemini', false],

  // legacy BT_INTRO_FORCE_GEMINI
  ['legacy force-gemini overrides global', 'S6d_intro', A({ ...K, BT_IMAGE_ENGINE: 'openai', BT_INTRO_FORCE_GEMINI: '1' }), 'gemini', false],
  ['stage env beats legacy',         'S6d_intro',     A({ ...K, BT_INTRO_ENGINE: 'openai', BT_INTRO_FORCE_GEMINI: '1' }), 'openai', false],

  // CLI --engine (최우선)
  ['cli openai beats everything',    'S6e_thumbnail', A({ ...K, BT_THUMBNAIL_ENGINE: 'gemini' }, { cliOverride: 'openai' }), 'openai', false],
  ['cli gemini beats global openai', 'S6d_intro',     A({ ...K, BT_IMAGE_ENGINE: 'openai' }, { cliOverride: 'gemini' }), 'gemini', false],
  ['cli openai no key → downgrade',  'S6e_thumbnail', A({}, { cliOverride: 'openai' }), 'gemini', true],

  // 잘못된 값은 무시(다음 우선순위로)
  ['invalid stage env ignored → auto', 'S6e_thumbnail', A({ ...K, BT_THUMBNAIL_ENGINE: 'dalle' }), 'gemini', false],
];

let pass = 0, fail = 0;
for (const [label, stage, opts, expEng, expDown] of cases) {
  const r = resolveImageEngine(stage, opts);
  const ok = r.engine === expEng && r.downgraded === expDown;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${label} → ${r.engine}${r.downgraded ? '(downgraded)' : ''} [src=${r.source}]  (기대: ${expEng}${expDown ? '(downgraded)' : ''})`);
}
console.log(`\n${pass}/${cases.length} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
