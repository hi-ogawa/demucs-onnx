# Fixtures

`sine-10s.wav` is a deterministic 10-second, 44.1 kHz stereo float32 WAV. The left channel is a 220 Hz sine and the right channel is a 110 Hz sine, both at amplitude 0.4.

Regenerate it from the repository root with FFmpeg:

```bash
ffmpeg -hide_banner -loglevel error \
  -f lavfi \
  -i "aevalsrc=0.4*sin(2*PI*220*t)|0.4*sin(2*PI*110*t):s=44100:d=10" \
  -c:a pcm_f32le \
  fixtures/sine-10s.wav
```
