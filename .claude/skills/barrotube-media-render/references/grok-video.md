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
   `이미지 | 비디오 | 에이전트` · `480p | 720p` · `6s | 10s` · `9:16 ▾`.
   - Select **비디오**, **720p**, **10s**, and aspect **9:16**.
   - **Zoom into the option bar and confirm** the chosen pills are filled white
     (selected). The bar frequently already defaults to the right values — verify
     instead of blindly toggling, so you don't accidentally turn a correct option off.
   - To change aspect, click the `9:16 ▾` dropdown and pick 9:16.

3. **Provide the input.**
   - **Image→video is required for BarroTube reel continuity.** Attach the ChatGPT
     still from `Image/<slug>.png`, then type a short motion prompt.
   - If `browser_file_upload` reports no modal state, use the hidden input directly:
     `page.locator('input[type="file"]').first().setInputFiles(imagePath)`.
   - Use text→video only as a fallback and report that character consistency may drop.

4. **Generate.** Click the send (↑) button. A 9:16 canvas shows **"생성 중 NN%"**.

5. **Wait to 100%.** Poll with short waits (≤10s each) and re-screenshot. Video gen
   typically takes ~30–90s. The result auto-plays in the canvas when done; a right-side
   action panel appears: `공유 · X에 게시 · 다운로드 · 재생성 · 연장 · 프리셋`.

6. **Download.** Click **다운로드**. With Playwright MCP, wrap it in
   `page.waitForEvent('download')`, then `download.saveAs('/.../video/<slug>.mp4')`.

7. **Validate.** `ffprobe` should show h264 video, portrait resolution, and an MP4
   duration near 10s. Some Grok sessions return 6s despite the UI showing 10s; keep
   it if visually acceptable and compensate in the final trim/merge.

## Playwright MCP pattern

```js
await page.goto('https://grok.com/imagine');
await page.waitForTimeout(1500);

await page.evaluate(() => {
  for (const txt of ['비디오', '720p', '10s']) {
    const b = [...document.querySelectorAll('button')]
      .find(x => (x.innerText || x.textContent || '').trim() === txt);
    if (b) b.click();
  }
});

// If aspect shows 2:3, click the dropdown and choose "9:16 수직".
await page.locator('input[type="file"]').first().setInputFiles(imagePath);
await page.waitForTimeout(2500);

const box = page.locator('[role="textbox"][aria-label="Ask Grok anything"]').first();
await box.click();
await page.keyboard.insertText(motionPrompt);
await page.locator('button[aria-label="제출"]').click();

// Poll body text until "다운로드" appears.
const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
await page.getByRole('button', { name: '다운로드' }).click();
const download = await downloadPromise;
await download.saveAs('/Users/beye/.../video/<slug>.mp4');
```

## Gotchas

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
