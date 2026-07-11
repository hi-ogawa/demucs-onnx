# Demucs: Mechanism and Existing Ports

Upstream facts — how demucs v4 (htdemucs) works and what portable-port work already exists.
Independent of our project; our choices on top are in `design.md`.

## Core Model

- Input: float32 waveform `(1, 2, T)`, stereo 44.1kHz
- Output: float32 `(1, 4, 2, T)` — sources `[drums, bass, other, vocals]`
- T is fixed at inference: `segment * samplerate` = 7.8s × 44100 = **343,980 samples**
  (`use_train_segment=True`; forward right-pads shorter input, raises on longer)
- Inside forward: STFT (nfft=4096, hop=1024), complex-as-channels, per-chunk mean/std
  normalization, dual-branch encoder/decoder + cross-domain transformer, iSTFT + branch sum
- Batch dim exists but is always 1 in the real pipeline

## Orchestration Layer (outside the model)

1. Decode → float32, resample to 44100, conform channels (mono replicated, extra channels
   dropped — `convert_audio_channels`)
2. Global loudness normalization: `ref = mean(channels)`; `(wav - ref.mean()) / (ref.std() + 1e-8)`,
   inverted on output (`demucs/api.py:268-291`)
3. Shift trick (default `shifts=1`): pad 0.5s, *random* offset, un-shift, average
   (`demucs/apply.py:237-256`)
4. Chunking + weighted overlap-add: segment 343,980 samples, stride `(1-overlap)*segment`,
   `overlap=0.25`, centered padding from the full tensor (`TensorChunk.padded`), `center_trim`,
   normalized triangular window, `transition_power=1` (`demucs/apply.py:257-301`)
5. Bag of models: a `-n` name resolves to a yaml spec (`demucs/remote/*.yaml`) = checkpoint
   list + per-source weight matrix. `htdemucs` = 1 member; `htdemucs_ft` = 4 specialists with
   one-hot weights (order drums/bass/other/vocals); mdx-era bags use fractional weights (true
   ensembles). Each member is a *complete* model (same topology, ~42M params); combination is
   `stem_k = Σᵢ(wᵢₖ·outᵢₖ)/Σᵢwᵢₖ`
6. Two-stems arithmetic (pure post-processing): `add` → `no_x = sum(others)`; `minus` →
   `no_x = mix − x`. Upstream always runs the full bag even in minus mode (no member-filtering
   fast path). Quality trade: minus preserves the master except phase-inverted
   estimation-error artifacts (leakage subtraction); add stacks three separations' artifacts
   and sounds hollower; which loses depends on how clean the target-stem estimate is per song
7. Encode → int16/24/float32 wav with clip strategy

All deterministic testable DSP except the shift trick's `random.randint`.

Quality/compute: `htdemucs_ft` ≈ 9.2 dB SDR at 4× compute vs `htdemucs` ≈ 9.0 dB at 1×.

**What "fine-tuned" means** (documented in `demucs/grids/mmi_ft.py`): each ft specialist is the
generalist checkpoint (`955717e8` — the same signature `htdemucs.yaml` ships) with training
continued under **one-hot per-source loss weights** (`weights: [0,1,0,0]` etc.), same dataset,
plus stability hyperparameters (lr 1e-4, remix/scale augment off, adamw + t_weight_decay,
grad clip, 50 epochs, longer training segments). The model still outputs all 4 stems; training
just stops rewarding the other 3 — which is why those rows degrade and get discarded. The
one-hot `weights` field selecting the loss at training time is the same knob the bag yaml
reuses to select outputs at inference time.

## ONNX Export Problem and Flavors

`torch.stft/istft` (complex tensors) are not ONNX-exportable; two solutions exist:

