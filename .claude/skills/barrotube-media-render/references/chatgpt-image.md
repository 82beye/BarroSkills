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
- **How to attach (macOS clipboard — verified for claude-in-chrome & Playwright):**
  ```bash
  osascript -e 'set the clipboard to (read (POSIX file "/Users/beye/BarroTubeData/workspace/docs/바로경제_캐릭터시트.png") as «class PNGf»)'
  ```
  Then click the ChatGPT composer and paste with **Cmd+V**. A thumbnail attaches to
  the composer (an inline `<img>` / attachment chip appears). `file_upload` host-path
  and `localhost`/`base64` bridges do NOT work here — use the clipboard paste.
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

## Steps

1. **Open the tab.** Navigate to `https://chatgpt.com/`. Wait ~3s and inspect the
   page. Confirm the composer "무엇이든 물어보세요" is visible and an account is
   logged in. If a login screen shows, stop and ask the user to sign in.

2. **Make image intent explicit.** Either click **이미지 만들기** if visible, or start
   the prompt with: `Create a single vertical 9:16 cinematic image. No text, no
   subtitles, no watermark.` This reliably routes ChatGPT to image generation in
   the current UI.

   For BarroTube scenes, immediately add the framing rule:
   `Use a wide-angle 24mm lens look inside the vertical 9:16 frame. Show the full
   body or full key object, include the surrounding environment, leave headroom and
   footroom, no tight close-up, no cropped limbs or props.`

   Do **not** ask for a horizontal image. The goal is still a vertical reel still,
   just composed wide enough that the character, action, and location read clearly.

3. **Type the prompt.** Click the composer field, type `image_prompt`. Screenshot to
   confirm the text and that the **이미지 만들기** chip is still attached.

4. **Send.** Click the send (↑) button at the right end of the composer. The page shows
   a placeholder card labeled **"이미지 생성 중"**.

5. **Wait for completion.** Poll with short waits (≤10s each) and re-screenshot until the
   image card renders the finished picture (the "이미지 생성 중" label disappears and the
   image fills the card). Typical time: ~20–45s.

6. **Download.** The verified 2026 UI path is:
   - Hover the generated image.
   - Click **이 이미지 공유**.
   - In the share dialog, click **다운로드**.
   - With Playwright MCP, wrap that click in `page.waitForEvent('download')` and call
     `download.saveAs('/.../Image/<slug>.png')`.
   This avoids guessing the browser Downloads path.

   **claude-in-chrome (no `download.saveAs`): use the detail-view download — it is the
   only unambiguous grab.** Click the finished image to open its **detail/editor view**
   (a titled lightbox, e.g. "…의 순간"), then click the **top-right ⬇** download icon. Then
   retrieve the newest `ChatGPT Image *.png` from `~/Downloads` via the History(+WAL)+Finder
   method (see SKILL.md gotcha). Press **Esc** to close the detail view before the next
   prompt. Why not a JS "grab the last image" shortcut: when a **character sheet is
   attached**, that sheet is an `<img>` in the DOM at its own size (e.g. `1024×1535`) while
   generated stills are `941×1672`, and long chats keep cached/older portrait layers — a
   "last/largest portrait" grab silently saves the **sheet or a previous scene**. The
   detail-view download acts on exactly the image you clicked, so it can't pick the sheet.
   **Always eyeball the saved PNG** and re-grab if it's the turnaround sheet or wrong scene.

7. **Validate.** `file Image/<slug>.png` should show a portrait PNG. Typical
   ChatGPT output is `941 x 1672`. If it reads `1024×1535` you grabbed the **attached
   character sheet**, not a scene — re-download via the detail view. Also open the image
   and confirm it's the intended scene (not a repeat of an earlier cut).

## Playwright MCP pattern

```js
const box = page.locator('div[role="textbox"][aria-label="ChatGPT와 채팅"]').first();
await box.click();
await page.keyboard.insertText(imagePrompt);
await page.getByTestId('send-button').click();

// Poll until a new portrait image appears and stop button is gone.
await page.waitForFunction(() =>
  !document.querySelector('[data-testid="stop-button"]') &&
  [...document.images].some(img => img.naturalWidth > 500 && img.naturalHeight > 900)
);

const imgs = page.locator('img');
const img = imgs.nth(await imgs.count() - 1);
await img.scrollIntoViewIfNeeded().catch(() => {});
const box2 = await img.boundingBox();
if (box2) await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);

await page.locator('button[aria-label="이 이미지 공유"]').last().click();
const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
await page.getByRole('button', { name: '다운로드' }).click();
const download = await downloadPromise;
await download.saveAs('/Users/beye/.../Image/<slug>.png');
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

⚠️ **Only when no character sheet is attached and the chat is short.** The selector below
picks the largest-area `<img>`, which can be the **attached sheet** (`1024×1535`) or a
cached older still rather than the new render — the exact failure the detail-view download
avoids. When a sheet is attached, prefer the detail-view download in Step 6. If you must use
this, filter to the generated size (`naturalWidth === 941`), pick the **last** match in DOM
order, and verify the saved PNG visually before trusting it.

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
