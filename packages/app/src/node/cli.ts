import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as ort from "onnxruntime-web";
import init, {
  separate as separateWasm,
  type Host,
} from "../../../../crates/wasm/pkg/demucs_wasm.js";
import {
  AUDIO_SAMPLE_RATE,
  MODEL_INPUT_LENGTH,
  MODEL_OUTPUT_LENGTH,
  MODEL_SEGMENT,
  SOURCES,
} from "../lib/audio/constants";
import { decodeWav, encodeWavF32 } from "../lib/audio/wav";

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

async function main() {
  const args = parseCli();
  const inputBytes = await readFile(args.input);
  const { left, right, sampleRate } = decodeWav(inputBytes);
  if (sampleRate !== AUDIO_SAMPLE_RATE) {
    throw new Error(`expected ${AUDIO_SAMPLE_RATE}Hz WAV, got ${sampleRate}Hz`);
  }
  console.error(
    `input: ${left.length} samples (${(left.length / AUDIO_SAMPLE_RATE).toFixed(2)}s) | model ${args.name} | shifts ${args.shifts}`,
  );

  const wasmBytes = await readFile(
    new URL("../../../../crates/wasm/pkg/demucs_wasm_bg.wasm", import.meta.url),
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
        MODEL_INPUT_LENGTH,
      );
      const result = await (session as ort.InferenceSession).run({
        input: new ort.Tensor("float32", input, [1, 2, MODEL_SEGMENT]),
      });
      const output = new Float32Array(
        wasm.memory.buffer,
        outputPtr,
        MODEL_OUTPUT_LENGTH,
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
      AUDIO_SAMPLE_RATE,
    );
    await writeFile(path, new Uint8Array(await wav.arrayBuffer()));
    console.error(`wrote ${path}`);
  }
}

main().catch((error) => {
  console.error(`${basename(process.argv[1])}: ${error.message ?? error}`);
  process.exitCode = 1;
});
