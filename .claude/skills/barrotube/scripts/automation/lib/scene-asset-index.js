/**
 * scene-asset-index.js — 기존 에피소드 씬 자산 인덱스 + 재사용 매칭 (2026-09-22)
 *
 * 왜 필요했나: 2026-09-22 us-close(EP-2026-0172)가 Phase 7 에서 halt 했다.
 * 이미지를 굽는 **모든** 경로가 같은 날 동시에 막혔다 — 실측 로그:
 *   ChatGPT(브라우저)   : "usage limit … try again at Sep 25th, 2026 7:17 AM" (주간 한도)
 *   codex imagegen      : 같은 ChatGPT 계정이라 같은 한도
 *   gpt-image-1 API     : 크레딧 고갈
 *   Gemini API          : 402 prepayment credits depleted
 *   Grok                : 주간 한도 소진 (운영자 확인)
 * 이 조합에서는 코드로 풀 수 있는 생성 경로가 하나도 없다. 그런데 채널에는 이미
 * 같은 캐릭터로 구운 씬 스틸 792장과 모션 클립 427개가 쌓여 있다 — 캐릭터 일관성은
 * 이미 담보돼 있고, 필요한 건 "지금 대본에 맞는 컷"을 고르는 일뿐이다.
 *
 * 매칭 방식: 코퍼스 자체로 계산한 TF-IDF 코사인.
 *   image_prompt 는 절반 이상이 보일러플레이트다(캐릭터 시트 문구·"9:16 vertical"·
 *   "no readable text or numbers"). 불용어 목록을 손으로 관리하면 프롬프트 템플릿이
 *   바뀔 때마다 갈라진다. IDF 는 코퍼스에 흔한 단어의 가중치를 스스로 0 에 수렴시키므로
 *   보일러플레이트가 자동으로 빠지고 변별어(balance scale, microchip, bar chart)만 남는다.
 *   2026-09-22 실측(EP-2026-0171 질의, 자기 자신 제외):
 *     lopsided balance scale → tilted balance scale (0.324)
 *     uneven bar chart       → split bar chart      (0.474)
 *     glowing microchip      → glowing microchip    (0.406)
 *
 * 이 모듈은 **읽기만** 한다. 파일 복사·원장 기록은 reuse-scene-assets.js 가 한다.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { BOUNDS, CARICATURE } from './image-prompt-contract.js';
import { isGenericObject } from './scene-slot-taxonomy.js';

/** 자산 경로 규칙. image-engines.json 의 media_render.*_out 과 같은 레이아웃이다. */
const IMAGES_REL = join('40_assets', 'images');
const VIDEOS_REL = join('40_assets', 'videos');

/**
 * 한 대본 경로에서 (씬 → 프롬프트 + 실제 자산) 항목을 만든다.
 *
 * 대본에만 있고 파일이 없는 씬은 버린다 — 인덱스는 "지금 복사할 수 있는 것"의 목록이고,
 * 없는 파일을 후보로 올리면 고른 뒤에 복사가 실패한다.
 */
