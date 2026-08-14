#!/usr/bin/env node

/**
 * generate-tts.js — TTS 생성 (로컬 Qwen3-TTS → ElevenLabs 체인)
 *
 * Usage:
 *   node generate-tts.js --text "나레이션 텍스트" --out path/scene_001.wav
 *   node generate-tts.js --script <episode_dir>/30_script.md --out-dir <assets>/tts/
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';
import { recordCost } from './lib/cost-tracker.js';

const API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE_ID = '4JJwo477JUAx3HV0T7n7'; // Yohan Koo — Encouraging, Clear and Airy
const DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * Qwen3-TTS(로컬 MLX) 파일럿 — 2026-08-14.
 *
 * ElevenLabs 는 문자당 과금이고 이쪽은 로컬이라 $0 다. 다만 그냥 꽂으면 Shorts 60초
 * 규격을 못 맞춘다. EP-2026-0091 씬1(72자)로 실측한 값:
 *   원본 14.2초(5.1자/초) → instruct 지정 11.6초 → 문장 사이 무음 압축 8.9초(8.1자/초)
 * ElevenLabs 가 7.9자/초라 무음만 정리하면 같은 자리에 들어온다. 느린 게 아니라
 * 문장 사이를 길게 쉬는 것이었다 — 그래서 배속(atempo)보다 무음 압축을 먼저 쓴다.
 */
const QWEN_DIR = process.env.BT_QWEN_TTS_DIR || join(homedir(), 'qwen3-tts');
const QWEN_SPEAKER = process.env.BT_QWEN_SPEAKER || 'clone';

/**
 * auto 모드의 시도 순서. 로컬($0)을 먼저 쓰고 유료 API 를 뒤에 둔다.
 *
 * 로컬 모델은 확률적으로 폭주하고(실측: 123자를 63.8초), 그건 재생성으로도 못 뚫을 수
 * 있다. 무인 cron 에서 그 한 씬 때문에 하루치 에피소드를 못 내보내는 것보다,
 * 그 씬만 유료로 넘기고 경고를 남기는 편이 낫다. generate-script.js 의 엔진 체인과 같은 규약.
 */
export function resolveTtsChain(spec = process.env.BT_TTS_ENGINE_CHAIN) {
  const fallback = 'qwen,elevenlabs';
  return String(spec || fallback).split(',').map((e) => e.trim()).filter(Boolean);
}
const QWEN_MAX_PAUSE = 0.25;   // 문장 사이에 남길 무음(초)
const QWEN_MAX_TEMPO = 1.35;   // 이보다 빠르게 밀면 알아듣기 어려워진다
const QWEN_MIN_RATE = 2.5;     // 이보다 느리면 정상 발화가 아니라 반복 루프다 (자/초)
const QWEN_MAX_ATTEMPTS = 3;   // 폭주 시 재생성 횟수

/**
 * 끝음 잘림 대책.
 *
 * 이 모델은 마지막 음절의 여운(릴리스)을 만들지 않고 발화가 살아 있는 상태에서 파일을 끝낸다.
 * 실측(2026-08-14): 마지막 유성 프레임 10.46초 → 파일 끝 10.48초, 마지막 50ms 피크 -23dBFS.
 * ElevenLabs 는 같은 지점이 -73dBFS 로, 0.4초에 걸쳐 -85dBFS 까지 감쇠한다.
 *
 * 뒤에 짧은 어구를 붙여 생성하면 본문이 정상 종료되고 그 뒤에 공백이 생긴다. 그 공백에서
 * 잘라내면 본문의 여운이 살아 있는 상태로 끝난다 — 실측 결과 -73.4dBFS 로 ElevenLabs 와 같아졌다.
 * clone·custom 양쪽 모두 같은 증상이라 두 경로에 모두 적용한다.
 */
const QWEN_TAIL_FILLER = ' 네.';
const QWEN_TAIL_KEEP = 0.15;   // 공백에서 남길 여운(초) 상한
const QWEN_TAIL_FADE = 0.06;   // 컷 지점 직전 페이드로 클릭음 방지

