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
pnpm tsx tools/generate-benchmark-fixture.ts
cargo build --release -p demucs-cli
pnpm build-wasm
pnpm tsx tools/benchmark-native.ts
pnpm -C packages/app benchmark
pnpm tsx tools/benchmark-summary.ts
```

Each command is independent and should be run in order. They generate the fixture, build the native and WASM targets, run both backends, and produce a median summary. Results are written under `data/benchmark/`:

```text
native.json
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
