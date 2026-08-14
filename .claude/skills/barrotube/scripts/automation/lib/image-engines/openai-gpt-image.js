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

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const API_URL = 'https://api.openai.com/v1/images/generations';
const EDITS_URL = 'https://api.openai.com/v1/images/edits';
const DEFAULT_MODEL = 'gpt-image-1';

/**
 * 채널 캐릭터시트 경로. generate-image-gemini.js 의 sheetPart 와 같은 규칙이다.
 */
export function sheetPath(channel) {
  if (!channel) return null;
  const p = resolve('workspace', 'docs', `${channel === 'econ-daily' ? '바로경제' : channel}_캐릭터시트.png`);
  return existsSync(p) ? p : null;
}

export async function generateImageOpenAI({
  prompt,
  outPath,
  size = '1024x1536',
  quality = 'high',
  model = DEFAULT_MODEL,
  channel = null,
  costContext = {}
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY env var not set. Use macOS Keychain or transient export. Do NOT commit plaintext .env.');
  }

  // 시트가 있으면 generations 대신 edits 로 보낸다 — 텍스트만으로는 비율이 안 잡힌다.
  // 2026-08-14 실측: 시트를 붙이면 몸통/머리 0.64 (발행본 밴드 0.57~0.68), 안 붙이면
  // 0.85~1.0 으로 뚱뚱해진다. 프롬프트를 아무리 고쳐도 안 잡히던 값이다.
  const sheet = sheetPath(channel);
  let res;
  if (sheet) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', `Use the attached official character sheet as the exact reference for the mascot — `
      + `identical body proportions, limb thickness, face, eyes, cheeks and colours. `
      + `Do not re-invent the character.\n\n${prompt}`);
    form.append('size', size);
    form.append('quality', quality);
    form.append('n', '1');
    form.append('image[]', new Blob([readFileSync(sheet)], { type: 'image/png' }), 'character-sheet.png');
    res = await fetch(EDITS_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  } else {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, prompt, size, quality, n: 1 })
    });
  }

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
      sheet_attached: !!sheet,
      bytes: buf.length
    });
  } catch {
    // cost-tracker import 실패 시 silent (선택적)
  }

  return { path: outPath, bytes: buf.length, model, engine: 'openai-gpt-image-1', sheetAttached: !!sheet };
}
