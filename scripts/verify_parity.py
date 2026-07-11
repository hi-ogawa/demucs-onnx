#!/usr/bin/env python
"""Verify an exported ONNX graph against the original PyTorch forward path.

The comparison that matters: ONNX output vs the *original* torch path
(onnx_exportable=False, i.e. real torch.stft/istft), on the same chunk. That checks
both the export and PR #10's STFT/iSTFT rewrite in one shot. GSoC reports MSE < 1e-4;
StemSplit claims 1.6e-4 max abs diff -- we produce our own numbers.

Usage:
    uv run python verify_parity.py --onnx ../data/onnx/htdemucs_ft_bass.onnx \
        --model htdemucs_ft --index 1
    uv run python verify_parity.py --onnx ... --model ... --index 1 --wav ../data/input/clip.wav

--index picks the bag member (htdemucs_ft order: 0=drums 1=bass 2=other 3=vocals);
omit for a plain HTDemucs model. Without --wav, uses a seeded random chunk (harsher
than music for numerical comparison, which is fine).
"""

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from demucs.apply import BagOfModels
from demucs.pretrained import get_model


def load_chunk(wav: Path | None, length: int) -> torch.Tensor:
    if wav is None:
        gen = torch.Generator().manual_seed(42)
        return torch.randn(1, 2, length, generator=gen)
    import soundfile as sf

    data, sr = sf.read(wav, dtype="float32", always_2d=True)
    assert sr == 44100, f"expected 44.1kHz input, got {sr} (resample first)"
    data = data.T[None, :2, :length]  # (1, 2, N)
    out = torch.zeros(1, 2, length)
    out[..., : data.shape[-1]] = torch.from_numpy(data.copy())
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx", type=Path, required=True)
    parser.add_argument("--model", default="htdemucs_ft")
    parser.add_argument("--index", type=int, default=None, help="bag member index")
    parser.add_argument("--wav", type=Path, default=None)
    args = parser.parse_args()

    model = get_model(args.model)
    core = model.models[args.index] if isinstance(model, BagOfModels) else model
    core.eval()
    assert not getattr(core, "onnx_exportable", False), "reference must use the real torch path"

    length = int(core.segment * core.samplerate)
    chunk = load_chunk(args.wav, length)

    with torch.no_grad():
        ref = core(chunk).numpy()  # (1, 4, 2, length)

    sess = ort.InferenceSession(str(args.onnx), providers=["CPUExecutionProvider"])
    (out,) = sess.run(["output"], {"input": chunk.numpy()})

    assert out.shape == ref.shape, f"shape mismatch: onnx {out.shape} vs torch {ref.shape}"
    diff = np.abs(out - ref)
    print(f"shape: {ref.shape}")
    print(f"max abs diff: {diff.max():.3e}")
    print(f"mse:          {(diff ** 2).mean():.3e}")
    for i, src in enumerate(core.sources):
        d = diff[0, i]
        print(f"  {src:>6}: max {d.max():.3e}  mse {(d ** 2).mean():.3e}")


if __name__ == "__main__":
    main()
