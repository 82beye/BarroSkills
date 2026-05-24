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

export async function generateTTS({ text, outPath, voiceId = DEFAULT_VOICE_ID, model = DEFAULT_MODEL, settings = {}, costContext = {} }) {
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
        const { text: ttsText, count: applied } = applyOverrides(scene.narration);
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
