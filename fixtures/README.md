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
