// Minimal float32 wav encoder (stereo planar in, RIFF out) — matches the CLI's output format.
export function encodeWavF32(channels: Float32Array[], sampleRate: number): Blob {
  const nch = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * nch * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 4, true);
  v.setUint16(32, nch * 4, true);
  v.setUint16(34, 32, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  const out = new Float32Array(buf, 44);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) out[i * nch + c] = channels[c][i];
  }
  return new Blob([buf], { type: "audio/wav" });
}
