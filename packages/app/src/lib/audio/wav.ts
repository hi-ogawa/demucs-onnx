export interface DecodedWav {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0) !== "RIFF" || readAscii(view, 8) !== "WAVE") {
    throw new Error("expected a RIFF/WAVE file");
  }
  let format: WavFormat | undefined;
  let dataOffset: number | undefined;
  let dataLength: number | undefined;
  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const id = readAscii(view, offset);
    const length = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = {
        encoding: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        blockAlign: view.getUint16(offset + 20, true),
        bits: view.getUint16(offset + 22, true),
      };
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = length;
    }
    offset += 8 + length + (length & 1);
  }
  if (!format || dataOffset === undefined || dataLength === undefined) {
    throw new Error("WAV is missing fmt or data chunk");
  }
  if (format.channels < 1) {
    throw new Error("WAV has no channels");
  }
  const frames = Math.floor(dataLength / format.blockAlign);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const offset = dataOffset + frame * format.blockAlign;
    left[frame] = readSample(view, offset, format);
    right[frame] =
      format.channels === 1
        ? left[frame]
        : readSample(view, offset + format.bits / 8, format);
  }
  return { left, right, sampleRate: format.sampleRate };
}

interface WavFormat {
  encoding: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bits: number;
}

function readSample(view: DataView, offset: number, format: WavFormat) {
  if (format.encoding === 3 && format.bits === 32) {
    return view.getFloat32(offset, true);
  }
  if (format.encoding !== 1) {
    throw new Error(`unsupported WAV encoding ${format.encoding}`);
  }
  switch (format.bits) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32_768;
    case 24: {
      let value =
        view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16);
      if (value & 0x80_0000) {
        value |= 0xff00_0000;
      }
      return value / 8_388_608;
    }
    case 32:
      return view.getInt32(offset, true) / 2_147_483_648;
    default:
      throw new Error(`unsupported PCM bit depth ${format.bits}`);
  }
}

function readAscii(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

// Minimal float32 wav encoder (stereo planar in, RIFF out) — matches the CLI's output format.
export function encodeWavF32(
  channels: Float32Array[],
  sampleRate: number,
): Blob {
  const nch = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * nch * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      v.setUint8(off + i, s.charCodeAt(i));
    }
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
    for (let c = 0; c < nch; c++) {
      out[i * nch + c] = channels[c][i];
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}