/** ffmpeg silencedetect 로 무음 구간 [start, end] 목록을 얻는다. */
function detectSilences(path, thresholdDb = -50, minDuration = 0.10) {
  const r = spawnSync('ffmpeg', ['-i', path, '-af',
    `silencedetect=n=${thresholdDb}dB:d=${minDuration}`, '-f', 'null', '-'],
  { encoding: 'utf-8' });
  const log = r.stderr || '';
  const out = [];
  let start = null;
  for (const line of log.split('\n')) {
    const s = /silence_start:\s*([0-9.]+)/.exec(line);
    if (s) { start = Number(s[1]); continue; }
    const e = /silence_end:\s*([0-9.]+)/.exec(line);
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return out;
}

/**
 * 필러 앞 공백에서 자를 지점을 찾는다.
 * 못 찾으면 null — 그때는 자르지 않고 원본을 그대로 쓴다(내용을 잃는 것보다 낫다).
 */
function findTailCut(rawPath, duration) {
  // 마지막 공백부터 역순으로 훑는다. 필러 직전 공백이 항상 마지막이라는 보장이 없다 —
  // 필러 뒤에 또 공백이 생기면 마지막 공백은 필러 "뒤"가 되고, 그 기준으로 자르면
  // 필러가 그대로 남는다(2026-08-14 EP-0092 씬2·4 실측: 대본에 없는 "네" 가 들렸다).
  const silences = detectSilences(rawPath);
  for (let i = silences.length - 1; i >= 0; i--) {
    const s = silences[i];
    const tailAfter = duration - s.end;       // 이 공백 뒤에 남은 소리 = 필러여야 한다
    if (s.start < duration * 0.5) break;      // 앞쪽 절반은 본문이다
    if (tailAfter > 0.05 && tailAfter <= 0.8) {
      return s.start + Math.min(QWEN_TAIL_KEEP, (s.end - s.start) * 0.85);
    }
  }
  return null;
}

/**
 * 채널 고정 화자를 zero-shot 복제로 쓰는 경로.
 *
 * 학습이 아니라 참조 음성 한 개를 그때그때 조건으로 넣는 방식이라, 채널 디렉토리에
 * ref.wav + ref.txt 만 두면 된다. 둘의 내용이 어긋나면 복제 품질이 떨어지므로
 * 대사 텍스트를 파일로 함께 보관한다.
 */
export function loadCloneRef(channelId) {
  if (!channelId) return null;
  const ROOT = resolve(import.meta.dirname, '../..');
  const dir = join(ROOT, 'workspace', 'channels', channelId, 'voice-ref');
  const audio = join(dir, 'ref.wav');
  const textPath = join(dir, 'ref.txt');
  if (!existsSync(audio) || !existsSync(textPath)) return null;
  const text = readFileSync(textPath, 'utf-8').trim();
  if (!text) throw new Error(`${textPath} 가 비었다 — ref.wav 의 대사를 그대로 적어야 한다`);
  return { audio, text };
}

/** 페르소나 톤을 Qwen 의 instruct 문구로 옮긴 것. ElevenLabs 의 stability/style 에 대응. */
export const QWEN_INSTRUCT = {
  'barro-alert': '빠르고 간결한 속보 브리핑 톤. 문장 사이를 끌지 말고 바로 이어서 읽어라.',
  'barro-teacher': '차분하고 신뢰감 있는 설명 톤. 또박또박 읽되 문장 사이를 길게 끌지 마라.',
};

// 이모지·픽토그램(🚨📚✅ 등) 제거 — TTS 오발음·자막 표시 오류 방지 (2026-06-07)
// 자막(render-direct.js)과 동일 규칙. narration 표기 원본은 보존하고 TTS 입력만 정제한다.
export function stripEmoji(s) {
  return (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// narration은 ElevenLabs에 그대로 전달된다. 숫자 표기는 subtitle_text에만 둔다.
function assertTtsNarration(text, label = 'TTS narration') {
  const digit = String(text || '').match(/\d/);
  if (digit) {
    throw new Error(`${label} has an Arabic numeral ("${digit[0]}"). Write numbers in Korean for TTS and put the numeric form in subtitle_text.`);
  }
}

export function parseSpeed(value) {
  if (value === undefined) return null;
  const speed = typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.2) {
    throw new Error('--speed must be a finite number between 0.7 and 1.2');
  }
  return speed;
}

export async function generateTTS({ text, outPath, voiceId = DEFAULT_VOICE_ID, model = DEFAULT_MODEL, settings = {}, costContext = {} }) {
  assertTtsNarration(text);
  const apiKey = getSecret('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in .env');

  const voiceSettings = {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.3,
    use_speaker_boost: true,
    ...settings,
  };

  // Starter tier는 MP3만 가능. WAV가 필요하면 후처리로 ffmpeg 변환
  const url = `${API_URL}/${voiceId}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({ text, model_id: model, voice_settings: voiceSettings }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${err}`);
  }

  const mp3 = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(outPath), { recursive: true });

  // 확장자 기반: .wav이면 ffmpeg로 변환, .mp3이면 그대로 저장
  if (outPath.endsWith('.wav')) {
    const mp3Tmp = outPath.replace(/\.wav$/, '.tmp.mp3');
    writeFileSync(mp3Tmp, mp3);
    const { execSync } = await import('node:child_process');
    execSync(`ffmpeg -y -i "${mp3Tmp}" -ar 44100 -ac 1 -sample_fmt s16 "${outPath}" 2>/dev/null`);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(mp3Tmp);
  } else {
    writeFileSync(outPath, mp3);
  }

  // Cost tracking — best-effort (2026-04-27)
  // ElevenLabs charges by input characters (not bytes). Use text.length as proxy.
  recordCost('voice-engineer', {
    model,
    characters: text ? text.length : 0,
    episode: costContext.episode || null,
    stage: costContext.stage || null,
    note: costContext.note || null,
  });

  return { path: outPath, bytes: mp3.length };
}

