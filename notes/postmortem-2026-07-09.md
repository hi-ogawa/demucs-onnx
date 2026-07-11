# Postmortem — Iteration 1 (2026-07-09): ONNX Export + Parity

## Goal

Reproduce the htdemucs ONNX export ourselves from PR #10 code (uv, CPU-only), produce our own
parity numbers instead of trusting anyone's claims.

## What Happened

Everything landed first-try:

- `uv sync` clean: torch 2.1.2+cpu / torchaudio 2.1.2 against `dhunstack/demucs@6a96f8c`
- Exported `htdemucs_ft_bass.onnx` (304.4 MB, opset 17, `input (1,2,343980)` →
  `output (1,4,2,343980)`)
- Parity vs original torch path (real `torch.stft/istft`, seeded random chunk):
  **max abs diff 4.5e-4, MSE 4.3e-9**; bass stem itself 2.5e-5. Better than the GSoC-claimed
  MSE < 1e-4. The PR's STFT/iSTFT rewrite checks out under independent reproduction.

## Findings

**File anatomy** (the surprise of the iteration):

| Component | Size | Notes |
|---|---|---|
| Learned weights (533 initializers) | 168 MB | the actual ~42M params, fp32 |
| STFT/iSTFT DFT kernels (3 Constant tensors) | 136 MB | cos/sin `[2049,1,4096]` ×2 + synthesis `[4098,1,4096]` |
| Graph structure (4,523 nodes) | ~0 | 1,496 Constants, mostly shape scalars |

45% of the file is deterministic sin/cos tables — the "self-contained graph" tax. They are
identical across all 4 ft specialists. Size levers for later: ONNX external-data format (one
shared graph + swappable per-specialist weight blobs), dedupe or client-side synthesis of DFT
tables, fp16 weights (~84 MB/specialist). Plausible web payload for one specialist: ~90 MB vs
naive 304 MB.

**Other:**

- Bag order confirmed empirically: `models[1]` = bass specialist (parity would explode otherwise)
- TracerWarnings at export are expected: the trace bakes the fixed chunk shape, which *is* the
  contract
- Output tensor metadata reports dims `[0,0,0,0]` (unknown) even though the shape is fixed —
  cosmetic, but the Rust side shouldn't rely on declared output shape
- PR #10's own convert script hardcodes `htdemucs` and exports only `models[0]` of a bag —
  it cannot produce the ft specialists as-is. Our `export_onnx.py` iterates the bag and names
  members by one-hot source. Reinforces the reproduce-don't-trust stance: even the "good"
  reference needed reading and fixing.

## What Went Wrong / Friction

- GitHub raw fetches got 429-rate-limited during recon (use `gh api` instead)
- **Scope shortcut, corrected by Hiroshi**: I exported only the bass specialist because the
  personal use case is bass covers. Product-wise the tool should offer arbitrary stem choice like
  anyone would expect — the artifact set must be complete (all 4 specialists), and the bass-only
  path is a runtime *optimization* (minus mode loads 1 model), not an artifact-level shortcut.

## Resources

Workspace: `data/` 291 MB, `scripts/.venv` 988 MB (both gitignored). Export + parity ran niced,
4 threads, well within the laptop's headroom.
