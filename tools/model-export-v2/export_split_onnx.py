"""Prove and export the experimental split-DSP HTDemucs graph.

The exported graph contains only the learned middle of HTDemucs. The caller owns STFT,
complex-as-channels packing, iSTFT, and the final frequency/time branch sum.

Usage:
    uv run --project tools/model-export-v2 python tools/model-export-v2/export_split_onnx.py \
        htdemucs --out data/onnx-split
    uv run --project tools/model-export-v2 python tools/model-export-v2/export_split_onnx.py \
        --all --out data/onnx-split
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
import torch
from demucs.apply import BagOfModels
from demucs.htdemucs import HTDemucs
from demucs.pretrained import get_model
from einops import rearrange

MEMBERS = (
    "htdemucs",
    "htdemucs_ft_drums",
    "htdemucs_ft_bass",
    "htdemucs_ft_other",
    "htdemucs_ft_vocals",
)
FT_PREFIX = "htdemucs_ft_"


class SplitHTDemucs(torch.nn.Module):
    """HTDemucs from packed spectrogram/waveform inputs to decoded branch outputs."""

    def __init__(self, core: HTDemucs) -> None:
        super().__init__()
        if not core.cac:
            raise ValueError("split export requires complex-as-channels mode")
        self.core = core
        self.length = mix_length(core)

    def forward(
        self, mix: torch.Tensor, spectrogram: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        core = self.core
        x = spectrogram
        batch, _, frequencies, frames = x.shape

        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)

        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)

        saved = []
        saved_t = []
        lengths = []
        lengths_t = []
        for idx, encode in enumerate(core.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(core.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = core.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and core.freq_emb is not None:
                frequency_indices = torch.arange(x.shape[-2], device=x.device)
                embedding = core.freq_emb(frequency_indices).t()[None, :, :, None].expand_as(x)
                x = x + core.freq_emb_scale * embedding
            saved.append(x)

        if core.crosstransformer:
            if core.bottom_channels:
                _, _, frequency_bins, _ = x.shape
                x = rearrange(x, "b c f t -> b c (f t)")
                x = core.channel_upsampler(x)
                x = rearrange(x, "b c (f t) -> b c f t", f=frequency_bins)
                xt = core.channel_upsampler_t(xt)

            x, xt = core.crosstransformer(x, xt)

            if core.bottom_channels:
                x = rearrange(x, "b c f t -> b c (f t)")
                x = core.channel_downsampler(x)
                x = rearrange(x, "b c (f t) -> b c f t", f=frequency_bins)
                xt = core.channel_downsampler_t(xt)

        for idx, decode in enumerate(core.decoder):
            skip = saved.pop()
            x, pre = decode(x, skip, lengths.pop())
            offset = core.depth - len(core.tdecoder)
            if idx >= offset:
                tdec = core.tdecoder[idx - offset]
                length_t = lengths_t.pop()
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    xt, _ = tdec(xt, saved_t.pop(), length_t)

        sources = len(core.sources)
        x = x.view(batch, sources, -1, frequencies, frames)
        frequency = x * std[:, None] + mean[:, None]
        time = xt.view(1, sources, core.audio_channels, self.length)
        time = time * stdt[:, None] + meant[:, None]
        return frequency, time


def unwrap_model(model: HTDemucs | BagOfModels, name: str) -> HTDemucs:
    if isinstance(model, BagOfModels):
        if len(model.models) != 1:
            raise ValueError(f"expected one {name} member, got {len(model.models)}")
        model = model.models[0]
    if not isinstance(model, HTDemucs):
        raise TypeError(f"expected HTDemucs, got {type(model)}")
    model.eval()
    return model


def load_members(requested: list[str]) -> dict[str, HTDemucs]:
    members = {}
    if "htdemucs" in requested:
        members["htdemucs"] = unwrap_model(get_model("htdemucs"), "htdemucs")

    requested_ft = {name.removeprefix(FT_PREFIX) for name in requested if name.startswith(FT_PREFIX)}
    if requested_ft:
        bag = get_model("htdemucs_ft")
        if not isinstance(bag, BagOfModels):
            raise TypeError(f"expected htdemucs_ft bag, got {type(bag)}")
        for core, weights in zip(bag.models, bag.weights):
            selected = [source for source, weight in zip(bag.sources, weights) if weight > 0]
            if len(selected) != 1:
                raise ValueError(f"expected one-hot htdemucs_ft weights, got {weights}")
            source = selected[0]
            if source not in requested_ft:
                continue
            if not isinstance(core, HTDemucs):
                raise TypeError(f"expected HTDemucs, got {type(core)}")
            core.eval()
            members[f"{FT_PREFIX}{source}"] = core

    missing = [name for name in requested if name not in members]
    if missing:
        raise ValueError(f"failed to load member(s): {', '.join(missing)}")
    return members


def pack_spectrogram(core: HTDemucs, mix: torch.Tensor) -> torch.Tensor:
    z = core._spec(mix)
    batch, channels, frequencies, frames = z.shape
    return torch.view_as_real(z).permute(0, 1, 4, 2, 3).reshape(
        batch, channels * 2, frequencies, frames
    )


def reconstruct(core: HTDemucs, frequency: torch.Tensor, time: torch.Tensor) -> torch.Tensor:
    batch, sources, _, frequencies, frames = frequency.shape
    z = frequency.view(batch, sources, -1, 2, frequencies, frames)
    z = z.permute(0, 1, 2, 4, 5, 3).contiguous()
    z = torch.view_as_complex(z)
    return core._ispec(z, mix_length(core)) + time


def mix_length(core: HTDemucs) -> int:
    return int(core.segment * core.samplerate)


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


def validate_onnx(
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
    torch.onnx.export(
        split,
        (mix, spectrogram),
        path,
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=["waveform", "spectrogram"],
        output_names=["frequency", "time"],
    )
    parity = validate_onnx(path, mix, spectrogram, frequency, time)
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
