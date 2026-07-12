"""Export one prepared split-DSP HTDemucs model to ONNX."""

from pathlib import Path

import torch

from model import SplitHTDemucs


def export_onnx(
    model: SplitHTDemucs,
    mix: torch.Tensor,
    spectrogram: torch.Tensor,
    path: Path,
) -> None:
    torch.onnx.export(
        model,
        (mix, spectrogram),
        path,
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=["waveform", "spectrogram"],
        output_names=["frequency", "time"],
    )