export function indexScriptDir(scriptPath, { origin = 'episode' } = {}) {
  if (!existsSync(scriptPath)) return [];
  const raw = readFileSync(scriptPath, 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];

  let meta;
  try {
    meta = parseYAML(fm[1]);
  } catch {
    // 손상된 대본 하나가 인덱스 전체를 죽이면 안 된다. 그 경로만 버린다.
    return [];
  }
  if (!meta || !Array.isArray(meta.scenes)) return [];

  const base = dirname(scriptPath);
  const out = [];
  for (const scene of meta.scenes) {
    const sceneId = String(scene.scene_id ?? '').padStart(3, '0');
    if (!/^\d{3}$/.test(sceneId)) continue;
    const prompt = String(scene.image_prompt ?? '').trim();
    if (!prompt) continue;

    const image = join(base, IMAGES_REL, `scene_${sceneId}.png`);
    if (!existsSync(image) || statSync(image).size === 0) continue;

    const video = join(base, VIDEOS_REL, `scene_${sceneId}.mp4`);
    out.push({
      /**
       * 자산의 출처. 'episode' 는 발행 경로를 탄 컷이고 'library' 는 백필로 구워 둔
       * 컷이다. 신선도 규칙이 이 값으로 갈린다 — pickReuseSet 주석 참조.
       */
      origin,
      episodeId: String(meta.episode_id ?? ''),
      channelId: String(meta.channel_id ?? ''),
      format: String(meta.format ?? ''),
      sceneDir: base,
      sceneId,
      role: String(scene.role ?? ''),
      palette: (prompt.match(/\[palette:(\w+)\]/) || [, ''])[1],
      prompt,
      /**
       * 한국어 대사. 슬롯 주제 분류의 정본이다.
       *
       * image_prompt 로 주제를 맞히려 해 봤는데(2026-09-22 실측) 어휘의 대부분이
       * 조명·분위기어였다 — glow 204 · warm 191 · skyline 78 에 비해 주제어는
       * chip 15 · oil 16 수준이다. 프롬프트는 **어떻게 보이나**를 적고, 주제는
       * 대사에 있다. 같은 실측에서 대사 기반 분류의 미분류율이 16% 로 떨어졌다.
       */
      text: `${scene.narration ?? ''} ${scene.subtitle_text ?? ''}`.trim(),
      image,
      video: existsSync(video) && statSync(video).size > 0 ? video : null,
      /**
       * 생성 시점. 시청자가 최근 컷을 알아보는 걸 막는 쿨다운의 기준이다.
       * 에피소드 번호가 아니라 파일 mtime 을 쓴다 — 재생성·top-up 으로 같은 EP 안에서도
       * 시점이 갈리고, workspace 는 gitignore 된 심볼릭 링크라 checkout 이 mtime 을
       * 건드리지 않는다.
       */
      mtimeMs: statSync(image).mtimeMs,
    });
  }
  return out;
}

/**
 * 재사용 **대상** 에피소드의 씬 목록을 읽는다.
 *
 * indexScriptDir 과 갈라놓은 이유: 인덱스는 "복사할 수 있는 자산"만 담아야 해서 파일이
 * 없는 씬을 버리는데, 대상 에피소드는 정의상 자산이 없다. 같은 함수로 둘 다 하면
 * 대상 씬이 전부 버려져 조용히 0컷을 배정한다.
 */
export function readTargetScenes(scriptPath) {
  const raw = readFileSync(scriptPath, 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) throw new Error(`frontmatter 없음: ${scriptPath}`);
  const meta = parseYAML(fm[1]);
  if (!meta || !Array.isArray(meta.scenes)) throw new Error(`scenes 없음: ${scriptPath}`);

  return meta.scenes.map((scene, i) => {
    const prompt = String(scene.image_prompt ?? '').trim();
    return {
      sceneId: String(scene.scene_id ?? i + 1).padStart(3, '0'),
      role: String(scene.role ?? ''),
      palette: (prompt.match(/\[palette:(\w+)\]/) || [, ''])[1],
      prompt,
      text: `${scene.narration ?? ''} ${scene.subtitle_text ?? ''}`.trim(),
    };
  }).filter((s) => {
    if (!s.prompt) {
      // image_prompt 없는 씬은 재사용 대상이 아니다 — 무엇에 맞춰 고를지가 없다.
      console.warn(`  ⚠ 씬 ${s.sceneId}: image_prompt 가 없어 재사용 대상에서 제외`);
      return false;
    }
    return true;
  });
}

/**
 * 에피소드 루트 전체를 인덱싱한다. v1(에피소드 직하)·v2(platforms/<platform>/) 레이아웃을 모두 본다.
 */
