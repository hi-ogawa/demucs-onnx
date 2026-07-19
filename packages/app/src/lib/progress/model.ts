import type { ProgressEvent } from "../audio/separate";

export type ModelProgress = {
  index: number;
  total: number;
  file: string;
  done: number;
  chunks: number;
  shifts: number;
  shift: number;
  phase: "loading" | "separating" | "complete";
  loadStartedAt: number;
  inferenceStartedAt?: number;
  loadMs?: number;
  inferenceMs?: number;
  chunkTimings: ChunkTiming[];
};

export type ChunkTiming = {
  member: number;
  shift: number;
  chunk: number;
  prepareInputMs: number;
  ortRunMs: number;
  outputCopyMs: number;
  processOutputMs: number;
};

export type RunProgress = {
  phase: "preparing" | "loading" | "separating" | "finalizing" | "complete";
  startedAt: number;
  completedAt?: number;
  finalizeStartedAt?: number;
  done: number;
  total: number;
  models: ModelProgress[];
  finalizeMs: number;
};

export function updateRunProgress(
  progress: RunProgress,
  event: ProgressEvent,
  at: number,
): RunProgress {
  const models = progress.models.map((model) => ({ ...model }));
  const current = models.at(-1);
  switch (event.type) {
    case "started":
      return { ...progress, total: event.total };
    case "model-loading":
      return {
        ...progress,
        phase: "loading",
        models: [
          ...models,
          {
            index: event.index,
            total: event.total,
            file: event.file,
            done: 0,
            chunks: event.chunks,
            shift: 1,
            shifts: 1,
            phase: "loading",
            loadStartedAt: at,
            chunkTimings: [],
          },
        ],
      };
    case "model-loaded":
      if (!current) {
        return progress;
      }
      current.phase = "separating";
      current.loadMs = at - current.loadStartedAt;
      current.inferenceStartedAt = at;
      return { ...progress, phase: "separating", models };
    case "inference":
      if (!current) {
        return progress;
      }
      current.done = event.memberDone;
      current.chunks = event.memberTotal;
      current.shift = event.shift;
      current.shifts = event.shifts;
      current.inferenceMs = at - (current.inferenceStartedAt ?? at);
      current.chunkTimings.push({
        member: current.index,
        shift: event.shift,
        chunk: event.memberDone,
        prepareInputMs: event.prepareMs,
        ortRunMs: event.runMs,
        outputCopyMs: event.copyMs,
        processOutputMs: event.processMs,
      });
      return { ...progress, done: event.done, total: event.total, models };
    case "model-complete":
      if (!current) {
        return progress;
      }
      current.phase = "complete";
      current.done = current.chunks;
      current.inferenceMs = at - (current.inferenceStartedAt ?? at);
      return { ...progress, models };
    case "finalizing":
      return {
        ...progress,
        phase: "finalizing",
        finalizeStartedAt: at,
        models,
      };
    case "finalized":
      return {
        ...progress,
        phase: "complete",
        completedAt: at,
        finalizeMs: at - (progress.finalizeStartedAt ?? at),
        models,
      };
  }
}
