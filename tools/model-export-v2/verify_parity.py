"""Verify the Python split seam and exported ONNX branch outputs."""

from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from demucs.htdemucs import HTDemucs

from model import SplitHTDemucs, reconstruct


def verify_python_seam(
    core: HTDemucs, split: SplitHTDemucs, mix: torch.Tensor, spectrogram: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor]:
    with torch.no_grad():
        expected = core(mix)
        frequency, time = split(mix, spectrogram)
        actual = reconstruct(core, frequency, time)
    if not torch.equal(actual, expected):
        diff = (actual - expected).abs()
        raise SystemExit(
            "Python seam differs from HTDemucs.forward: "
            f"max abs {diff.max().item():.3e}, mse {(diff**2).mean().item():.3e}"
        )
    print("Python seam: exactly matches HTDemucs.forward")
    return frequency, time


def verify_onnx(
    path: Path,
    mix: torch.Tensor,
    spectrogram: torch.Tensor,
    expected_frequency: torch.Tensor,
    expected_time: torch.Tensor,
) -> dict[str, dict[str, float]]:
    model = onnx.load(str(path), load_external_data=False)
    onnx.checker.check_model(model)
    inputs = [(value.name, [dim.dim_value for dim in value.type.tensor_type.shape.dim])
              for value in model.graph.input]
    outputs = [(value.name, [dim.dim_value for dim in value.type.tensor_type.shape.dim])
               for value in model.graph.output]
    expected_inputs = [
        ("waveform", [1, 2, 343980]),
        ("spectrogram", [1, 4, 2048, 336]),
    ]
    expected_outputs = [
        ("frequency", [1, 4, 4, 2048, 336]),
        ("time", [1, 4, 2, 343980]),
    ]
    if inputs != expected_inputs or outputs != expected_outputs:
        raise SystemExit(f"unexpected ONNX contract: inputs={inputs}, outputs={outputs}")

    external = [initializer.name for initializer in model.graph.initializer
                if initializer.data_location == onnx.TensorProto.EXTERNAL]
    dft_shapes = {(2049, 1, 4096), (4098, 1, 4096), (356352,)}
    dft_constants = []
    for node in model.graph.node:
        if node.op_type != "Constant":
            continue
        for attribute in node.attribute:
            shape = tuple(attribute.t.dims)
            if shape in dft_shapes:
                dft_constants.append((node.output[0], shape))
    if external or dft_constants:
        raise SystemExit(
            f"split graph contains external data or DFT constants: {external=}, {dft_constants=}"
        )

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    frequency, time = session.run(
        ["frequency", "time"],
        {"waveform": mix.numpy(), "spectrogram": spectrogram.numpy()},
    )
    parity = {}
    for name, actual, expected in (
        ("frequency", frequency, expected_frequency.numpy()),
        ("time", time, expected_time.numpy()),
    ):
        diff = np.abs(actual - expected)
        max_abs = float(diff.max())
        mse = float((diff**2).mean())
        print(f"ONNX {name}: max abs {max_abs:.3e}, mse {mse:.3e}")
        if max_abs > 2e-3 or mse > 1e-7:
            raise SystemExit(f"ONNX {name} parity failed: max abs {max_abs:.3e}, mse {mse:.3e}")
        parity[name] = {"max_abs": max_abs, "mse": mse}
    print(f"split graph: {path.stat().st_size / 1e6:.1f} MB, no DFT payload")
    return parity
