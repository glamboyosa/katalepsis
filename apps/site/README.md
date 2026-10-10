# katalepsis site

A static landing page. Everything the browser loads is in `public/`.

```bash
pnpm --filter site serve
```

Then open http://127.0.0.1:4321.

## Product video

`public/katalepsis-demo.mp4` is rendered, not screen-recorded. `video/stage.html` draws each scene as a function of time from real material in `video/assets/`: CLI output captured from actual runs on the demo form (with absolute paths shortened to project-relative ones) and screenshots of the real reports. To render it again on macOS, with the site server running:

```bash
node video/render-frames.mjs /tmp/katalepsis-frames 30
swift video/encode.swift /tmp/katalepsis-frames public/katalepsis-demo.mp4 30
```

The encoder uses AVFoundation, which ships with macOS, so no ffmpeg is needed.
