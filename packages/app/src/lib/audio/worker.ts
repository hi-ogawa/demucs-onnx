import { separate, type SeparateRequest } from "./separate";
import type { WorkerResponse } from "./worker-client";

function main() {
  self.onmessage = async (event: MessageEvent<SeparateRequest>) => {
    const post = (message: WorkerResponse, transfer?: Transferable[]) =>
      (self as unknown as Worker).postMessage(message, transfer ?? []);
    try {
      const outputs = await separate(event.data, {
        onProgress: (progress) =>
          post({ type: "progress", event: progress, at: Date.now() }),
      });
      const transfers = outputs.flatMap((output) => [
        output.left.buffer,
        output.right.buffer,
      ]);
      post({ type: "done", outputs }, transfers);
    } catch (error) {
      post({ type: "error", message: String(error) });
    }
  };
}

main();
