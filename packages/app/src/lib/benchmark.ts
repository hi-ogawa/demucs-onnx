import type { ProgressEvent } from "./audio/separate";
import {
  updateRunProgress,
  type ChunkTiming,
  type RunProgress,
} from "./progress/model";

declare global {
  interface Window {
    __demucsBenchmarkResult?: BenchmarkResult;
  }
}

interface BenchmarkResult {
  loadMs: number;
  inferenceMs: number;
  finalizeMs: number;
  totalMs: number;
  chunks: ChunkTiming[];
}

export function createBenchmarkRecorder(startedAt: number) {
  if (!new URLSearchParams(location.search).has("benchmark")) {
    return null;
  }

  delete window.__demucsBenchmarkResult;
  let progress: RunProgress = {
    phase: "preparing",
    startedAt,
    done: 0,
    total: 0,
    models: [],
    finalizeMs: 0,
  };
  return (event: ProgressEvent, at: number) => {
    progress = updateRunProgress(progress, event, at);
    if (event.type === "finalized") {
      window.__demucsBenchmarkResult = {
        loadMs: progress.models.reduce(
          (sum, item) => sum + (item.loadMs ?? 0),
          0,
        ),
        inferenceMs: progress.models.reduce(
          (sum, item) => sum + (item.inferenceMs ?? 0),
          0,
        ),
        finalizeMs: progress.finalizeMs,
        totalMs: at - progress.startedAt,
        chunks: progress.models.flatMap((item) => item.chunkTimings),
      };
    }
  };
}

export function isBenchmarkMode() {
  return new URLSearchParams(location.search).has("benchmark");
}
