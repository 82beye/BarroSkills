/**
 * Korean text verification using GPT-4o-mini vision (2026-05-16)
 * GPT-Image-1 결과의 한글 정확도를 검증해 자동 retry loop를 지원.
 *
 * Input:  imagePath (PNG/JPG), expectedTextSet (배열 of {field, expected})
 * Output: { accurate, perField: [{field, expected, detected, matches}], cost_usd }
 */
import { readFileSync } from 'fs';

const VERIFY_MODEL = 'gpt-4o-mini';

export async function verifyImageText({ imagePath, expectedTextSet }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY env var not set');

  const imgBuf = readFileSync(imagePath);
  const b64 = imgBuf.toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;

  const expectedDesc = expectedTextSet.map((e, i) => `  ${i + 1}. ${e.field}: "${e.expected}"`).join('\n');

  const userPrompt = `Look at the Korean text rendered in this image. I will give you a list of expected text values that SHOULD appear exactly in the image. For each, report whether it appears EXACTLY (every Hangul syllable preserved, no missing/extra characters, no spacing inside words).

Expected text:
${expectedDesc}

Reply with JSON only, no markdown:
{
  "per_field": [
    { "field": "<field name>", "expected": "<expected text>", "detected": "<what you actually see>", "matches": true/false, "reason": "<short>" }
  ],
  "all_match": true/false
}`;

  const body = JSON.stringify({
    model: VERIFY_MODEL,
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    response_format: { type: 'json_object' }
  });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vision API HTTP ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { per_field: [], all_match: false, parse_error: text };
  }

  const inTok = data?.usage?.prompt_tokens || 0;
  const outTok = data?.usage?.completion_tokens || 0;
  // gpt-4o-mini: $0.15/Mtok in, $0.60/Mtok out
  const cost_usd = (inTok * 0.15 + outTok * 0.60) / 1_000_000;

  return {
    accurate: !!parsed.all_match,
    perField: parsed.per_field || [],
    cost_usd,
    raw: text
  };
}
