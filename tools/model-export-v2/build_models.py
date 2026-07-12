"""Build and verify split-DSP HTDemucs ONNX model artifacts.

Usage:
    uv run --project tools/model-export-v2 python tools/model-export-v2/build_models.py \
        htdemucs --out data/onnx-split
    uv run --project tools/model-export-v2 python tools/model-export-v2/build_models.py \
        --all --out data/onnx-split
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import torch
from demucs.htdemucs import HTDemucs

from export_onnx import export_onnx
from model import FT_PREFIX, MEMBERS, SplitHTDemucs, load_members, mix_length, pack_spectrogram
from verify_parity import verify_onnx, verify_python_seam


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def export_member(name: str, core: HTDemucs, out: Path) -> dict:
    print(f"exporting {name} ...")
    split = SplitHTDemucs(core).eval()
    generator = torch.Generator().manual_seed(42)
    mix = torch.randn(1, 2, mix_length(core), generator=generator)
    with torch.no_grad():
        spectrogram = pack_spectrogram(core, mix)
    frequency, time = verify_python_seam(core, split, mix, spectrogram)

    path = out / f"{name}.onnx"
    export_onnx(split, mix, spectrogram, path)
    parity = verify_onnx(path, mix, spectrogram, frequency, time)
    return {
        "file": path.name,
        "member": name,
        "precision": "fp32",
        "sha256": sha256(path),
        "size": path.stat().st_size,
        "specialty": name.removeprefix(FT_PREFIX) if name.startswith(FT_PREFIX) else None,
        "parity": parity,
    }


def replace_output(staging: Path, output: Path) -> None:
    backup = None
    if output.exists():
        backup = Path(tempfile.mkdtemp(prefix=f".{output.name}.old-", dir=output.parent))
        backup.rmdir()
        os.replace(output, backup)
    try:
        os.replace(staging, output)
    except BaseException:
        if backup is not None:
            os.replace(backup, output)
        raise
    if backup is not None:
        shutil.rmtree(backup)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("members", nargs="*", metavar="MEMBER")
    parser.add_argument("--all", action="store_true", help="build all model members")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    if args.all and args.members:
        parser.error("pass either --all or explicit members, not both")
    if not args.all and not args.members:
        parser.error("pass --all or at least one member")
    requested = list(MEMBERS) if args.all else list(dict.fromkeys(args.members))
    unknown = [name for name in requested if name not in MEMBERS]
    if unknown:
        parser.error(f"unknown member(s): {', '.join(unknown)}; expected: {', '.join(MEMBERS)}")

    output = args.out.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.new-", dir=output.parent))
    try:
        cores = load_members(requested)
        models = [export_member(name, cores[name], staging) for name in requested]
        manifest = {
            "format": 1,
            "graph_flavor": "split-dsp",
            "models": models,
            "onnx_contract": {
                "inputs": {
                    "waveform": [1, 2, 343980],
                    "spectrogram": [1, 4, 2048, 336],
                },
                "outputs": {
                    "frequency": [1, 4, 4, 2048, 336],
                    "time": [1, 4, 2, 343980],
                },
                "sample_rate": 44100,
                "sources": ["drums", "bass", "other", "vocals"],
            },
            "upstream": {"demucs": "4.1.0"},
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        )
        replace_output(staging, output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(f"wrote {len(requested)} model(s) and manifest to {output}")


if __name__ == "__main__":
    main()
