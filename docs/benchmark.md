# Native and Web Benchmark

The benchmark compares the current native ONNX Runtime CLI with Chromium's threaded `onnxruntime-web` WASM backend. Both paths use the same `demucs-core` separation plan and report model loading, inference, finalization, and total separation time through their existing progress boundaries.

## Scope

The initial benchmark deliberately fixes the workload:

- A deterministic 30-second, 44.1 kHz stereo multi-tone WAV
- `htdemucs`
- Full four-stem output
- One shift
- Native ONNX Runtime default, 1, 2, 4, 8, and 16 intra-op threads
- One unreported warm-up and three measured runs per configuration

The inference graph receives fixed-size chunks, so the synthetic signal is suitable for measuring runtime. It is not intended to measure separation quality.

The CLI defaults to four intra-op threads. Passing `--threads 0` leaves thread selection to ONNX Runtime. Chromium uses the threaded WASM build under cross-origin isolation.

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
for threads in 0 1 2 4 8 16; do
  label=$threads
  test "$threads" = 0 && label=default
  for run in 0 1 2 3; do
    rm -rf "data/benchmark/native-threads-$label-run-$run"
    target/release/demucs separate \
      --models data/onnx-lean \
      --threads "$threads" \
      --timings-json "data/benchmark/native-threads-$label-run-$run.json" \
      data/benchmark/input-30s.wav \
      "data/benchmark/native-threads-$label-run-$run"
  done
done
pnpm -C packages/app benchmark
pnpm tsx tools/benchmark-summary.ts
```

Each command is independent and should be run in order. Run 0 of each native thread configuration is the warm-up; runs 1 through 3 are summarized. Results are written under `data/benchmark/`:

```text
web.json
summary.json
```

Generated fixtures, stems, and results remain under the gitignored `data/` directory.

## Timing Boundaries

- `loadMs` covers ONNX session creation and model loading.
- `inferenceMs` covers all model chunk runs for the selected workload.
- Each run retains one raw timing record per chunk with its member, shift, and chunk index.
- `prepareInputMs` covers chunk input materialization and native tensor-view setup.
- `ortRunMs` covers only the chunk's ONNX Runtime `Session::run` call.
- `outputCopyMs` covers the chunk's browser copy from ONNX Runtime output into WASM memory; it is zero for native inference.
- `processOutputMs` covers the chunk's output extraction, validation, and overlap-add processing.
- `finalizeMs` covers stem finalization after inference.
- `totalMs` covers preparation through finalization, but excludes WAV encoding, ZIP creation, and output writing for cross-backend comparability.

The native raw result additionally records output writing and complete process-level work as `writeMs` and `endToEndMs`. Its comparable `totalMs` is preparation through finalization, matching the web boundary. The benchmark preserves all raw records for inspection.

## Results

Measured on Linux x64 with an Intel Core i7-12650H (10 physical cores, 16 logical CPUs). Each configuration used one warm-up and three measured runs.

| Backend       |     Intra-op threads | Inference median | Run spread |
| ------------- | -------------------: | ---------------: | ---------: |
| Native        |                    1 |          32.507s |       0.7% |
| Native        |                    2 |          19.614s |       3.0% |
| Native        |                    4 |          13.903s |       3.5% |
| Native        |                    8 |          12.327s |       1.7% |
| Native        |                   16 |          11.905s |       1.8% |
| Native        | ONNX Runtime default |          12.495s |       2.2% |
| Chromium WASM |      runtime-managed |          36.167s |       3.3% |

Sixteen native threads were fastest on this machine and ran inference about 3.04 times faster than Chromium WASM. The ONNX Runtime default was within 5% of the fastest result, while the CLI's conservative four-thread default was about 14% slower than the fastest result.

### Timing Breakdown

Inference dominates both backends. At four native threads, the median 14.507-second comparable total was approximately 0.2% audio preparation, 3.9% model loading, 95.8% inference, and 0.1% finalization. At 16 native threads, inference remained about 95.2% of the 12.506-second total. WAV writing took roughly 40 to 70 milliseconds and is excluded from the comparable total.

For Chromium WASM, the median 37.183-second total was approximately 2.3% model loading, 97.3% inference, less than 0.1% finalization, and 0.4% other preparation and dispatch.

`inferenceMs` remains the wall-clock user-facing duration. Raw chunk records preserve variance, first-chunk effects, and component correlations; the summary derives aggregate component totals later. Component sums may differ slightly from wall time because they exclude progress dispatch and host-boundary overhead, and they will not represent elapsed time if chunk inference becomes concurrent in the future.

### Chunk Components

A single follow-up run retained all six chunks for the 30-second workload. Native used four intra-op threads. Reproduce the raw `small-native.json` and `small-web.json` artifacts with:

```bash
rm -rf data/benchmark/small-native
target/release/demucs separate \
  --models data/onnx-lean \
  --threads 4 \
  --timings-json data/benchmark/small-native.json \
  data/benchmark/input-30s.wav data/benchmark/small-native
pnpm -C packages/app exec playwright test \
  --config benchmark/playwright.config.ts benchmark/e2e/small.spec.ts
```

| Component           |  Native | Chromium WASM |
| ------------------- | ------: | ------------: |
| Inference wall time | 13.048s |       31.795s |
| ONNX Runtime runs   | 13.037s |       31.716s |
| Input preparation   |   4.1ms |           6ms |
| Output copy         |       0 |         6.3ms |
| Output processing   |   6.8ms |          12ms |

ONNX Runtime graph execution accounted for 99.92% of native inference time and 99.75% of browser inference time. Native chunk run times ranged from 2.095 to 2.254 seconds, while browser chunks ranged from 5.141 to 5.421 seconds. JavaScript/WASM boundaries, output copying, and overlap-add were negligible in this sample, so the native/browser performance gap is overwhelmingly within ONNX Runtime graph execution. External chunk concurrency may still be useful as an alternative ONNX Runtime scheduling strategy, but not primarily to hide orchestration overhead.
