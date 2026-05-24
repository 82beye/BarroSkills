/**
 * OpenAI GPT-Image-1 어댑터 (2026-05-16)
 *
 * 인트로 카드용 — 인포그래픽·텍스트·콜라주 표현이 Gemini 3.1보다 우월.
 * 씬·썸네일은 기존 Gemini 유지 (비용·일관성).
 *
 * Endpoint: POST https://api.openai.com/v1/images/generations
 * Model:    gpt-image-1
 * Sizes:    1024x1024 | 1024x1536 (portrait, 인트로용) | 1536x1024
 * Quality:  low | medium | high | auto
 * Cost:     high quality 1024x1536 ≈ $0.17/장
 *
 * 환경변수: OPENAI_API_KEY (필수. keychain 사용 권장 — 평문 .env 금지)
 *
 * 사용:
 *   import { generateImageOpenAI } from './lib/image-engines/openai-gpt-image.js';
 *   await generateImageOpenAI({
 *     prompt: '...',
 *     outPath: 'path.png',
 *     size: '1024x1536',
 *     quality: 'high'
 *   });
 */

import { writeFileSync } from 'fs';

const API_URL = 'https://api.openai.com/v1/images/generations';
const DEFAULT_MODEL = 'gpt-image-1';

export async function generateImageOpenAI({
  prompt,
  outPath,
  size = '1024x1536',
  quality = 'high',
  model = DEFAULT_MODEL,
  costContext = {}
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY env var not set. Use macOS Keychain or transient export. Do NOT commit plaintext .env.');
  }

  const body = JSON.stringify({ model, prompt, size, quality, n: 1 });

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Image API HTTP ${res.status}: ${errText.slice(0, 800)}`);
  }

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(`No b64_json in OpenAI Image API response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const buf = Buffer.from(b64, 'base64');
  writeFileSync(outPath, buf);

  // 비용 기록 (cost-tracker 사용 가능하면)
  try {
    const { recordCost } = await import('../cost-tracker.js');
    const COST_PER_IMAGE = { low: 0.011, medium: 0.042, high: 0.167, auto: 0.042 };
    const cost = COST_PER_IMAGE[quality] || 0.042;
    recordCost('08-image-generator', cost, {
      ...costContext,
      engine: 'openai-gpt-image-1',
      model,
      size,
      quality,
      bytes: buf.length
    });
  } catch {
    // cost-tracker import 실패 시 silent (선택적)
  }

  return { path: outPath, bytes: buf.length, model, engine: 'openai-gpt-image-1' };
}