1. **Self-contained** (GSoC 2025 / dhunstack, adefossez/demucs PR #10): STFT/iSTFT rewritten as
   real-valued conv/matmul against sine/cosine bases, inside the graph. Waveform in → waveform
   out. The matmul-DFT is FLOP-wasteful vs a real FFT but negligible in the total budget; the
   win is no host↔device round-trips on GPU/WebGPU and zero numerical-mismatch surface in
   ports.
2. **STFT-outside** (sevagh/demucs.onnx): graph is spectrogram-domain; the runtime owns
   STFT/iSTFT. More DSP per port, two tensors at the boundary. (sevagh's demucs.cpp is the
   fully handwritten C++/Eigen port; demucs.onnx is a thin vendored patch — hoist
   spec/ispec/magnitude/mask out of the model — plus an ORT C++ runner borrowing demucs.cpp's
   DSP.)

## Fully Client-Side Demos in the Wild

- **freemusicdemixer** — https://freemusicdemixer.com (sevagh) — the original: demucs.cpp →
  wasm, CPU-only, live for years
- **demucs-rs** — https://github.com/nikhilunni/demucs-rs (Show HN 2026-03
  https://news.ycombinator.com/item?id=47234566, Apache 2.0, ~130 stars) — full native-Rust
  HTDemucs reimplementation on **Burn** (wgpu: Metal/Vulkan/WebGPU): native CLI, browser app
  (wasm + WebGPU, https://nikhilunni.github.io/demucs-rs/), and a VST3/CLAP DAW plugin with
  per-stem outputs (macOS; audio dropped into the plugin UI, MIDI note as playback gate, drag
  stems out to tracks). All 3 model variants, auto-downloaded cached weights. Different lane
  from ours (model reimplementation à la demucs.cpp vs our ONNX-artifact + ORT); its
  weight-conversion/verification story unexamined — same post-agent-era skepticism applies.
  **Takes the `demucs-rs` name** — our repo promotion needs another.
- **demucs-web** — https://github.com/timcsy/demucs-web — onnxruntime-web (wasm/WebGPU),
  architecturally the same shape as our `packages/app/` prototype; depth unassessed.

## Weight Handling in the Wild

De-facto standard across shipping ports: **fp16 weights, ~81–84 MB per model, one file per
specialist** — matching upstream's own `.th` distribution. demucs.cpp converts to ggml f16
(HF-hosted, `Retrobear/demucs.cpp`); demucs-rs auto-downloads ~84 MB records; GSoC/PR #10
exports plain fp32 (304 MB, DFT tables baked, undeduped); StemSplit ships fp32 + fp16-weight
variants (untrusted). Nobody quantizes below fp16 by default, nobody dedupes across models,
nobody delta-encodes ft specialists against the generalist (unexplored; fine-tuning likely
moves weights too far for lossless delta — measurable via xor+compress on two checkpoints if
ever curious). The baked-DFT duplication problem is specific to self-contained ONNX exports;
STFT-outside runtimes (demucs.cpp, demucs-rs) never have it, and the self-contained shippers
(GSoC, StemSplit) don't solve it. Consequence for us: fp16 conversion is table stakes for
distribution, not a nice-to-have.

## Hosted Artifact Landscape

No trustworthy pre-exported model exists. Mixxx integration of the GSoC export is early
(onnxruntime not yet in their vcpkg manifest, no model download infra); dhunstack published no
weights (no releases, nothing on HF); PR #10 is export code only. StemSplit's HF models exist
but are vibe-coded slop (see References). Hence: export it yourself.

## References

- Original (archived): https://github.com/facebookresearch/demucs — last real commit Nov 2023
- Author's continuation fork: https://github.com/adefossez/demucs — v4.1.0a2, 8 ahead / 6
  behind the archive; pushed as recently as May 2026
- ONNX export PR (self-contained, still open): https://github.com/adefossez/demucs/pull/10
  by dhunstack
- GSoC 2025 writeup (STFT/ISTFT-as-real-ops technique):
  https://mixxx.org/news/2025-10-27-gsoc2025-demucs-to-onnx-dhunstack/
- Mixxx integration epic: https://github.com/mixxxdj/mixxx/issues/15495
- sevagh/demucs.cpp (fully handwritten C++/Eigen port): https://github.com/sevagh/demucs.cpp
- sevagh/demucs.onnx (STFT-outside flavor): https://github.com/sevagh/demucs.onnx
- gianlourbano/demucs-onnx (onnxruntime-web/WebGPU experiment):
  https://github.com/gianlourbano/demucs-onnx
- StemSplit demucs-onnx (PyPI + HF pre-exported models) — **do not build on: vibe-coded slop**;
  their Mixxx-epic comment reads as LLM promo. Export correctness, parity claims, and
  provenance all unverified. At most an untrusted cross-check.
