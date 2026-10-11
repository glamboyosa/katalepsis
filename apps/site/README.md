# katalepsis site

A static landing page. Everything the browser loads is in `public/`.

```bash
pnpm --filter site serve
```

Then open http://127.0.0.1:4321.

## Deploying

The site is meant for https://www.katalepsis.glamboyosa.xyz. On Vercel, set the project's root directory to `apps/site`. `vercel.json` serves `public/` as is and redirects `/install.sh` to the installer on GitHub, so `curl -fsSL https://www.katalepsis.glamboyosa.xyz/install.sh | sh` works once the domain points at the deployment.

## Product video

`public/katalepsis-demo.mp4` is rendered, not screen-recorded. `video/stage.html` draws each scene as a function of time from real material in `video/assets/`: CLI output captured from actual runs on the demo form (with absolute paths shortened to project-relative ones) and screenshots of the real reports. To render it again on macOS, with the site server running:

```bash
node video/render-frames.mjs /tmp/katalepsis-frames 30
swift video/encode.swift /tmp/katalepsis-frames public/katalepsis-demo.mp4 30
```

The encoder uses AVFoundation, which ships with macOS, so no ffmpeg is needed.

## Link previews

`public/og.png` is the 1200x630 image X, LinkedIn, Slack and iMessage show for links to the site. It is rendered from `og/og.html`:

```bash
node og/render.mjs
```