export function buildIndex(episodesRoot, { excludeEpisodeIds = [], libraryRoot = null } = {}) {
  const entriesFromLibrary = libraryRoot ? indexLibrary(libraryRoot) : [];
  if (!existsSync(episodesRoot)) return entriesFromLibrary;
  const skip = new Set(excludeEpisodeIds);
  const entries = [];

  for (const ep of readdirSync(episodesRoot)) {
    if (!/^EP-/.test(ep)) continue;
    if (skip.has(ep)) continue;
    const epDir = join(episodesRoot, ep);
    let stat;
    try {
      stat = statSync(epDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const scripts = [join(epDir, '30_script.md')];
    const platforms = join(epDir, 'platforms');
    if (existsSync(platforms)) {
      for (const p of readdirSync(platforms)) {
        scripts.push(join(platforms, p, '30_script.md'));
      }
    }
    for (const s of scripts) entries.push(...indexScriptDir(s));
  }
  return [...entries, ...entriesFromLibrary];
}

/**
 * 백필 라이브러리를 인덱싱한다.
 *
 * 왜 workspace/episodes 밖에 두는가: 거기에 두면 20곳 넘는 스크립트가 라이브러리를
 * 에피소드로 착각한다 — 발행 대조(publish_reconciliation)·보드·youtube-state 동기화가
 * "업로드 안 된 회차"로 잡아 매일 가짜 경보를 낸다. buildIndex 의 `/^EP-/` 필터도
 * 어차피 걸러내므로 별도 루트를 명시로 받는 편이 정직하다.
 *
 * 디렉터리는 배치(날짜) 단위다. 슬롯 단위로 묶지 않는 이유는 max_per_source_episode
 * 가 "한 출처에서 몇 컷까지"를 재기 때문이다 — 슬롯 단위면 한 슬롯을 통째로 가져가고,
 * 날짜 단위면 여러 날에서 섞인다.
 */
export function indexLibrary(libraryRoot) {
  if (!existsSync(libraryRoot)) return [];
  const out = [];
  for (const batch of readdirSync(libraryRoot)) {
    const dir = join(libraryRoot, batch);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    out.push(...indexScriptDir(join(dir, '30_script.md'), { origin: 'library' }));
  }
  return out;
}

/** 프롬프트를 비교용 토큰으로 만든다. palette 태그는 별도 facet 이라 본문에서 뺀다. */
export function tokenize(prompt) {
  return String(prompt)
    .replace(/\[palette:\w+\]/g, ' ')
    .toLowerCase()
    .match(/[a-z]{3,}/g) || [];
}

/**
 * 코퍼스로 IDF 를 학습한 벡터라이저를 만든다.
 *
 * 코퍼스는 **후보 집합 자체**다. 외부 사전을 쓰지 않으므로 프롬프트 템플릿이 바뀌면
 * 보일러플레이트 판정도 같이 따라온다 — 손으로 고칠 곳이 없다.
 */
export function buildVectorizer(prompts) {
  const df = new Map();
  for (const p of prompts) {
    for (const w of new Set(tokenize(p))) df.set(w, (df.get(w) || 0) + 1);
  }
  const n = Math.max(prompts.length, 1);

  return function vectorize(prompt) {
    const tf = new Map();
    for (const w of tokenize(prompt)) tf.set(w, (tf.get(w) || 0) + 1);

    const vec = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const d = df.get(w);
      if (!d) continue; // 코퍼스에 없는 단어는 비교에 쓸 수 없다
      const weight = (1 + Math.log(c)) * Math.log(n / d);
      if (weight <= 0) continue; // 모든 문서에 있는 단어 = 보일러플레이트 → 가중치 0
      vec.set(w, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, v] of vec) vec.set(w, v / norm);
    return vec;
  };
}

/** 코사인 유사도. 두 벡터 모두 buildVectorizer 로 정규화된 상태를 전제한다. */
export function cosine(a, b) {
  // 짧은 쪽을 돌아야 한다 — 프롬프트 길이가 컷마다 2배까지 벌어진다.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [w, v] of small) sum += v * (large.get(w) || 0);
  return sum;
}

/**
 * 지금 화풍으로 구운 컷인지 판정한다.
 *
 * 왜 필요했나: 2026-09-22 EP-2026-0172 1차 실측에서 씬 003 이 EP-2026-0050 s001 로
 * 배정됐다. TF-IDF 점수는 0.357 로 멀쩡했는데 결과물이 쓸 수 없었다 — 그 시절 프롬프트는
 * "vertical 9:16, cartoon stick figure …, bold line art" 176자짜리 구세대 템플릿이고,
 * 렌더 결과가 평면 미니멀 화풍이다. 현행 편집일러스트 컷(씬 001, 751자) 과 한 영상에
 * 섞이면 화풍이 통째로 깨진다. 점수는 **무엇을 그렸나**만 보고 **어떻게 그렸나**를 못 본다.
 *
 * 날짜 컷오프를 쓰지 않는 이유: 화풍 전환일을 상수로 박으면 다음 전환 때 또 갈라진다.
 * 대신 현행 image_prompt 계약(image-prompt-contract.js BOUNDS.minChars)과 캐릭터 시트
 * 문구 보유를 본다 — 계약이 바뀌면 이 판정도 같이 따라온다.
 * 2026-09-22 기준 748컷 중 443컷이 통과한다(하루 5컷·쿨다운 30일 기준 충분).
 */
export function isCurrentEra(prompt) {
  const p = String(prompt);
  return p.length >= BOUNDS.minChars && /official character sheet/i.test(p);
}

/**
 * 공인 캐리커처가 들어 있는 컷인가.
 *
 * 왜 무조건 배제하나: 2026-09-22 EP-2026-0172 2차 실측에서 씬 005 가 EP-2026-0128 s001
 * 로 배정됐다. 화풍도 점수도 정상 범위였는데, 그 컷에는 실존 인물 캐리커처가 들어 있었다
 * (프롬프트: "WITH: a flat cartoon caricature of a middle-aged man with short neatly
 * combed dark hair"). EP-0172 씬 005 의 대본은 **다른 인물**(이란 대통령 유엔 연설)을
 * 말한다. 인물 A 를 말하면서 인물 B 의 얼굴을 내보내는 건 미학 문제가 아니라 오귀속이고,
 * 채널 정책(policies/public-figures-policy.md)이 인물 사용을 씬 단위로 통제하는 이유다.
 *
 * 대상 씬이 같은 인물을 요청한 경우만 허용하는 방식도 가능하지만, 인물 식별이
 * 자유서술 문장 비교가 되어 신뢰할 수 없다. 748컷 중 캐리커처 컷은 17개뿐이라
 * 통째로 빼도 후보가 줄지 않는다 — 무인 실행에서는 보수적인 쪽이 정답이다.
 */
export function hasCaricature(prompt) {
  return CARICATURE.clauseRe.test(String(prompt));
}

/**
 * 팔레트의 방향. 상승 그림이 하락 대본에 붙으면 시청자가 즉시 알아본다.
 * bullish/bearish 만 명확한 반대쌍이라 이 둘만 본다 — explainer·cta 는 중립이다.
 */
const PALETTE_DIRECTION = { bullish: 1, bearish: -1 };

/** 두 팔레트가 방향이 반대인가. 한쪽이라도 중립·미지정이면 모순이 아니다. */
export function palettesConflict(a, b) {
  const da = PALETTE_DIRECTION[a];
  const db = PALETTE_DIRECTION[b];
  return !!da && !!db && da !== db;
}

export const DEFAULT_POLICY = {
  /** 이보다 최근에 구운 자산은 후보에서 뺀다. 시청자가 알아보는 걸 막는다. */
  min_source_age_days: 10,
  /** 원장에 이 기간 안에 재사용 기록이 있는 자산은 다시 쓰지 않는다. */
  cooldown_days: 30,
  /**
   * 한 원본 에피소드에서 가져올 수 있는 최대 컷 수. 5컷을 한 EP 에서 다 가져오면
   * 옛 영상을 그대로 재방송하는 셈이 된다.
   */
  max_per_source_episode: 2,
  /**
   * 이 아래면 "시각적으로 안 맞는 컷을 썼다"고 경보한다. halt 하지는 않는다.
   *
   * 0.24 는 실측 분포에서 역산했다 — 2026-09-22 에 최근 9편(EP-0158·0160·0162·0164·
   * 0166·0168·0170·0171·0172) 45컷을 각각 대상으로 돌린 결과(세대·캐리커처·팔레트
   * 가드 전부 적용, 미배정 0): 최소 0.139 · p10 0.214 · p25 0.255 · 중앙 0.394 ·
   * 최대 0.682. 0.24 는 p10 과 p25 사이라 하위 약 18% 를 잡는다.
   *
   * 처음 감으로 넣었던 0.12 는 45컷 중 한 번도 발동하지 않는 죽은 값이었다. 하한의
   * 뜻은 "매칭이 하위권인 컷을 사람이 한 번 보게 한다" 이고, 막는 장치가 아니다.
   */
  min_score: 0.24,
  /** 같은 역할(hook/insight/…)이면 구도 의도가 맞을 확률이 높다. */
  role_bonus: 0.05,
  /** 같은 팔레트면 색 톤이 이어진다. */
  palette_bonus: 0.03,
  /**
   * 현행 화풍(image_prompt 계약 충족)으로 구운 컷만 후보로 본다.
   * 끄면 구세대 평면 화풍이 섞여 한 영상 안에서 그림체가 갈린다 — 2026-09-22 실측.
   */
  require_current_era: true,
  /** bullish 그림을 bearish 대본에 붙이지 않는다. */
  block_palette_conflict: true,
  /** 공인 캐리커처가 들어간 컷은 재사용하지 않는다 (인물 오귀속 방지). */
  block_caricature: true,
  /**
   * 1차에서 못 채운 씬을 2차 패스로 반드시 채운다.
   *
   * 끄면 예전처럼 미배정이 남고 파이프라인이 Phase 7 에서 멈춘다. 켜면 신선도 조건
   * (연령·쿨다운)만 풀어 "마시가 서서 설명하는" 범용 구도를 우선 배정한다 —
   * 안전 조건(화풍 세대·캐리커처·방향 모순)은 2차에서도 그대로다.
   */
  complete_with_generic: true,
};

/**
 * 슬롯(주제/방향) 우선 조회는 **시도했다가 기각했다** (2026-09-23).
 *
 * PRD Phase 2 는 "같은 슬롯 후보를 먼저 보면 오배정이 준다"는 가정이었다. 구현해서
 * 최근 9편 45컷으로 재면 반대였다 — 중앙값 0.394 → 0.288, 약한 매칭 7 → 21컷.
 *
 * 원인은 **슬롯이 무엇을 뜻하는지**에 있다. 슬롯은 원본 회차의 **한국어 대사**로 정해지는데,
 * 재사용에서 중요한 건 그림이 **무엇을 담았나**다. 주유기 그림이 물가 얘기를 하던 회차에서
 * 나왔으면 슬롯은 labor/* 가 되고, 정작 유가 씬에 딱 맞는데도 뒤로 밀린다. 실측(EP-2026-0172):
 *   씬 002  유가 게이지 0.302  →  해협 디오라마 0.118
 *   씬 004  주유기      0.434  →  갈래 화살표   0.099
 *
 * 더 근본적으로, TF-IDF 단독 선택 45컷 중 슬롯까지 일치한 것은 40% 뿐인데 그림은 맞았다.
 * 11버킷 라벨은 프롬프트 전문을 쓰는 TF-IDF 보다 해상도가 낮아서, 앞세우면 정보가 줄어든다.
 *
 * 슬롯은 **커버리지 측정과 백필**(Phase 1·3)에서는 그대로 쓴다. 검색에만 안 쓴다.
 */

/**
 * 씬별로 재사용할 원본을 고른다.
 *
 * 탐욕 배정이다: 점수가 가장 확실한 씬부터 자산을 확정한다. 전역 최적(헝가리안)을
 * 쓰지 않는 이유는 후보가 수백 개라 어느 씬도 굶지 않고, 한 씬이 애매해서 밀리는 쪽이
 * 확실한 씬의 매칭을 망치는 것보다 낫기 때문이다.
 *
 * @returns {{picks: Array, unmatched: Array}}
 */
export function pickReuseSet({ scenes, candidates, policy = {}, ledger = [], nowMs }) {
  const pol = { ...DEFAULT_POLICY, ...policy };
  const dayMs = 86400000;

  // 쿨다운: 원장에서 최근에 재사용된 (경로, 씬) 조합을 뺀다.
  const cooled = new Set();
  for (const rec of ledger) {
    const usedAt = Date.parse(rec.used_at || '');
    if (!Number.isFinite(usedAt)) continue;
    if (nowMs - usedAt < pol.cooldown_days * dayMs) {
      cooled.add(`${rec.source_dir}#${rec.source_scene_id}`);
    }
  }

  const pool = candidates.filter((c) => {
    /**
     * 신선도(min_source_age_days)는 **발행된 컷**에만 적용한다.
     *
     * 규칙의 근거는 "시청자가 최근 컷을 알아본다"였다. 백필 라이브러리 컷은 발행
     * 경로를 탄 적이 없어 본 사람이 없다 — 여기에 10일을 걸면 빈 슬롯을 채우려고
     * 구운 컷이 정확히 그 슬롯이 필요한 날에 후보에서 빠진다. 백필의 목적을 스스로
     * 무효화하는 조건이라 출처로 가른다. 쓴 뒤의 쿨다운은 그대로 적용된다 — 한 번
     * 발행에 실리면 그때부터는 본 사람이 생긴다.
     */
    if (c.origin !== 'library' && nowMs - c.mtimeMs < pol.min_source_age_days * dayMs) return false;
    if (cooled.has(`${c.sceneDir}#${c.sceneId}`)) return false;
    if (pol.require_current_era && !isCurrentEra(c.prompt)) return false;
    if (pol.block_caricature && hasCaricature(c.prompt)) return false;
    return true;
  });

  const vectorize = buildVectorizer([...pool.map((c) => c.prompt), ...scenes.map((s) => s.prompt)]);
  const poolVecs = pool.map((c) => ({ cand: c, vec: vectorize(c.prompt) }));

  // 씬 × 후보 점수를 한 번에 계산해 놓고, 확실한 쪽부터 확정한다.
  const graded = scenes.map((scene) => {
    const qv = vectorize(scene.prompt);
    const ranked = poolVecs
      .filter(({ cand }) => !(pol.block_palette_conflict && palettesConflict(scene.palette, cand.palette)))
      .map(({ cand, vec }) => {
        let score = cosine(qv, vec);
        if (scene.role && cand.role && scene.role === cand.role) score += pol.role_bonus;
        if (scene.palette && cand.palette && scene.palette === cand.palette) score += pol.palette_bonus;
        return { cand, score };
      })
      .sort((a, b) => b.score - a.score);
    return { scene, ranked };
  });

  const picks = [];
  const unmatched = [];
  const takenAsset = new Set();   // 같은 파일을 두 씬에 박지 않는다 (중복 바이트 게이트)
  const perEpisode = new Map();   // 한 원본 EP 에서 가져온 컷 수

  // 1순위 후보와 2순위의 격차가 큰 씬 = 대안이 없는 씬. 그 씬을 먼저 확정한다.
  graded.sort((a, b) => {
    const gapA = (a.ranked[0]?.score ?? 0) - (a.ranked[1]?.score ?? 0);
    const gapB = (b.ranked[0]?.score ?? 0) - (b.ranked[1]?.score ?? 0);
    return gapB - gapA;
  });

  for (const { scene, ranked } of graded) {
    const hit = ranked.find(({ cand }) => {
      if (takenAsset.has(cand.image)) return false;
      const used = perEpisode.get(cand.episodeId) || 0;
      return used < pol.max_per_source_episode;
    });

    if (!hit) {
      unmatched.push(scene.sceneId);
      continue;
    }
    takenAsset.add(hit.cand.image);
    perEpisode.set(hit.cand.episodeId, (perEpisode.get(hit.cand.episodeId) || 0) + 1);
    picks.push({
      sceneId: scene.sceneId,
      source: hit.cand,
      score: Number(hit.score.toFixed(4)),
      weak: hit.score < pol.min_score,
    });
  }

  // ── 2차 패스 — 회차를 완주시킨다 ────────────────────────────────
  //
  // 1차가 비는 이유는 대개 신선도 조건이다(min_source_age_days·cooldown 으로 후보가
  // 말랐거나, 한 원본 EP 상한에 걸렸거나). 거기서 멈추면 파이프라인이 Phase 7 에서
  // 서고 회차가 통째로 날아간다. 그럴 바에는 주제가 덜 맞아도 내보내는 편이 낫다.
  //
  // **푸는 것은 신선도뿐이다.** 화풍 세대·캐리커처·방향 모순은 2차에서도 막는다 —
  // 그 셋은 "덜 맞는" 문제가 아니라 "틀린" 문제라서 완주보다 우선한다.
  if (pol.complete_with_generic && unmatched.length) {
    const relaxed = candidates.filter((c) => {
      if (pol.require_current_era && !isCurrentEra(c.prompt)) return false;
      if (pol.block_caricature && hasCaricature(c.prompt)) return false;
      return !takenAsset.has(c.image);
    });
    const vec2 = buildVectorizer([...relaxed.map((c) => c.prompt), ...scenes.map((s) => s.prompt)]);

    for (const sceneId of [...unmatched]) {
      const scene = scenes.find((s) => s.sceneId === sceneId);
      if (!scene) continue;
      const qv = vec2(scene.prompt);
      const ranked = relaxed
        .filter((c) => !takenAsset.has(c.image))
        .filter((c) => !(pol.block_palette_conflict && palettesConflict(scene.palette, c.palette)))
        .map((cand) => ({
          cand,
          score: cosine(qv, vec2(cand.prompt)),
          // "마시가 서서 설명하는" 범용 구도를 앞세운다. 주제가 안 맞아도 어색하지 않다.
          generic: isGenericObject(cand.prompt),
        }))
        .sort((a, b) => (b.generic - a.generic) || (b.score - a.score));

      const hit = ranked[0];
      if (!hit) continue;
      takenAsset.add(hit.cand.image);
      picks.push({
        sceneId,
        source: hit.cand,
        score: Number(hit.score.toFixed(4)),
        weak: true,                 // 2차 배정은 항상 사람이 한 번 본다
        filled_generic: true,
        generic_object: hit.generic,
      });
      unmatched.splice(unmatched.indexOf(sceneId), 1);
    }
  }

  picks.sort((a, b) => a.sceneId.localeCompare(b.sceneId));
  return { picks, unmatched: unmatched.sort() };
}
