"""Verify an exported ONNX graph against the original PyTorch forward path.

The comparison that matters: ONNX output vs the *original* torch path
(onnx_exportable=False, i.e. real torch.stft/istft), on the same chunk. That checks
both the export and PR #10's STFT/iSTFT rewrite in one shot. GSoC reports MSE < 1e-4;
StemSplit claims 1.6e-4 max abs diff -- we produce our own numbers.

Usage:
    pnpm verify-parity --onnx data/onnx/htdemucs.onnx \
        --stripped-onnx data/onnx-lean/htdemucs.onnx --model htdemucs
    pnpm verify-parity --onnx data/onnx/htdemucs_ft_bass.onnx \
        --model htdemucs_ft --index 1
    uv run python tools/model-export/verify_parity.py --onnx ... --model ... --index 1 --wav data/input/clip.wav

--index picks the bag member (htdemucs_ft order: 0=drums 1=bass 2=other 3=vocals);
omit for a plain HTDemucs model. Without --wav, uses a seeded random chunk (harsher
than music for numerical comparison, which is fine).
"""

import argparse
import math
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
    parser.add_argument("--stripped-onnx", type=Path)
    parser.add_argument("--model", default="htdemucs_ft")
    parser.add_argument("--index", type=int, default=None, help="bag member index")
    parser.add_argument("--wav", type=Path, default=None)
    parser.add_argument("--max-abs", type=float, default=2e-3)
    parser.add_argument("--max-mse", type=float, default=1e-7)
    args = parser.parse_args()

    if not args.onnx.is_file():
        parser.error(f"ONNX model not found: {args.onnx}")
    if args.stripped_onnx is not None and not args.stripped_onnx.is_file():
        parser.error(f"stripped ONNX model not found: {args.stripped_onnx}")
    for name in ("max_abs", "max_mse"):
        value = getattr(args, name)
        if not math.isfinite(value) or value < 0:
            parser.error(f"--{name.replace('_', '-')} must be a finite nonnegative number")

    model = get_model(args.model)
    if isinstance(model, BagOfModels):
        if args.index is None:
            if len(model.models) != 1:
                parser.error(f"--index is required for {args.model} ({len(model.models)} members)")
            core = model.models[0]
        elif not 0 <= args.index < len(model.models):
            parser.error(f"--index must be between 0 and {len(model.models) - 1}")
        else:
            core = model.models[args.index]
    else:
        if args.index is not None:
            parser.error(f"--index is not valid for single model {args.model}")
        core = model
    core.eval()
    assert not getattr(core, "onnx_exportable", False), "reference must use the real torch path"

    length = int(core.segment * core.samplerate)
    chunk = load_chunk(args.wav, length)

    with torch.no_grad():
        ref = core(chunk).numpy()  # (1, 4, 2, length)

    def run_onnx(path: Path) -> np.ndarray:
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        (output,) = sess.run(["output"], {"input": chunk.numpy()})
        return output

    out = run_onnx(args.onnx)

    assert out.shape == ref.shape, f"shape mismatch: onnx {out.shape} vs torch {ref.shape}"
    diff = np.abs(out - ref)
    max_abs = float(diff.max())
    mse = float((diff**2).mean())
    print(f"shape: {ref.shape}")
    print(f"max abs diff: {max_abs:.3e} (limit {args.max_abs:.3e})")
    print(f"mse:          {mse:.3e} (limit {args.max_mse:.3e})")
    for i, src in enumerate(core.sources):
        d = diff[0, i]
        print(f"  {src:>6}: max {d.max():.3e}  mse {(d**2).mean():.3e}")

    failures = []
    if max_abs > args.max_abs:
        failures.append(f"max abs diff {max_abs:.3e} > {args.max_abs:.3e}")
    if mse > args.max_mse:
        failures.append(f"mse {mse:.3e} > {args.max_mse:.3e}")
    if failures:
        raise SystemExit(f"parity check failed: {', '.join(failures)}")

    if args.stripped_onnx is not None:
        stripped = run_onnx(args.stripped_onnx)
        assert stripped.shape == out.shape, (
            f"shape mismatch: stripped {stripped.shape} vs unstripped {out.shape}"
        )
        if not np.array_equal(stripped, out):
            strip_diff = np.abs(stripped - out)
            raise SystemExit(
                "stripped model differs from unstripped model: "
                f"max abs diff {strip_diff.max():.3e}, mse {(strip_diff**2).mean():.3e}"
            )
        print("stripped model: exactly matches unstripped output")


if __name__ == "__main__":
    main()
