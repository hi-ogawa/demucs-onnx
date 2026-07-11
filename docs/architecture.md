# Design: What We Build on Top

Our port's choices, layered over the upstream mechanism documented in `demucs.md`.
How each piece came to be is in `development.md`.

## Stance

Everything is reproduced and verified ourselves; existing work (including PR #10 and the GSoC
benchmarks) is reference with public numbers, never a trusted dependency. All post-coding-agent
work gets the same skepticism. The artifact chain is committed scripts end to end:
official checkpoint → pinned PR export (`dhunstack/demucs@6a96f8c`) → `export_onnx.py` →
`strip_dft.py` → parity harness.

## Export Choice

Self-contained flavor (PR #10), exported ourselves per bag member. Our `export_onnx.py`
extends the PR's script (which hardcodes `htdemucs` and exports only `models[0]`) to iterate
bag members, naming ft specialists by their one-hot source.

## Graph Anatomy (our exports)

Per baked fp32 file (~304 MB, opset 17, ~4,500 nodes):

| Component                               | Size     | Notes                                                                                                                   |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Learned weights (533 initializers)      | 168 MB   | ~42M params fp32; upstream ships fp16 `.th` = 81 MB                                                                     |
| Deterministic DFT tensors (4 Constants) | 135.7 MB | STFT cos/sin `[2049,1,4096]` ×2, iSTFT basis `[4098,1,4096]`, window-sum `[356352]`; byte-identical across all 5 models |
| Graph structure                         | ~0       | 1,496 Constants, mostly shape scalars                                                                                   |

Exported graph metadata declares output dims as unknown `[0,0,0,0]` — consumers check actual
shape at runtime, never the declared one. An ft "specialist" is a complete htdemucs with
fine-tuned weight _values_ — same topology, same file size; the bag's one-hot weight selects
the output row downstream.

## Artifact Format (current: `data/onnx-lean`)

fp32 `.onnx` per model (~169 MB, learned weights only) + one shared `dft.bin` (135.7 MB)
holding the 4 deterministic tensors as ONNX external data. ORT resolves external data natively
at session load — Python and Rust consumers need zero special handling.

- `dft.bin` baked bytes are **authoritative** (hash-pinned): the iSTFT basis comes from
  `torch.linalg.pinv` (LAPACK SVD), so bit-exact re-synthesis outside torch isn't realistic;
  formula-synthesis is an optional measured-equivalence experiment, not a dependency
- fp16 weight blobs: deferred — precision trade, not duplication (~840 MB → ~420 MB ≈
  upstream's `.th` distribution)
- Shared-graph "pack" (one graph + swappable weight blobs + manifest): after DFT stripping the
  only remaining cross-file duplication is graph structure (a few MB), so this is loader
  architecture for the repo-promotion phase, not a size fix. Requires verifying trace-generated
  tensor names line up across independent exports (initializer names like `onnx::MatMul_*`).
  Note: weights must stay _initializers_ (external data), never graph inputs — inputs are
  dynamic and kill ORT's session-load prepacking/folding; the swap seam is session creation,
  not `Run()`.

## Orchestration Port (Rust, `crates/`)

Mirrors upstream math exactly (Bessel-corrected std, `TensorChunk`-style centered padding,
`center_trim`, triangular OLA) with deliberate divergences:

- **Deterministic shift trick**: seeded xorshift offsets instead of `random.randint` —
  reproducible runs, comparable outputs; quality-equivalent
- **Member filtering fast path**: minus-mode two-stems loads only the target specialist
  (1 of 4 models, 25% compute) — upstream runs the full bag and discards
- Bag members run sequentially (session per member) to cap memory
- Backend-agnostic core is the intent for repo promotion: orchestration crate with a
  `Backend` trait, `ort` behind it natively, onnxruntime-web/tract swappable for wasm
- Engine API: deterministic `member → shift → chunk` plan; caller explicitly scopes
  `ChunkStrideProcessor` (weighted overlap-add), `ShiftMerger`, and `StemFinalizer`.
  Core owns the accumulation math, while native and wasm drivers own its lifecycle.

## GPU Integration Is Wiring (by design)

For any EP — CUDA/DirectML/CoreML natively, WebGPU in ort-web — integration on our side is a
session-creation toggle. Two existing choices make that reduction hold: the self-contained
graph (waveform in/out per chunk → no mid-pipeline host↔device transfers) and the
sans-inference core (orchestration is CPU-side per-track array math; the GPU boundary is
exactly `session.run`). Residual work is verification, not code: per-EP op-coverage profiling
(silent per-op CPU fallback with boundary transfers is a perf cliff) and a dummy-run warmup
(EPs compile kernels/shaders on first run; cf. the CoreML 30–60s first-call tax). WebGPU is
bounded by the client's actual GPU minus translation overhead — it's the only path past wasm's
fixed 128-bit SIMD in-browser, an upside where silicon exists, not magic.

## Open Product Questions

- minus vs add `no_bass` quality (belief: minus is bad; mechanism in `demucs.md` §6) — listen
- plain `htdemucs` vs `htdemucs_ft` audibility for backing tracks — decides the product default
