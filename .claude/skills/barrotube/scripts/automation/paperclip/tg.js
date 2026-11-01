#!/usr/bin/env node
/**
 * tg.js — 에이전트가 운영자에게 텔레그램 한 줄을 보낸다.
 * 셸 문자열을 거치지 않게 인자 하나로만 받는다 (이슈 본문·모델 출력이 섞여도 명령이 되지 않는다).
 * Usage: node scripts/automation/paperclip/tg.js "🛠 IR-… EP-… — 조치 요약"
 */
import { sendTelegramText } from '../notify.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.error('보낼 문장이 없다'); process.exit(2); }
const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 3500);
sendTelegramText(esc).then((ok) => console.log(ok ? '보냄' : '보내지 않음(DRY_RUN·BT_NO_NOTIFY)')).catch((e) => { console.error(`텔레그램 실패: ${e.message}`); process.exit(1); });
