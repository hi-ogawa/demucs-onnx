# Bass-Cover Workflow

Produce `bass.wav` and `no_bass.wav` from a YouTube ID or URL without the original Docker and PyTorch inference runtime.

Prerequisites: Rust, `uv`, `pnpm`, `ffmpeg`, and `yt-dlp`.

## Setup

Run the one-time setup from the repository root:

```bash
pnpm install

# Install the pinned export environment and build the fine-tuned bass specialist.
pnpm build:model htdemucs_ft_bass
```

## Run

Pass a YouTube ID or URL to the workflow script:

```bash
pnpm bass-cover 6q8UMVXhXsE --name triples-baby-flower
# -> data/output/triples-baby-flower/bass.wav + no_bass.wav

pnpm bass-cover 6q8UMVXhXsE --name triples-baby-flower --start 10 --end 20
# -> data/output/triples-baby-flower-trim-s10-e20/bass.wav + no_bass.wav
```

The wrapper downloads audio, optionally trims it, and delegates to the same `pnpm cli-separate` wrapper documented in the README with the settled `htdemucs_ft` two-stems bass/minus configuration. Minus mode loads only the bass specialist and computes `no_bass = mix - bass`, so it avoids running the other three specialists.

For the measurements and A/B decision behind these defaults, see [development.md](development.md), especially section 8.
