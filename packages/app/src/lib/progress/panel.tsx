import type { RunProgress } from "./model";

function formatClock(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours, minutes, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunProgressPanel({
  progress,
  now,
}: {
  progress: RunProgress;
  now: number;
}) {
  const elapsed = (progress.completedAt ?? now) - progress.startedAt;
  const loadMs = progress.models.reduce(
    (sum, model) => sum + (model.loadMs ?? 0),
    0,
  );
  const inferenceMs = progress.models.reduce(
    (sum, model) => sum + (model.inferenceMs ?? 0),
    0,
  );
  const loaded = progress.models.filter(
    (model) => model.loadMs !== undefined,
  ).length;
  const modelTotal = progress.models.at(-1)?.total ?? 0;
  const etaMs =
    progress.done > 0
      ? (inferenceMs / progress.done) * (progress.total - progress.done) +
        (loaded > 0 ? (loadMs / loaded) * (modelTotal - loaded) : 0)
      : undefined;
  const percent =
    progress.total > 0 ? (100 * progress.done) / progress.total : 0;
  const title =
    progress.phase === "complete"
      ? "Separation complete"
      : progress.phase === "finalizing"
        ? "Finalizing stems"
        : progress.phase === "loading"
          ? "Loading model"
          : progress.phase === "separating"
            ? "Separating track"
            : "Preparing separation";

  return (
    <section className="mt-5 grid gap-4 border-t border-[#d9d8ce] pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-[#18201b]">{title}</h3>
        <span className="text-xs font-bold tracking-[0.05em] text-[#667068] uppercase">
          {Math.round(percent)}%
        </span>
      </div>

      <div className="grid gap-2.5" data-testid="model-progress">
        {progress.models.map((model) => {
          const modelPercent =
            model.chunks > 0 ? (100 * model.done) / model.chunks : 0;
          return (
            <div
              className="rounded-md border border-[#d9d8ce] bg-[#f8f7f1] px-3.5 py-3"
              key={model.index}
            >
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <b className="min-w-0 truncate text-sm font-semibold">
                  {model.total > 1 && `Model ${model.index}/${model.total} · `}
                  {model.file}
                </b>
                <span className="text-xs text-[#667068]">
                  Load{" "}
                  {model.loadMs === undefined
                    ? "in progress"
                    : `done · ${formatSeconds(model.loadMs)}`}
                </span>
              </div>
              {model.phase !== "loading" && (
                <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-3 text-xs text-[#667068]">
                  <div className="h-2 overflow-hidden rounded-full bg-[#d9d8ce]">
                    <div
                      className="h-full rounded-full bg-[#48a875] transition-[width] duration-300"
                      style={{ width: `${modelPercent}%` }}
                    />
                  </div>
                  <span>
                    {model.done}/{model.chunks}
                    {model.shifts > 1 &&
                      ` · shift ${model.shift}/${model.shifts}`}
                    {model.phase === "complete" &&
                      model.inferenceMs !== undefined &&
                      ` · ${formatSeconds(model.inferenceMs)}`}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-2">
        <div
          aria-label="Overall separation progress"
          aria-valuemax={Math.max(progress.total, 1)}
          aria-valuemin={0}
          aria-valuenow={progress.done}
          className="h-3 overflow-hidden rounded-full bg-[#d9d8ce]"
          id="progress"
          role="progressbar"
        >
          <div
            className={`h-full rounded-full bg-[#245f46] transition-[width] duration-300 ${progress.total === 0 ? "animate-pulse" : ""}`}
            style={{ width: progress.total === 0 ? "35%" : `${percent}%` }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-[#667068]">
          <span>
            {progress.total === 0
              ? "Preparing browser runtime"
              : `Overall · ${progress.done}/${progress.total} chunks`}
          </span>
          <span>
            elapsed {formatClock(elapsed)}
            {etaMs !== undefined &&
              progress.phase !== "finalizing" &&
              progress.phase !== "complete" && (
                <span className="text-[#8a918b]">
                  {" "}
                  (ETA {formatClock(etaMs)})
                </span>
              )}
          </span>
        </div>
      </div>

      {progress.phase === "complete" && (
        <p className="text-sm text-[#667068]" data-testid="timing-summary">
          Load {formatSeconds(loadMs)} · Inference {formatSeconds(inferenceMs)}{" "}
          · Finalize {formatSeconds(progress.finalizeMs)}
        </p>
      )}
    </section>
  );
}
