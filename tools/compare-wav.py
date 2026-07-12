"""Compare float WAV files in two output directories."""

import argparse
import math
from pathlib import Path

import numpy as np
import soundfile as sf


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expected", type=Path)
    parser.add_argument("actual", type=Path)
    parser.add_argument("--max-abs", type=float, default=2e-3)
    parser.add_argument("--max-mse", type=float, default=1e-7)
    args = parser.parse_args()

    for name in ("max_abs", "max_mse"):
        value = getattr(args, name)
        if not math.isfinite(value) or value < 0:
            parser.error(f"--{name.replace('_', '-')} must be a finite nonnegative number")

    expected_files = {path.name: path for path in args.expected.glob("*.wav")}
    actual_files = {path.name: path for path in args.actual.glob("*.wav")}
    if not expected_files:
        parser.error(f"no WAV files found in {args.expected}")
    if expected_files.keys() != actual_files.keys():
        missing = sorted(expected_files.keys() - actual_files.keys())
        extra = sorted(actual_files.keys() - expected_files.keys())
        raise SystemExit(f"WAV file mismatch: missing={missing}, extra={extra}")

    failures = []
    for filename in sorted(expected_files):
        expected, expected_rate = sf.read(expected_files[filename], dtype="float32", always_2d=True)
        actual, actual_rate = sf.read(actual_files[filename], dtype="float32", always_2d=True)
        if expected_rate != actual_rate or expected.shape != actual.shape:
            failures.append(
                f"{filename}: expected {expected_rate}Hz {expected.shape}, "
                f"got {actual_rate}Hz {actual.shape}"
            )
            continue
        diff = expected - actual
        max_abs = float(np.abs(diff).max())
        mse = float(np.square(diff).mean())
        print(f"{filename:>12}: max {max_abs:.3e}  mse {mse:.3e}")
        if max_abs > args.max_abs or mse > args.max_mse:
            failures.append(
                f"{filename}: max {max_abs:.3e} (limit {args.max_abs:.3e}), "
                f"mse {mse:.3e} (limit {args.max_mse:.3e})"
            )

    if failures:
        raise SystemExit("parity check failed:\n  " + "\n  ".join(failures))


if __name__ == "__main__":
    main()
