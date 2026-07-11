// Worker: messaging and the browser host for the Rust/WASM separation flow.
// Input is a SeparateRequest verbatim; output is the WorkerResponse union.
import { separate, type SeparatedStem, type SeparateRequest } from "./audio/separate";

export type WorkerResponse =
  | { type: "status"; text: string }
  | { type: "progress"; done: number; total: number }
  | { type: "done"; outputs: SeparatedStem[] }
  | { type: "error"; message: string };

self.onmessage = async (e: MessageEvent<SeparateRequest>) => {
  const post = (m: WorkerResponse, t?: Transferable[]) =>
    (self as unknown as Worker).postMessage(m, t ?? []);
  try {
    const outputs = await separate(e.data, {
      onStatus: (text) => post({ type: "status", text }),
      onProgress: (done, total) => post({ type: "progress", done, total }),
    });
    const transfers = outputs.flatMap((o) => [o.left.buffer, o.right.buffer]);
    post({ type: "done", outputs }, transfers);
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
};
