#!/usr/bin/env python
"""Export htdemucs / htdemucs_ft to self-contained ONNX (waveform in -> stems out).

Adapted from dhunstack's scripts/convert-pth-to-onnx.py (adefossez/demucs PR #10).
The PR script hardcodes `htdemucs` and exports only `models[0]` of a bag; this version
exports every bag member, naming each by its one-hot source specialty so that
htdemucs_ft yields htdemucs_ft_{drums,bass,other,vocals}.onnx.

Usage:
    uv run python export_onnx.py --model htdemucs_ft --out ../../data/onnx
    uv run python export_onnx.py --model htdemucs_ft --sources bass --out ../../data/onnx
    uv run python export_onnx.py --model htdemucs --out ../../data/onnx

Graph contract (per exported file):
    input:  float32 (1, 2, 343980)   stereo 44.1kHz, exactly segment*samplerate samples
    output: float32 (1, 4, 2, 343980)  sources [drums, bass, other, vocals]
"""

import argparse
from pathlib import Path

import torch
from demucs.apply import BagOfModels
from demucs.htdemucs import HTDemucs
from demucs.pretrained import get_model


def specialty(sources: list[str], weights: list[float]) -> str:
    """Name a bag member by its one-hot weight (htdemucs_ft convention)."""
    nonzero = [s for s, w in zip(sources, weights) if w > 0]
    return nonzero[0] if len(nonzero) == 1 else "mixed"


def export_one(core: HTDemucs, path: Path) -> None:
    core.eval()
    core.onnx_exportable = True  # PR #10 flag: swap STFT/iSTFT to ONNX-compatible impls
    length = int(core.segment * core.samplerate)
    dummy = torch.randn(1, 2, length)
    print(f"exporting {path.name} (input length {length}) ...")
    torch.onnx.export(
        core,
        (dummy,),
        path,
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=["input"],
        output_names=["output"],
    )
    print(f"  wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="htdemucs_ft")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--sources",
        nargs="*",
        help="for a bag, export only these specialists (e.g. --sources bass)",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    model = get_model(args.model)
    if isinstance(model, HTDemucs):
        export_one(model, args.out / f"{args.model}.onnx")
    elif isinstance(model, BagOfModels):
        if len(model.models) == 1:
            # single-member bag (e.g. plain htdemucs): no specialty suffix
            assert isinstance(model.models[0], HTDemucs)
            export_one(model.models[0], args.out / f"{args.model}.onnx")
            return
        for sub, weights in zip(model.models, model.weights):
            assert isinstance(sub, HTDemucs)
            name = specialty(model.sources, weights)
            if args.sources and name not in args.sources:
                continue
            export_one(sub, args.out / f"{args.model}_{name}.onnx")
    else:
        raise TypeError(f"unsupported model type: {type(model)}")


if __name__ == "__main__":
    main()
