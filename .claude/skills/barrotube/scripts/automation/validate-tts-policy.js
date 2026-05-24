#!/usr/bin/env node

/**
 * validate-tts-policy.js — TTS 표기 정책 v2.0 자동 검증기 (품질 권고 #2)
 *
 * 목적:
 *   EP-0043 사례 ("오십칠조 이천억" → "57조 2,000억원") 같은 한글 풀어쓰기
 *   숫자/연도/퍼센트 위반을 TTS(S6a) 진입 전 자동 감지하여 차단.
 *
 * Usage:
 *   # EP의 30_script.md 검증 (long, shorts 모두)
 *   node scripts/automation/validate-tts-policy.js --ep EP-2026-0043
 *   node scripts/automation/validate-tts-policy.js --ep EP-2026-0043 --platform shorts
 *
 *   # 임의 텍스트를 stdin으로 검증
 *   echo "오십칠조 이천억 어닝 서프라이즈" | node scripts/automation/validate-tts-policy.js
 *
 *   # 임의 파일 검증
 *   node scripts/automation/validate-tts-policy.js --file path/to/script.md
 *
 *   --json     검증 결과 JSON 으로 stdout에 출력
 *   --quiet    위반 없으면 출력 생략
 *   --help     사용법
 *
 * Exit code:
 *   0  정책 통과 (위반 0건; warning 만 있을 수 있음)
 *   1  정책 위반 (1건 이상의 violation 또는 입력 오류)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE = resolve(ROOT, 'workspace');

const HELP = `
validate-tts-policy.js — TTS 표기 정책 v2.0 자동 검증기

Usage:
  # EP 검증
  node scripts/automation/validate-tts-policy.js --ep EP-2026-0043 [--platform long|shorts]

  # stdin 검증
  echo "텍스트" | node scripts/automation/validate-tts-policy.js

  # 파일 검증
  node scripts/automation/validate-tts-policy.js --file path/to/script.md

Options:
  --ep <id>            workspace/episodes/<id>/ 의 platforms/{long,shorts}/30_script.md 자동 탐색
  --platform <id>      long | shorts (기본: 둘 다)
  --file <path>        임의 파일 검증
  --json               결과 JSON 출력
  --quiet              위반 없으면 침묵
  --help               이 도움말

Exit code:
  0 통과 (위반 0건)
  1 위반 발견
`;

// ──────────────────────────────────────────────────────────
// 정책 규칙 (v2.0)
// ──────────────────────────────────────────────────────────

// 한글 숫자 단어 (단위 직전에 풀어쓰면 위반)
// 일/이/삼/사/오/육/칠/팔/구/십/백/천/만/억/조 가 연속해서 나타나며 단위(조|억|만|천|백|원|달러|퍼센트|프로) 가 따라옴
const RX_HANGUL_NUMBER_BEFORE_UNIT =
  /(?<![가-힣A-Za-z0-9])([일이삼사오육칠팔구십백천만억조][일이삼사오육칠팔구십백천만억조\s]*)\s*(조|억|만|천(?!\s)|백(?!\s)|원|달러|퍼센트|프로)(?![가-힣A-Za-z])/g;

// 연도 한글 표기 — 이천이십<X>년
const RX_HANGUL_YEAR =
  /이천(?:이십|삼십|사십|십)?[일이삼사오육칠팔구]?년/g;
// 단순 "이천년" 도 잡고 싶으면 보강
const RX_HANGUL_YEAR_SIMPLE = /(?<![가-힣])이천년(?![가-힣])/g;

// 퍼센트 한글 표기
const RX_HANGUL_PERCENT =
  /(?<![가-힣A-Za-z0-9])([일이삼사오육칠팔구십백]+)\s*(퍼센트|프로)(?![가-힣A-Za-z])/g;

// "포인트" 단독 사용 (수치 차이 표기) — bp/%p 권장
// 한글 숫자 + "포인트" 또는 "베이시스 포인트" 패턴을 warn
const RX_POINT_WARN =
  /([일이삼사오육칠팔구십백천만\d]+)\s*(베이시스\s*)?포인트(?![가-힣])/g;

// 한글 숫자 → 아라비아 숫자 매핑 (간단 변환 — 제안용)
const HANGUL_DIGIT = {
  '일': 1, '이': 2, '삼': 3, '사': 4, '오': 5,
  '육': 6, '칠': 7, '팔': 8, '구': 9,
};

function hangulToArabicShort(s) {
  // 100 이하 + 단순 단위까지만 best-effort 변환 ("오십칠" → 57)
  // 완전 변환은 어려우므로 "57" 같은 plain digit로 안내
  if (!s) return '?';
  // 이천이십육 (year)
  if (s.startsWith('이천')) {
    const rest = s.slice(2);
    const map = { '': 2000, '이십': 2020, '이십일': 2021, '이십이': 2022, '이십삼': 2023, '이십사': 2024, '이십오': 2025, '이십육': 2026, '이십칠': 2027, '이십팔': 2028, '이십구': 2029, '삼십': 2030 };
    if (map[rest] !== undefined) return String(map[rest]);
    return '20XX';
  }
  // 오십칠 / 오십 / 칠 / 십 / 십이
  let total = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (HANGUL_DIGIT[ch] !== undefined) {
      const next = s[i + 1];
      if (next === '십') { total += HANGUL_DIGIT[ch] * 10; i += 2; continue; }
      if (next === '백') { total += HANGUL_DIGIT[ch] * 100; i += 2; continue; }
      if (next === '천') { total += HANGUL_DIGIT[ch] * 1000; i += 2; continue; }
      total += HANGUL_DIGIT[ch];
      i += 1;
      continue;
    }
    if (ch === '십') { total += 10; i += 1; continue; }
    if (ch === '백') { total += 100; i += 1; continue; }
    if (ch === '천') { total += 1000; i += 1; continue; }
    // unrecognized
    return '?';
  }
  return total > 0 ? String(total) : '?';
}

function suggestNumberFix(hangul, unit) {
  // 한글 숫자 + 단위 → 아라비아 숫자 + 단위
  const trimmed = hangul.replace(/\s/g, '');
  const arabic = hangulToArabicShort(trimmed);
  // 큰 단위 결합 (예: "오십칠조 이천억" → "57조 2,000억원" 같은 형식)
  // 단순 단어 한 묶음일 때만 자동 변환을 시도하고, 복합은 placeholder
  return arabic === '?' ? '<숫자>' + unit : arabic + unit;
}

function suggestYearFix(yr) {
  const arabic = hangulToArabicShort(yr.replace(/년$/, ''));
  return arabic === '?' || arabic === '20XX' ? '20XX년' : arabic + '년';
}

function suggestPercentFix(hangul) {
  const arabic = hangulToArabicShort(hangul.replace(/\s/g, ''));
  return arabic === '?' ? '<숫자>%' : arabic + '%';
}

function suggestPointFix(num) {
  const arabic = hangulToArabicShort(num.replace(/\s/g, ''));
  return arabic === '?' ? '<숫자>%p' : arabic + '%p';
}

// ──────────────────────────────────────────────────────────
// 검증 엔진
// ──────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @param {string} sourceLabel
 * @returns {{violations:Array, warnings:Array}}
 */
