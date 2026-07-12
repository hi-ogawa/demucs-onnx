# Design: Split DSP Models

This document proposes the next model and runtime architecture: export only the learned HTDemucs
core to ONNX and move STFT/iSTFT into the native and WASM runtimes. It is a migration design, while
[`architecture.md`](architecture.md) remains the description of the currently shipped
self-contained graph and shared `dft.bin` artifacts.

## Motivation

The current waveform-to-waveform ONNX graph replaces upstream `torch.stft` and `torch.istft` with
real-valued convolution and transposed-convolution operations. Four deterministic tensors account
for 135.7 MB of every baked graph. We externalize their identical bytes into one shared `dft.bin`,
but a user still needs that file before any model can run.

A split-DSP graph removes those tensors rather than deduplicating them:

```text
waveform
  -> runtime STFT and complex-as-channels packing
  -> learned-core ONNX
  -> runtime complex unpacking and iSTFT
  -> frequency/time branch sum
  -> stems
```

This reduces one standard FP32 workflow from approximately 304 MB to 168 MB. Combined with FP16
weight storage, the model artifact can be approximately 84 MB with no separate DFT artifact.

The reference remains upstream's original `torch.stft`/`torch.istft` path. The current ONNX DFT
rewrite is a verified implementation and useful comparison, but its pseudoinverse-derived iSTFT
basis is not an artifact the new runtime should reproduce bit for bit.

## Boundary

For the fixed 7.8-second HTDemucs segment, the split ONNX contract is:

```text
inputs:
  waveform      float32 [1, 2, 343980]
  spectrogram   float32 [1, 4, 2048, 336]

outputs:
  frequency     float32 [1, 4, 4, 2048, 336]
  time          float32 [1, 4, 2, 343980]
```

The spectrogram and frequency tensors use complex-as-channels ordering. For each stereo signal,
the four channels are `left.real`, `left.imag`, `right.real`, and `right.imag`. The output adds a
source dimension in `[drums, bass, other, vocals]` order.

The ONNX graph owns:

- frequency-branch mean/std normalization;
- waveform-branch mean/std normalization;
- both encoders and decoders and the cross-domain transformer;
- branch denormalization.

The runtime owns:

- HTDemucs reflect padding and alignment;
- periodic-Hann STFT and normalized real FFT;
- Nyquist removal, frame cropping, and complex-as-channels packing;
- inverse packing, Nyquist and frame restoration, and normalized iSTFT;
- final alignment crop and addition of the frequency and time branches.

Keeping normalization in ONNX minimizes the new boundary. It also avoids duplicating PyTorch's
Bessel-corrected standard-deviation behavior in another part of the runtime.

## DSP Contract

Given `N = 343980`, `n_fft = 4096`, and `hop = 1024`:

1. Set `frames = ceil(N / hop) = 336` and `alignment_pad = 3 * hop / 2 = 1536`.
2. Reflect-pad the waveform by 1536 samples on the left and 1620 on the right, producing 347136
   samples. The extra 84 right samples make the aligned length divisible by the hop.
3. Run a centered, normalized STFT with a periodic Hann window. Centering contributes another
   2048 reflected samples at each edge. The result has shape `[1, 2, 2049, 340]` as complex values.
4. Remove the Nyquist bin and two frames from each edge, producing `[1, 2, 2048, 336]`.
5. Pack real and imaginary values into `[1, 4, 2048, 336]` and run ONNX.
6. Unpack each source's frequency output into stereo complex values, restore a zero Nyquist bin,
   and restore two zero frames at each edge.
7. Run normalized iSTFT for an aligned length of 347136, then crop
   `[1536 : 1536 + 343980]`.
8. Add the reconstructed frequency waveform to the ONNX time-branch output.

The FFT algorithm and floating-point reduction order need not match PyTorch bitwise. Shape,
padding, window, normalization, bin/frame selection, channel order, and output alignment are the
semantic contract.

## Export Design

Do not remove nodes from an already exported waveform graph. Export a module whose forward method
starts after `_spec`/complex packing and ends before complex unpacking/`_ispec` and branch addition.
This gives ONNX explicit, stable inputs and outputs and prevents DFT constants from entering the
graph in the first place.

