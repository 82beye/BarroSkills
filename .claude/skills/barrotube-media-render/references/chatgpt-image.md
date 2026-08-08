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

2. **Make image intent explicit.** Either click **이미지 만들기** if visible, or start
   the prompt with: `Create a single vertical 9:16 cinematic image with Masi as the
   dominant central actor.` This reliably routes ChatGPT to image generation in the
   current UI.

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

6. **Download.** The verified 2026 UI path is:
   - Hover the generated image.
   - Click **이 이미지 공유**.
   - In the share dialog, click **다운로드**.
   - With Playwright MCP, wrap that click in `page.waitForEvent('download')` and call
     `download.saveAs('/.../Image/<slug>.png')`.
   This avoids guessing the browser Downloads path.
   Scope the share button to the new assistant response from step 5. After `saveAs()` and
   file validation, close the share dialog; the next batch item starts in a fresh chat.

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