function validateText(text, sourceLabel) {
  const lines = text.split(/\r?\n/);
  const violations = [];
  const warnings = [];

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 1. 한글 숫자 + 단위
    let m;
    const rx1 = new RegExp(RX_HANGUL_NUMBER_BEFORE_UNIT.source, 'g');
    while ((m = rx1.exec(line)) !== null) {
      const matched = m[0];
      const hangul = m[1];
      const unit = m[2];
      // 화이트리스트: "만 원"이 단위가 아닌 부사 "만"인 경우 등은 너무 엄격하면 false positive — 기본은 위반으로 표기.
      violations.push({
        rule: 'hangul-number-before-unit',
        source: sourceLabel,
        line: lineNo,
        col: m.index + 1,
        text: matched.trim(),
        suggestion: suggestNumberFix(hangul, unit),
        message: `한글 풀어쓰기 숫자 + 단위. 표기 정책 v2.0 위반.`,
      });
    }

    // 2. 연도 한글 표기
    const rx2 = new RegExp(RX_HANGUL_YEAR.source, 'g');
    while ((m = rx2.exec(line)) !== null) {
      violations.push({
        rule: 'hangul-year',
        source: sourceLabel,
        line: lineNo,
        col: m.index + 1,
        text: m[0],
        suggestion: suggestYearFix(m[0]),
        message: `연도는 4자리 숫자로 표기 (e.g., 2026년).`,
      });
    }
    const rx2b = new RegExp(RX_HANGUL_YEAR_SIMPLE.source, 'g');
    while ((m = rx2b.exec(line)) !== null) {
      violations.push({
        rule: 'hangul-year',
        source: sourceLabel,
        line: lineNo,
        col: m.index + 1,
        text: m[0],
        suggestion: '2000년',
        message: `연도는 4자리 숫자로 표기.`,
      });
    }

    // 3. 퍼센트 한글 표기
    const rx3 = new RegExp(RX_HANGUL_PERCENT.source, 'g');
    while ((m = rx3.exec(line)) !== null) {
      // "이백 퍼센트" 같이 "백" 단위 포함도 포함되어 매칭됨 (정책상 위반)
      violations.push({
        rule: 'hangul-percent',
        source: sourceLabel,
        line: lineNo,
        col: m.index + 1,
        text: m[0],
        suggestion: suggestPercentFix(m[1]),
        message: `퍼센트는 숫자 + % 로 표기 (e.g., 4%).`,
      });
    }

    // 4. "포인트" 권장 → %p / bp
    const rx4 = new RegExp(RX_POINT_WARN.source, 'g');
    while ((m = rx4.exec(line)) !== null) {
      const isBasis = !!m[2];
      warnings.push({
        rule: 'point-recommend-pp',
        source: sourceLabel,
        line: lineNo,
        col: m.index + 1,
        text: m[0],
        suggestion: isBasis ? `${suggestPointFix(m[1]).replace('%p', '')}bp` : suggestPointFix(m[1]),
        message: `"포인트" 표기. "%p" 또는 "bp" 권장.`,
      });
    }
  });

  return { violations, warnings };
}

