# Grok Imagine video generation (browser, verified steps)

Goal: produce one **9:16 / 720p / ~10s** MP4 from a still image and save it as
`video/<slug>.mp4`. Use the user's logged-in grok.com session. Scheduled BarroTube
jobs first use `grok-motion-applescript.js`, which binds the regular Chrome PID and
window/tab IDs. Playwright is an alternative only when its own profile is ready;
an isolated Chrome does not inherit the user's login or Apple Events setting.

## Steps

1. **Open the tab.** Navigate to `https://grok.com/imagine`. Wait ~3s. Confirm the
   prompt bar is visible and an account is logged in. Note which account; it may
   differ from ChatGPT.

2. **Set the option bar — then VERIFY.** Two different kinds of control live here, and
   mixing them up is what broke this step for four days.
   - **Toggles** (still buttons): mode `비디오` carries `aria-checked`, `Video audio`
     (`aria-label="비디오 오디오"`) carries `aria-pressed`. Click each **only when it is
     false** — clicking an already-on toggle turns it off, and a submit click that lands
     during that re-render is swallowed silently (2026-09-02 EP-0131, two cuts).
   - **Dropdowns** (since the 2026-09-17 UI change): resolution, duration and aspect are
     no longer pills. They are `button[aria-haspopup="menu"]` whose label shows the
     **current value** (`720p`, `10s`, `9:16`), and the menu items are `role="menuitemradio"`.
     Find the trigger by the shape of its text, not by the value you want — the trigger
     reads `480p` when 480p is selected, so looking for a control labelled "720p" finds
     nothing. **New accounts default to 480p.**
   - They are Radix menus: a plain `click()` does not open them. Dispatch **`pointerdown`**,
     then click the `menuitemradio` whose text equals the target value.
   - Confirm the trigger's text afterwards. If it will not move to 720p/10s, or an upgrade
     dialog appears, stop before attaching or generating — the attachment alone can start
     a post. Never start a trial or purchase.
   - Why this matters: the old pill-hunting code silently failed `--check` (exit 3) every
     run, so the pipeline skipped Grok entirely and shipped EP-2026-0156~0159 as
     HyperFrames pans. The failure looked like "logged out", which it never was.

3. **Provide the input.**
   - **Image→video is required for BarroTube reel continuity.** Attach the ChatGPT
     still from `Image/<slug>.png`, then type a short motion prompt.
   - **claude-in-chrome: copy the still into the session scratchpad first, then
     `file_upload`.** The tool rejects the *path*, not the file — `~/BarroTubeData/...`
     is refused, a session-shared copy is accepted (verified 2026-08-17, 4/4 uploads).
     `find` the hidden input, then `file_upload(tabId, ref, ["<scratchpad>/scene_NNN.png"])`.
   - **Check the actual browser surface.** The regular Chrome Apple Events path
     successfully attached a local still through DataTransfer on 2026-09-14.
     Earlier extension upload failures do not apply to every Codex environment.
   - Playwright MCP (when available) can still inject directly:
     `page.locator('input[type="file"]').first().setInputFiles(imagePath)`.
   - Wait for the `Remove image` button or attached thumbnail. The uploaded filename
     may never become an accessible button, so filename visibility is not the gate.
   - Use text→video only as a fallback and report that character consistency may drop.

4. **Generate.** Record the current URL, then click send (↑). Wait for the new
   `/imagine/post/<id>` URL and that post's **"생성 중 NN%"** state (or its Download
   button if it finishes unusually fast). The new ID must differ from the path just
   before submission: attaching the image can already create a still-image post.
   Grok is an SPA: the submit call can return
   while the URL still says `/imagine`. Do not treat that transient URL as failure, and
   do not query option-bar locators captured before navigation after the post opens.

5. **Wait to 100%.** Poll with short waits (≤10s each) and re-screenshot. Video gen
   typically takes ~30–90s. The result auto-plays in the canvas when done; a right-side
   action panel appears: `공유 · X에 게시 · 다운로드 · 재생성 · 연장 · 프리셋`.

6. **Download.** Click **다운로드**. With Playwright MCP, wrap it in
   `page.waitForEvent('download')`, then `download.saveAs('/.../video/<slug>.mp4')`.
   The Apple Events script fetches the same post's video through the authenticated
   page and transfers it in chunks. Never select an older history-strip video.

