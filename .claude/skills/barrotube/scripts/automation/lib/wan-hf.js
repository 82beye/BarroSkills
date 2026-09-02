/**
 * wan-hf.js — HuggingFace Space 의 Wan 2.2 I2V 엔진 클라이언트 (Node 전용)
 *
 * gradio 의 REST API(`/gradio_api/upload` → `/call/<api>` → SSE)를 직접 친다.
 * python gradio_client 를 쓰면 launchd 크론에 venv 를 하나 더 매달아야 하는데,
 * 이 저장소는 이미 node 경로 해석만으로도 크론이 조용히 깨진 전력이 있다 — 의존을 안 늘린다.
 *
 * 무과금: 익명 ZeroGPU 쿼터. 토큰이 있으면 HF_TOKEN 으로 상향되지만 필수가 아니다.
 *
 * 스펙(2026-09-02 실측): 출력 480×832 · 16fps · 최대 5s. 720p·24fps 는 모델(TI2V-5B)
 * 스펙이지 이 무료 Space 스펙이 아니다 — 720p/24fps 가 필요하면 후처리로 올린다.
 */

import { getSecret } from '../config-loader.js';

const SPACE = process.env.BT_WAN_SPACE || 'zerogpu-aoti-wan2-2-fp8da-aoti-faster';
const BASE = `https://${SPACE}.hf.space`;

/**
 * HF 토큰. 크론은 로그인 셸을 안 거쳐 process.env 가 비어 있으므로 .env 를 읽는
 * getSecret 을 경유한다 — 다른 자격증명과 같은 경로다.
 * 토큰이 있으면 PRO 쿼터(2,400 GPU초/일), 없으면 익명(120초/일)으로 떨어진다.
 */
const hfToken = () => getSecret('HF_TOKEN');
const API = '/generate_video';

/**
 * Space 슬라이더 상한. 80프레임 ÷ 16fps = 5.0초다.
 * 씬은 6.6~11.5초라 항상 이보다 짧으므로 렌더가 늘려서 맞춘다 — 그래서 **최대치를 쓰는
 * 것이 기본**이다. 4초로 구우면 1.63~2.83배 슬로모션이 되고, 5초면 1.31~2.27배로 준다.
 */
export const MAX_DURATION = 5;
/**
 * 기본 4초. 상한 5초가 렌더 슬로모션은 덜하지만 얼굴 결함이 크게 는다 —
 * 4초는 재시도 2회에 결함 0, 5초는 3회를 태워도 3~5개가 남았다 (2026-09-02 실측).
 */
export const DEFAULT_DURATION = 4;
export const FPS = 16;

/** Space 범위(0.5~5초)로 자른다. */
export function clampDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return MAX_DURATION;
  return Math.min(MAX_DURATION, Math.max(0.5, Math.round(n * 10) / 10));
}

export const DEFAULT_NEGATIVE = [
  '色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 整体发灰, 最差质量, 低质量,',
  'JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的,',
  '形态畸形的肢体, 手指融合, 杂乱的背景, 三条腿, 背景人很多, 倒着走,',
  'deformed eyes, blocky eyes, missing eye, distorted facial features, warped mouth,',
  'teeth artifacts, flickering face, smeared face, inconsistent character',
].join(' ');

