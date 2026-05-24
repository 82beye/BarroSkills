/**
 * Intro Image v10 — ALL-IN-ONE + verify retry loop (2026-05-16)
 *
 * Flow:
 *   1. enrichPrompt (GPT-4o cinematic)
 *   2. generateImageOpenAI (GPT-Image-1 high)
 *   3. verifyImageText (GPT-4o-mini vision OCR)
 *   4. if inaccurate → retry up to maxRetries (default 2)
 *
 * Cost: success on attempt 1 ≈ $0.17 · 평균 1.5회 ≈ $0.26
 */
import { enrichPrompt } from '../prompt-enrich.js';
import { generateImageOpenAI } from './openai-gpt-image.js';
import { verifyImageText } from './openai-vision-verify.js';

export async function generateIntroV10({
  topic,
  visualHint = '',
  headline,
  keyword = '',
  outPath,
  maxRetries = 2,
  mood = 'tense breaking-news alert',
}) {
  if (!headline) throw new Error('generateIntroV10: headline required');

  const expectedTextSet = [{ field: 'headline', expected: headline }];
  if (keyword) expectedTextSet.push({ field: 'led_number', expected: keyword });

  let totalCost = 0;
  let lastVerdict = null;
  let lastEnrichLen = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    console.log(`   v10 attempt ${attempt}/${maxRetries + 1}: enrich → generate → verify`);

    const enriched = await enrichPrompt({ topic, visualHint, headline, keyword, mood, useMascot: false });
    totalCost += enriched.cost_usd;
    lastEnrichLen = enriched.prompt.length;

    await generateImageOpenAI({ prompt: enriched.prompt, outPath, size: '1024x1536', quality: 'high', costContext: { stage: 'S6d', engine: 'v10' } });
    totalCost += 0.17;

    const verdict = await verifyImageText({ imagePath: outPath, expectedTextSet });
    totalCost += verdict.cost_usd;
    lastVerdict = verdict;

    console.log(`     verdict: ${verdict.accurate ? '✅ accurate' : '❌ inaccurate'}`);
    for (const f of verdict.perField) {
      if (!f.matches) console.log(`       - ${f.field}: expected="${f.expected}" got="${f.detected}"`);
    }

    if (verdict.accurate) break;
    if (attempt > maxRetries) {
      console.log(`     max retries reached, using last attempt (may have minor errors)`);
    }
  }

  return { outPath, accurate: lastVerdict?.accurate || false, attempts: lastVerdict ? Math.min(maxRetries + 1, expectedTextSet.length) : 0, cost_usd: totalCost, enrich_prompt_chars: lastEnrichLen, verdict: lastVerdict };
}

/**
 * Intro headline 자동 추출/단순화
 * 우선순위: brief.thumbnail.intro_headline_text > headline_text > topic 압축
 * 9자 이하 권장 (GPT-Image-1 한글 정확도 ↑)
 */
export function resolveIntroHeadline({ briefThumb = {}, topic = '' }) {
  if (briefThumb.intro_headline_text) return briefThumb.intro_headline_text;

  // topic 압축: "美 10년물 4.5% 돌파 — ..." → "10년물 4.5% 돌파"
  const stripped = String(topic).replace(/^[美中日韓]\s*/, '').split(/[—–\-:|]/)[0].trim();
  // 패턴: <X년물> <Y%> <돌파/급등/급락/상승/하락>
  const m1 = stripped.match(/([\d]+년물)\s*([\d.]+%)\s*(돌파|급등|급락|상승|하락|폭락|반등)/);
  if (m1) return `${m1[1]} ${m1[2]} ${m1[3]}`;
  // 패턴: <X%> <돌파/...>
  const m2 = stripped.match(/([\d.]+%)\s*(돌파|급등|급락|상승|하락|폭락|반등)/);
  if (m2) return `${m2[1]} ${m2[2]}`;
  // fallback: thumbnail.headline_text 또는 stripped 첫 9자
  if (briefThumb.headline_text) return briefThumb.headline_text;
  return stripped.slice(0, 9);
}
