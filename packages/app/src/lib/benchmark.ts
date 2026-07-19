import type { ProgressEvent } from "./audio/separate";
import {
  updateRunProgress,
  type ChunkTiming,
  type RunProgress,
} from "./progress/model";

declare global {
  interface Window {
    __demucsBenchmarkResults?: BenchmarkResult[];
  }
}

interface BenchmarkResult {
  loadMs: number;
  inferenceMs: number;
  finalizeMs: number;
  totalMs: number;
  chunks: ChunkTiming[];
}

let progress: RunProgress | null = null;

export const benchmark = {
  enabled: new URLSearchParams(location.search).has("benchmark"),
  start(initialProgress: RunProgress) {
    if (!this.enabled) {
      return;
    }
    progress = initialProgress;
  },
  record(event: ProgressEvent, at: number) {
    if (!progress) {
      return;
    }
    progress = updateRunProgress(progress, event, at);
    if (event.type === "finalized") {
      const result = {
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
      (window.__demucsBenchmarkResults ??= []).push(result);
      progress = null;
    }
  },
};
