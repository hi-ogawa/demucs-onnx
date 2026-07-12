"""Generate the compact PyTorch reference fixture for the Rust iSTFT parity test."""

import argparse
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

SOURCES = 4
CHANNELS = 2
CAC_CHANNELS = CHANNELS * 2
SEGMENT = 343980
N_FFT = 4096
HOP = 1024
FRAMES = 336
FREQUENCIES = 2048
SAMPLE_STEP = 8


def deterministic_frequency_output() -> torch.Tensor:
    state = 0x87654321
    values = np.empty(SOURCES * CAC_CHANNELS * FREQUENCIES * FRAMES, dtype=np.float32)
    bits = values.view(np.uint32)
    for index in range(len(values)):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        bits[index] = 0x3F800000 | (state >> 9)
    values = (values - np.float32(1.0)) * np.float32(2.0) - np.float32(1.0)
    return torch.from_numpy(values.reshape(1, SOURCES, CAC_CHANNELS, FREQUENCIES, FRAMES))


def reconstruct(frequency: torch.Tensor) -> torch.Tensor:
    z = frequency.view(1, SOURCES, CHANNELS, 2, FREQUENCIES, FRAMES)
    z = torch.view_as_complex(z.permute(0, 1, 2, 4, 5, 3).contiguous())
    z = F.pad(z, (0, 0, 0, 1))
    z = F.pad(z, (2, 2))
    aligned_length = FRAMES * HOP
    padded_length = aligned_length + 2 * (3 * HOP // 2)
    waveform = torch.istft(
        z.reshape(-1, FREQUENCIES + 1, FRAMES + 4),
        n_fft=N_FFT,
        hop_length=HOP,
        window=torch.hann_window(N_FFT),
        normalized=True,
        center=True,
        length=padded_length,
    ).reshape(1, SOURCES, CHANNELS, padded_length)
    alignment_pad = 3 * HOP // 2
    return waveform[..., alignment_pad : alignment_pad + SEGMENT]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    with torch.no_grad():
        reference = reconstruct(deterministic_frequency_output())
    selected = reference[0, :, :, ::SAMPLE_STEP].contiguous().numpy().astype("<f4")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(selected.tobytes())
    print(f"wrote {selected.nbytes} bytes to {args.out}")


if __name__ == "__main__":
    main()
