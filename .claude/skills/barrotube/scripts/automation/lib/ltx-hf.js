/**
 * ltx-hf.js — HuggingFace Space 의 LTX-2.3 I2V 엔진 클라이언트 (Node 전용)
 *
 * wan-hf.js 와 같은 방식으로 gradio REST(`/gradio_api/upload` → `/call/<api>` → SSE)를 직접 친다.
 * python gradio_client 를 크론에 매달지 않기 위해서다.
 *
 * ── 왜 Wan 대신 LTX 인가 (2026-09-02 실측) ──
 *
 *   Wan 2.2   480×832 · 16fps · 최대 5초 · 무음 · 생성 4회 중 3회 얼굴 붕괴
 *   LTX-2.3  1024×1536 · 24fps · 최대 10초 · AAC 포함 · 193프레임 전수 무결함(첫 시도)
 *
 * 픽셀 3.8배, fps 1.5배, 길이 2배인데 **우리 유일한 실패 모드였던 얼굴 붕괴가 안 난다.**
 * 클립당 GPU 는 더 쓰지만(150초 요청 vs 53.6초), Wan 은 평균 1.5회 재생성이 필요해서
 * 영상 1초당으로 환산하면 LTX 8.7 GPU초 vs Wan 11.1 GPU초로 **LTX 가 오히려 싸다.**
 *
 * 길이가 특히 중요하다. 씬은 6.6~11.5초인데 Wan 4초 클립은 렌더에서 1.63~2.83배 늘어나
 * 슬로모션이 된다. LTX 8초면 0.82~1.43배라 거의 정속이다.
 *
 * 인증: HF_TOKEN 이 있으면 PRO 쿼터(2,400 GPU초/일)로, 없으면 익명(120초/일)로 돈다.
 * 익명으로는 클립 하나도 못 굽는다 — 150초를 요청하기 때문이다.
 */

import { getSecret } from '../config-loader.js';

const SPACE = process.env.BT_LTX_SPACE || 'lightricks-ltx-2-3';
const BASE = `https://${SPACE}.hf.space`;

/**
 * HF 토큰. 크론은 로그인 셸을 안 거쳐 process.env 가 비어 있으므로 .env 를 읽는
 * getSecret 을 경유한다 — 다른 자격증명과 같은 경로다.
 * 토큰이 있으면 PRO 쿼터(2,400 GPU초/일), 없으면 익명(120초/일)으로 떨어진다.
 */
const hfToken = () => getSecret('HF_TOKEN');
const API = '/generate_video';

/** 9:16 세로 프리셋. Space 의 RESOLUTIONS["high"]["9:16"] 과 같은 값이다. */
export const PORTRAIT = { width: 1024, height: 1536 };
/** Space 슬라이더 상한. 이보다 길게 요청하면 잘린다. */
export const MAX_DURATION = 10;
export const FPS = 24;

/**
 * 기본 모션 지시.
 *
 * 카메라를 명시적으로 묶는다. "gentle slow push-in" 만 줬더니 8초 내내 밀고 들어가
 * 마지막엔 눈 하나가 화면을 채웠다(2026-09-02 실측) — LTX 는 카메라 지시를 매우
 * 문자 그대로 받는다. 얼굴은 Wan 과 달리 안 깨지므로 얼굴 보존 문구는 짧게만 둔다.
 */
export const DEFAULT_PROMPT = [
  'locked-off static camera, no zoom, no push-in, no camera movement.',
  'the full character stays in frame at the same size for the entire shot.',
  'flat 2D cartoon vector illustration, clean line art.',
  'only small ambient motion: background elements drift slowly, subtle idle gesture.',
].join(' ');

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (hfToken()) h.Authorization = `Bearer ${hfToken()}`;
  return h;
}

/** 로컬 이미지를 Space 에 올리고 gradio FileData 로 돌려준다. */
export async function uploadImage(buffer, name = 'scene.png', fetchImpl = fetch) {
  const fd = new FormData();
  fd.append('files', new Blob([buffer], { type: 'image/png' }), name);
  const res = await fetchImpl(`${BASE}/gradio_api/upload`, { method: 'POST', body: fd, headers: authHeaders() });
  if (!res.ok) throw new Error(`업로드 실패 ${res.status}`);
  const paths = await res.json();
  if (!Array.isArray(paths) || !paths[0]) throw new Error('업로드 응답에 경로가 없습니다');
  return { path: paths[0], meta: { _type: 'gradio.FileData' } };
}

