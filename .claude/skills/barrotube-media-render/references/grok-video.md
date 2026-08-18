# Grok Imagine video generation (browser, verified steps)

Goal: produce one **9:16 / 720p / ~10s** MP4 from a still image and save it as
`video/<slug>.mp4`. Use the user's logged-in grok.com session. Prefer Playwright
MCP when it is already logged in; it can upload through hidden file inputs and
save downloads directly with `download.saveAs()`.

## Steps

1. **Open the tab.** Navigate to `https://grok.com/imagine`. Wait ~3s. Confirm the
   prompt bar is visible and an account is logged in. Note which account; it may
   differ from ChatGPT.

2. **Set the option bar — then VERIFY.** Along the bottom of the prompt bar:
   `이미지 | 비디오 | 에이전트` · `480p | 720p` · `6s | 10s` · `Video audio` · `9:16 ▾`.
   - Select **비디오**, **720p**, **10s**, and aspect **9:16**.
   - Set **Video audio ON**. Do not infer state from the icon: inspect the button and
     require `aria-pressed="true"`. Click it only when false, then read the attribute again.
   - **Zoom into the option bar and confirm** the chosen pills are filled white
     (selected). The bar frequently already defaults to the right values — verify
     instead of blindly toggling, so you don't accidentally turn a correct option off.
   - To change aspect, click the `9:16 ▾` dropdown and pick 9:16.

3. **Provide the input.**
   - **Image→video is required for BarroTube reel continuity.** Attach the ChatGPT
     still from `Image/<slug>.png`, then type a short motion prompt.
   - **claude-in-chrome: copy the still into the session scratchpad first, then
     `file_upload`.** The tool rejects the *path*, not the file — `~/BarroTubeData/...`
     is refused, a session-shared copy is accepted (verified 2026-08-17, 4/4 uploads).
     `find` the hidden input, then `file_upload(tabId, ref, ["<scratchpad>/scene_NNN.png"])`.
   - **codex's Chrome surface cannot attach at all** — hidden-input injection, the
     composer picker, and Cmd+V all fail there (measured twice, 2026-08-17). Do not
     schedule sheet-dependent generation on the codex path; it will stop at the attach.
   - Playwright MCP (when available) can still inject directly:
     `page.locator('input[type="file"]').first().setInputFiles(imagePath)`.
   - Wait for the `Remove image` button or attached thumbnail. The uploaded filename
     may never become an accessible button, so filename visibility is not the gate.
   - Use text→video only as a fallback and report that character consistency may drop.

4. **Generate.** Record the current URL, then click send (↑). Wait for the new
   `/imagine/post/<id>` URL and that post's **"생성 중 NN%"** state (or its Download
   button if it finishes unusually fast). Grok is an SPA: the submit call can return
   while the URL still says `/imagine`. Do not treat that transient URL as failure, and
   do not query option-bar locators captured before navigation after the post opens.

5. **Wait to 100%.** Poll with short waits (≤10s each) and re-screenshot. Video gen
   typically takes ~30–90s. The result auto-plays in the canvas when done; a right-side
   action panel appears: `공유 · X에 게시 · 다운로드 · 재생성 · 연장 · 프리셋`.

6. **Download.** Click **다운로드**. With Playwright MCP, wrap it in
   `page.waitForEvent('download')`, then `download.saveAs('/.../video/<slug>.mp4')`.

7. **Validate.** `ffprobe` must show H.264 portrait video, an MP4 duration near 10s,
   and an **AAC audio stream**. Grok commonly returns 720×1280 or 720×1264; both are
   accepted portrait outputs. If audio is absent, the cut is incomplete: verify
   `Video audio aria-pressed="true"` and regenerate it. Some sessions return 6s despite
   the UI showing 10s; keep it only if visually acceptable and compensate in the merge.

   ```bash
   ffprobe -v error \
     -show_entries stream=codec_type,codec_name,width,height,sample_rate,channels \
     -show_entries format=duration -of json video/<slug>.mp4
   ```

## Playwright MCP pattern

```js
await page.goto('https://grok.com/imagine');
await page.waitForTimeout(1500);

for (const name of ['비디오', '720p', '10s']) {
  const option = page.getByRole('radio', { name });
  if (!(await option.isChecked())) await option.click();
}
const audio = page.locator('button[aria-label="Video audio"]');
if (await audio.getAttribute('aria-pressed') !== 'true') await audio.click();
if (await audio.getAttribute('aria-pressed') !== 'true') throw new Error('Video audio is off');

// If aspect shows 2:3, click the dropdown and choose "9:16 수직".
await page.locator('input[type="file"]').first().setInputFiles(imagePath);
await page.getByRole('button', { name: 'Remove image' })
  .waitFor({ state: 'visible', timeout: 15000 });

const box = page.locator('[role="textbox"][aria-label="Ask Grok anything"]').first();
await box.click();
await page.keyboard.insertText(motionPrompt);
const oldUrl = page.url();
await box.press('Enter');
await page.waitForURL(/\/imagine\/post\//, { timeout: 15000 });
if (page.url() === oldUrl) throw new Error('Grok did not open a new post');

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
