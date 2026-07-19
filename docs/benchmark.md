# Native and Web Benchmark

The benchmark compares the current native ONNX Runtime CLI with Chromium's threaded `onnxruntime-web` WASM backend. Both paths use the same `demucs-core` separation plan and report model loading, inference, finalization, and total separation time through their existing progress boundaries.

## Scope

The initial benchmark deliberately fixes the workload:

- A deterministic 30-second, 44.1 kHz stereo multi-tone WAV
- `htdemucs`
- Full four-stem output
- One shift
- One unreported warm-up and three measured runs per backend

The inference graph receives fixed-size chunks, so the synthetic signal is suitable for measuring runtime. It is not intended to measure separation quality.

Native inference currently sets ONNX Runtime to four intra-op threads. Chromium uses the threaded WASM build under cross-origin isolation. These settings represent current product behavior rather than a controlled thread-scaling comparison.

## Run

Download the standard model first:

```bash
pnpm install
pnpm model-release download models-2026-07-11 htdemucs
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

Each command is independent and should be run in order. Native run 0 is the warm-up; runs 1 through 3 are summarized. Results are written under `data/benchmark/`:

```text
web.json
summary.json
```

Generated fixtures, stems, and results remain under the gitignored `data/` directory.

## Timing Boundaries

- `loadMs` covers ONNX session creation and model loading.
- `inferenceMs` covers all model chunk runs for the selected workload.
- `finalizeMs` covers stem finalization after inference.
- `totalMs` covers preparation through finalization, but excludes WAV encoding, ZIP creation, and output writing for cross-backend comparability.

The native raw result additionally records output writing and complete process-level work as `writeMs` and `endToEndMs`. Its comparable `totalMs` is preparation through finalization, matching the web boundary. The benchmark preserves all raw records for inspection.
