---
created: 2026-06-30
tags:
  - operations
  - instagram
  - publishing
---

# Instagram Reels 게시 운영

## Script

```bash
node /Users/beye/youtube-co/scripts/automation/publish-instagram-reels.js \
  --video-url <public_https_mp4> \
  --meta <reel>/70_publish_meta.instagram.json
```

Local file mode may fail depending on Graph API token/host behavior. In the tested setup, Instagram required `video_url`.

## Temporary Public URL Flow

1. Serve the final export folder locally.
2. Open a temporary HTTPS tunnel.
3. Verify `curl -I <url>/video.mp4` returns `content-type: video/mp4`.
4. Publish with `--video-url`.
5. Save result to `<reel>/80_publish_result.instagram.json`.
6. Shut down tunnel and local server.

## EP02 Result

- Reel: EP02 - 놀이동산 간 조선 선비
- Published: 2026-06-30 22:19 KST
- URL: https://www.instagram.com/reel/DaNiFfPlamY/
- Result file: `/Users/beye/BarroAiFactory/takitani.lab/barrotube/ep02_reel/80_publish_result.instagram.json`

## Security

- Do not commit access tokens.
- Do not paste tokens into markdown notes.
- Store tokens in `.env`, environment variables, or macOS Keychain only.
