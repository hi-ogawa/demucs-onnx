# Demucs ONNX

Portable Demucs v4 (`htdemucs`) inference built from exported ONNX models and a Rust orchestration layer. The repository includes a native CLI, Node binding, and fully client-side WASM web app.

The CLI separates WAV input into Demucs stems using locally exported ONNX models. Model export requires PyTorch, but inference uses the native Rust and ONNX Runtime stack.

## Usage

Prerequisites: Rust and `uv`.

One-time setup from the repository root:

```bash
# Install the pinned export environment and export the standard model. This downloads the
# upstream checkpoint and writes a ~304 MB ONNX model.
cd tools/model-export
uv sync
uv run python export_onnx.py --model htdemucs --out ../../data/onnx

# Move the shared DFT tensors into an external data file, matching the production layout.
uv run python strip_dft.py --models htdemucs \
  --src ../../data/onnx --out ../../data/onnx-lean
cd ../..

# Build the Rust CLI.
cargo build --release -p demucs-cli
```

Separate a WAV file into four stems:

```bash
./target/release/demucs-rs-proto separate \
  --models data/onnx-lean \
  --name htdemucs \
  data/input/song.wav data/output/song
```

Useful variants:

- `--two-stems <source> --method add` emits a target stem and the sum of the remaining stems.
- `--two-stems <source> --method minus` emits a target stem and subtracts it from the input mix.
- `--name htdemucs_ft` uses the four fine-tuned specialist models.
- `--shifts N` averages `N` seeded-offset passes. The default is one pass.
- `node crates/napi/cli.mjs separate ...` exposes the same flow through the Node binding.

The setup above creates the size-optimized standard model under `data/onnx-lean/`. See [development history](docs/development.md) sections 2 and 7 to export all fine-tuned specialists and deduplicate their shared DFT data.

## Repository

- `crates/` contains the Rust workspace: orchestration core, ONNX Runtime driver, CLI, Node binding, and WASM binding.
- `packages/app/` contains the fully client-side Vite app.
- `tools/model-export/` contains the uv-managed model export, DFT stripping, and parity tools.
- `docs/architecture.md` describes the runtime and artifact design.
- `docs/demucs.md` documents upstream Demucs mechanics and prior art.
- `docs/development.md` records the chronological implementation process and measurements.
- `docs/history.md` preserves the original motivation and prototype completion timeline.
- `docs/pipeline.html` is a visual review of model selection and orchestration.

Generated models, audio, and outputs live under the gitignored `data/` directory.
