# ChatGPT image generation (browser, verified steps)

Goal: produce one still PNG from `image_prompt` and save it as
`Image/<slug>.png`. Use the user's logged-in chatgpt.com session. Prefer
Playwright MCP when it is already logged in; it can save downloads directly to
the project path with `download.saveAs()`.

## Step 0 — Attach the channel character reference (REQUIRED when a sheet exists)

If the channel has an **official character sheet**, attach that image to the
image-generation request so the mascot matches exactly — do not rely on text alone.

- **바로경제(econ-daily) 시트**: `~/BarroTubeData/workspace/docs/바로경제_캐릭터시트.png`.
  Character constants: `~/BarroTubeData/CLAUDE.md` (auto-loaded policy),
  `~/BarroTubeData/workspace/channels/<channel>/character-dna.md` (DNA, single source of truth),
  `.../role.md` (role/identity). Other channels: `workspace/docs/<brand>_캐릭터시트.png`.
- **Playwright MCP:** prefer the page's hidden file input. Use
  `page.locator('#upload-photos, input[type="file"]').first().setInputFiles(sheetPath)`
  and wait until the attachment chip containing the sheet filename is visible. A resolved
  `setInputFiles()` call alone is not attachment evidence.
- **claude-in-chrome, or Playwright input failure:** use the macOS clipboard:
  ```bash
  osascript -e 'set the clipboard to (read (POSIX file "/Users/beye/BarroTubeData/workspace/docs/바로경제_캐릭터시트.png") as «class PNGf»)'
  ```
  Then click the ChatGPT composer and paste with **Cmd+V**. A thumbnail attaches to
  the composer (an inline `<img>` / attachment chip appears). `file_upload` host-path
  and `localhost`/`base64` bridges may fail on this surface — use the clipboard fallback.
- ⚠️ **First paste right after a fresh page load often no-ops** — click the composer +
  Cmd+V again in a *separate* action and confirm the thumbnail before typing.
- **Prompt wording with the attachment:** start the prompt with
  `Use the attached character sheet as the exact reference for the mascot — identical body,
  face, eyes, cheeks, colors and proportions.` then describe only the **scene, pose,
  expression and props** (do not re-invent the character). Pick pose/expression from the
  sheet's named set (neutral/happy/surprised/worried/determined/crying;
  standing/walking/running/pointing/cheering/presenting).
- If clipboard attach is genuinely unavailable, fall back to embedding the full DNA block
  from `character-dna.md` as text in the prompt (less exact, still on-model).
- In a batch, start a **fresh chat for every image** before attaching the same character
  sheet again. Reusing one conversation can reject the file as already uploaded. Do not
  send the prompt until the new chat shows the attachment chip.

## Steps

1. **Open or reuse the logged-in tab.** List existing `chatgpt.com` tabs before opening
   another one. Select a candidate and confirm both the composer ("무엇이든 물어보세요" /
   `ChatGPT와 채팅`) and an account/profile control are visible. The `/` URL or a new-chat
   page is not evidence of logout. Stop only when the composer is absent and an explicit
   sign-in form or captcha is present; leave that tab in front for the user.

2. **Select the 이미지 만들기 tool — this is required, not optional.** Open the composer
   tool menu (`+` / 도구) and click **이미지 만들기** so the chip is attached BEFORE typing.
   Verify the chip by screenshot. Do not send without it.

   Falling back to a text-only cue (`Create a single vertical 9:16 …`) was previously
   allowed as an alternative; it is not. 2026-08-14 실측: 텍스트 경로로만 요청하면
   ChatGPT 가 일반 응답 경로로 라우팅돼 생성이 멈추거나 규격 밖 이미지가 나온다.
   The text cue may be added on top of the chip, never instead of it.

   If the tool menu does not expose **이미지 만들기**, stop and report
   「이미지 만들기 도구 없음」 — do not improvise with a plain prompt.

   For BarroTube scenes, immediately add the framing rule:
   `Show Masi's readable face and full-body action in the centre. Keep one key scene
   object and the surrounding environment secondary, with comfortable headroom and
   footroom.`

   Do **not** ask for a horizontal image. The goal is still a vertical reel still,
   just composed wide enough that the character, action, and location read clearly.

3. **Type the prompt.** Click the composer field, type `image_prompt`. Screenshot to
   confirm the text and that the **이미지 만들기** chip is still attached.

4. **Send.** Click the send (↑) button at the right end of the composer. The page shows
   a placeholder card labeled **"이미지 생성 중"**.

5. **Wait for this response, not any old image.** Record the current assistant-response
   count or image `src` values before sending. Poll with short waits (≤10s each) until a
   new assistant response contains a new portrait image and its "이미지 생성 중" state is
   gone. An older portrait elsewhere in the conversation must not satisfy completion.
   Typical time: ~20–45s.