function readStdin() {
  return new Promise((resolveP) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolveP(data));
    // stdin이 tty면 즉시 종료
    if (process.stdin.isTTY) resolveP('');
  });
}

function findEpisodeScripts(epId, platformFilter) {
  const epDir = join(WORKSPACE, 'episodes', epId);
  if (!existsSync(epDir)) {
    throw new Error(`EP 디렉토리가 없습니다: ${epDir}`);
  }
  const candidates = [];
  const platforms = platformFilter ? [platformFilter] : ['long', 'long-3min', 'shorts'];
  for (const p of platforms) {
    const pPath = join(epDir, 'platforms', p, '30_script.md');
    if (existsSync(pPath)) candidates.push({ platform: p, path: pPath });
  }
  // v1 fallback: 평면 30_script.md
  const v1 = join(epDir, '30_script.md');
  if (existsSync(v1)) candidates.push({ platform: 'v1-flat', path: v1 });

  if (candidates.length === 0) {
    throw new Error(`30_script.md 를 찾을 수 없습니다: ${epDir}`);
  }
  return candidates;
}

function formatViolation(v) {
  return `[POLICY VIOLATION] ${v.source} 줄 ${v.line}: "${v.text}" → "${v.suggestion}"  (${v.message})`;
}
function formatWarning(w) {
  return `[POLICY WARNING]  ${w.source} 줄 ${w.line}: "${w.text}" → "${w.suggestion}"  (${w.message})`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        ep:        { type: 'string' },
        platform:  { type: 'string' },
        file:      { type: 'string' },
        json:      { type: 'boolean', default: false },
        quiet:     { type: 'boolean', default: false },
        help:      { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`[ERROR] 인자 파싱 실패: ${e.message}`);
    console.error(HELP);
    process.exit(1);
  }

  // 입력 소스 결정 (우선순위: --ep > --file > stdin)
  const sources = [];
  try {
    if (values.ep) {
      const items = findEpisodeScripts(values.ep, values.platform);
      for (const it of items) {
        sources.push({ label: `${values.ep}/platforms/${it.platform}/30_script.md`, text: readFileSync(it.path, 'utf-8') });
      }
    } else if (values.file) {
      const p = resolve(values.file);
      if (!existsSync(p)) throw new Error(`파일 없음: ${p}`);
      sources.push({ label: p, text: readFileSync(p, 'utf-8') });
    } else {
      const stdin = await readStdin();
      if (!stdin || stdin.trim().length === 0) {
        console.error('[ERROR] 입력이 없습니다. --ep / --file / stdin 중 하나를 사용하세요.');
        console.error(HELP);
        process.exit(1);
      }
      sources.push({ label: '<stdin>', text: stdin });
    }
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    process.exit(1);
  }

  let totalViolations = 0;
  let totalWarnings = 0;
  const result = { sources: [] };

  for (const src of sources) {
    const { violations, warnings } = validateText(src.text, src.label);
    totalViolations += violations.length;
    totalWarnings += warnings.length;
    result.sources.push({
      source: src.label,
      violations_count: violations.length,
      warnings_count: warnings.length,
      violations,
      warnings,
    });

    if (values.json) continue;

    if (!values.quiet || violations.length > 0 || warnings.length > 0) {
      console.log(`\n=== ${src.label} ===`);
      console.log(`  violations: ${violations.length}, warnings: ${warnings.length}`);
      for (const v of violations) console.log('  ' + formatViolation(v));
      for (const w of warnings) console.log('  ' + formatWarning(w));
      if (violations.length === 0 && warnings.length === 0) {
        console.log('  [OK] 정책 위반 없음.');
      }
    }
  }

  if (values.json) {
    result.total_violations = totalViolations;
    result.total_warnings = totalWarnings;
    result.passed = totalViolations === 0;
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n총 violations: ${totalViolations}, warnings: ${totalWarnings}`);
    if (totalViolations === 0) {
      console.log('[OK] 표기 정책 v2.0 통과. TTS 진입 가능.');
    } else {
      console.log('[FAIL] 표기 정책 v2.0 위반. 30_script.md 수정 후 재검증 필요.');
    }
  }

  process.exit(totalViolations > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
