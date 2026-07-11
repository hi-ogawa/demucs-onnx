# Plan / Process

Chronological record of the port, stage by stage — what was run, what came out, what was
learned. Next steps at the bottom.
Everything here happened on 2026-07-09 on the home laptop (8 cores, 16G; heavy runs prefixed with
`OMP_NUM_THREADS=4 nice -n 10` to stay polite).

## 1. Workspace

`tools/model-export/` is a uv project, CPU-only torch (the export doesn't need CUDA; keeps the venv ~1 GB
instead of multi-GB):

```bash
uv sync --project tools/model-export
```

`pyproject.toml` pins torch/torchaudio 2.1.2 (newest line the demucs fork supports) and installs
demucs from the ONNX-export PR branch, pinned to the reviewed head:
`demucs @ git+https://github.com/dhunstack/demucs@6a96f8c`. `uv.lock` is committed. Resolved
clean on the first try.

## 2. Export (PyTorch → ONNX)

PR #10's own `convert-pth-to-onnx.py` hardcodes `htdemucs` and silently exports only `models[0]`
of a bag — it cannot produce the ft specialists. `tools/model-export/export_onnx.py` is our adaptation: it
iterates bag members, names each by its one-hot source specialty, handles single-member bags
(plain `htdemucs`) without a suffix, and takes `--sources bass` to export a subset. Export
mechanics are unchanged from the PR: set the `onnx_exportable` flag, trace with a fixed
`(1, 2, 343980)` input, opset 17.

```bash
uv run --project tools/model-export python tools/model-export/export_onnx.py --model htdemucs --out data/onnx
uv run --project tools/model-export python tools/model-export/export_onnx.py --model htdemucs_ft --sources bass --out data/onnx
```

Both produced 304.4 MB files. Checkpoints download to `~/.cache/torch/hub/checkpoints/` (81 MB
fp16 `.th` each; note `get_model("htdemucs_ft")` fetches all four even when exporting one).

Expected noise: TracerWarnings about tensors-to-Python-values — fine here, the baked-in shapes
_are_ the contract. The exported graph declares output dims as unknown `[0,0,0,0]`, so consumers
shouldn't trust declared output shape (the Rust side checks the actual shape at runtime).

The identical file sizes are structural, not a bug: an ft "specialist" is a complete htdemucs
(same topology, same 4-stem output) with fine-tuned weight _values_; the bag's one-hot weight
just selects which output row to keep downstream. Graph anatomy (168 MB weights + 136 MB
deterministic DFT tables per file) is in `architecture.md`.

## 3. Tensor-level parity (Python)

`tools/model-export/verify_parity.py` runs the same chunk through the exported graph (ORT CPU) and through
the _original_ torch path (`onnx_exportable=False`, real `torch.stft/istft`), so it validates the
PR's STFT/iSTFT rewrite and the export in one comparison. Input is a seeded random chunk —
harsher than music numerically. `--index` picks the bag member (ft order: 0=drums 1=bass 2=other
3=vocals); a wildly wrong diff here would have exposed a wrong index, so the clean result also
confirms `models[1]` = bass empirically.

```bash
uv run --project tools/model-export python tools/model-export/verify_parity.py --onnx data/onnx/htdemucs.onnx --model htdemucs --index 0
uv run --project tools/model-export python tools/model-export/verify_parity.py --onnx data/onnx/htdemucs_ft_bass.onnx --model htdemucs_ft --index 1
```

| Artifact                | Parity (max abs / MSE)                    |
| ----------------------- | ----------------------------------------- |
| `htdemucs.onnx`         | 7.3e-4 / 6.2e-9                           |
| `htdemucs_ft_bass.onnx` | 4.5e-4 / 4.3e-9 (bass stem itself 2.5e-5) |

Both consistent with (better than) the GSoC-claimed MSE < 1e-4. These are our own numbers from
our own harness — the point of the exercise.

## 4. Baseline decision

Working artifact for the port is **plain `htdemucs` in one 304 MB binary**: one model, all 4
stems in one forward pass, simplest possible Rust bring-up. Known and accepted gap, to be closed
in follow-up: the existing bass workflow runs `htdemucs_ft` (~9.2 dB tier vs ~9.0), so the four
ft specialist exports are required for workflow parity — see `architecture.md`.

## 5. Rust end-to-end prototype

