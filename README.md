# Demucs Port

Port the Demucs v4 (htdemucs) inference pipeline to a portable native stack: exported ONNX model
for the neural core + a Rust orchestration layer, eventually packaged as a Rust CLI and/or
wasm-powered JS CLI / web frontend.

Motivation is curiosity-driven: get into the actual model/inference code and drive it with a
concrete deliverable, reproducing everything ourselves rather than trusting existing ports
(all post-coding-agent-era work gets the same skepticism). Practical tie-in is the existing bass
stem separation workflow (`2026-06-20-bass-stem-separation/`), currently a 1.4 GB Docker + PyTorch
setup.

Product direction: arbitrary stem choice like anyone would expect — all stems, any two-stems
split, add/minus methods. Stem-specific loading (e.g. bass-only for minus mode) is a runtime
optimization, never an artifact-level shortcut.

## Status

1. [x] **Baseline ONNX artifact** — plain `htdemucs` baked into a single ~304 MB binary (one
       model, all 4 stems in one forward pass), exported ourselves from PR #10 code and
       parity-verified against the original torch path (max abs 7.3e-4).
       **Known gap, must address in follow-up:** the existing bass workflow runs `htdemucs_ft`
       (~9.2 dB tier); this baseline is ~9.0 dB. Baseline is for Rust bring-up simplicity, not
       the quality endpoint — workflow parity requires the 4 ft specialist exports.
2. [x] **Rust e2e prototype** — Rust crates (`ort` + `hound`): wav → norm → chunk → ORT →
       triangular OLA → 4 stem wavs, matching the Python demucs CLI at max abs 3.7e-5 /
       SNR 73–103 dB on a 12s synthetic clip (2026-07-09, first run)
