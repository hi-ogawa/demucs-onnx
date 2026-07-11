#!/usr/bin/env python
"""Export and size-optimize an exact set of shipped Demucs ONNX models."""

import argparse
import os
import shutil
import tempfile
from pathlib import Path

MEMBERS = (
    "htdemucs",
    "htdemucs_ft_drums",
    "htdemucs_ft_bass",
    "htdemucs_ft_other",
    "htdemucs_ft_vocals",
)
FT_PREFIX = "htdemucs_ft_"
REPO_DIR = Path(__file__).resolve().parents[2]


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
    parser.add_argument("--all", action="store_true", help="build all shipped model members")
    parser.add_argument("--cache", type=Path, default=REPO_DIR / "data/onnx")
    parser.add_argument("--out", type=Path, default=REPO_DIR / "data/onnx-lean")
    parser.add_argument(
        "--precision",
        choices=("fp32", "fp16"),
        default="fp32",
        help="weight storage precision; model computation and I/O remain fp32",
    )
    args = parser.parse_args()

    if args.all and args.members:
        parser.error("pass either --all or explicit members, not both")
    if not args.all and not args.members:
        parser.error("pass --all or at least one member")

    requested = list(MEMBERS) if args.all else list(dict.fromkeys(args.members))
    unknown = [name for name in requested if name not in MEMBERS]
    if unknown:
        parser.error(f"unknown member(s): {', '.join(unknown)}; expected: {', '.join(MEMBERS)}")

    cache = args.cache.resolve()
    output = args.out.resolve()
    if cache == output:
        parser.error("--cache and --out must be different directories")
    cache.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)

    from export_onnx import export_model
    from strip_dft import strip_models

    if "htdemucs" in requested and not (cache / "htdemucs.onnx").is_file():
        export_model("htdemucs", cache)

    missing_ft = [
        name.removeprefix(FT_PREFIX)
        for name in requested
        if name.startswith(FT_PREFIX) and not (cache / f"{name}.onnx").is_file()
    ]
    if missing_ft:
        export_model("htdemucs_ft", cache, missing_ft)

    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.new-", dir=output.parent))
    try:
        source = cache
        converted = None
        if args.precision == "fp16":
            from convert_fp16 import convert_model

            converted = Path(tempfile.mkdtemp(prefix=".onnx-fp16-", dir=output.parent))
            for name in requested:
                convert_model(cache / f"{name}.onnx", converted / f"{name}.onnx")
            source = converted
        strip_models(requested, source, staging)
        replace_output(staging, output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        if converted is not None:
            shutil.rmtree(converted, ignore_errors=True)

    print(f"wrote {len(requested)} model(s) to {output}")


if __name__ == "__main__":
    main()
