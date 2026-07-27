#!/usr/bin/env node

/** Generate read-only channel-operation HTML snapshots from the registry. */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { scanChannelEpisodes } from './lib/channel-adapters.js';
import { renderChannelDocument } from './lib/channel-document.js';
import { createChannelRegistry } from './lib/channel-registry.js';

const SKILL_ROOT = resolve(import.meta.dirname, '../..');
const REPO_ROOT = resolve(SKILL_ROOT, '../../..');
const DATA_ROOT = resolve(process.env.BARROTUBE_DATA || '/Users/beye/BarroTubeData');
const FACTORY_ROOT = resolve(process.env.BARRO_AI_FACTORY || '/Users/beye/BarroAiFactory');

const { values } = parseArgs({
  options: {
    channel: { type: 'string', short: 'c' },
    all: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'no-backup': { type: 'boolean', default: false },
  },
});

function readSeries(path) {
  if (!path || typeof path !== 'string') return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Could not read configured series index ${path}: ${error.message}`); }
}

function existingGeneratedAt(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8').match(/"generated_at":"([^"]+)"/)?.[1] || null;
  } catch { return null; }
}

function writeSnapshot(path, content, backup) {
  mkdirSync(dirname(path), { recursive: true });
  const next = Buffer.from(content);
  if (existsSync(path) && readFileSync(path).equals(next)) {
    return { changed: false, backup_path: null };
  }
  let backupPath = null;
  if (backup && existsSync(path)) {
    backupPath = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backupPath);
  }
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, next, { mode: 0o644 });
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* noop */ }
    throw error;
  }
  return { changed: true, backup_path: backupPath };
}

async function main() {
  if (!values.channel && !values.all) {
    throw new Error('Usage: render-channel-document.js --channel <id> | --all [--dry-run] [--no-backup]');
  }
  if (values.channel && values.all) throw new Error('Use either --channel or --all, not both.');

  const registry = createChannelRegistry({
    skillRoot: SKILL_ROOT,
    dataRoot: DATA_ROOT,
    factoryRoot: FACTORY_ROOT,
    channelsRoot: join(DATA_ROOT, 'workspace', 'channels'),
    allowedRoots: [DATA_ROOT, FACTORY_ROOT, REPO_ROOT],
  });
  const records = values.all
    ? (await registry.listChannels({ strict: true }))
    : [await registry.getChannel(values.channel)];
  const result = [];

  for (const record of records) {
    const outputPath = record.context.document_output_path;
    if (!outputPath || typeof outputPath !== 'string' || outputPath.includes('${')
        || record.context.document_output_safe !== true || extname(outputPath).toLowerCase() !== '.html') {
      throw new Error(`${record.id}: document.output_path is unresolved or unsafe`);
    }
    const episodes = scanChannelEpisodes(record.context);
    const series = readSeries(record.context.series_index);
    const channel = {
      ...record.manifest,
      ...record.context,
      identity: { ...record.manifest.identity, ...record.context.identity },
      conflicts: record.conflicts,
      risks: record.conflicts,
    };
    const previousGeneratedAt = existingGeneratedAt(outputPath);
    let document = renderChannelDocument({
      channel,
      series,
      episodes,
      offline: true,
      generatedAt: previousGeneratedAt || new Date().toISOString(),
    });
    if (previousGeneratedAt && !readFileSync(outputPath).equals(Buffer.from(document))) {
      document = renderChannelDocument({
        channel,
        series,
        episodes,
        offline: true,
        generatedAt: new Date().toISOString(),
      });
    }
    const write = values['dry-run']
      ? { changed: !existsSync(outputPath) || !readFileSync(outputPath).equals(Buffer.from(document)), backup_path: null }
      : writeSnapshot(outputPath, document, !values['no-backup']);
    result.push({
      channel_id: record.id,
      output_path: outputPath,
      episode_count: episodes.length,
      dry_run: values['dry-run'],
      ...write,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, documents: result }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`render-channel-document: ${error.message}`);
  process.exitCode = 1;
});
