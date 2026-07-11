# Bass-Cover Workflow

Produce `bass.wav` and `no_bass.wav` from a YouTube ID or URL without the original Docker and PyTorch inference runtime.

Prerequisites: Rust, `uv`, `ffmpeg`, and `yt-dlp`.

## Setup

Run the one-time setup from the repository root:

```bash
# Install the pinned export environment and export the fine-tuned bass specialist.
cd tools/model-export
uv sync
uv run python export_onnx.py --model htdemucs_ft --sources bass --out ../../data/onnx

# Move the shared DFT tensors into an external data file.
uv run python strip_dft.py --models htdemucs_ft_bass \
  --src ../../data/onnx --out ../../data/onnx-lean
cd ../..

# Build the Rust CLI.
cargo build --release -p demucs-cli
```

## Run

Pass a YouTube ID or URL to the workflow script:

```bash
./docs/bass-cover.py 6q8UMVXhXsE --name triples-baby-flower
./docs/bass-cover.py 6q8UMVXhXsE --name triples-baby-flower --start 10 --end 20
# -> data/output/<name>/bass.wav + no_bass.wav
```

The wrapper downloads audio, optionally trims it, and runs the settled `htdemucs_ft` two-stems bass/minus configuration. Minus mode loads only the bass specialist and computes `no_bass = mix - bass`, so it avoids running the other three specialists.

For the measurements and A/B decision behind these defaults, see [development.md](development.md), especially section 8.
