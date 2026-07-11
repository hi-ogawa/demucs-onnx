// Browser capabilities plugged into the Rust/WASM separation driver. The worker owns
// messaging; this module owns fetch and onnxruntime-web only.
import * as ort from "onnxruntime-web/wasm";
import init, {
  separate as separateWasm,
  type Host,
} from "../../../../crates/wasm/pkg/demucs_wasm.js";
import { readModelFile, type ModelFilename, type ModelSource } from "./models";

const SEGMENT = 343980;
const IN_LEN = 2 * SEGMENT; // (1, 2, SEGMENT)
const OUT_LEN = 4 * 2 * SEGMENT; // (1, 4, 2, SEGMENT)

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

export interface SeparateCallbacks {
  onStatus?: (text: string) => void;
  onProgress?: (done: number, total: number) => void;
}

export async function separate(
  req: SeparateRequest,
  cb: SeparateCallbacks = {},
): Promise<SeparatedStem[]> {
  cb.onStatus?.("loading wasm core...");
  const wasm = await init();
  let dft: Uint8Array | undefined;

  const host: Host = {
    event(...event) {
      if (event[0] === "status") {
        cb.onStatus?.(event[1]);
      } else {
        cb.onProgress?.(event[1], event[2]);
      }
    },

    async initialize() {
      this.event("status", "loading dft.bin...");
      dft = await readModelFile(req.modelSource, "dft.bin");
    },

    async loadModel(model, source) {
      if (!dft) {
        throw new Error("host not initialized");
      }
      const file = (
        source ? `${model}_${source}.onnx` : `${model}.onnx`
      ) as ModelFilename;
      this.event("status", `loading model ${file}...`);
      const bytes = await readModelFile(req.modelSource, file);
      return ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        externalData: [{ data: dft, path: "dft.bin" }],
      });
    },

    async runModel(session, inputPtr, outputPtr) {
      const input = new Float32Array(wasm.memory.buffer, inputPtr, IN_LEN);
      const feeds = {
        input: new ort.Tensor("float32", input, [1, 2, SEGMENT]),
      };
      const result = await (session as ort.InferenceSession).run(feeds);
      const output = new Float32Array(wasm.memory.buffer, outputPtr, OUT_LEN);
      output.set(result.output.data as Float32Array);
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
