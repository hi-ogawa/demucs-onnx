import type { ProgressEvent, SeparatedStem, SeparateRequest } from "./separate";

export type WorkerResponse =
  | { type: "progress"; event: ProgressEvent; at: number }
  | { type: "done"; outputs: SeparatedStem[] }
  | { type: "error"; message: string };

export interface SeparateInWorkerOptions {
  onProgress: (event: ProgressEvent, at: number) => void;
}

export function separateInWorker(
  request: SeparateRequest,
  options: SeparateInWorkerOptions,
): Promise<SeparatedStem[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`Worker failed: ${event.message}`));
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        options.onProgress(message.event, message.at);
        return;
      }

      worker.terminate();
      if (message.type === "done") {
        resolve(message.outputs);
      } else {
        reject(new Error(message.message));
      }
    };

    worker.postMessage(request, [request.left.buffer, request.right.buffer]);
  });
}
