#!/usr/bin/env python3
"""Download or publish the shipped Demucs model artifacts."""

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = "hi-ogawa/demucs-onnx"
MEMBERS = [
    "htdemucs",
    "htdemucs_ft_drums",
    "htdemucs_ft_bass",
    "htdemucs_ft_other",
    "htdemucs_ft_vocals",
]
ASSETS = ["dft.bin", *(f"{member}.onnx" for member in MEMBERS)]
REPO_DIR = Path(__file__).resolve().parents[1]
MODELS_DIR = REPO_DIR / "data/onnx-lean"


def run(args: list[str], capture_output: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=True,
        text=True,
        capture_output=capture_output,
    )


def download(args: argparse.Namespace) -> None:
    members = list(dict.fromkeys(args.members or MEMBERS))
    expected = ["dft.bin", *(f"{member}.onnx" for member in members)]
    MODELS_DIR.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix=".onnx-lean.download-", dir=MODELS_DIR.parent
    ) as temporary:
        staging = Path(temporary)
        patterns: list[str] = []
        for name in expected:
            patterns.extend(("--pattern", name))
        run(
            [
                "gh",
                "release",
                "download",
                args.tag,
                "--repo",
                REPO,
                "--dir",
                str(staging),
                *patterns,
            ]
        )

        for name in expected:
            if not (staging / name).is_file():
                raise SystemExit(f"release {args.tag} is missing asset: {name}")

        backup = Path(tempfile.mkdtemp(prefix=".onnx-lean.old-", dir=MODELS_DIR.parent))
        backup.rmdir()
        if MODELS_DIR.exists():
            os.replace(MODELS_DIR, backup)
        try:
            os.replace(staging, MODELS_DIR)
        except BaseException:
            if backup.exists():
                os.replace(backup, MODELS_DIR)
            raise
        if backup.exists():
            shutil.rmtree(backup)

    print(f"downloaded {len(members)} model(s) and dft.bin to {MODELS_DIR}")


def release(args: argparse.Namespace) -> None:
    missing = [str(MODELS_DIR / name) for name in ASSETS if not (MODELS_DIR / name).is_file()]
    if missing:
        raise SystemExit(
            f"missing release asset: {missing[0]}\n"
            "build the complete set with: pnpm build:model --all"
        )

    paths = [str(MODELS_DIR / name) for name in ASSETS]
    existing = subprocess.run(
        ["gh", "release", "view", args.tag, "--repo", REPO],
        text=True,
        capture_output=True,
    )
    if existing.returncode == 0:
        run(
            [
                "gh",
                "release",
                "upload",
                args.tag,
                *paths,
                "--clobber",
                "--repo",
                REPO,
            ]
        )
    elif "release not found" in existing.stderr.lower():
        run(
            [
                "gh",
                "release",
                "create",
                args.tag,
                *paths,
                "--repo",
                REPO,
                "--target",
                "main",
                "--title",
                f"Demucs ONNX models ({args.tag})",
                "--notes-file",
                str(REPO_DIR / "docs/model-release-notes.md"),
            ]
        )
    else:
        raise SystemExit(existing.stderr.strip())

    run(["gh", "release", "view", args.tag, "--repo", REPO])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(required=True)

    download_parser = subparsers.add_parser("download", help="download release assets")
    download_parser.add_argument("tag")
    download_parser.add_argument("members", nargs="*", choices=MEMBERS)
    download_parser.set_defaults(func=download)

    release_parser = subparsers.add_parser("release", help="create or update a release")
    release_parser.add_argument("tag")
    release_parser.set_defaults(func=release)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
