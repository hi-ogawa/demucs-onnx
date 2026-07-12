# Fixtures

`sine-2s.wav` and `sine-10s.wav` are deterministic 44.1 kHz stereo float32 WAVs. The left channel is a 220 Hz sine and the right channel is a 110 Hz sine, both at amplitude 0.4.

Regenerate it from the repository root with FFmpeg:

```bash
ffmpeg -hide_banner -loglevel error \
  -f lavfi \
  -i "aevalsrc=0.4*sin(2*PI*220*t)|0.4*sin(2*PI*110*t):s=44100:d=DURATION" \
  -c:a pcm_f32le \
  fixtures/sine-DURATIONs.wav
```

Replace `DURATION` with `2` or `10`.

`stft-reference-f32.bin` contains little-endian float32 PyTorch STFT output for the 64 frequency
bins listed in `stft-reference-f32.json`, across every frame and complex-as-channels channel. The
input waveform is generated from integer state in both Python and Rust, so it does not need to be
stored. Regenerate the reference from the repository root with:

```bash
uv run --project tools/model-export-v2 python \
  tools/model-export-v2/generate_stft_fixture.py \
  --out fixtures/stft-reference-f32.bin
```

`istft-reference-f32.bin` similarly contains every eighth reconstructed sample for all sources and
channels. Its input frequency tensor is generated from integer state in both implementations.
Regenerate it with:

```bash
uv run --project tools/model-export-v2 python \
  tools/model-export-v2/generate_istft_fixture.py \
  --out fixtures/istft-reference-f32.bin
```
