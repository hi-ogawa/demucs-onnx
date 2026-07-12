import type { ProgressEvent, SeparatedStem, SeparateRequest } from "./separate";

export type WorkerResponse =
  | { type: "progress"; event: ProgressEvent; at: number }
  | { type: "done"; outputs: SeparatedStem[] }
  | { type: "error"; message: string };

export interface SeparateInWorkerOptions {
  onProgress?: (event: ProgressEvent, at: number) => void;
  signal?: AbortSignal;
}

export function separateInWorker(
  request: SeparateRequest,
  options: SeparateInWorkerOptions = {},
): Promise<SeparatedStem[]> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason);
      return;
    }

    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      options.signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
    };
    const handleAbort = () => {
      finish();
      reject(options.signal?.reason);
    };

    options.signal?.addEventListener("abort", handleAbort, { once: true });
    worker.onerror = (event) => {
      finish();
      reject(new Error(`Worker failed: ${event.message}`));
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        options.onProgress?.(message.event, message.at);
        return;
      }

      finish();
      if (message.type === "done") {
        resolve(message.outputs);
      } else {
        reject(new Error(message.message));
      }
    };

    worker.postMessage(request, [request.left.buffer, request.right.buffer]);
  });
}
