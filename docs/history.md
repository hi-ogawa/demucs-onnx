# Project History

## Motivation

This project started as a curiosity-driven port of the Demucs v4 (`htdemucs`) inference pipeline to a portable native stack: an exported ONNX model for the neural core plus a Rust orchestration layer, eventually packaged as a Rust CLI, JS CLI, and web frontend.

The goal was to get into the actual model and inference code and reproduce the pipeline rather than trust existing ports. The practical tie-in was an existing bass stem separation workflow built around a 1.4 GB Docker and PyTorch setup.

The product direction was arbitrary stem choice: all stems, any two-stems split, and add/minus methods. Stem-specific loading, such as bass-only loading for minus mode, was treated as a runtime optimization rather than an artifact-level shortcut.

## Prototype Timeline

1. **Baseline ONNX artifact:** Plain `htdemucs` was exported into a single approximately 304 MB binary, with one model producing all four stems in one forward pass. It was parity-verified against the original Torch path at a maximum absolute difference of 7.3e-4. The baseline was used for simple Rust bring-up, while workflow parity required the four `htdemucs_ft` specialist exports.
2. **Rust end-to-end prototype:** The Rust pipeline implemented WAV decoding, normalization, chunking, ONNX Runtime inference, triangular overlap-add, and four-stem WAV output. It matched the Python Demucs CLI at a maximum absolute difference of 3.7e-5 and 73-103 dB SNR on a 12-second synthetic clip on 2026-07-09.
3. **Workflow-replacement CLI:** All five models were exported and parity-checked. The CLI added 48 kHz resampling, the fine-tuned bag, two-stems add/minus modes, and deterministic shifts. Fine-tuned two-stems output matched the Python CLI at 92-94 dB SNR. Minus mode loaded one of four models, providing a four-times fast path absent upstream.
4. **DFT kernel deduplication:** `tools/model-export/strip_dft.py` moved four byte-identical deterministic tensors, totaling 135.7 MB, into one shared external `dft.bin`. Five models went from 1.5 GB to 934 MB with no Rust changes because ONNX Runtime loads external data natively. Parity remained unchanged. The iSTFT basis produced by `torch.linalg.pinv` remained authoritative.
5. **Real-music verification:** Ten seconds of a real track passed at the numerical parity floor of 2-4e-4 maximum absolute difference on every stem and both two-stems methods. This accounted for upstream `save_audio` rescaling clipping stems, while the Rust path preserved raw f32 output and stems summing to the mix.
6. **Workspace split for JS bindings:** The Rust implementation was split into a sans-inference core with a pull-style engine and native drivers around it. Synchronous callers drive it directly, while asynchronous JS drivers await between pulls. Real-music and one-shift outputs remained bit-identical to the pre-refactor pipeline.
7. **Node CLI via napi-rs:** `crates/napi/` bound the core and ONNX Runtime driver. Its CLI mirrored the Rust flags and matched the Python reference identically, while matching the Rust CLI at float-noise level.
8. **Browser prototype:** `crates/wasm/` and `packages/app/` produced a fully client-side flow using `decodeAudioData`, a worker, and the ONNX Runtime Web WASM execution provider. A three-second clip separated in 12.2 seconds. Browser output matched native CLI stems at 29.5-64.2 dB because of WASM-kernel floating-point divergence, with no systematic pipeline bug found. The Playwright flow test passed in approximately 13 seconds.
9. **Contract cleanup:** Inference became allocation-free per chunk, and the CLI and Node binding shared `crates/ort-driver/`. The core moved from strings and general-purpose containers to typed sources, outputs, bags, and model vocabulary.
10. **Reducer cleanup:** The orchestration adopted a hierarchical member, shift, and chunk plan with caller-owned reducer lifecycles: `ChunkStrideProcessor`, `ShiftMerger`, and `StemFinalizer`. The engine no longer held a cursor or inferred boundaries. Output modes became one enum, WASM returned channels directly, worker messages became typed, and the CLI reported chunk progress. The workspace, browser flow, and real-model CLI were verified on 2026-07-10.

See [development.md](development.md) for the detailed commands, measurements, decisions, and remaining work from these iterations.