/**
 * SSE 스트림에서 완료 페이로드를 뽑는다.
 * ZeroGPU 쿼터 초과는 `event: error` 로 오는데, 본문에 남은 초와 재시도 시각이 들어 있다 —
 * Wan Space 는 본문 없이 null 만 보내 원인을 못 찾았지만 여기는 그대로 흘려도 읽힌다.
 */
export function parseSSE(text) {
  const lines = String(text).split('\n');
  let event = null;
  for (const line of lines) {
    if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (event === 'error') {
      if (payload === 'null' || payload === '') {
        throw new Error(hfToken()
          ? 'ZeroGPU 일일 쿼터 소진 (토큰 인증됨). 리셋은 그날 첫 사용 시점 +24h 다 — '
            + '검증 실행이 창을 잠식하면 그날 프로덕션이 폴백으로 떨어진다.'
          : 'ZeroGPU 쿼터 소진 (익명). HF_TOKEN 을 설정하면 쿼터가 올라간다 (PRO 2,400 GPU초/일).');
      }
      throw new Error(`Space 오류: ${payload.slice(0, 300)}`);
    }
    if (event === 'complete') {
      try { return JSON.parse(payload); } catch { throw new Error('완료 페이로드 파싱 실패'); }
    }
  }
  return null;
}

/**
 * 클립 1개 생성. 반환 { url, seed }.
 *
 * duration 은 초 단위(1~10). 씬 길이에 맞춰 넘기면 렌더 리타임이 1.0 에 가까워진다 —
 * 호출부가 TTS 길이를 알고 있으므로 그 값을 그대로 주는 것이 이 엔진을 쓰는 핵심 이유다.
 */
export async function generateClip({
  imageBuffer, prompt = DEFAULT_PROMPT, seed = 42, duration = 8,
  width = PORTRAIT.width, height = PORTRAIT.height,
  enhancePrompt = false, timeoutMs = 900_000, fetchImpl = fetch,
} = {}) {
  const dur = clampDuration(duration);
  const file = await uploadImage(imageBuffer, 'scene.png', fetchImpl);
  const body = JSON.stringify({
    // 순서는 Space 의 /generate_video 시그니처 그대로다:
    // input_image, prompt, duration, enhance_prompt, seed, randomize_seed, height, width
    data: [file, prompt, dur, enhancePrompt, seed, false, height, width],
  });
  const start = await fetchImpl(`${BASE}/gradio_api/call${API}`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body,
  });
  if (!start.ok) throw new Error(`생성 요청 실패 ${start.status}: ${(await start.text()).slice(0, 300)}`);
  const { event_id: eventId } = await start.json();
  if (!eventId) throw new Error('event_id 를 받지 못했습니다');

  const res = await fetchImpl(`${BASE}/gradio_api/call${API}/${eventId}`, {
    headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`결과 스트림 실패 ${res.status}`);
  const out = parseSSE(await res.text());
  if (!out) throw new Error('완료 이벤트를 받지 못했습니다 (Space 중단 가능)');

  const [video, usedSeed] = out;
  const url = video?.video?.url || video?.url || video?.video?.path;
  if (!url) throw new Error('응답에 영상 URL 이 없습니다');
  return { url: url.startsWith('http') ? url : `${BASE}/gradio_api/file=${url}`, seed: usedSeed ?? seed };
}

/** Space 슬라이더 범위(1~10초)로 자른다. 씬이 더 길면 렌더가 늘려서 맞춘다. */
export function clampDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 8;
  return Math.min(MAX_DURATION, Math.max(1, Math.round(n * 10) / 10));
}

/** 생성 결과 URL 을 내려받아 Buffer 로. */
export async function downloadClip(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`다운로드 실패 ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 결함 힌트를 프롬프트에 덧대되 상한을 지킨다 — 너무 길면 모델이 앞부분을 흘린다. */
export function withRepairHint(prompt, hint, maxChars = 700) {
  if (!hint) return prompt;
  const merged = `${prompt} ${hint}`;
  return merged.length <= maxChars ? merged : merged.slice(0, maxChars);
}