function probeDuration(path) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  const seconds = Number(String(out).trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe 가 길이를 못 읽었다: ${path}`);
  return seconds;
}

/**
 * Qwen3-TTS 로컬 CLI 로 같은 wav 를 만든다.
 *
 * 산출물 규격은 ElevenLabs 경로와 같게 맞춘다(44.1kHz mono s16) — sync-durations·
 * render-direct 가 두 엔진을 구분하지 않아야 한다.
 *
 * targetSeconds 를 주면 무음 압축 후에도 넘칠 때만 배속을 건다. Shorts 는 60초가
 * 규격이라 TTS 가 길이를 결정하게 두면 규격을 못 지킨다.
 */
export async function generateTTSQwen({
  text, outPath, speaker = QWEN_SPEAKER, instruct = null, targetSeconds = null,
  cloneRef = null, costContext = {},
}) {
  assertTtsNarration(text);
  const py = join(QWEN_DIR, 'v', 'bin', 'python');
  const cli = join(QWEN_DIR, 'tts.py');
  if (!existsSync(py) || !existsSync(cli)) {
    throw new Error(`Qwen3-TTS 로컬 설치를 찾을 수 없다: ${QWEN_DIR} — BT_QWEN_TTS_DIR 로 경로를 지정하라`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const rawPath = outPath.replace(/\.wav$/, '.raw.wav');
  const trimPath = outPath.replace(/\.wav$/, '.trim.wav');
  const pausePath = outPath.replace(/\.wav$/, '.pause.wav');

  // 끝음 여운을 얻으려고 필러를 붙여 생성한 뒤, 아래에서 필러 앞 공백을 찾아 잘라낸다.
  const spoken = `${text}${QWEN_TAIL_FILLER}`;

  // clone 은 참조 음성이 화자를 정하므로 -s/-i 를 받지 않는다 (tts.py 의 clone 분기).
  const args = cloneRef
    ? [cli, spoken, '-m', 'clone', '--ref-audio', cloneRef.audio, '--ref-text', cloneRef.text, '-o', rawPath]
    : [cli, spoken, '-s', speaker, '-l', 'korean', '-o', rawPath];
  if (instruct && !cloneRef) args.push('-i', instruct);

  // 샘플링이 반복 루프에 빠지면 같은 구절을 계속 읽는다 — 실측: ryan 화자가 123자를
  // 63.8초로 뱉었다(정상 ~16초). 조용히 넘기면 배속으로 뭉개거나 규격을 깨므로,
  // 글자수 대비 말이 안 되는 길이면 버리고 다시 뽑는다. temperature 0.9 라 재시도가 통한다.
  const maxPlausible = Math.max(8, text.length / QWEN_MIN_RATE);
  let rawDuration = 0;
  for (let attempt = 1; attempt <= QWEN_MAX_ATTEMPTS; attempt++) {
    const r = spawnSync(py, args, {
      cwd: QWEN_DIR, encoding: 'utf-8', timeout: 900_000, maxBuffer: 10 * 1024 * 1024,
    });
    if (r.error?.code === 'ENOENT') throw new Error(`Qwen3-TTS python 을 실행할 수 없다: ${py}`);
    if (r.status !== 0) throw new Error(`Qwen3-TTS 종료코드 ${r.status}: ${(r.stderr || '').slice(-300)}`);
    if (!existsSync(rawPath)) throw new Error('Qwen3-TTS 가 wav 를 내놓지 않았다');

    rawDuration = probeDuration(rawPath);
    const runaway = rawDuration > maxPlausible;
    // 필러 경계를 못 찾으면 대본에 없는 "네" 가 그대로 남는다 — 실측(EP-0092 씬2·4)에서
    // 사용자가 바로 알아챘다. 그대로 쓰느니 다시 뽑는다. 필러 위치는 매 생성마다 달라진다.
    const noCut = findTailCut(rawPath, rawDuration) === null;
    if (!runaway && !noCut) break;

    if (attempt === QWEN_MAX_ATTEMPTS) {
      if (runaway) {
        throw new Error(`Qwen3-TTS 가 ${QWEN_MAX_ATTEMPTS}회 모두 폭주했다 `
          + `(${text.length}자 → ${rawDuration.toFixed(1)}초, 상한 ${maxPlausible.toFixed(1)}초). `
          + '문장을 짧게 끊거나 --speaker 를 바꿔라.');
      }
      throw new Error(`Qwen3-TTS 필러 경계를 ${QWEN_MAX_ATTEMPTS}회 모두 못 찾았다 — `
        + '그대로 쓰면 대본에 없는 어구가 들린다. 문장 끝을 바꾸거나 QWEN_TAIL_FILLER 를 조정하라.');
    }
    console.warn(runaway
      ? `  ⚠ 생성 폭주 (${text.length}자 → ${rawDuration.toFixed(1)}초) — 재생성 ${attempt}/${QWEN_MAX_ATTEMPTS - 1}`
      : `  ⚠ 필러 경계 미검출 — 재생성 ${attempt}/${QWEN_MAX_ATTEMPTS - 1}`);
  }

  try {
    // 1) 필러를 잘라낸다. 뒤쪽은 여기서만 건드린다 — 무음 제거로 뒤를 깎으면
    //    애써 얻은 여운이 다시 사라진다(-45dB 기준이 릴리스를 무음으로 본다).
    // 위 루프가 cutAt 이 null 인 결과를 이미 걸러냈으므로 여기선 항상 자른다.
    const cutAt = findTailCut(rawPath, rawDuration);
    const cutArgs = ['-t', cutAt.toFixed(3),
      '-af', `afade=t=out:st=${(cutAt - QWEN_TAIL_FADE).toFixed(3)}:d=${QWEN_TAIL_FADE}`];
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', rawPath, ...cutArgs, trimPath]);

    // 2) 앞쪽 여백과 문장 사이 공백만 정리한다. 끝의 여운(< QWEN_MAX_PAUSE)은 살아남는다.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', trimPath, '-af',
      'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB'
      + `:stop_periods=-1:stop_duration=${QWEN_MAX_PAUSE}:stop_threshold=-45dB`,
      pausePath]);
    renameSync(pausePath, trimPath);

    // 2) 그래도 목표를 넘으면 그때만 배속. 상한을 넘는 초과분은 남겨 둔다 —
    //    억지로 밀어 넣는 것보다 sync-durations 가 실길이를 반영하는 편이 낫다.
    const trimmed = probeDuration(trimPath);
    const tempo = targetSeconds && trimmed > targetSeconds
      ? Math.min(trimmed / targetSeconds, QWEN_MAX_TEMPO)
      : 1;
    const filters = [tempo > 1 ? `atempo=${tempo.toFixed(4)}` : null, 'aresample=44100']
      .filter(Boolean).join(',');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', trimPath, '-af', filters,
      '-ac', '1', '-sample_fmt', 's16', outPath]);

    recordCost('voice-engineer', {
      model: `qwen3-tts-local (${cloneRef ? 'clone' : speaker})`,
      characters: text ? text.length : 0,
      episode: costContext.episode || null,
      stage: costContext.stage || null,
      note: `${costContext.note || ''} local $0${tempo > 1 ? ` atempo=${tempo.toFixed(2)}` : ''}`.trim(),
    });

    return { path: outPath, raw: probeDuration(rawPath), trimmed, tempo, final: probeDuration(outPath) };
  } finally {
    for (const p of [rawPath, trimPath, pausePath]) { try { unlinkSync(p); } catch { /* 이미 없으면 그만 */ } }
  }
}

function parseFrontmatter(mdPath) {
  const content = readFileSync(mdPath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No YAML frontmatter');
  return parseYAML(match[1]);
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }

  try {
    const speed = parseSpeed(opts.speed);

    // 엔진 선택은 두 진입점(--text, --script)에 모두 걸어야 한다.
    // 처음엔 --script 쪽에만 걸었다가 --engine qwen 을 준 --text 호출이 조용히
    // ElevenLabs 로 나가 과금됐다 (2026-08-14). 분기 위로 올린다.
    const engine = (opts.engine || process.env.BT_TTS_ENGINE || 'auto').toLowerCase();
    if (!['auto', 'elevenlabs', 'qwen'].includes(engine)) {
      throw new Error(`--engine 은 auto|elevenlabs|qwen 중 하나여야 한다 (받음: ${engine})`);
    }
    // 명시 지정은 폴백 없이 그 엔진으로만 간다 — 그렇게 부른 사람은 실패를 보고 싶은 것이다
    // (generate-script.js 의 --engine 과 같은 규약).
    let chain = engine === 'auto' ? resolveTtsChain() : [engine];
    const speaker = opts.speaker || QWEN_SPEAKER;
    const engineUsed = {};

    if (opts.text && opts.out) {
      // 단발 호출은 체인을 돌리지 않는다 — 첫 엔진으로만 간다. 사람이 보고 있는 경로다.
      if (chain[0] === 'qwen') {
        let cloneRef = null;
        if (speaker === 'clone') {
          cloneRef = loadCloneRef(opts.channel);
          if (!cloneRef) throw new Error('--speaker clone 은 --channel <id> 와 그 채널의 voice-ref/ 가 필요하다');
        }
        const got = await generateTTSQwen({
          text: opts.text, outPath: resolve(opts.out), speaker, cloneRef,
          instruct: opts.instruct || null,
          costContext: { stage: 'S6a', note: 'cli-text' },
        });
        console.log(`✅ TTS saved: ${opts.out} (qwen/${cloneRef ? 'clone' : speaker}, ${got.final.toFixed(1)}s)`);
      } else {
        await generateTTS({
          text: opts.text,
          outPath: resolve(opts.out),
          settings: speed === null ? {} : { speed },
          costContext: { stage: 'S6a', note: 'cli-text' },
        });
        console.log(`✅ TTS saved: ${opts.out}`);
      }
    } else if (opts.script && opts['out-dir']) {
      const meta = parseFrontmatter(opts.script);
      const outDir = resolve(opts['out-dir']);
      mkdirSync(outDir, { recursive: true });

      // Persona-based voice settings
      const PERSONA_SETTINGS = {
        'barro-teacher': { stability: 0.65, similarity_boost: 0.78, style: 0.2, speed: 1.0 },
        'barro-alert':   { stability: 0.5,  similarity_boost: 0.75, style: 0.4, speed: 1.05 },
      };
      const persona = meta.persona || null;
      const settings = { ...(persona && PERSONA_SETTINGS[persona] ? PERSONA_SETTINGS[persona] : {}) };
      if (speed !== null) settings.speed = speed;

      const instruct = opts.instruct || (persona ? QWEN_INSTRUCT[persona] : null) || null;

      // speaker=clone 이면 채널의 참조 음성으로 복제한다.
      // 참조가 없는 채널은 로컬을 건너뛰고 기존 ElevenLabs 목소리를 그대로 쓴다 —
      // 참조도 없이 sohee 같은 기성 화자로 조용히 갈아타면 채널 정체성이 바뀐다.
      let cloneRef = null;
      if (chain.includes('qwen') && speaker === 'clone') {
        cloneRef = loadCloneRef(meta.channel_id);
        if (cloneRef) {
          console.log(`   clone ref: ${cloneRef.audio} (${cloneRef.text.length}자 대사)`);
        } else if (chain.length > 1) {
          console.warn(`  ⚠ ${meta.channel_id} 에 voice-ref 가 없다 — 로컬 복제를 건너뛴다`);
          chain = chain.filter((e) => e !== 'qwen');
        } else {
          throw new Error('--speaker clone 인데 참조 음성이 없다: '
            + `workspace/channels/${meta.channel_id}/voice-ref/{ref.wav,ref.txt}`);
        }
      }
      console.log(`🎙 Engine chain: ${chain.join(' → ')}${chain.includes('qwen') ? ` (qwen speaker=${speaker})` : ''}`);

      if (chain.includes('qwen') && instruct) {
        console.log(`   instruct: ${instruct}`);
      }
      if (chain.includes('elevenlabs') && persona) {
        console.log(`🎭 Persona=${persona} → stability=${settings.stability ?? 'default'}, style=${settings.style ?? 'default'}, speed=${settings.speed ?? 'default'}`);
      }

      // narration은 TTS용 한글 수사, subtitle_text는 화면용 숫자 표기다.
      // phoneme override는 약어 발음에만 적용하며 숫자 표기를 대신하지 않는다.
      let phonemeMap = null;
      if (meta.channel_id) {
        const ROOT = resolve(import.meta.dirname, '../..');
        const overridesPath = join(ROOT, 'workspace', 'channels', meta.channel_id, 'phoneme-overrides.json');
        if (existsSync(overridesPath)) {
          try {
            const cfg = JSON.parse(readFileSync(overridesPath, 'utf-8'));
            // 긴 문자열부터 치환 (S&P500 우선, S&P 후순위)
            phonemeMap = Object.entries(cfg.overrides || {}).sort((a, b) => b[0].length - a[0].length);
            console.log(`📚 Phoneme overrides loaded: ${phonemeMap.length} entries (${meta.channel_id})`);
          } catch (e) {
            console.warn(`  ⚠ phoneme-overrides.json parse error: ${e.message} — proceeding without override`);
          }
        }
      }
      const applyOverrides = (text) => {
        if (!phonemeMap || phonemeMap.length === 0) return { text, count: 0 };
        let out = text;
        let count = 0;
        for (const [from, to] of phonemeMap) {
          const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          const before = out;
          out = out.replace(re, to);
          if (before !== out) count++;
        }
        return { text: out, count };
      };

      console.log(`🎙 Generating ${meta.scenes.length} TTS clips...`);
      // 기존 WAV가 있어도 잘못된 원고를 통과시키지 않도록 전체를 먼저 검증한다.
      for (const scene of meta.scenes) {
        assertTtsNarration(stripEmoji(scene.narration), `Scene ${scene.scene_id} narration`);
      }
      let totalOverrides = 0;
      for (const scene of meta.scenes) {
        const outPath = join(outDir, `scene_${scene.scene_id}.wav`);
        if (existsSync(outPath) && !opts.force) {
          console.log(`  ⏭  Scene ${scene.scene_id} exists (use --force to regen)`);
          continue;
        }
        const { text: ttsText, count: applied } = applyOverrides(stripEmoji(scene.narration));
        if (applied > 0) {
          totalOverrides += applied;
          console.log(`  📝 Scene ${scene.scene_id}: ${applied} phoneme override(s) applied`);
        }
        const costContext = {
          episode: meta.episode_id || null,
          stage: 'S6a',
          note: `scene_${scene.scene_id}${applied > 0 ? ` (${applied} phoneme overrides)` : ''}`,
        };
        // 씬 단위로 체인을 돈다. 로컬이 폭주해 3회 재생성까지 실패해도 그 씬만 유료 API 로
        // 넘어가고 나머지는 로컬로 남는다 — cron 이 한 씬 때문에 통째로 서지 않는다.
        // 목소리가 섞이지 않는 이유: clone 의 참조가 애초에 ElevenLabs 화자다.
        let lastError = null;
        for (const [i, name] of chain.entries()) {
          try {
            if (name === 'qwen') {
              const got = await generateTTSQwen({
                text: ttsText, outPath, speaker, instruct, cloneRef,
                targetSeconds: scene.target_seconds, costContext,
              });
              console.log(`  ✅ Scene ${scene.scene_id} ${got.raw.toFixed(1)}s → 무음압축 ${got.trimmed.toFixed(1)}s`
                + `${got.tempo > 1 ? ` → ×${got.tempo.toFixed(2)} ` : ' → '}${got.final.toFixed(1)}s (목표 ${scene.target_seconds}s)`);
            } else {
              await generateTTS({ text: ttsText, outPath, settings, costContext });
              console.log(`  ✅ Scene ${scene.scene_id} (${scene.narration.slice(0, 30)}...)`);
            }
            engineUsed[name] = (engineUsed[name] || 0) + 1;
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            const last = i === chain.length - 1;
            if (last) break;
            console.warn(`  ⚠ Scene ${scene.scene_id} ${name} 실패 (${e.message.slice(0, 120)}) → ${chain[i + 1]} 로 폴백`);
          }
        }
        if (lastError) throw lastError;
      }
      if (totalOverrides > 0) console.log(`\n📚 Total phoneme overrides applied: ${totalOverrides}`);
      const used = Object.entries(engineUsed).map(([k, v]) => `${k} ${v}씬`).join(' · ');
      console.log(`\n🎙 All TTS generated in ${outDir}${used ? ` (${used})` : ''}`);
      if (engineUsed.elevenlabs && chain[0] === 'qwen') {
        console.warn(`⚠ ${engineUsed.elevenlabs}개 씬이 유료 폴백으로 나갔다 — 로컬 엔진 상태를 확인하라`);
      }
    } else {
      console.error('Usage: generate-tts.js --text "..." --out path/to/file.wav [--speed 0.7-1.2]');
      console.error('   or: generate-tts.js --script 30_script.md --out-dir assets/tts/ [--speed 0.7-1.2] [--force]');
      console.error('                       [--engine auto|qwen|elevenlabs] [--speaker clone|sohee|ryan|...] [--instruct "..."]');
      console.error('  기본 auto = qwen → elevenlabs 체인 (BT_TTS_ENGINE_CHAIN 으로 변경).');
      console.error('  --engine 을 명시하면 폴백 없이 그 엔진으로만 간다.');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ TTS failed: ${e.message}`);
    process.exit(1);
  }
}