The first implementation should be an exporter-local wrapper around the pinned `HTDemucs` model.
It may reproduce the learned middle of `HTDemucs.forward` while reusing the model's existing
submodules and parameters. This avoids making a new fork patch part of the artifact chain before
the boundary is proven. If maintaining that wrapper requires copying an unreasonable amount of
upstream control flow, extract a `forward_core` method in a new pinned fork commit instead.

Split artifacts must use a distinct directory, filename convention, and manifest flavor while the
current self-contained artifacts remain supported. A split model must never be loadable as a
waveform model by accident.

## Verification

Verification is layered so each failure identifies one boundary:

1. **Python seam:** compute the spectrogram with the model's existing `_spec`, run the extracted
   learned core, reconstruct with the existing `_ispec`, and compare with the original
   `HTDemucs.forward` on the same input.
2. **Split ONNX:** compare the ONNX frequency and time outputs separately with the extracted
   PyTorch core outputs.
3. **Runtime STFT:** compare packed Rust STFT output with a saved PyTorch tensor before invoking
   ONNX.
4. **Runtime iSTFT:** feed saved frequency output into both Rust reconstruction and PyTorch
   `_ispec`, then compare aligned waveforms.
5. **Complete chunk:** compare the split runtime's final chunk with original PyTorch and the current
   self-contained ONNX graph.
6. **Orchestration:** run full-track tests covering overlap, deterministic shifts, standard and
   fine-tuned models, and add/minus two-stem modes.
7. **Browser:** run the same model and representative fixtures through native ORT and
   onnxruntime-web WASM.

Use measured tolerances rather than bit equality. Keep max-absolute and MSE metrics, per-source
diagnostics, and representative listening tests. The existing waveform parity baseline is a useful
scale: approximately `7.3e-4` max absolute error and `6.15e-9` MSE against PyTorch.

## Delivery Steps

### 1. Prove the seam in Python

- Add the exporter-local learned-core wrapper.
- Add a deterministic test that reconstructs the original forward result with `_spec`, the wrapper,
  and `_ispec`.
- Export one experimental `htdemucs` split model.
- Assert the graph contract and assert that no external data or large DFT constants are present.

Stop here if the wrapper cannot reproduce the original model before introducing ONNX or new FFT
code.

### 2. Verify the split ONNX artifact

- Compare frequency and time outputs independently against PyTorch.
- Extend model-building scripts with an explicit split flavor.
- Generate all standard and fine-tuned members only after the standard model passes.
- Record exact model sizes and tensor metadata.

### 3. Implement native runtime DSP

- Add reusable real-FFT plans, Hann window, and work buffers with `realfft`/`rustfft`.
- Implement the padding, packing, reconstruction, and crop contract above.
- Change the native backend to provide two inputs and consume two outputs.
- Preserve the existing member, shift, chunk, overlap-add, and stem-finalization orchestration.

### 4. Integrate WASM

- Reuse the Rust DSP implementation and buffers in WASM.
- Minimize JS/WASM copies and recreate typed-array views after memory growth.
- Update browser model requirements so split artifacts do not request `dft.bin`.
- Retain the current URL/file-backed model source abstraction.

### 5. Benchmark execution providers

- Compare split and self-contained graphs on native CPU and browser WASM.
- Measure WebGPU separately. A split chunk transfers approximately 11 MB of frequency input and
  reads approximately 44 MB of frequency output, so the self-contained graph may remain preferable
  for GPU execution providers.
- Select model flavor explicitly by backend; do not assume one graph is optimal everywhere.

### 6. Migrate distribution

- Publish split artifacts as an opt-in release flavor with manifest metadata.
- Keep self-contained artifacts available until native and browser parity and performance are
  established.
- Make split DSP the CPU/WASM default only after release-level verification.
- Remove `dft.bin` from the default workflow when no supported default path requires it.

## Decision Points

- **Exporter wrapper or fork patch:** begin with a local wrapper; patch the fork only if extraction
  cannot stay reviewable.
- **One universal graph or backend-specific flavors:** decide from WebGPU transfer benchmarks.
- **FP32 or FP16 default:** treat precision independently from the DSP split and require its own
  compatibility and parity evidence.
- **Retiring self-contained artifacts:** defer until split models have shipped and fallback value is
  understood.
