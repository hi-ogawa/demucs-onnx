import ortWasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
// Browser capabilities plugged into the Rust/WASM separation driver. The worker owns
// messaging; this module owns fetch and onnxruntime-web only.
import * as ort from "onnxruntime-web/wasm";
import init, {
  separate as separateWasm,
  type Host,
} from "../../../../../crates/wasm/pkg/demucs_wasm.js";
import { readModelFile, type ModelFilename, type ModelSource } from "./models";

// Keep Emscripten's pthread entry point separate from this application worker.
// https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html#envwasmwasmpaths
ort.env.wasm.wasmPaths = { mjs: ortWasmModuleUrl, wasm: ortWasmUrl };

const SEGMENT = 343980;
const IN_LEN = 2 * SEGMENT; // (1, 2, SEGMENT)
const SPECTROGRAM_LEN = 4 * 2048 * 336; // (1, 4, 2048, 336)
const FREQUENCY_LEN = 4 * 4 * 2048 * 336; // (1, 4, 4, 2048, 336)
const TIME_LEN = 4 * 2 * SEGMENT; // (1, 4, 2, SEGMENT)

export interface TwoStems {
  source: string;
  method: "add" | "minus";
}

export interface SeparateRequest {
  left: Float32Array;
  right: Float32Array;
  model: string;
  twoStems?: TwoStems;
  shifts: number;
  modelSource: ModelSource;
}

export interface SeparatedStem {
  name: string;
  left: Float32Array;
  right: Float32Array;
}

export type ProgressEvent =
  | { type: "started"; total: number }
  | {
      type: "model-loading";
      index: number;
      total: number;
      chunks: number;
      file: string;
    }
  | { type: "model-loaded" | "model-complete" | "finalizing" | "finalized" }
  | {
      type: "inference";
      done: number;
      total: number;
      memberDone: number;
      memberTotal: number;
      shift: number;
      shifts: number;
    };

export interface SeparateCallbacks {
  onProgress?: (event: ProgressEvent) => void;
}

export async function separate(
  req: SeparateRequest,
  cb: SeparateCallbacks = {},
): Promise<SeparatedStem[]> {
  const wasm = await init();

  const host: Host = {
    event(...event) {
      switch (event[0]) {
        case "started":
          cb.onProgress?.({ type: event[0], total: event[1] });
          break;
        case "model-loading":
          cb.onProgress?.({
            type: event[0],
            index: event[1],
            total: event[2],
            chunks: event[3],
            file: event[4],
          });
          break;
        case "inference":
          cb.onProgress?.({
            type: event[0],
            done: event[1],
            total: event[2],
            memberDone: event[3],
            memberTotal: event[4],
            shift: event[5],
            shifts: event[6],
          });
          break;
        default:
          cb.onProgress?.({ type: event[0] });
      }
    },

    async loadModel(model, source) {
      const file = (
        source ? `${model}_${source}.onnx` : `${model}.onnx`
      ) as ModelFilename;
      const bytes = await readModelFile(req.modelSource, file);
      return ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
      });
    },

    async runModel(session, inputPtr, spectrogramPtr, frequencyPtr, timePtr) {
      const input = new Float32Array(wasm.memory.buffer, inputPtr, IN_LEN);
      const spectrogram = new Float32Array(
        wasm.memory.buffer,
        spectrogramPtr,
        SPECTROGRAM_LEN,
      );
      const feeds = {
        waveform: new ort.Tensor("float32", input, [1, 2, SEGMENT]),
        spectrogram: new ort.Tensor("float32", spectrogram, [1, 4, 2048, 336]),
      };
      const result = await (session as ort.InferenceSession).run(feeds);
      const frequency = new Float32Array(
        wasm.memory.buffer,
        frequencyPtr,
        FREQUENCY_LEN,
      );
      const time = new Float32Array(wasm.memory.buffer, timePtr, TIME_LEN);
      frequency.set(result.frequency.data as Float32Array);
      time.set(result.time.data as Float32Array);
    },

    async releaseModel(session) {
      await (session as ort.InferenceSession).release();
    },
  };

  const tracks = await separateWasm(
    req.model,
    req.twoStems?.source,
    req.twoStems?.method,
    req.shifts,
    req.left,
    req.right,
    host,
  );
  const names = req.twoStems
    ? [req.twoStems.source, `no_${req.twoStems.source}`]
    : ["drums", "bass", "other", "vocals"];
  return names.map((name, index) => ({
    name,
    left: tracks[2 * index],
    right: tracks[2 * index + 1],
  }));
}
