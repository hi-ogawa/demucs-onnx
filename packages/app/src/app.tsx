import { useMutation } from "@tanstack/react-query";
import { Check, CircleHelp, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { decodeAudioFile, type DecodedAudio } from "./lib/audio/decode";
import {
  isModelFilename,
  requiredModelFiles,
  type ModelFilename,
  type ModelSource,
} from "./lib/audio/models";
import type { SeparateRequest, SeparatedStem } from "./lib/audio/separate";
import { separateInWorker } from "./lib/audio/worker-client";
import { loadPreferences, savePreferences } from "./lib/preferences";
import { updateRunProgress, type RunProgress } from "./lib/progress/model";
import { RunProgressPanel } from "./lib/progress/panel";
import { encodeWavF32 } from "./lib/wav";

// TODO: bad?
type Output = SeparatedStem & { url: string };

export function App() {
  // TODO: bad. mutation result?
  const [decoded, setDecoded] = useState<DecodedAudio | null>(null);

  const [modelFiles, setModelFiles] = useState<
    Partial<Record<ModelFilename, File>>
  >({});
  const [unsupportedModelFiles, setUnsupportedModelFiles] = useState<string[]>(
    [],
  );
  const [modelFileErrors, setModelFileErrors] = useState<
    Partial<Record<ModelFilename, string>>
  >({});
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);

  // TODO: probably bad
  const [status, setStatus] = useState("");

  const [preferences, setPreferences] = useState(loadPreferences);
  useEffect(() => savePreferences(preferences), [preferences]);

  const { model, method, shifts } = preferences;
  const twoStems =
    preferences.outputMode === "two-stems" ? preferences.targetStem : "";

  const selectedModelFiles = Object.values(modelFiles);
  const requiredFiles = requiredModelFiles(
    model,
    twoStems || undefined,
    twoStems ? method : undefined,
  );
  const missingModelFiles = requiredFiles.filter(
    (filename) => !modelFiles[filename],
  );
  const modelsReady = missingModelFiles.length === 0;
  const modelSource: ModelSource | null = modelsReady
    ? { files: selectedModelFiles }
    : null;
  function addModelFiles(files: File[], expected?: ModelFilename) {
    const accepted = files.filter(
      (file) =>
        isModelFilename(file.name) && (!expected || file.name === expected),
    );
    setModelFiles((current) => ({
      ...current,
      ...Object.fromEntries(accepted.map((file) => [file.name, file])),
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
  }

  // TODO: bad. pending/error?
  const decodeMutation = useMutation({ mutationFn: decodeAudioFile });

  function handleAudioFile(file: File | undefined) {
    if (!file) {
      decodeMutation.reset();
      setDecoded(null);
      setStatus("");
      return;
    }

    setDecoded(null);
    setStatus("decoding...");
    decodeMutation.mutate(file, {
      onSuccess: (audio) => {
        setDecoded(audio);
        setStatus(
          `decoded: ${audio.duration.toFixed(2)}s, ${audio.numberOfChannels}ch @${audio.sampleRate / 1000}k`,
        );
      },
      onError: () => setStatus(""),
    });
  }

  // TODO: bad
  const runAbortRef = useRef<AbortController | null>(null);

  // TODO: bad. probably mutation result
  const [outputs, setOutputs] = useState<Output[]>([]);
  const outputUrlsRef = useRef<string[]>([]);

  useEffect(
    () => () => {
      runAbortRef.current?.abort();
      for (const url of outputUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    },
    [],
  );

  const handleRunMutation = useMutation({
    mutationFn: async () => {
      if (!decoded || !modelSource) {
        throw new Error("Audio and model files are required");
      }

      for (const url of outputUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      outputUrlsRef.current = [];
      setOutputs([]);
      const startedAt = Date.now();
      setRunProgress({
        phase: "preparing",
        startedAt,
        done: 0,
        total: 0,
        models: [],
        finalizeMs: 0,
      });
      const started = performance.now();
      const request: SeparateRequest = {
        left: decoded.left.slice(),
        right: decoded.right.slice(),
        model,
        twoStems: twoStems ? { source: twoStems, method } : undefined,
        shifts,
        modelSource,
      };
      const controller = new AbortController();
      runAbortRef.current = controller;
      try {
        const separated = await separateInWorker(request, {
          signal: controller.signal,
          onProgress: (event, at) =>
            setRunProgress((progress) =>
              progress ? updateRunProgress(progress, event, at) : progress,
            ),
        });
        const nextOutputs = separated.map((output) => {
          const blob = encodeWavF32([output.left, output.right], 44100);
          return { ...output, url: URL.createObjectURL(blob) };
        });
        outputUrlsRef.current = nextOutputs.map((output) => output.url);
        setOutputs(nextOutputs);
        setStatus(
          `Done in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          setRunProgress(null);
          throw error;
        }
      } finally {
        if (runAbortRef.current === controller) {
          runAbortRef.current = null;
        }
      }
    },
  });

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
                onChange={(event) => handleAudioFile(event.target.files?.[0])}
              />
            </section>
          </div>

          <aside className="grid gap-6">
            <section className="bg-surface shadow-card min-w-0 rounded-lg border px-5 pt-4 pb-5 sm:px-7 sm:pt-5 sm:pb-7">
              <h2 className="text-foreground mb-5 text-xl font-semibold">
                2. Configure
              </h2>
              <div className="grid grid-cols-1 gap-4.5 sm:grid-cols-2">
                <div className="grid gap-2">
                  <div className="text-muted flex items-center justify-between text-xs font-bold tracking-[0.04em] uppercase">
                    <label htmlFor="model">Model</label>
                    <FieldHelp>
                      Choose the standard general-purpose model or the
                      fine-tuned source-specialist models.
                    </FieldHelp>
                  </div>
                  <select
                    className="border-border-control text-foreground min-h-11 w-full rounded-md border bg-white px-2.5 py-2 text-base normal-case"
                    id="model"
                    value={model}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        model: event.target.value as typeof current.model,
                      }))
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
                      Trade speed for separation quality by averaging multiple
                      processing passes. Runtime grows roughly in proportion.
                    </FieldHelp>
                  </div>
                  <input
                    className="border-border-control text-foreground min-h-11 w-full rounded-md border bg-white px-2.5 py-2 text-base normal-case"
                    type="number"
                    id="shifts"
                    value={shifts}
                    min="1"
                    max="4"
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        shifts: Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <div className="text-muted flex items-center justify-between text-xs font-bold tracking-[0.04em] uppercase">
                    <label htmlFor="twoStems">Two-stems</label>
                    <FieldHelp>
                      Output the selected source and a mix without it. Other
                      contains instruments not classified as vocals, drums, or
                      bass.
                    </FieldHelp>
                  </div>
                  <select
                    className="border-border-control text-foreground min-h-11 w-full rounded-md border bg-white px-2.5 py-2 text-base normal-case"
                    id="twoStems"
                    value={twoStems}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        outputMode: event.target.value
                          ? "two-stems"
                          : "four-stems",
                        targetStem: event.target.value
                          ? (event.target.value as typeof current.targetStem)
                          : current.targetStem,
                      }))
                    }
                  >
                    <option value="">off</option>
                    <option>drums</option>
                    <option>bass</option>
                    <option>other</option>
                    <option>vocals</option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <div className="text-muted flex items-center justify-between text-xs font-bold tracking-[0.04em] uppercase">
                    <label htmlFor="method">Method</label>
                    <FieldHelp>
                      Add combines the other separated stems. Minus subtracts
                      the source from the original and, with htdemucs_ft, runs
                      about four times faster. Results vary by track.
                    </FieldHelp>
                  </div>
                  <select
                    className="border-border-control text-foreground disabled:bg-surface-disabled disabled:text-disabled min-h-11 w-full rounded-md border bg-white px-2.5 py-2 text-base disabled:cursor-not-allowed"
                    id="method"
                    value={method}
                    disabled={!twoStems}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        method: event.target.value as typeof current.method,
                      }))
                    }
                  >
                    <option>add</option>
                    <option>minus</option>
                  </select>
                </div>
                <p
                  className="bg-surface-note text-copy rounded-md px-3 py-2.5 text-sm leading-relaxed sm:col-span-2"
                  id="outputSummary"
                >
                  {twoStems ? (
                    <>
                      Creates <strong>{twoStems}.wav</strong> and{" "}
                      <strong>no_{twoStems}.wav</strong>.
                    </>
                  ) : (
                    <>
                      Creates <strong>vocals.wav</strong>,{" "}
                      <strong>drums.wav</strong>, <strong>bass.wav</strong>, and{" "}
                      <strong>other.wav</strong>.
                    </>
                  )}
                </p>
              </div>
            </section>

            <section className="bg-surface shadow-card min-w-0 rounded-lg border px-5 pt-4 pb-5 sm:px-7 sm:pt-5 sm:pb-7">
              <h2 className="text-foreground mb-2 text-xl font-semibold">
                3. Add models
              </h2>
              <p className="text-muted mb-5.5 leading-relaxed">
                Download model assets from the{" "}
                <a
                  className="text-primary hover:text-accent font-semibold underline underline-offset-3"
                  href="https://github.com/hi-ogawa/demucs-onnx/releases"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub Releases page
                </a>
                , then select the required files.
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
            </section>

            <section className="bg-surface shadow-card min-w-0 rounded-lg border p-5 sm:p-6">
              <h2 className="text-foreground mb-4 text-xl font-semibold">
                4. Separate
              </h2>
              <button
                className="bg-primary-bright text-primary-foreground shadow-action hover:not-disabled:bg-primary-bright-hover disabled:border-primary-border disabled:bg-primary-soft disabled:text-primary-muted min-h-13 w-full cursor-pointer rounded-md border border-transparent font-bold disabled:cursor-not-allowed disabled:shadow-none"
                id="run"
                disabled={
                  handleRunMutation.isPending || !decoded || !modelsReady
                }
                onClick={() => handleRunMutation.mutate()}
              >
                Separate track
              </button>
              {runProgress && <RunProgressPanel progress={runProgress} />}
              {!handleRunMutation.isPending && status && (
                <p
                  className="text-muted mt-3.5 text-sm leading-normal whitespace-pre-line"
                  id="status"
                >
                  {status}
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
            <div className="mb-7">
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
            <div className="grid gap-3.5" id="stems">
              {outputs.map((output) => (
                <div
                  className="bg-surface-muted grid min-w-0 grid-cols-[1fr_auto] items-center gap-3.5 rounded-md border p-4.5"
                  key={output.name}
                >
                  <b className="text-xl font-semibold capitalize">
                    {output.name}
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
  return (
    <div data-testid="model-file-slot">
      <label
        className={`flex min-h-13 cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition-colors ${
          ready
            ? "border-success-border bg-success-surface hover:bg-success-surface-hover"
            : "border-border-strong bg-surface-muted hover:border-drop-border-hover hover:bg-drop-surface-hover border-dashed"
        }`}
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
        <span className="text-primary-strong shrink-0 text-sm font-bold">
          {ready ? "Ready" : "Choose file"}
        </span>
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