7. **Validate.** `ffprobe` must show H.264 portrait video, an MP4 duration near 10s,
   and an **AAC audio stream**. Grok commonly returns 720×1280 or 720×1264; both are
   accepted portrait outputs. If audio is absent, the cut is incomplete: verify
   `Video audio aria-pressed="true"` and regenerate it. A 480p/6s result does not meet
   the default requirement even when the UI previously showed 720p/10s. Keep it out
   of completed scene assets and report the quality mismatch.

   ```bash
   ffprobe -v error \
     -show_entries stream=codec_type,codec_name,width,height,sample_rate,channels \
     -show_entries format=duration -of json video/<slug>.mp4
   ```

## Playwright MCP pattern

```js
await page.goto('https://grok.com/imagine');
await page.waitForTimeout(1500);

// Toggles: press only when off (pressing an on-toggle turns it off).
const mode = page.locator('button[aria-label="비디오"], button[aria-label="Video"]').first();
if (await mode.getAttribute('aria-checked') !== 'true') await mode.click();
const audio = page.locator('button[aria-label="비디오 오디오"], button[aria-label="Video audio"]').first();
if (await audio.getAttribute('aria-pressed') !== 'true') await audio.click();
if (await audio.getAttribute('aria-pressed') !== 'true') throw new Error('Video audio is off');

// Dropdowns (Radix, since 2026-09-17): the trigger shows the CURRENT value, so match it
// by shape. It opens on pointerdown, not click.
for (const [shape, want] of [[/^\d{3,4}p$/, '720p'], [/^\d+s$/, '10s'], [/^\d+:\d+$/, '9:16']]) {
  const trigger = page.locator('button[aria-haspopup="menu"]')
    .filter({ hasText: shape }).first();
  if ((await trigger.innerText()).trim() === want) continue;
  await trigger.dispatchEvent('pointerdown');
  await page.getByRole('menuitemradio', { name: want, exact: true }).click();
  if ((await trigger.innerText()).trim() !== want) throw new Error(`${want} unavailable; check plan/quota`);
}
await page.locator('input[type="file"]').first().setInputFiles(imagePath);
await page.getByRole('button', { name: 'Remove image' })
  .waitFor({ state: 'visible', timeout: 15000 });

const box = page.locator('[role="textbox"][aria-label="Ask Grok anything"]').first();
await box.click();
await page.keyboard.insertText(motionPrompt);
const oldUrl = page.url();
await box.press('Enter');
await page.waitForURL(url => url.pathname.startsWith('/imagine/post/') && url.href !== oldUrl,
  { timeout: 15000 });

// Poll the new post until its own download control appears.
const downloadButton = page.getByRole('button', { name: '다운로드' });
await downloadButton.waitFor({ state: 'visible', timeout: 90000 });
const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
await downloadButton.click();
const download = await downloadPromise;
await download.saveAs('/Users/beye/.../video/<slug>.mp4');
```

## Gotchas

- **The "experiencing issues" banner is not a stop sign.** grok.com sometimes shows
  `Grok is experiencing issues. We are working on restoring service as quickly as
  possible.` while image→video generation still works normally. 2026-08-18: the banner
  stayed up across reloads for over an hour, yet all five EP-0098 clips generated and
  downloaded fine. **Try one cut before believing it.** Treat an actual failed generate
  or a stuck 생성 중 as the real signal, not the banner.

- **SuperGrok paywall.** On some accounts / when a quota is spent, clicking generate
  opens a **SuperGrok** subscription modal ($/월, "무료 체험"). **Do not pay or start a
  trial.** Close it (X, top-right), report to the user, and offer: try later, use a
  different signed-in account, or deliver just the ChatGPT still. Verify by re-clicking
  once; if it reopens, the quota/plan is the blocker.
- **Window too short for full-frame capture.** Not needed for downloading (use the
  Download button), but if you ever render the raw frame to screenshot, the 1280-tall
  9:16 frame won't fit a normal viewport — resize the window or just rely on the file.
- **Don't confuse 공유/X에 게시 with 다운로드.** Only **다운로드** writes a local file.
- **The default aspect may be 2:3.** Open the aspect menu and choose **9:16 수직**
  before generating. If the UI still shows 2:3 in a subsequent fresh page, set it again.
- **Do one cut at a time.** Generate, wait, download, validate, then navigate back to
  `/imagine` for the next cut. This avoids duplicate downloads and option drift.
