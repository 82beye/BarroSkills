#!/usr/bin/env node
/**
 * 새 애니메이션 스타일 등록:
 *   1) CapCut에서 아무 드래프트의 자막 1개에 원하는 인 애니메이션 적용→저장→⌘Q
 *   2) node scripts/capture-animation.mjs "<드래프트폴더명>" <key>
 *      예: node scripts/capture-animation.mjs BT-EP01-FirstEyeContact fade_in
 * 해당 드래프트에서 비어있지 않은 material_animation을 찾아 animations.json[key]에 저장.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const [ , , draftName, key ] = process.argv;
if (!draftName || !key) { console.error('usage: capture-animation.mjs <draftFolder> <key>'); process.exit(1); }
const draftInfo = join(homedir(),'Movies/CapCut/User Data/Projects/com.lveditor.draft', draftName, 'draft_info.json');
if (!existsSync(draftInfo)) { console.error('draft not found:', draftInfo); process.exit(1); }
const info = JSON.parse(readFileSync(draftInfo,'utf-8'));
const src = (info.materials.material_animations||[]).find(m => (m.animations||[]).length);
if (!src) { console.error('적용된 애니메이션이 없습니다. CapCut에서 자막 1개에 적용 후 저장하세요.'); process.exit(1); }
const entry = JSON.parse(JSON.stringify(src.animations[0]));
entry.request_id = '';
const regPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'animations.json');
const reg = existsSync(regPath) ? JSON.parse(readFileSync(regPath,'utf-8')) : {};
reg[key] = { label: entry.name, note: `${entry.type} 애니메이션. 캡처 등록.`, entry };
writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf-8');
console.log(`✅ '${entry.name}' → animations.json['${key}'] 등록 (type=${entry.type}, dur=${(entry.duration/1e6).toFixed(2)}s)`);
console.log('   등록된 키:', Object.keys(reg).join(', '));
