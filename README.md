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

In a secondary Git worktree, reuse the main worktree's gitignored `data/` directory instead of downloading the models again:

```bash
pnpm link-wt
```

This creates a `data` symlink and refuses to replace an existing file, directory, or symlink.

Separate a WAV file into vocals, drums, bass, and other. `other` contains
instruments not classified as vocals, drums, or bass.

```bash
pnpm cli-separate data/input/song.wav data/output/song
```

To create a bass track and a backing track without bass:

```bash
pnpm model-release download models-2026-07-11 htdemucs_ft_bass
pnpm cli-separate --name htdemucs_ft --two-stems bass --two-stems-mix minus data/input/song.wav data/output/song
```

This creates `bass.wav` and `backing.wav`.

Run the same separation flow through the Rust/WASM driver and
`onnxruntime-web`'s Node WASM runtime with:

```bash
pnpm build-wasm
pnpm wasm-separate --models data/onnx-lean data/input/song.wav data/output/song
```

The WASM CLI accepts the same `--name`, `--two-stems`, `--two-stems-mix`, and
`--shifts` options as the native CLI. Its WAV decoder currently requires 44.1
kHz PCM or float input.

| Option                         | Explanation                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name htdemucs\|htdemucs_ft` | Chooses the standard general-purpose model or the fine-tuned source-specialist models.                                                                                                                                                                            |
| `--two-stems <source>`         | Selects a `drums`, `bass`, `vocals`, or `other` source and outputs it with a mix without it. By default, outputs all four stems.                                                                                                                                  |
| `--two-stems-mix add\|minus`   | Chooses the backing-mix quality and speed tradeoff. `add` combines the other separated stems. `minus` subtracts the source from the original and, with `htdemucs_ft`, runs about four times faster by using only that source's specialist. Results vary by track. |
| `--shifts N`                   | Trades speed for separation quality by averaging `N` processing passes. Runtime grows roughly in proportion. The default is one pass.                                                                                                                             |

## Build Models Locally

Build models locally with:

```bash
pnpm build-model htdemucs
```

Run `pnpm build-model --all` to build the standard model and all fine-tuned specialists.

## Benchmark

Compare native ONNX Runtime inference with Chromium's ONNX Runtime WASM backend using a deterministic 30-second workload:

```bash
mkdir -p data/benchmark
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=30" \
  -filter_complex "[0:a]asplit=2[left][right];[left][right]join=inputs=2:channel_layout=stereo" \
  -c:a pcm_f32le -y data/benchmark/input-30s.wav
cargo build --release -p demucs-cli
pnpm build-wasm
for run in 0 1 2 3; do
  rm -rf "data/benchmark/native-run-$run"
  target/release/demucs separate \
    --models data/onnx-lean \
    --timings-json "data/benchmark/native-run-$run.json" \
    data/benchmark/input-30s.wav "data/benchmark/native-run-$run"
done
pnpm -C packages/app benchmark
pnpm tsx tools/benchmark-summary.ts
```

See [`docs/benchmark.md`](docs/benchmark.md) for the workload, timing boundaries, and generated results.

## Web App

Build the WASM binding and start the fully client-side app:

```bash
pnpm build-wasm
pnpm dev
```

Open `http://localhost:5173`, choose a local audio file and the required model files from `data/onnx-lean/`, then run separation. Audio and models stay in the browser.

When separation finishes, the app automatically downloads all generated stems as a source-named archive such as `song_wav.stems.zip`. Individual stem previews and WAV downloads remain available in the results.

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
