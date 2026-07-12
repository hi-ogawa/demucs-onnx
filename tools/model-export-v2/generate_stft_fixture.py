"""Generate the compact PyTorch reference fixture for the Rust STFT parity test."""

import argparse
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

CHANNELS = 2
SEGMENT = 343980
N_FFT = 4096
HOP = 1024
FRAMES = 336
FREQUENCY_INDICES = list(range(0, 2048, 32))


def deterministic_waveform() -> torch.Tensor:
    state = 0x12345678
    values = np.empty(CHANNELS * SEGMENT, dtype=np.float32)
    bits = values.view(np.uint32)
    for index in range(len(values)):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        bits[index] = 0x3F800000 | (state >> 9)
    values = (values - np.float32(1.0)) * np.float32(2.0) - np.float32(1.0)
    return torch.from_numpy(values.reshape(1, CHANNELS, SEGMENT))


def packed_stft(waveform: torch.Tensor) -> torch.Tensor:
    aligned_length = ((SEGMENT + HOP - 1) // HOP) * HOP
    alignment_pad = 3 * HOP // 2
    waveform = F.pad(
        waveform,
        (alignment_pad, alignment_pad + aligned_length - SEGMENT),
        mode="reflect",
    )
    z = torch.stft(
        waveform.reshape(-1, waveform.shape[-1]),
        n_fft=N_FFT,
        hop_length=HOP,
        window=torch.hann_window(N_FFT),
        normalized=True,
        center=True,
        return_complex=True,
        pad_mode="reflect",
    )
    z = z.reshape(1, CHANNELS, 2049, 340)[..., :-1, 2 : 2 + FRAMES]
    return torch.view_as_real(z).permute(0, 1, 4, 2, 3).reshape(1, 4, 2048, FRAMES)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    with torch.no_grad():
        reference = packed_stft(deterministic_waveform())
    selected = reference[0, :, FREQUENCY_INDICES, :].contiguous().numpy().astype("<f4")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(selected.tobytes())
    print(f"wrote {selected.nbytes} bytes to {args.out}")


if __name__ == "__main__":
    main()
