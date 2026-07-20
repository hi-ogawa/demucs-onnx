import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CircleHelp, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { modelArtifactManager } from "./lib/audio/artifact-store";
import { AUDIO_SAMPLE_RATE } from "./lib/audio/constants";
import { decodeAudioFile } from "./lib/audio/decode";
import {
  isModelFilename,
  modelAssetUrl,
  requiredModelFiles,
  type ModelArtifact,
  type ModelFilename,
  type ModelSource,
} from "./lib/audio/models";
import type { SeparateRequest } from "./lib/audio/separate";
import {
  createStemArchive,
  downloadBlob,
  toStemArchiveFilename,
} from "./lib/audio/stem-archive";
import { encodeWavF32 } from "./lib/audio/wav";
import { separateInWorker } from "./lib/audio/worker-client";
import { benchmark } from "./lib/benchmark";
import {
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./lib/preferences";
import { updateRunProgress, type RunProgress } from "./lib/progress/model";
import { RunProgressPanel } from "./lib/progress/panel";

export function App() {
  // synchronize preferences with localStorage
  const [preferences, setPreferences] = useState(loadPreferences);
  useEffect(() => savePreferences(preferences), [preferences]);

  const [selectedModelFiles, setSelectedModelFiles] = useState<
    Partial<Record<ModelFilename, ModelArtifact>>
  >({});
  const [unsupportedModelFiles, setUnsupportedModelFiles] = useState<string[]>(
    [],
  );
  const [modelFileErrors, setModelFileErrors] = useState<
    Partial<Record<ModelFilename, string>>
  >({});

  const { model, method, shifts, twoStems } = preferences;

  const loadStoredModelsQuery = useQuery({
    queryKey: ["stored-models"],
    queryFn: modelArtifactManager.load,
  });
  const storeModelsMutation = useMutation({
    mutationFn: modelArtifactManager.store,
  });
  const modelFiles: Partial<Record<ModelFilename, ModelArtifact>> = {
    ...Object.fromEntries(
      (loadStoredModelsQuery.data ?? []).map((artifact) => [
        artifact.name,
        artifact,
      ]),
    ),
    ...selectedModelFiles,
  };

  const requiredFiles = requiredModelFiles(
    model,
    twoStems || undefined,
    twoStems ? method : undefined,
  );
  const modelSource: ModelSource | null = requiredFiles.every(
    (filename) => modelFiles[filename],
  )
    ? { artifacts: Object.values(modelFiles) }
    : null;
  function addModelFiles(files: File[], expected?: ModelFilename) {
    const accepted = files.filter(
      (file) =>
        isModelFilename(file.name) && (!expected || file.name === expected),
    );
    setSelectedModelFiles((current) => ({
      ...current,
      ...Object.fromEntries(
        accepted.map((file) => [file.name, { name: file.name, blob: file }]),
      ),
    }));
    setUnsupportedModelFiles(
      expected
        ? []
        : files
            .filter((file) => !isModelFilename(file.name))
            .map((file) => file.name),
    );
    if (expected) {
      const rejected = files.find((file) => file.name !== expected);
      setModelFileErrors((current) => ({
        ...current,
        [expected]: rejected
          ? `Expected ${expected}, received ${rejected.name}.`
          : undefined,
      }));
    }
    if (accepted.length > 0) {
      storeModelsMutation.mutate(accepted);
    }
  }

  const modelStorageError = loadStoredModelsQuery.error
    ? "Browser storage is unavailable; uploads still work."
    : storeModelsMutation.error instanceof DOMException &&
        storeModelsMutation.error.name === "QuotaExceededError"
      ? "Browser storage is full; files are available for this session only."
      : storeModelsMutation.error
        ? "Files are available for this session but could not be stored."
        : "";

  const handleAudioFileMutation = useMutation({
    mutationFn: decodeAudioFile,
  });
  const decodedAudio = handleAudioFileMutation.data;

  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);

  const outputCleanupRef = useRef<Array<() => void>>([]);
  const handleRunMutation = useMutation({
    mutationFn: async () => {
      if (!decodedAudio || !modelSource) {
        throw new Error("Audio and model files are required");
      }

      for (const cleanup of outputCleanupRef.current) {
        cleanup();
      }
      outputCleanupRef.current = [];

      const startedAt = Date.now();
      const initialProgress: RunProgress = {
        phase: "preparing",
        startedAt,
        done: 0,
        total: 0,
        models: [],
        finalizeMs: 0,
      };
      setRunProgress(initialProgress);
      const started = performance.now();
      benchmark.start(initialProgress);
      const request: SeparateRequest = {
        left: decodedAudio.left.slice(),
        right: decodedAudio.right.slice(),
        model,
        twoStems: twoStems ? { source: twoStems, method } : undefined,
        shifts,
        modelSource,
      };
      const separated = await separateInWorker(request, {
        onProgress: (event, at) => {
          benchmark.record(event, at);
          setRunProgress((progress) =>
            progress ? updateRunProgress(progress, event, at) : progress,
          );
        },
      });
      const nextOutputs = separated.map((output) => {
        const blob = encodeWavF32(
          [output.left, output.right],
          AUDIO_SAMPLE_RATE,
        );
        return { ...output, blob, url: URL.createObjectURL(blob) };
      });
      outputCleanupRef.current = nextOutputs.map(
        (output) => () => URL.revokeObjectURL(output.url),
      );
      const durationMs = performance.now() - started;
      const archiveBlob = await createStemArchive(nextOutputs);
      const archive = {
        name: toStemArchiveFilename(decodedAudio.name),
        url: URL.createObjectURL(archiveBlob),
      };
      outputCleanupRef.current.push(() => URL.revokeObjectURL(archive.url));
      return { outputs: nextOutputs, archive, durationMs };
    },
    onSuccess: ({ archive }) => {
      if (!benchmark.enabled) {
        downloadBlob(archive.url, archive.name);
      }
    },
    onSettled: (_data, error) => {
      if (error) {
        setRunProgress(null);
      }
    },
  });

  const outputs = handleRunMutation.data?.outputs ?? [];

  const audioFileStatusText = handleAudioFileMutation.isPending
    ? "Decoding..."
    : decodedAudio
      ? `Decoded: ${decodedAudio.duration.toFixed(2)}s, ${decodedAudio.numberOfChannels}ch @${decodedAudio.sampleRate / 1000}k`
      : "";
  const separationStatusText = handleRunMutation.data
    ? `Done in ${(handleRunMutation.data.durationMs / 1000).toFixed(1)}s`
    : "";

  return (
    <main className="mx-auto w-full max-w-[800px] px-3 py-9 sm:px-5 sm:py-18 md:pb-24">
      <header className="mb-8 max-w-190">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h1 className="text-4xl leading-tight font-semibold tracking-[-0.035em] sm:text-5xl">
            Demucs ONNX
          </h1>
          <a
            className="text-primary hover:text-accent ml-auto text-sm font-semibold underline underline-offset-3"
            href="https://github.com/hi-ogawa/demucs-onnx"
            target="_blank"
            rel="noreferrer"
          >
            View on GitHub
          </a>
        </div>
        <p className="text-copy mt-4 mb-2 text-lg leading-relaxed">
          Separate music into vocals, drums, bass, and other stems, entirely in
          your browser. Your audio and model files stay on this device.
        </p>
      </header>

      <div className="grid gap-6">
        <section className="grid gap-6" aria-label="Separation setup">
          <div className="grid gap-6">
            <section className="bg-surface shadow-card min-w-0 rounded-lg border px-5 pt-4 pb-5 sm:px-7 sm:pt-5 sm:pb-7">
              <h2 className="text-foreground mb-2 text-xl font-semibold">
                1. Choose audio
              </h2>
              <p className="text-muted mb-5.5 leading-relaxed">
                Select the track you want to separate.
              </p>
              <input
                className="border-border-strong bg-surface-muted text-muted file:bg-primary-soft file:text-primary w-full rounded-md border border-dashed p-3 file:mr-3 file:cursor-pointer file:rounded file:border-0 file:px-3.5 file:py-2 file:font-bold"
                type="file"
                id="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    handleAudioFileMutation.mutate(file);
                  }
                }}
              />
              {audioFileStatusText && (
                <p className="text-muted mt-3.5 text-sm" id="audio-status">
                  {audioFileStatusText}
                </p>
              )}
            </section>
          </div>

          <aside className="grid gap-6">
            <section className="bg-surface shadow-card min-w-0 rounded-lg border px-5 pt-4 pb-5 sm:px-7 sm:pt-5 sm:pb-7">
              <h2 className="text-foreground mb-2 text-xl font-semibold">
                2. Choose output
              </h2>
              <p className="text-muted mb-5.5 leading-relaxed">
                Choose which tracks to create. “Other instruments” includes
                guitars, keys, and anything not classified as vocals, drums, or
                bass.
              </p>
              <OutputConfiguration
                configuration={preferences}
                onChange={setPreferences}
              />
            </section>

            <section className="bg-surface shadow-card min-w-0 rounded-lg border px-5 pt-4 pb-5 sm:px-7 sm:pt-5 sm:pb-7">
              <h2 className="text-foreground mb-2 text-xl font-semibold">
                3. Add models
              </h2>
              <p className="text-muted mb-5.5 leading-relaxed">
                Download each required model, then drop or select the downloaded
                file.
              </p>
              <div className="grid gap-2.5">
                {requiredFiles.map((filename) => (
                  <ModelFileSlot
                    key={filename}
                    filename={filename}
                    ready={Boolean(modelFiles[filename])}
                    error={modelFileErrors[filename]}
                    onSelect={(files) => addModelFiles(files, filename)}
                  />
                ))}
              </div>
              <p className="text-muted mt-4 text-sm">
                Alternatively,{" "}
                <label className="text-primary hover:text-accent cursor-pointer font-semibold underline underline-offset-3">
                  choose multiple files at once
                  <input
                    className="sr-only"
                    type="file"
                    id="modelFiles"
                    accept=".bin,.onnx"
                    multiple
                    onChange={(event) =>
                      addModelFiles([...(event.target.files ?? [])])
                    }
                  />
                </label>
                .
              </p>
              {unsupportedModelFiles.length > 0 && (
                <p className="text-danger mt-2 text-sm">
                  Unsupported files: {unsupportedModelFiles.join(", ")}.
                </p>
              )}
              {modelStorageError && (
                <p className="text-danger mt-2 text-sm">{modelStorageError}</p>
              )}
            </section>

            <section className="bg-surface shadow-card min-w-0 rounded-lg border p-5 sm:p-6">
              <h2 className="text-foreground mb-4 text-xl font-semibold">
                4. Separate
              </h2>
              <button
                className="bg-primary-bright text-primary-foreground shadow-action hover:not-disabled:bg-primary-bright-hover disabled:border-primary-border disabled:bg-primary-soft disabled:text-primary-muted min-h-13 w-full cursor-pointer rounded-md border border-transparent font-bold disabled:cursor-not-allowed disabled:shadow-none"
                id="run"
                disabled={
                  handleRunMutation.isPending || !decodedAudio || !modelSource
                }
                onClick={() => handleRunMutation.mutate()}
              >
                Separate track
              </button>
              {runProgress && <RunProgressPanel progress={runProgress} />}
              {separationStatusText && (
                <p
                  className="text-muted mt-3.5 text-sm leading-normal whitespace-pre-line"
                  id="status"
                >
                  {separationStatusText}
                </p>
              )}
            </section>
          </aside>
        </section>

        {outputs.length > 0 && (
          <section
            className="bg-surface shadow-card min-w-0 rounded-lg border px-5 py-6 sm:p-9"
            aria-labelledby="results-title"
          >
            <div className="mb-7 flex items-end justify-between gap-4">
              <div>
                <p className="text-primary-strong mb-2.5 text-xs font-extrabold tracking-[0.14em] uppercase">
                  Separation complete
                </p>
                <h2
                  className="text-3xl font-semibold tracking-[-0.025em]"
                  id="results-title"
                >
                  Your stems
                </h2>
              </div>
              <a
                className="text-primary hover:text-accent shrink-0 text-sm font-semibold underline underline-offset-3"
                href={handleRunMutation.data?.archive.url}
                download={handleRunMutation.data?.archive.name}
              >
                Download ZIP
              </a>
            </div>
            <div className="grid gap-3.5" id="stems">
              {outputs.map((output) => (
                <div
                  className="bg-surface-muted grid min-w-0 grid-cols-[1fr_auto] items-center gap-3.5 rounded-md border p-4.5"
                  key={output.name}
                >
                  <b className="text-xl font-semibold capitalize">
                    {stemLabel(output.name, twoStems)}
                  </b>
                  <audio
                    className="col-span-full w-full"
                    controls
                    src={output.url}
                  />
                  <a
                    className="text-primary hover:text-accent text-sm font-semibold underline underline-offset-3"
                    href={output.url}
                    download={`${output.name}.wav`}
                  >
                    Download WAV
                  </a>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

const OUTPUT_OPTIONS: {
  value: Preferences["twoStems"];
  label: string;
  description: string;
}[] = [
  {
    value: null,
    label: "Four stems",
    description: "Create vocals, drums, bass, and “other” stems",
  },
  {
    value: "vocals",
    label: "Vocals + backing",
    description: "Create a vocals stem and a backing track without vocals",
  },
  {
    value: "drums",
    label: "Drums + backing",
    description: "Create a drums stem and a backing track without drums",
  },
  {
    value: "bass",
    label: "Bass + backing",
    description: "Create a bass stem and a backing track without bass",
  },
  {
    value: "other",
    label: "Other instruments + backing",
    description: "Create an “other” stem and a backing track without it",
  },
];

function OutputConfiguration({
  configuration,
  onChange,
}: {
  configuration: Preferences;
  onChange(configuration: Preferences): void;
}) {
  return (
    <>
      <fieldset>
        <legend className="sr-only">Stem output</legend>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {OUTPUT_OPTIONS.map((option) => (
            <OutputOption
              key={option.label}
              option={option}
              selected={configuration.twoStems === option.value}
              onSelect={() =>
                onChange({ ...configuration, twoStems: option.value })
              }
            />
          ))}
        </div>
      </fieldset>

      <details className="bg-surface-muted border-border-control group mt-3 rounded-lg border">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span className="text-muted text-lg leading-none transition-transform group-open:rotate-90">
            ›
          </span>
          <span className="shrink-0">Advanced settings</span>
          <span className="text-muted ml-auto min-w-0 truncate text-right text-xs font-normal">
            {configuration.model} · {configuration.shifts} shift
            {configuration.shifts === 1 ? "" : "s"} ·{" "}
            {configuration.method === "minus"
              ? "subtract source"
              : "combine other stems"}
          </span>
        </summary>
        <div className="border-border-control grid gap-4 border-t p-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <div className="text-muted flex items-center justify-between text-xs font-bold tracking-[0.04em] uppercase">
              <label htmlFor="model">Model</label>
              <FieldHelp>
                Choose a standard general-purpose model or a fine-tuned model
                specialized for a source.
              </FieldHelp>
            </div>
            <select
              className="border-border-control text-foreground min-h-11 w-full rounded-md border bg-white px-2.5 py-2 text-base normal-case"
              id="model"
              value={configuration.model}
              onChange={(event) =>
                onChange({
                  ...configuration,
                  model: event.target.value as Preferences["model"],
                })
              }
            >
              <option>htdemucs</option>
              <option>htdemucs_ft</option>
            </select>
          </div>
          <div className="grid gap-2">
            <div className="text-muted flex items-center justify-between text-xs font-bold tracking-[0.04em] uppercase">
              <label htmlFor="shifts">Shifts</label>
              <FieldHelp>
                Choose how many processing passes to average. More shifts can
                improve separation quality, but runtime increases roughly in
                proportion.
              </FieldHelp>
            </div>
            <input
              className="border-border-control text-foreground min-h-11 w-full rounded-md border bg-white px-2.5 py-2 text-base normal-case"
              type="number"
              id="shifts"
              value={configuration.shifts}
              min="1"
              max="4"
              onChange={(event) =>
                onChange({
                  ...configuration,
                  shifts: Number(event.target.value),
                })
              }
            />
          </div>
          <div className="grid gap-2">
            <div className="text-muted flex items-center justify-between text-xs font-bold tracking-[0.04em] uppercase">
              <label htmlFor="method">Backing mix</label>
              <FieldHelp>
                Subtract source removes the selected source from the original.
                With htdemucs_ft, it runs about four times faster than Combine
                other stems. Combine other stems mixes the other separated
                stems. Results vary by track.
              </FieldHelp>
            </div>
            <select
              className="border-border-control text-foreground disabled:bg-surface-disabled disabled:text-disabled min-h-11 w-full rounded-md border bg-white px-2.5 py-2 text-base disabled:cursor-not-allowed"
              id="method"
              value={configuration.method}
              disabled={!configuration.twoStems}
              onChange={(event) =>
                onChange({
                  ...configuration,
                  method: event.target.value as Preferences["method"],
                })
              }
            >
              <option value="minus">Subtract source</option>
              <option value="add">Combine other stems</option>
            </select>
          </div>
        </div>
      </details>
      <p
        className="bg-surface-note text-copy mt-4 rounded-md px-3 py-2.5 text-sm leading-relaxed"
        id="outputSummary"
      >
        {configuration.twoStems ? (
          <>
            Creates <strong>{configuration.twoStems}.wav</strong> and{" "}
            <strong>backing.wav</strong>.
          </>
        ) : (
          <>
            Creates <strong>vocals.wav</strong>, <strong>drums.wav</strong>,{" "}
            <strong>bass.wav</strong>, and <strong>other.wav</strong>.
          </>
        )}
      </p>
    </>
  );
}

function OutputOption({
  option,
  selected,
  onSelect,
}: {
  option: (typeof OUTPUT_OPTIONS)[number];
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <label
      className={`flex min-h-18 cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
        option.value === null ? "sm:col-span-2" : ""
      } ${
        selected
          ? "border-primary-border bg-primary-soft ring-primary-border ring-1"
          : "border-border-control hover:bg-surface-muted bg-white"
      }`}
    >
      <input
        className="accent-primary mt-0.5 size-4 shrink-0"
        type="radio"
        name="output"
        value={option.value ?? ""}
        checked={selected}
        onChange={onSelect}
      />
      <span>
        <strong className="block text-sm font-semibold">{option.label}</strong>
        <span className="text-muted mt-1 block text-sm leading-snug">
          {option.description}
        </span>
      </span>
    </label>
  );
}

function stemLabel(name: string, source: string | null): string {
  if (name === "backing" && source) {
    return `Backing track (without ${source})`;
  }
  return name;
}

function ModelFileSlot({
  filename,
  ready,
  error,
  onSelect,
}: {
  filename: ModelFilename;
  ready: boolean;
  error?: string;
  onSelect: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div data-testid="model-file-slot">
      <div
        className={`flex min-h-13 items-center gap-3 rounded-md border px-4 py-3 transition-colors ${
          dragging
            ? "border-drop-border-hover bg-drop-surface-hover"
            : ready
              ? "border-success-border bg-success-surface hover:bg-success-surface-hover"
              : "border-border-strong bg-surface-muted hover:border-drop-border-hover hover:bg-drop-surface-hover border-dashed"
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) {
            onSelect([file]);
          }
        }}
      >
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
            ready
              ? "bg-primary-bright text-primary-foreground"
              : "border-border-strong text-help border"
          }`}
          aria-hidden="true"
        >
          {ready ? <Check className="size-4" /> : <Plus className="size-4" />}
        </span>
        <code className="text-foreground min-w-0 flex-1 overflow-hidden text-sm font-semibold text-ellipsis">
          {filename}
        </code>
        <a
          className="text-primary hover:text-accent shrink-0 text-sm font-semibold underline underline-offset-3"
          href={modelAssetUrl(filename)}
        >
          Download
        </a>
        <label className="text-primary-strong shrink-0 cursor-pointer text-sm font-bold">
          {ready ? "Ready" : "Choose file"}
          <input
            className="sr-only"
            type="file"
            aria-label={`Select ${filename}`}
            accept={filename.endsWith(".onnx") ? ".onnx" : ".bin"}
            onChange={(event) => {
              onSelect([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {error && <p className="text-danger mt-1.5 text-sm">{error}</p>}
    </div>
  );
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return (
    <details className="relative normal-case">
      <summary
        className="text-help hover:text-primary flex size-5 cursor-pointer list-none items-center justify-center [&::-webkit-details-marker]:hidden"
        aria-label="More information"
      >
        <CircleHelp aria-hidden="true" className="size-5" />
      </summary>
      <div className="text-copy absolute top-7 right-0 z-10 w-56 rounded-md border bg-white p-3 text-sm leading-relaxed font-normal tracking-normal shadow-lg sm:w-64">
        {children}
      </div>
    </details>
  );
}