3. [x] **Workflow-replacement CLI** — all 5 models exported + parity-checked; resampling
       (48k yt-dlp wavs), ft bag, two-stems add/minus, deterministic shifts. ft two-stems
       output matches the Python CLI at 92–94 dB SNR; minus mode loads 1 of 4 models (the 4×
       fast path upstream doesn't have). Replaces the Docker/PyTorch setup for the bass
       workflow (2026-07-09).
4. [x] **DFT kernel dedupe** — `tools/model-export/strip_dft.py` post-processes the exports: the 4
       deterministic tensors (135.7 MB, byte-identical across all 5 models) move to one shared
       external `dft.bin`. 1.5 GB → 934 MB (`data/onnx-lean`), zero redundant bytes, zero Rust
       changes (ORT loads external data natively); parity digits identical to baked
       (2026-07-09). Note: iSTFT basis is built with `torch.linalg.pinv`, so baked bytes are
       authoritative — formula-synthesis demoted to optional experiment.
5. [x] **Real-music verification** — 10s of a real track (June task's test song) through both
       pipelines: parity floor (2–4e-4 max abs) on every stem and both two-stems methods, after
       accounting for upstream's `save_audio` clip='rescale' default silently rescaling
       clipping stems (our raw f32 preserves stems-sum-to-mix; theirs doesn't). Numeric gate
       for Docker retirement: passed (2026-07-09).
6. [x] **Workspace split for JS bindings** — `crates/` contains `core` (sans-inference pull-style
       engine: `next_job`/`feed`/`finish`, no ort dependency; sync callers drive directly,
       async JS drivers await between pulls) + `cli` (ort driver, same binary/flags).
       Regression: real-music and shifts=1 outputs **bit-identical** to pre-refactor;
       synthetic-vs-Python numbers unchanged (2026-07-09).

7. [x] **Node CLI via napi-rs** — `crates/napi/` binds core + ort; `cli.mjs` mirrors the Rust
       CLI. Output matches Python reference identically and the Rust CLI at float-noise level
       (ft minus path bit-identical) (2026-07-09).
8. [x] **Browser prototype** — `crates/wasm/` (wasm-bindgen over core) + `packages/app/` Vite
       app; fully client-side: decodeAudioData → worker → onnxruntime-web wasm EP. 3s clip
       separates in-browser in 12.2s; stems vs native CLI at 29.5–64.2 dB (wasm-kernel float
       divergence, no systematic bug). Flow e2e committed: `packages/app/e2e/separate.spec.ts`
       (@playwright/test, `pnpm test`), passing in ~13s (2026-07-09).
9. [x] **Contract cleanup** — allocation-free chunk inference, shared `crates/ort-driver`
       crate (cli + napi), core de-stringed and de-generalized (`Source`, typed `Outputs`,
       `Bag` encoding the three shipped shapes, `vocab` for names + model registry).
       Gate: cargo check/clippy clean; numeric regression deferred, no model artifacts on
       this machine (2026-07-09).
10. [x] **De-slop pass** — hierarchical member/shift/chunk plan with caller-owned reducer
         lifecycle (`ChunkStrideProcessor` → `ShiftMerger` → `StemFinalizer`, no engine
         cursor or inferred boundaries); `Options.mode` one enum (the degenerate
         two_stems+minus pair is unrepresentable); wasm `finish()` returns channels
        directly; worker messages typed; CLI chunk progress. Gate: workspace clean, web
        e2e passing, real-model CLI run verified (2026-07-10).

## Usage (bass-cover workflow, replaces the Docker setup)

Prerequisites: Rust, `uv`, `ffmpeg`, and `yt-dlp`.

One-time setup from this directory:

```bash
# Install the pinned export environment and export the bass specialist needed by the default
# ft/minus workflow. This downloads the upstream checkpoints and writes a ~304 MB ONNX model.
cd tools/model-export
uv sync
uv run python export_onnx.py --model htdemucs_ft --sources bass --out ../../data/onnx

# Move the shared DFT tensors into an external data file, matching the production layout.
uv run python strip_dft.py --models htdemucs_ft_bass \
  --src ../../data/onnx --out ../../data/onnx-lean
cd ../..

# Build the Rust CLI.
cargo build --release -p demucs-cli
```

Test the complete WAV → Rust → ONNX Runtime → WAV path on a short clip:

```bash
mkdir -p data/input
yt-dlp "https://www.youtube.com/watch?v=6q8UMVXhXsE" -x --audio-format wav \
  -o "data/input/triples-baby-flower.%(ext)s"
ffmpeg -ss 10 -t 10 -i data/input/triples-baby-flower.wav \
  data/input/triples-baby-flower-clip.wav

./target/release/demucs-rs-proto separate \
  --models data/onnx-lean --name htdemucs_ft --two-stems bass --method minus \
  data/input/triples-baby-flower-clip.wav data/output/triples-baby-flower-clip
```

A successful run creates `data/output/triples-baby-flower-clip/bass.wav` and
`data/output/triples-baby-flower-clip/no_bass.wav`.

The setup above creates the minimal size-optimized `data/onnx-lean/` model set needed by the
default bass/minus flow and `examples/bass-cover.py`. See `docs/development.md` §2/§7 to export all five models for the other
model, stem, and add-method variants while deduplicating their shared DFT data.

`examples/bass-cover.py` is the one-command flow, a port of the old task's wrapper with the docker step
replaced by the Rust CLI (settled defaults baked in: ft, two-stems bass, minus):

```bash
./examples/bass-cover.py 6q8UMVXhXsE --name triples-baby-flower                       # whole song
./examples/bass-cover.py 6q8UMVXhXsE --name triples-baby-flower --start 10 --end 20   # test clip
# -> data/output/<name>/bass.wav + no_bass.wav
```

The manual steps, for anything the wrapper doesn't expose:

```bash
cd demucs-onnx

# 1. get the song (any wav works; yt-dlp output is 48k — the CLI resamples itself)
yt-dlp "https://www.youtube.com/watch?v=<id>" -x --audio-format wav -o "data/input/song.%(ext)s"

# 2. optional: trim a test clip first
ffmpeg -ss 10 -to 20 -i data/input/song.wav data/input/song-clip.wav

# 3. separate -> <outdir>/bass.wav + no_bass.wav (f32 wav, drop into Ableton)
#    minus mode (no_bass = mix - bass) runs only the bass specialist: 4x faster, and the
#    A/B on real music found it indistinguishable from add (2026-07-10), so it is the default
./target/release/demucs-rs-proto separate --models data/onnx-lean --name htdemucs_ft \
  --two-stems bass --method minus data/input/song.wav data/output/song

# variants:
#   --method add     no_bass = drums+other+vocals; runs all 4 specialists (4x slower,
#                    audibly equivalent per the 2026-07-10 A/B)
#   --name htdemucs  single non-ft model (~0.2 dB lower quality; same cost as the minus
#                    default, so only worth it for full/add runs where the ft bag costs 4x)
#   --shifts N       passes to average: default 1 = single pass; 2+ = seeded-offset shift
#                    trick at N x compute (0 is rejected — offsetting one pass buys nothing)
# node flavor (same flags): node crates/napi/cli.mjs separate ...
```

Listening A/B set: `data/real-rust-*`, regenerable with the commands above (`data/` is gitignored; see `docs/development.md` §8).

## Files

- `examples/bass-cover.py` — bass-cover workflow wrapper (yt-dlp → trim → Rust CLI), replaces the old task's
  docker-based `run.py`
- `docs/development.md` — the whole process in flow (each stage with its commands, results, and lessons)
  plus next steps at the bottom
- `docs/demucs.md` — upstream: demucs mechanism, ONNX export problem, existing ports and
  artifact landscape, references
- `docs/architecture.md` — ours: stance, export choice, graph anatomy, lean artifact format,
  orchestration port choices, open product questions
- `docs/pipeline.html` — visual review companion: entities, black-box contract, orchestration flow, mode contrast
- `docs/postmortems/2026-07-09-initial-port.md` — iteration 1 (export + parity) postmortem
- `crates/` — Rust workspace crates: `core` (sans-inference engine), `ort-driver` (shared native ort
  driver), `cli`, `napi` (Node), `wasm` (browser)
- `packages/app/` — fully client-side Vite prototype (see `docs/development.md` §12)
- `tools/model-export/` — uv-managed export + parity harness (CPU-only torch)
- `data/` — gitignored artifacts (exported .onnx, ~300 MB each)
