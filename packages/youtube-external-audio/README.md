# YouTube External Audio Prototype

A standalone Chrome extension prototype that replaces a normal YouTube
video's audio with an arbitrary local audio file. YouTube remains the source
of truth for play, pause, seeking, and playback rate.

This implements the first three prototype milestones:

1. YouTube watch-page extension shell and SPA lifecycle.
2. Local audio selection and replacement toggle.
3. Discrete player synchronization.

Continuous drift correction, automatic file lookup, acquisition, and audio
processing are intentionally out of scope.

## Build and load

```sh
pnpm install
pnpm test
pnpm build
```

After building, `pnpm test-e2e` loads the extension in Chromium against a real
YouTube watch page.

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select this repository's `dist/extension` directory. The packaged extension
is available at `dist/extension.zip`.

On a normal YouTube watch page, choose a local audio file from the control in
the bottom-right corner and enable replacement audio. YouTube's existing
controls and keyboard shortcuts continue to control the video; the extension
follows the resulting media events.

## Attribution

The YouTube content-script integration patterns are adapted from
[Zamak (ytsub-v5)](https://github.com/hi-ogawa/ytsub-v5), as documented next
to the adapted lifecycle code in `src/content.tsx`.
