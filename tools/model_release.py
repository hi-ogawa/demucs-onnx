#!/usr/bin/env python3
"""Download or publish the shipped Demucs model artifacts."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

MEMBERS = (
    "htdemucs",
    "htdemucs_ft_drums",
    "htdemucs_ft_bass",
    "htdemucs_ft_other",
    "htdemucs_ft_vocals",
)
ASSETS = ("dft.bin", *(f"{member}.onnx" for member in MEMBERS))
REPO_DIR = Path(__file__).resolve().parents[1]
MODELS_DIR = REPO_DIR / "data/onnx-lean"


def run(*args: str, capture_output: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=True,
        text=True,
        capture_output=capture_output,
    )


def github_repo() -> str:
    run("gh", "auth", "status", capture_output=True)
    result = run(
        "gh",
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
        capture_output=True,
    )
    return result.stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_checksums(path: Path) -> None:
    path.write_text(
        "".join(f"{sha256(MODELS_DIR / name)}  {name}\n" for name in ASSETS)
    )


def read_checksums(path: Path) -> dict[str, str]:
    checksums = {}
    for line in path.read_text().splitlines():
        digest, separator, name = line.partition("  ")
        if not separator or len(digest) != 64:
            raise SystemExit(f"invalid checksum line in {path}: {line}")
        checksums[name] = digest
    return checksums


def download(args: argparse.Namespace) -> None:
    members = tuple(dict.fromkeys(args.members or MEMBERS))
    repo = github_repo()
    expected = ("dft.bin", *(f"{member}.onnx" for member in members))
    MODELS_DIR.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix=".onnx-lean.download-", dir=MODELS_DIR.parent
    ) as temporary:
        staging = Path(temporary)
        patterns = []
        for name in (*expected, "SHA256SUMS"):
            patterns.extend(("--pattern", name))
        run(
            "gh",
            "release",
            "download",
            args.tag,
            "--repo",
            repo,
            "--dir",
            str(staging),
            *patterns,
        )

        for name in (*expected, "SHA256SUMS"):
            if not (staging / name).is_file():
                raise SystemExit(f"release {args.tag} is missing asset: {name}")
        checksums = read_checksums(staging / "SHA256SUMS")
        for name in expected:
            if name not in checksums:
                raise SystemExit(f"SHA256SUMS is missing an entry for {name}")
            if sha256(staging / name) != checksums[name]:
                raise SystemExit(f"checksum mismatch: {name}")

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

    repo = github_repo()
    with tempfile.TemporaryDirectory() as temporary:
        checksums = Path(temporary) / "SHA256SUMS"
        write_checksums(checksums)
        paths = (*(str(MODELS_DIR / name) for name in ASSETS), str(checksums))
        existing = subprocess.run(
            ("gh", "release", "view", args.tag, "--repo", repo),
            text=True,
            capture_output=True,
        )
        if existing.returncode == 0:
            if args.draft:
                raise SystemExit("--draft only applies when creating a release")
            run("gh", "release", "upload", args.tag, *paths, "--clobber", "--repo", repo)
        elif "release not found" in existing.stderr.lower():
            command = (
                "gh",
                "release",
                "create",
                args.tag,
                *paths,
                "--repo",
                repo,
                "--target",
                "main",
                "--title",
                f"Demucs ONNX models ({args.tag})",
                "--notes-file",
                str(REPO_DIR / "docs/model-release-notes.md"),
            )
            run(*command, *(("--draft",) if args.draft else ()))
        else:
            raise SystemExit(existing.stderr.strip())

    result = run(
        "gh",
        "release",
        "view",
        args.tag,
        "--repo",
        repo,
        "--json",
        "url,isDraft,assets",
        capture_output=True,
    )
    details = json.loads(result.stdout)
    print(json.dumps({
        "url": details["url"],
        "isDraft": details["isDraft"],
        "assets": [asset["name"] for asset in details["assets"]],
    }, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(required=True)

    download_parser = subparsers.add_parser("download", help="download release assets")
    download_parser.add_argument("tag")
    download_parser.add_argument("members", nargs="*", choices=MEMBERS)
    download_parser.set_defaults(func=download)

    release_parser = subparsers.add_parser("release", help="create or update a release")
    release_parser.add_argument("tag")
    release_parser.add_argument("--draft", action="store_true")
    release_parser.set_defaults(func=release)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
