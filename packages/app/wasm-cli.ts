import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as ort from "onnxruntime-web";
import init, {
  separate as separateWasm,
  type Host,
} from "../../crates/wasm/pkg/demucs_wasm.js";
import { encodeWavF32 } from "./src/lib/audio/wav";

const SAMPLE_RATE = 44_100;
const SEGMENT = 343_980;
const INPUT_LENGTH = 2 * SEGMENT;
const OUTPUT_LENGTH = 4 * 2 * SEGMENT;
const SOURCES = ["drums", "bass", "other", "vocals"];

function usage() {
  console.error(`Usage: pnpm wasm-separate [OPTIONS] <INPUT.WAV> <OUT_DIR>

Options:
  --models <DIR>             Directory containing ONNX models (required)
  --name <MODEL>             htdemucs or htdemucs_ft (default: htdemucs)
  --two-stems <SOURCE>       drums, bass, other, or vocals
  --two-stems-mix <METHOD>   add or minus
  --shifts <N>               Number of processing passes (default: 1)`);
}

function parseCli() {
  const command = process.argv[2];
  if (command !== "separate") {
    usage();
    process.exit(2);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(3),
      allowPositionals: true,
      options: {
        models: { type: "string" },
        name: { type: "string", default: "htdemucs" },
        "two-stems": { type: "string" },
        "two-stems-mix": { type: "string" },
        shifts: { type: "string", default: "1" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(String(error));
    usage();
    process.exit(2);
  }
  if (parsed.values.help) {
    usage();
    process.exit(0);
  }
  const { models, name, shifts: shiftsText } = parsed.values;
  const [input, outDir] = parsed.positionals;
  const twoStems = parsed.values["two-stems"];
  const method = parsed.values["two-stems-mix"];
  const shifts = Number(shiftsText);
  if (!models || !input || !outDir || parsed.positionals.length !== 2) {
    usage();
    process.exit(2);
  }
  if (!["htdemucs", "htdemucs_ft"].includes(name)) {
    throw new Error(`unknown model ${name}`);
  }
  if (twoStems && !SOURCES.includes(twoStems)) {
    throw new Error(`unknown source ${twoStems}`);
  }
  if (method && !["add", "minus"].includes(method)) {
    throw new Error(`unknown two-stems mix ${method}`);
  }
  if (!Number.isSafeInteger(shifts) || shifts < 1) {
    throw new Error("shifts must be an integer >= 1");
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  return {
    models: resolve(cwd, models),
    name,
    twoStems,
    method,
    shifts,
    input: resolve(cwd, input),
    outDir: resolve(cwd, outDir),
  };
}

function decodeWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
    throw new Error("expected a RIFF/WAVE file");
  }
  let format;
  let dataOffset;
  let dataLength;
  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const id = readFourCc(view, offset);
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
  if (format.sampleRate !== SAMPLE_RATE) {
    throw new Error(
      `expected ${SAMPLE_RATE}Hz WAV, got ${format.sampleRate}Hz`,
    );
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
  return { left, right };
}

function readFourCc(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
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

async function main() {
  const args = parseCli();
  const inputBytes = await readFile(args.input);
  const { left, right } = decodeWav(inputBytes);
  console.error(
    `input: ${left.length} samples (${(left.length / SAMPLE_RATE).toFixed(2)}s) | model ${args.name} | shifts ${args.shifts}`,
  );

  const wasmBytes = await readFile(
    new URL("../../crates/wasm/pkg/demucs_wasm_bg.wasm", import.meta.url),
  );
  const wasm = await init({ module_or_path: wasmBytes });
  let dft: Uint8Array;
  const host: Host = {
    event(type, ...event) {
      if (type === "model-loading") {
        console.error(`loading ${event[3]}`);
      }
      if (type === "model-complete") {
        console.error("model complete");
      }
    },
    async initialize() {
      dft = await readFile(join(args.models, "dft.bin"));
    },
    async loadModel(model, source) {
      const file = source ? `${model}_${source}.onnx` : `${model}.onnx`;
      const modelBytes = await readFile(join(args.models, file));
      return ort.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
        externalData: [{ data: dft, path: "dft.bin" }],
      });
    },
    async runModel(session, inputPtr, outputPtr) {
      const input = new Float32Array(
        wasm.memory.buffer,
        inputPtr,
        INPUT_LENGTH,
      );
      const result = await (session as ort.InferenceSession).run({
        input: new ort.Tensor("float32", input, [1, 2, SEGMENT]),
      });
      const output = new Float32Array(
        wasm.memory.buffer,
        outputPtr,
        OUTPUT_LENGTH,
      );
      output.set(result.output.data as Float32Array);
    },
    async releaseModel(session) {
      await (session as ort.InferenceSession).release();
    },
  };

  const tracks = await separateWasm(
    args.name,
    args.twoStems,
    args.method,
    args.shifts,
    left,
    right,
    host,
  );
  const names = args.twoStems
    ? [args.twoStems, `no_${args.twoStems}`]
    : SOURCES;
  await mkdir(args.outDir, { recursive: true });
  for (const [index, name] of names.entries()) {
    const path = join(args.outDir, `${name}.wav`);
    const wav = encodeWavF32(
      [tracks[index * 2], tracks[index * 2 + 1]],
      SAMPLE_RATE,
    );
    await writeFile(path, new Uint8Array(await wav.arrayBuffer()));
    console.error(`wrote ${path}`);
  }
}

main().catch((error) => {
  console.error(`${basename(process.argv[1])}: ${error.message ?? error}`);
  process.exitCode = 1;
});
