#!/usr/bin/env node

/**
 * generate-tts.js — ElevenLabs TTS 생성
 *
 * Usage:
 *   node generate-tts.js --text "나레이션 텍스트" --out path/scene_001.wav
 *   node generate-tts.js --script <episode_dir>/30_script.md --out-dir <assets>/tts/
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { getSecret } from './config-loader.js';
import { recordCost } from './lib/cost-tracker.js';

const API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE_ID = '4JJwo477JUAx3HV0T7n7'; // Yohan Koo — Encouraging, Clear and Airy
const DEFAULT_MODEL = 'eleven_multilingual_v2';

// 이모지·픽토그램(🚨📚✅ 등) 제거 — TTS 오발음·자막 표시 오류 방지 (2026-06-07)
// 자막(render-direct.js)과 동일 규칙. narration 표기 원본은 보존하고 TTS 입력만 정제한다.
export function stripEmoji(s) {
  return (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function generateTTS({ text, outPath, voiceId = DEFAULT_VOICE_ID, model = DEFAULT_MODEL, settings = {}, costContext = {}, withTimestamps = true }) {
  const apiKey = getSecret('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in .env');

  const voiceSettings = {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.3,
    use_speaker_boost: true,
    ...settings,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  // 자막 발화 싱크용 문자단위 정렬 저장 경로 (scene_NNN.timestamps.json)
  const tsPath = outPath.replace(/\.(wav|mp3)$/, '.timestamps.json');

  let mp3 = null;
  let alignment = null;

  // 1) with-timestamps 엔드포인트 우선 — audio_base64 + 문자단위 정렬(시간) 반환.
  //    정렬은 여기 보낸 `text`(= phoneme override 적용된 TTS 입력) 기준이다. 자막은 원본
  //    narration을 표시하므로, 소비 측(render)에서 override diff로 매핑한다. text도 함께 저장.
  if (withTimestamps) {
    try {
      const url = `${API_URL}/${voiceId}/with-timestamps?output_format=mp3_44100_128`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ text, model_id: model, voice_settings: voiceSettings }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.audio_base64) mp3 = Buffer.from(data.audio_base64, 'base64');
        const a = data.alignment || data.normalized_alignment;
        if (a && Array.isArray(a.characters) && a.characters.length) {
          alignment = {
            text,
            characters: a.characters,
            start: a.character_start_times_seconds,
            end: a.character_end_times_seconds,
          };
        }
      } else {
        console.warn(`  ⚠ with-timestamps ${res.status} — plain TTS로 폴백(정렬 없음)`);
      }
    } catch (e) {
      console.warn(`  ⚠ with-timestamps 오류(${e.message}) — plain TTS로 폴백`);
    }
  }

  // 2) 폴백/기본: plain 엔드포인트 (Starter tier는 MP3만 가능)
  if (mp3 === null) {
    const url = `${API_URL}/${voiceId}?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model, voice_settings: voiceSettings }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElevenLabs TTS failed: ${res.status} ${err}`);
    }
    mp3 = Buffer.from(await res.arrayBuffer());
  }

  // 확장자 기반: .wav이면 ffmpeg로 변환(길이 불변 → 정렬 시간 유효), .mp3이면 그대로 저장
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

  // 정렬 JSON 저장(있을 때만) — 없으면 render가 기존 char-비례 타이밍으로 폴백
  if (alignment) writeFileSync(tsPath, JSON.stringify(alignment));

  // Cost tracking — best-effort (2026-04-27)
  // ElevenLabs charges by input characters (not bytes). Use text.length as proxy.
  recordCost('voice-engineer', {
    model,
    characters: text ? text.length : 0,
    episode: costContext.episode || null,
    stage: costContext.stage || null,
    note: costContext.note || null,
  });

  return { path: outPath, bytes: mp3.length, timestamps: alignment ? tsPath : null };
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
    if (opts.text && opts.out) {
      await generateTTS({
        text: opts.text,
        outPath: resolve(opts.out),
        costContext: { stage: 'S6a', note: 'cli-text' },
      });
      console.log(`✅ TTS saved: ${opts.out}`);
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
      const settings = persona && PERSONA_SETTINGS[persona] ? PERSONA_SETTINGS[persona] : {};
      if (persona) console.log(`🎭 Persona=${persona} → stability=${settings.stability ?? 'default'}, style=${settings.style ?? 'default'}`);

      // 표기 정책 v2.0 — phoneme override 사전 적용 (channel별)
      // narration 원본은 자막 burn-in용 보존, TTS 입력만 약어/숫자 → 한국어 발음 치환
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
        await generateTTS({
          text: ttsText,
          outPath,
          settings,
          costContext: {
            episode: meta.episode_id || null,
            stage: 'S6a',
            note: `scene_${scene.scene_id}${applied > 0 ? ` (${applied} phoneme overrides)` : ''}`,
          },
        });
        console.log(`  ✅ Scene ${scene.scene_id} (${scene.narration.slice(0, 30)}...)`);
      }
      if (totalOverrides > 0) console.log(`\n📚 Total phoneme overrides applied: ${totalOverrides}`);
      console.log(`\n🎙 All TTS generated in ${outDir}`);
    } else {
      console.error('Usage: generate-tts.js --text "..." --out path/to/file.wav');
      console.error('   or: generate-tts.js --script 30_script.md --out-dir assets/tts/ [--force]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ TTS failed: ${e.message}`);
    process.exit(1);
  }
}
