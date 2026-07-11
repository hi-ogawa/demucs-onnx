"""Download YouTube audio and separate it into bass and no-bass stems."""

import argparse
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
MODELS = REPO_DIR / "data/onnx-lean"


def run(label, command):
    command_text = " ".join(shlex.quote(str(part)) for part in command)
    print(f"\n{'=' * 72}")
    print(f"STEP: {label}")
    print(f"{'=' * 72}")
    print(f"$ {command_text}", flush=True)

    start = time.perf_counter()
    subprocess.run(command, check=True)
    elapsed = time.perf_counter() - start

    print(f"{'-' * 72}")
    print(f"DONE: {label} ({elapsed:.2f}s)")
    print(f"{'-' * 72}", flush=True)


def time_slug(value):
    return f"{value:g}".replace(".", "p")


def slugify(value):
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "song"


def youtube_url(value):
    if value.startswith(("http://", "https://")):
        return value
    return f"https://www.youtube.com/watch?v={value}"


def main():
    parser = argparse.ArgumentParser(
        description="Download YouTube audio, optionally trim it, and run Demucs bass separation."
    )
    parser.add_argument("youtube", help="YouTube ID or URL")
    parser.add_argument("--name", help="output basename")
    parser.add_argument("--start", type=float, help="trim start time in seconds")
    parser.add_argument("--end", type=float, help="trim end time in seconds")
    args = parser.parse_args()

    if args.end is not None:
        start = args.start or 0
        if args.end <= start:
            parser.error("--end must be greater than --start")

    if not MODELS.is_dir():
        sys.exit(f"missing {MODELS}\nbuild it first: pnpm build-model htdemucs_ft_bass")

    os.chdir(REPO_DIR)
    name = slugify(args.name or args.youtube)
    url = youtube_url(args.youtube)

    input_dir = Path("data/input")
    input_dir.mkdir(parents=True, exist_ok=True)

    source = input_dir / f"{name}.wav"
    run(
        "download audio",
        [
            "yt-dlp",
            "--no-playlist",
            url,
            "-x",
            "--audio-format",
            "wav",
            "-o",
            str(input_dir / f"{name}.%(ext)s"),
        ],
    )

    demucs_input = source
    if args.start is not None or args.end is not None:
        trim_parts = ["trim"]
        if args.start is not None:
            trim_parts.append(f"s{time_slug(args.start)}")
        if args.end is not None:
            trim_parts.append(f"e{time_slug(args.end)}")
        clip = input_dir / f"{name}-{'-'.join(trim_parts)}.wav"
        command = ["ffmpeg", "-y"]
        if args.start is not None:
            command.extend(["-ss", str(args.start)])
        if args.end is not None:
            command.extend(["-to", str(args.end)])
        command.extend(["-i", str(source), str(clip)])
        run("trim clip", command)
        demucs_input = clip

    output_dir = Path("data/output") / demucs_input.stem
    run(
        "separate bass stem",
        [
            "pnpm",
            "cli-separate",
            "--name",
            "htdemucs_ft",
            "--two-stems",
            "bass",
            "--method",
            "minus",
            demucs_input,
            output_dir,
        ],
    )

    print(f"\nOutput: {output_dir}/")


if __name__ == "__main__":
    main()
