# Demucs ONNX

Portable Demucs v4 (`htdemucs`) inference using exported ONNX models and a Rust orchestration layer. The repository includes a native CLI and a fully client-side WASM web app. Model export requires PyTorch, but inference uses Rust and ONNX Runtime.

The model artifacts are derived from the [upstream Demucs models](https://github.com/adefossez/demucs), and the export builds on the ONNX work in [adefossez/demucs#10](https://github.com/adefossez/demucs/pull/10).

## Usage

Prerequisites: Rust, Python, `uv`, `pnpm`, and the GitHub CLI (`gh`).

Install dependencies and download the standard model using the current tag from the [releases page](https://github.com/hi-ogawa/demucs-onnx/releases):

The downloaded models are stored under `data/onnx-lean/`.

```bash
pnpm install
pnpm model-release download models-2026-07-11 htdemucs
```

Separate a WAV file into four stems:

```bash
pnpm cli-separate data/input/song.wav data/output/song
```

Fine-tuned minus mode works with `drums`, `bass`, `vocals`, or `other` and runs only the selected source's specialist instead of all four fine-tuned models, which makes inference about four times faster. For example, to split bass from the remaining mix:

```bash
pnpm model-release download models-2026-07-11 htdemucs_ft_bass
pnpm cli-separate --name htdemucs_ft --two-stems bass --method minus data/input/song.wav data/output/song
```

Other options:

- `--two-stems <source> --method add` emits a target stem and the sum of the remaining stems.
- `--name htdemucs_ft` selects the fine-tuned specialist models.
- `--shifts N` averages `N` seeded-offset passes. The default is one pass.

## Build Models Locally

Build models locally with:

```bash
pnpm build-model htdemucs
```

Run `pnpm build-model --all` to build the standard model and all fine-tuned specialists.

## Web App

Build the WASM binding and start the fully client-side app:

```bash
pnpm build-wasm
pnpm dev
```

Open `http://localhost:5173`, choose a local audio file, and run separation. Audio and models stay in the browser. During development, Vite serves the generated models from `data/onnx-lean/`.

Build the static app with:

```bash
pnpm build
```

The output in `packages/app/dist/` is configured for Cloudflare Workers static assets by `wrangler.jsonc`. Configure the Cloudflare build command as `pnpm build-cf`; production users select model files locally, so model artifacts are not included in the deployment.

## Repository

- [`crates/`](crates/) contains the Rust workspace: orchestration core, native ONNX Runtime CLI, and WASM binding.
- [`packages/app/`](packages/app/) contains the fully client-side Vite app.
- [`tools/model-export/`](tools/model-export/) contains the `uv`-managed model export, DFT stripping, and parity tools.
- [`docs/`](docs/) contains documentation about Demucs architecture, the model release process, and implementation history.
- `data/` is the gitignored and used for generated models, audio, and outputs.
