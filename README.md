# Demucs ONNX

Portable Demucs v4 (`htdemucs`) inference built from exported ONNX models and a Rust orchestration layer. The repository includes a native CLI, Node binding, and fully client-side WASM web app.

The model artifacts are derived from the [upstream Demucs models](https://github.com/adefossez/demucs), and the export builds on the ONNX work in [adefossez/demucs#10](https://github.com/adefossez/demucs/pull/10).

The CLI separates WAV input into Demucs stems using locally exported ONNX models. Model export requires PyTorch, but inference uses the native Rust and ONNX Runtime stack.

## Usage

Prerequisites: Rust, `uv`, and `pnpm`.

One-time setup from the repository root:

```bash
pnpm install
pnpm build:model htdemucs
```

Alternatively, download the prebuilt standard model using a tag from the [releases page](https://github.com/hi-ogawa/demucs-onnx/releases):

```bash
pnpm model-release download models-2026-07-11 htdemucs
```

Separate a WAV file into four stems:

```bash
pnpm cli-separate \
  --name htdemucs \
  data/input/song.wav data/output/song
```

Useful variants:

- `--two-stems <source> --method add` emits a target stem and the sum of the remaining stems.
- `--two-stems <source> --method minus` emits a target stem and subtracts it from the input mix.
- `--name htdemucs_ft` uses the four fine-tuned specialist models.
- `--shifts N` averages `N` seeded-offset passes. The default is one pass.
- `node crates/napi/cli.mjs separate ...` exposes the same flow through the Node binding.

Both setup paths create the size-optimized standard model under `data/onnx-lean/`. Run `pnpm build:model --all` to build the standard model and all fine-tuned specialists locally. Passing explicit member names builds an exact subset. For release downloads, omit `htdemucs` to download all models. See [Model releases](docs/model-release.md) for partial downloads and maintainer publishing instructions.

## Web App

Prerequisite: install [`wasm-pack`](https://rustwasm.github.io/wasm-pack/installer/) and make it available on `PATH`.

Build the WASM binding and start the fully client-side app:

```bash
pnpm install
pnpm build:wasm
pnpm dev
```

Open `http://localhost:5173`, choose a local audio file, and run separation. Audio and models stay in the browser; Vite serves the generated models from `data/onnx-lean/` during development.

## Repository

- `crates/` contains the Rust workspace: orchestration core, ONNX Runtime driver, CLI, Node binding, and WASM binding.
- `packages/app/` contains the fully client-side Vite app.
- `tools/model-export/` contains the uv-managed model export, DFT stripping, and parity tools.
- `docs/architecture.md` describes the runtime and artifact design.
- `docs/model-release.md` documents downloading and publishing model artifacts.
- `docs/demucs.md` documents upstream Demucs mechanics and prior art.
- `docs/development.md` records the chronological implementation process and measurements.
- `docs/history.md` preserves the original motivation and prototype completion timeline.
- `docs/pipeline.html` is a visual review of model selection and orchestration.

Generated models, audio, and outputs live under the gitignored `data/` directory.