Decision: skip the planned `.npy` tensor bridge (per Hiroshi — ORT-in-Rust vs ORT-in-Python
re-verifies the same runtime; more Python harness for little signal). Instead go straight to a
wav-level end-to-end comparison against the Python CLI, which validates inference _and_ the
reimplemented orchestration in one shot.

Setup that had to happen on the way:

- **rustup installed on the box** (wasn't present): minimal profile, stable 1.96.1
- Test input synthesized with ffmpeg — no Python involved, deterministic, committed as a command
  rather than a binary:

```bash
ffmpeg -y -f lavfi \
  -i "aevalsrc=sin(2*PI*220*t)*0.35+sin(2*PI*440*t)*0.15+0.05*random(0)|sin(2*PI*110*t)*0.35+sin(2*PI*330*t)*0.15+0.05*random(1):s=44100:d=12" \
  -c:a pcm_f32le data/input/test-clip.wav
```

- Reference stems from the Python CLI, torch path. `--shifts 0` removes the one source of
  randomness (the shift trick's random offset), `--float32` keeps int16 quantization out of the
  comparison:

```bash
uv run --project tools/model-export demucs --shifts 0 --float32 -n htdemucs -o data/reference data/input/test-clip.wav
```

The crates (`crates/`, `demucs-rs-proto`; deps: `ort`, `hound`, `anyhow`) reimplement the
orchestration layer — global loudness normalization (Bessel-corrected std, matching
`torch.std()`), fixed-size chunking with `TensorChunk`-style centered padding, `center_trim`,
triangular weighted overlap-add, denormalization — around an ORT session. The upstream logic it
mirrors is mapped with line refs in `demucs.md` ("Orchestration Layer"); the doc comment in
`crates/cli/src/main.rs` states scope. Build friction worth remembering: the `ort` crate resolved to
2.0.0-rc.12, whose typed errors aren't `Send+Sync` — they need stringifying before anyhow.

```bash
cargo build --release
./target/release/demucs-rs-proto separate data/onnx/htdemucs.onnx data/input/test-clip.wav data/rust-out
for s in drums bass other vocals; do
  echo -n "$s: "
  ./target/release/demucs-rs-proto compare data/reference/htdemucs/test-clip/$s.wav data/rust-out/$s.wav
done
```

Result, first run:

| Stem   | max abs diff | SNR      |
| ------ | ------------ | -------- |
| drums  | 3.7e-5       | 73.0 dB  |
| bass   | 2.0e-6       | 96.0 dB  |
| other  | 2.8e-5       | 95.2 dB  |
| vocals | 3.5e-6       | 102.9 dB |

30–50 dB below audibility — the orchestration math reproduced exactly.

Honest caveats: the test signal is easy (quasi-stationary sines), so re-verify on real music
before calling it bit-faithful; and the prototype only handles 44.1k stereo wav, shifts=0, single
model — no resampler, no shift trick, no stem selection / two-stems arithmetic, no ft bag yet.
Those became stage 6.

## 6. Full orchestration CLI (workflow replacement)

Goal: replace the Docker/PyTorch bass workflow (`-n htdemucs_ft --two-stems=bass`) with the Rust
binary. Added: resampling (rubato sinc, with output-delay compensation and exact-length trim —
yt-dlp wavs are typically 48k), channel conform (mono replicate / extra channels dropped,
mirroring `convert_audio_channels`), bag-of-models weighted averaging (members run sequentially
to cap memory), shift trick with _seeded deterministic_ offsets (upstream uses `random`; we take
reproducibility), two-stems add/minus arithmetic, and member filtering — minus mode loads only
the target specialist, the 4× fast path upstream doesn't implement.

First the remaining ft specialists were exported and parity-checked (same harness):

| Artifact                  | Parity (max abs / MSE) |
| ------------------------- | ---------------------- |
| `htdemucs_ft_drums.onnx`  | 4.9e-4 / 3.3e-9        |
| `htdemucs_ft_other.onnx`  | 7.9e-4 / 9.0e-9        |
| `htdemucs_ft_vocals.onnx` | 2.5e-4 / 4.8e-11       |

```bash
# the workflow-replacement invocation
./target/release/demucs-rs-proto separate --models data/onnx --name htdemucs_ft \
  --two-stems bass [--method minus] [--shifts N] input.wav out_dir
# -> out_dir/bass.wav + out_dir/no_bass.wav
```

Verification (12s test clip):

- Regression: rewritten CLI, `--name htdemucs --shifts 0` → bit-identical to stage 5 numbers
- ft bag two-stems add vs `demucs -n htdemucs_ft --two-stems bass --shifts 0 --float32`:
  bass max abs 2.2e-6 (94.3 dB SNR), no_bass 3.9e-5 (92.3 dB)
- minus fast path: loads only `htdemucs_ft_bass.onnx`; bass agrees with the full-bag run at
  129 dB (float noise)
- 48k input: resampled to exactly the expected length; separation agrees with the native-44.1k
  run at 34 dB SNR (different anti-alias chains through a nonlinear model — sanity, not parity)
- shifts=1 determinism: two runs identical (168 dB)

Rubato lesson: `SincFixedIn` output includes the sinc filter delay (`output_delay()`) and
zero-padded tail from the final partial chunk — skip the delay and trim to
`round(len * ratio)` or downstream length checks fail.

Remaining orchestration gaps vs upstream CLI: mp3/other input formats (wav only — yt-dlp can
emit wav), int16/24 output (f32 only), `--segment` override, 6s model. Real-music re-verify
still pending.

## 7. DFT kernel elimination (dedupe)

The 136 MB of deterministic DFT tensors baked into every export were the real duplication —
45% of each file, shipped 5×. Attacked per-file with ONNX post-processing; demucs source and
PR untouched.

Recon first: mapped the tensors to their generators — STFT cos/sin conv kernels
(`demucs/stft.py`, hann-windowed, computed in float32 torch ops) and the iSTFT inverse basis
(`demucs/istft.py`) built with **`torch.linalg.pinv`** — LAPACK SVD, effectively not
bit-reproducible outside torch. That killed the "synthesize at load, bit-compare" idea:
`dft.bin` carries the baked bytes as authoritative (hash-pinned), and formula-synthesis is
demoted to an optional measured-equivalence experiment. The dedupe never depended on synthesis.

Content-hash across all 5 exports found **4** identical tensors (not 3): the two 33.6 MB STFT
kernels, the 67.1 MB iSTFT basis, and a 1.4 MB window-sum envelope — same names, same hashes
everywhere (the shared-trace assumption held).

`tools/model-export/strip_dft.py`: Constant nodes ≥ 1 MB → initializers with external-data references
into one shared `dft.bin` (64-byte aligned offsets; layout recorded from the first model,
hash-verified by the rest).

```bash
uv run --project tools/model-export python tools/model-export/strip_dft.py \
    --models htdemucs htdemucs_ft_drums htdemucs_ft_bass \
    htdemucs_ft_other htdemucs_ft_vocals --src data/onnx --out data/onnx-lean
```

Result: **5 × 304 MB → 5 × 168.7 MB + one 135.7 MB `dft.bin`** (1.5 GB → 934 MB on disk; the
remaining bytes are all unique learned weights). Verification:

- Python parity on stripped `htdemucs.onnx`: max abs 7.303e-4 / MSE 6.156e-9 — _identical
  digits_ to the baked file → ORT's external-data load is byte-faithful
- Rust CLI pointed at `data/onnx-lean`: **zero code changes needed** (ORT resolves external
  data natively); bass output vs baked run at 129 dB (ORT thread-scheduling float noise)

## 8. Real-music verification

The synthetic-sines caveat closed with a real track, mirroring the old `docs/bass-cover.py` flow: yt-dlp
download (TripleS "Baby Flower", the workflow's test song), 10s trim conformed to 44.1k stereo
f32 in the same ffmpeg step (one shared input for both pipelines, so their different resamplers
stay out of the measurement).

```bash
yt-dlp "https://www.youtube.com/watch?v=6q8UMVXhXsE" -x --audio-format wav -o "data/input/baby-flower.%(ext)s"
ffmpeg -y -ss 10 -to 20 -i data/input/baby-flower.wav -ar 44100 -ac 2 -c:a pcm_f32le data/input/baby-flower-s10-e20.wav
```

First comparison looked like a bug: drums at 23.8 dB SNR (max 6.4e-2, uniform across the whole
track) while bass/other/vocals sat at 77–83 dB. Diagnosis chain: tensor-level parity on the
same real chunk was clean (2.6e-4) → normalized-input torch-vs-ORT also clean → so region
0–5.85s (single chunk, no OLA) _couldn't_ mathematically differ by e-2 unless an output-side
transform intervened. It did: **upstream `save_audio` defaults to `clip='rescale'`** and
silently rescales any stem peaking above 1.0 — even with `--float32`. Python's drums peak sat
at exactly 0.9901 (= 1/1.01, the rescale target); ours at the raw 1.0539. Undoing the uniform
rescale: drums 2.8e-4, parity floor.

| Comparison (rust vs python CLI, real music) | Raw      | After undoing upstream rescale  |
| ------------------------------------------- | -------- | ------------------------------- |
| htdemucs drums                              | 23.8 dB  | max 2.8e-4 (floor)              |
| htdemucs bass / other / vocals              | 77–83 dB | 2.1–3.1e-4                      |
| ft two-stems bass                           | 81.2 dB  | — (no clip, no rescale)         |
| ft two-stems no_bass                        | 11.2 dB  | max 4.4e-4 (py rescaled ×0.783) |

**Verified on real music at the parity floor everywhere.** Side finding worth keeping:
upstream's rescale default breaks the stems-sum-to-mix property (each clipping stem gets its
own scale factor); our raw f32 output preserves it. When int16/24 output lands, a clip
strategy option becomes necessary — for f32, raw is the more correct default.

Listening set for the open A/Bs was written to `data/`: `real-rust-htdemucs/` (plain, 4 stems),
`real-rust-ft-add/` and `real-rust-ft-minus/` (ft bass + both no_bass constructions). Note
`data/` is gitignored and machine-local, so the set survives only until the next `data/`
rebuild; regenerate with the CLI on any real track.

A/B outcome (2026-07-10): minus-vs-add `no_bass` indistinguishable on Baby Flower — the
phase-leakage worry did not materialize — so the bass workflow defaults to the 4x-faster
minus mode (README usage updated). This also moots the plain-`htdemucs`-vs-`ft` question
for backing tracks: in minus mode ft runs a single specialist per chunk, the same cost as
plain `htdemucs`, so ft is the quality tier for free (the comparison only matters for
full-stems mode, where ft genuinely costs 4x).

## 9. Workspace split: sans-inference core + CLI

Preparation for JS bindings (napi-rs, native + wasm via emnapi — one binding crate covers Node
and browser, the Rolldown/Oxc distribution pattern). The key design move: `crates/` became a
two-crate workspace where **`core` never runs inference**:

- `core` (`demucs-core`): wav io, channel conform, resample, normalization, bag registry, and
  the separation engine as a pull-style state machine — `next_job()` hands out a fixed-shape
  input buffer, `feed()` takes the model output, `finish()` returns named stems. Jobs are
  issued strictly in order (one outstanding), keeping memory bounded. `separate_with(run_fn)`
  is a sync-callback wrapper over the same machine. Sync callers (CLI/napi native) drive it
  directly; async callers (browser wasm + onnxruntime-web) `await` between `next_job`/`feed` —
  no async traits needed. No ort anywhere in the crate.
- `cli` (`demucs-cli`, binary still `demucs-rs-proto`): arg parsing + ort sessions driving
  `separate_with`, sessions loaded lazily one at a time (jobs arrive grouped by member).

Regression gate (refactor changed nothing):

| Test                                            | Result                                       |
| ----------------------------------------------- | -------------------------------------------- |
| 12s synthetic, htdemucs 4-stem vs Python        | same numbers (73.0/96.0/95.2/102.9 dB)       |
| 12s ft two-stems add vs Python                  | same (94.3 / 92.3 dB)                        |
| real music htdemucs vs pre-refactor Rust output | **bit-identical** (0.000e0)                  |
| shifts=1 ft minus vs pre-refactor Rust output   | **bit-identical** — xorshift order preserved |

## 10. Node CLI via napi-rs

`crates/napi/` (`demucs-napi`, third workspace member): `#[napi]`-exported `separate()` wrapping
the same core engine + ort driver as the CLI; `cli.mjs` is a thin Node argv wrapper mirroring
the Rust CLI's flags. Built with plain cargo — no `@napi-rs/cli` tooling yet; the cdylib is
copied to `demucs.node` and `require`d directly (the npm packaging/prebuild story belongs to
repo promotion).

```bash
cargo build --release -p demucs-napi
cp target/release/libdemucs_napi.so napi/demucs.node
node crates/napi/cli.mjs separate --models data/onnx-lean --name htdemucs --shifts 0 in.wav out/
```

Verification (12s synthetic, Node v24.18):

- napi vs Python reference: identical dB table to the Rust CLI (73.0/96.0/95.2/102.9)
- napi vs Rust CLI output: 114–132 dB (ORT run-to-run thread float noise)
- ft two-stems minus through the JS options path: **bit-identical** to the Rust CLI (0.000e0)

First-try build and run; the sans-inference core meant the binding is ~100 lines of driver +
option marshalling.

## 11. Perf spot-check

First fair timing (previously all runs were correctness-driven with uncontrolled conditions).
Same 12s clip, `htdemucs --shifts 0`, both sides `OMP_NUM_THREADS=4 nice -n 10`, wall clock
including startup and model load, single run each:

|                              | wall  | user CPU |
| ---------------------------- | ----- | -------- |
| Python CLI (torch 2.1.2 CPU) | 36.1s | 2m02.8s  |
| Rust CLI (ORT, lean models)  | 16.4s | 47.6s    |

≈ **2.2× faster wall, 2.6× less CPU** — well beyond the GSoC-reported ~18%; plausibly ORT's
session-load prepacking/fusion plus zero Python overhead. Caveats: one machine, one clip, one
run, startup included (Python pays uv+import+checkpoint load ~5s, Rust pays ~1.5s ONNX session
init); not a rigorous benchmark. Rigorous per-chunk numbers belong to the repo-promotion phase.

## 12. Browser prototype (end-to-end, perf deferred)

Built per the plan shape: `crates/wasm/` (wasm-bindgen over core's pull API — napi-rs wasm was
sidestepped because the napi crate depends on ort, which doesn't compile to wasm; unification
later) + `packages/app/` Vite app (main thread decodes via `OfflineAudioContext(44100).decodeAudioData`,
worker drives `next_input()` → onnxruntime-web wasm EP → `feed()`; models fetched from
`data/onnx-lean` via `/@fs`, `dft.bin` through ort-web's `externalData`).

```bash
pnpm add -g wasm-pack   # one-time (also: rustup target add wasm32-unknown-unknown)
(cd crates/wasm && wasm-pack build --target web --release)
(cd web && pnpm i && pnpm dev)
```

Vite + ort-web friction (both cost real time):

- ort runtime assets can't be served from `public/` (its loader dynamic-imports the .mjs;
  Vite refuses module-importing public-dir files) and can't be deep-imported
  (`onnxruntime-web/dist/*` is not in package exports). Working recipe: import
  `onnxruntime-web/wasm` (wasm-EP-only build), add `optimizeDeps.exclude:
["onnxruntime-web"]`, set no `wasmPaths` — ort resolves its assets off its own module URL.
- Vite HMR full-reloads the page on worker edits — a `waitForFunction` from a prior page
  generation waits forever (ate a 280s timeout during debugging).

Result: 3s test clip separates **in the browser in 12.2s** (threaded SIMD wasm EP under
COOP/COEP — far better than the feared minutes). Reproduced twice with identical outputs.

Speed model from two points (1 chunk = 12.2s, 3 chunks = 31.2s): **≈9.5s/chunk** (5.85s audio
each) + ~2.7s fixed session/model init → **~1.6× realtime** per model, only ~1.9×/chunk slower
than native ORT on the same laptop. 4-min song extrapolation: htdemucs or ft-minus shifts 0
≈ 6.5 min; shifts 1 doubles; full ft bag ≈ 26 min (where the deferred WebGPU tier earns its
place). Verdict: single-model browser use is already viable on CPU wasm.

Verification vs native CLI (same clip, same models):

| Stem   | max abs | SNR     |
| ------ | ------- | ------- |
| drums  | 1.9e-3  | 36.3 dB |
| bass   | 2.9e-3  | 50.5 dB |
| other  | 1.1e-2  | 29.5 dB |
| vocals | 7.4e-5  | 64.2 dB |

Looser than native-vs-Python (73–103 dB), but no systematic bug: peak ratios 1.00–1.02 (no
rescale-type issue), error uniform in time (no seam bug) — consistent with ort-wasm vs
ort-native kernel float divergence (wasm lacks FMA, different gemm) amplified through the
transformer. Whether 29 dB on the worst stem warrants investigation is deferred with the rest
of the perf tier.

**Verification honesty note:** the initial browser gate was driven interactively
(playwright-cli session) — a scripted manual smoke test, not a committed artifact. Follow-up
landed same day: `packages/app/e2e/separate.spec.ts` (@playwright/test, root `pnpm test`) exercises
the full flow — generated 2s wav fixture (no binary checked in) → upload → decode → separate →
asserts 4 stems rendered with players + download links. Flow-only by design; numeric parity is
the CLI comparisons' job. Skips with a clear message if `data/onnx-lean` is absent; the config
boots the dev server itself. First run: passed in 12.9s.

## 13. Engine API: plan/input/feed/finish

Review question from Hiroshi exposed the smell: the coupled `next_job`/`feed` state machine
needed paragraphs of justification, while his first-guess API — "jobs are all known and fully
ordered, why not an iterator?" — needed none. If a design needs that much explaining in a
review artifact, fix the design.

Refactored `Separation` to the self-explanatory shape: `plan()` returns the whole
deterministic job list (`JobSpec { member, shift, offset, … }`, seeded shift offsets drawn at
construction in the same order as before); `input(&spec)` is lazy and `&self` (drivers can
prepare job N+1 while N runs — the lockstep pipelining ceiling is gone); `feed(output)` folds
in plan order (the one real constraint: incremental OLA/bag folding bounds memory); `finish()`
combines. `separate_with` kept its signature, so CLI and napi only rebuilt; wasm binding and
web worker moved to indexed `job_member(i)`/`job_input(i)`.

Regression: real-music **bit-identical** (0.000e0); shifts=1 at 2.98e-8 = the ORT
run-to-run thread-noise floor (the same figure two runs of the _same_ pre-refactor binary
produced); napi bit-identical; browser e2e green (13.4s). The design.md justification
paragraph is deleted — the API no longer needs one.

## Current State / Footprint

Proven chain: official checkpoints → our export (all 5 models) → tensor parity → Rust e2e at wav
level → workflow-replacement CLI (ft bag, two-stems, both methods, resampling, deterministic
shifts) → deduped lean artifacts (`data/onnx-lean`: 934 MB, zero redundant bytes) → Node CLI via
napi. Disk: `data/` ~3 GB (baked + lean models + clips + stems), `tools/model-export/.venv` ~1 GB,
`target/` ~1 GB — all gitignored. Plus rustup (~700 MB, system-level) and 4×81 MB checkpoint
cache in `~/.cache/torch/`. Baked `data/onnx` can be deleted once lean is the trusted working
set.

## Next

- Deferred perf tier for web (prototype works, so these unlock when wanted): WebGPU EP as an
  **explicit user toggle + per-run timing readout — never auto-selection** (availability ≠
  benefit: a weak iGPU hands out an adapter and still loses to CPU wasm; detection only
  disables the option with a reason). fp16 weights (~84 MB), OPFS/Cache API model caching,
  two-stems UI, ft bag on web; also the 29.5 dB worst-stem wasm-kernel divergence question

Other threads:

- Retire the legacy Docker workflow: the substantive step landed
  2026-07-10 — `docs/bass-cover.py` ports the old wrapper (yt-dlp → trim → separate) onto the Rust CLI
  with the settled config (ft, two-stems bass, minus; A/Bs resolved, see §8), verified e2e on
  the test song (10s clip separated in 16.6s). Remaining housekeeping: supersede notice in the
  legacy workflow documentation, and the ~1.4 GB image lives on the Docker Desktop side (docker isn't
  reachable from this WSL distro), so reclaim it from there when convenient
- Repo promotion (e.g. `demucs-rs`) when publish/CI actually forces it: napi prebuild matrix,
  npm publishing, public visibility; CLI polish (formats, int16/24 out + clip strategy,
  `--segment`, progress); rigorous per-chunk benchmark; optionally the shared-graph pack +
  manifest (requires verifying trace-generated tensor names line up across independent exports)

Deferred (details in `architecture.md`): fp16 weight variants (precision trade, not
duplication — ~840 MB → ~420 MB ≈ upstream's `.th` distribution), `tract` pure-Rust experiment,
`htdemucs_6s`.
