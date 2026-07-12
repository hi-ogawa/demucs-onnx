"""PyTorch model boundary and member loading for split-DSP HTDemucs exports."""

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