/** 씬 스틸에 붙일 기본 모션 지시. 얼굴을 건드리지 말라고 명시하되, 그게 지켜진다고 믿지 않는다. */
export const DEFAULT_PROMPT = [
  'subtle cinematic motion in flat 2D cartoon style:',
  'the character keeps its face clean and well drawn with two smooth oval eyes and one simple mouth,',
  'background elements drift slowly, gentle slow camera push-in,',
  'smooth animation, keep the flat vector illustration look',
].join(' ');

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const t = hfToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** 로컬 이미지를 Space 에 올리고 gradio FileData 로 돌려준다. */
export async function uploadImage(buffer, name = 'input.png', fetchImpl = fetch) {
  const fd = new FormData();
  fd.append('files', new Blob([buffer], { type: 'image/png' }), name);
  const auth = hfToken() ? { Authorization: `Bearer ${hfToken()}` } : {};
  const res = await fetchImpl(`${BASE}/gradio_api/upload`, { method: 'POST', body: fd, headers: auth });
  if (!res.ok) throw new Error(`업로드 실패 ${res.status}`);
  const paths = await res.json();
  if (!Array.isArray(paths) || !paths[0]) throw new Error('업로드 응답에 경로가 없습니다');
  return { path: paths[0], meta: { _type: 'gradio.FileData' } };
}

/**
 * SSE 스트림에서 완료 페이로드를 뽑는다.
 * gradio 는 `event: complete` 뒤 `data: [...]` 한 줄을 보낸다. `event: error` 면 던진다.
 */
export function parseSSE(text) {
  const lines = text.split('\n');
  let event = null;
  for (const line of lines) {
    if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (event === 'error') {
      // ZeroGPU 는 쿼터가 마르면 본문 없이 `event: error / data: null` 만 보낸다.
      // 그대로 흘리면 "Space 오류: null" 이 돼서 원인을 못 찾는다 (2026-09-02 실측).
      if (payload === 'null' || payload === '') {
        throw new Error('ZeroGPU 쿼터 소진 또는 Space 거부 (본문 없음). '
          + 'HF_TOKEN 을 설정하면 쿼터가 올라간다 — 무료 계정 토큰으로 충분하다.');
      }
      throw new Error(`Space 오류: ${payload.slice(0, 200)}`);
    }
    if (event === 'complete') {
      try { return JSON.parse(payload); } catch { throw new Error('완료 페이로드 파싱 실패'); }
    }
  }
  return null;
}

/**
 * 클립 1개 생성. 반환 { url, seed }.
 * duration 은 Space 제약상 0.5~5.0s, steps 는 4~8 (Lightning 증류).
 */
export async function generateClip({
  imageBuffer, prompt = DEFAULT_PROMPT, negative = DEFAULT_NEGATIVE,
  seed = 42, duration = 4, steps = 6, timeoutMs = 600_000, fetchImpl = fetch,
} = {}) {
  const file = await uploadImage(imageBuffer, 'scene.png', fetchImpl);
  const body = JSON.stringify({
    data: [file, prompt, steps, negative, duration, 1, 1, seed, false],
  });
  const start = await fetchImpl(`${BASE}/gradio_api/call${API}`, { method: 'POST', headers: headers(), body });
  if (!start.ok) throw new Error(`생성 요청 실패 ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const { event_id: eventId } = await start.json();
  if (!eventId) throw new Error('event_id 를 받지 못했습니다');

  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(`${BASE}/gradio_api/call${API}/${eventId}`, { signal: ctl });
  if (!res.ok) throw new Error(`결과 스트림 실패 ${res.status}`);
  const out = parseSSE(await res.text());
  if (!out) throw new Error('완료 이벤트를 받지 못했습니다 (쿼터 소진이거나 Space 중단)');

  const [video, usedSeed] = out;
  const url = video?.video?.url || video?.url || video?.video?.path;
  if (!url) throw new Error('응답에 영상 URL 이 없습니다');
  return { url: url.startsWith('http') ? url : `${BASE}/gradio_api/file=${url}`, seed: usedSeed ?? seed };
}

/** 생성 결과 URL 을 내려받아 Buffer 로. */
export async function downloadClip(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`다운로드 실패 ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 결함 힌트를 프롬프트에 덧대되 상한을 지킨다 — 너무 길면 모델이 앞부분을 흘린다. */
export function withRepairHint(prompt, hint, maxChars = 620) {
  if (!hint) return prompt;
  const merged = `${prompt}. ${hint}`;
  return merged.length <= maxChars ? merged : merged.slice(0, maxChars);
}