6. **Download — use the blob fetch. There is no download button.**
   As of 2026-08-17 the media viewer exposes only **이 이미지 공유**; no 다운로드 entry
   appears. An agent that hunts for one stalls: EP-2026-0097 looped re-creating its
   marker file for ~20 minutes without ever saving a cut. Run this on the page instead:
   ```js
   const img = [...document.querySelectorAll('img')].find(i => /생성된 이미지/.test(i.alt));
   const r = await fetch(img.src); const b = await r.blob();          // b.size === 0 → failed
   const a = document.createElement('a'); a.href = URL.createObjectURL(b);
   a.download = 'scene_NNN.png'; document.body.appendChild(a); a.click(); a.remove();
   ```
   Then move `~/Downloads/scene_NNN.png` to the target path. Verified 5/5 on 2026-08-17
   **with claude-in-chrome**.

   **codex blocks this.** On codex's Chrome surface the page-level blob download is
   refused ("Chrome의 안전 제약으로 페이지 내 blob 다운로드 실행은 차단됐습니다",
   2026-08-18 EP-0098). There the working route is the browser's own read-only asset
   export: the image is already on disk under
   `$TMPDIR/browser-use/assets/<uuid>/<hash>` — copy that file to the target path and
   `file` it to confirm a portrait PNG. Pick the asset written for the newest response,
   not an older one. So: **blob fetch on claude-in-chrome, asset export on codex.**
   Pick by `alt` matching `생성된 이미지` — **never by area**: the character sheet
   (1024×1535) and a generated cut (941×1672) differ by under 0.1%, so an area sort
   grabs the sheet. If two cuts are in the thread, take the last match.
   (Grok is the opposite — there the blob fetch returns 0 bytes on CORS and you must use
   its ⬇ button. Do not carry one site's method over to the other.)
   With Playwright MCP available, `page.waitForEvent('download')` + `download.saveAs()`
   still works and avoids guessing the Downloads path.

7. **Validate.** `file Image/<slug>.png` should show a portrait PNG. Typical
   ChatGPT output is `941 x 1672`.

## Playwright MCP pattern

```js
const responses = page.locator('[data-message-author-role="assistant"]');
const responseCount = await responses.count();
const box = page.locator('div[role="textbox"][aria-label="ChatGPT와 채팅"]').first();
await box.click();
await page.keyboard.insertText(imagePrompt);
await page.getByTestId('send-button').click();

// Only the newly appended assistant turn can complete this request.
const response = responses.nth(responseCount);
await response.waitFor({ state: 'visible', timeout: 60000 });
const img = response.locator('img').last();
await img.waitFor({ state: 'visible', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'));
await img.scrollIntoViewIfNeeded().catch(() => {});
const box2 = await img.boundingBox();
if (box2) await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);

await response.getByRole('button', { name: '이 이미지 공유' }).last().click();
const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
await page.getByRole('button', { name: '다운로드' }).click();
const download = await downloadPromise;
await download.saveAs('/Users/beye/.../Image/<slug>.png');
await page.keyboard.press('Escape');
```

## Notes / gotchas

- **Free tier still generates images** — but quality/size and daily limits vary. If a
  generation stalls or errors, re-screenshot and report rather than spamming send.
- **Daily limit lands mid-batch, not at the start.** 2026-08-15 실측: 씬 2장을 만든 뒤
  응답 아래에 「내일 AM 10:18까지 기능이 제한됩니다. 응답 품질이 낮을 수 있고 일부 도구는
  사용할 수 없습니다」 + 「Pro로 업그레이드」 가 붙고 이미지 도구가 막혔다. **업그레이드·결제는
  절대 하지 마라.** 만든 것까지 저장하고 「ChatGPT 일일 한도」 라고 보고하면 된다 —
  auto-pipeline Phase 7 이 남은 씬을 gpt-image-1 + 캐릭터 시트(`/v1/images/edits`) 로 메운다.
- **Programmatic download 은 `alt` 로 고른다, 크기로 고르지 마라.** 첨부한 캐릭터 시트가
  1024×1535, 생성 이미지가 941×1672 라 면적 차이가 0.1% 도 안 된다 — 가장 큰 이미지를
  집으면 시트를 내려받는다. `/생성된 이미지/.test(img.alt)` 로 거른 뒤 마지막 것을 쓴다.
- **Do NOT curl the image URL from terminal.** `https://chatgpt.com/backend-api/estuary/...`
  usually requires browser cookies and returns 403 outside the browser context.
- **Do NOT return image bytes/base64 through the tool.** The output filter blocks
  base64, and screenshots are not the full-resolution asset.
- **If ChatGPT asks "which image do you prefer?"** pick/download the latest suitable
  candidate, then continue. Do not leave a repeated or wrong scene as the final cut;
  generate a replacement if the scene concept is wrong.
- **If you destroyed the DOM** while inspecting (e.g. replacing `document.body`), just
  re-`navigate` to the conversation URL — ChatGPT restores it from the server.

## Fallback: programmatic download (only if the UI download is unavailable)

In the page context, build a Blob from the rendered image and click a temporary
`<a download>`. This still lands in the browser download area:

```js
// run in the ChatGPT tab through the active Codex browser-client page context
const img = [...document.querySelectorAll('img')]
  .filter(i => i.naturalWidth > 256 && i.naturalHeight > 256)
  .sort((a,b) => b.naturalWidth*b.naturalHeight - a.naturalWidth*a.naturalHeight)[0];
const r = await fetch(img.currentSrc || img.src);
const b = await r.blob();
const u = URL.createObjectURL(b);
const a = document.createElement('a');
a.href = u; a.download = 'chatgpt_image.png';
document.body.appendChild(a); a.click(); a.remove();
setTimeout(() => URL.revokeObjectURL(u), 15000);
'triggered';   // return a tiny value, NOT the bytes (base64 is filtered)
```

Then move it with `move_media.py`. Never try to return the base64/dataURL through the
tool result — it will be blocked and waste a round trip.
