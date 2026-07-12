import { useEffect, useRef, useState } from "react";
import {
  isModelFilename,
  requiredModelFiles,
  type ModelFilename,
  type ModelSource,
} from "./lib/audio/models";
import type { SeparateRequest, SeparatedStem } from "./lib/audio/separate";
import { loadPreferences, savePreferences } from "./lib/preferences";
import { updateRunProgress, type RunProgress } from "./lib/progress/model";
import { RunProgressPanel } from "./lib/progress/panel";
import { encodeWavF32 } from "./lib/wav";
import type { WorkerResponse } from "./worker";

type DecodedAudio = { left: Float32Array; right: Float32Array };
type Output = SeparatedStem & { url: string };

function FieldHelp({ children }: { children: React.ReactNode }) {
  return (
    <details className="relative normal-case">
      <summary
        className="flex size-5 cursor-pointer list-none items-center justify-center rounded-full border border-[#aeb5ae] text-[11px] font-bold text-[#536059] hover:border-[#174331] hover:text-[#174331] [&::-webkit-details-marker]:hidden"
        aria-label="More information"
      >
        ?
      </summary>
      <div className="absolute top-7 right-0 z-10 w-64 rounded-md border border-[#d9d8ce] bg-white p-3 text-sm leading-relaxed font-normal tracking-normal text-[#3f4942] shadow-lg max-[480px]:w-56">
        {children}
      </div>
    </details>
  );
}

export function App() {
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
  const [preferences, setPreferences] = useState(loadPreferences);
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);
  const [now, setNow] = useState(Date.now());
  const [status, setStatus] = useState("");
  const [outputs, setOutputs] = useState<Output[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const outputUrlsRef = useRef<string[]>([]);
  const decodeIdRef = useRef(0);
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

  function clearOutputs() {
    for (const url of outputUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    outputUrlsRef.current = [];
    setOutputs([]);
  }

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      for (const url of outputUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    },
    [],
  );

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => savePreferences(preferences), [preferences]);

  async function handleAudioFile(file: File | undefined) {
    const decodeId = ++decodeIdRef.current;
    if (!file) {
      setDecoded(null);
      setStatus("");
      return;
    }

    setDecoded(null);
    setStatus("decoding...");
    try {
      const bytes = await file.arrayBuffer();
      const context = new OfflineAudioContext({
        numberOfChannels: 2,
        length: 1,
        sampleRate: 44100,
      });
      const buffer = await context.decodeAudioData(bytes);
      if (decodeId !== decodeIdRef.current) {
        return;
      }
      const left = buffer.getChannelData(0);
      const right =
        buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
      setDecoded({ left, right });
      setStatus(
        `decoded: ${(buffer.length / 44100).toFixed(2)}s, ${buffer.numberOfChannels}ch @44.1k`,
      );
    } catch (error) {
      if (decodeId === decodeIdRef.current) {
        setStatus(
          `error: failed to decode audio: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  function finishRun(worker: Worker) {
    if (workerRef.current !== worker) {
      return false;
    }
    workerRef.current = null;
    worker.terminate();
    setRunning(false);
    return true;
  }

  function handleRun() {
    if (!decoded || !modelSource) {
      return;
    }

    clearOutputs();
    setRunning(true);
    const startedAt = Date.now();
    setNow(startedAt);
    setRunProgress({
      phase: "preparing",
      startedAt,
      done: 0,
      total: 0,
      models: [],
      finalizeMs: 0,
    });
    const started = performance.now();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onerror = (event) => {
      if (finishRun(worker)) {
        setRunProgress(null);
        setStatus(`error: worker failed: ${event.message}`);
      }
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (workerRef.current !== worker) {
        return;
      }
      const message = event.data;
      if (message.type === "progress") {
        setRunProgress((progress) =>
          progress
            ? updateRunProgress(progress, message.event, message.at)
            : progress,
        );
      } else if (message.type === "done") {
        const nextOutputs = message.outputs.map((output) => {
          const blob = encodeWavF32([output.left, output.right], 44100);
          return { ...output, url: URL.createObjectURL(blob) };
        });
        outputUrlsRef.current = nextOutputs.map((output) => output.url);
        setOutputs(nextOutputs);
        setStatus(
          `done in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        );
        finishRun(worker);
      } else {
        setRunProgress(null);
        setStatus(`error: ${message.message}`);
        finishRun(worker);
      }
    };

    const left = decoded.left.slice();
    const right = decoded.right.slice();
    const request: SeparateRequest = {
      left,
      right,
      model,
      twoStems: twoStems ? { source: twoStems, method } : undefined,
      shifts,
      modelSource,
    };
    worker.postMessage(request, [left.buffer, right.buffer]);
  }

  return (
    <main className="mx-auto w-[min(760px,calc(100%-40px))] py-18 max-[480px]:w-[calc(100%-24px)] max-[480px]:py-9 md:pb-24">
      <header className="mb-8 max-w-190">
        <h1 className="text-4xl leading-tight font-semibold tracking-[-0.035em] sm:text-5xl">
          Demucs ONNX
        </h1>
        <p className="mt-4 mb-2 max-w-162.5 text-lg leading-relaxed text-[#3f4942]">
          Separate music into vocals, drums, bass, and other stems, entirely in
          your browser. Your audio and model files stay on this device.
        </p>
        <a
          className="text-sm font-semibold text-[#174331] underline underline-offset-3 hover:text-[#b85c2c]"
          href="https://github.com/hi-ogawa/demucs-onnx"
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub
        </a>
      </header>

      <section className="grid gap-6" aria-label="Separation setup">
        <div className="grid gap-6">
          <section className="min-w-0 rounded-lg border border-[#d9d8ce] bg-[rgb(255_253_247/90%)] px-7 pt-5 pb-7 shadow-[0_20px_50px_rgb(34_47_39/8%)] max-[480px]:px-5 max-[480px]:pt-4 max-[480px]:pb-5">
            <h2 className="mb-2 text-xl font-semibold text-[#18201b]">
              1. Choose audio
            </h2>
            <p className="mb-5.5 leading-relaxed text-[#667068]">
              Select the track you want to separate.
            </p>
            <input
              className="w-full rounded-md border border-dashed border-[#aeb5ae] bg-[#f8f7f1] p-3 text-[#667068] file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-[#dcebe1] file:px-3.5 file:py-2 file:font-bold file:text-[#174331]"
              type="file"
              id="file"
              accept="audio/*"
              onChange={(event) =>
                void handleAudioFile(event.target.files?.[0])
              }
            />
          </section>
        </div>

        <aside className="grid gap-6">
          <section className="min-w-0 rounded-lg border border-[#d9d8ce] bg-[rgb(255_253_247/90%)] px-7 pt-5 pb-7 shadow-[0_20px_50px_rgb(34_47_39/8%)] max-[480px]:px-5 max-[480px]:pt-4 max-[480px]:pb-5">
            <h2 className="mb-5 text-xl font-semibold text-[#18201b]">
              2. Configure
            </h2>
            <div className="grid grid-cols-2 gap-4.5 max-[480px]:grid-cols-1">
              <div className="grid gap-2">
                <div className="flex items-center justify-between text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                  <label htmlFor="model">Model</label>
                  <FieldHelp>
                    Choose the standard general-purpose model or the fine-tuned
                    source-specialist models.
                  </FieldHelp>
                </div>
                <select
                  className="min-h-11 w-full rounded-md border border-[#bdc2bc] bg-white px-2.5 py-2 text-base text-[#18201b] normal-case"
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
                <div className="flex items-center justify-between text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                  <label htmlFor="shifts">Shifts</label>
                  <FieldHelp>
                    Trade speed for separation quality by averaging multiple
                    processing passes. Runtime grows roughly in proportion.
                  </FieldHelp>
                </div>
                <input
                  className="min-h-11 w-full rounded-md border border-[#bdc2bc] bg-white px-2.5 py-2 text-base text-[#18201b] normal-case"
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
                <div className="flex items-center justify-between text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                  <label htmlFor="twoStems">Two-stems</label>
                  <FieldHelp>
                    Output the selected source and a mix without it. Other
                    contains instruments not classified as vocals, drums, or
                    bass.
                  </FieldHelp>
                </div>
                <select
                  className="min-h-11 w-full rounded-md border border-[#bdc2bc] bg-white px-2.5 py-2 text-base text-[#18201b] normal-case"
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
                <div className="flex items-center justify-between text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                  <label htmlFor="method">Method</label>
                  <FieldHelp>
                    Add combines the other separated stems. Minus subtracts the
                    source from the original and, with htdemucs_ft, runs about
                    four times faster. Results vary by track.
                  </FieldHelp>
                </div>
                <select
                  className="min-h-11 w-full rounded-md border border-[#bdc2bc] bg-white px-2.5 py-2 text-base text-[#18201b] disabled:cursor-not-allowed disabled:bg-[#eeeee9] disabled:text-[#777f79]"
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
                className="col-span-2 rounded-md bg-[#e8eee9] px-3 py-2.5 text-sm leading-relaxed text-[#3f4942] max-[480px]:col-span-1"
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

          <section className="min-w-0 rounded-lg border border-[#d9d8ce] bg-[rgb(255_253_247/90%)] px-7 pt-5 pb-7 shadow-[0_20px_50px_rgb(34_47_39/8%)] max-[480px]:px-5 max-[480px]:pt-4 max-[480px]:pb-5">
            <h2 className="mb-2 text-xl font-semibold text-[#18201b]">
              3. Add models
            </h2>
            <p className="mb-5.5 leading-relaxed text-[#667068]">
              Download model assets from the{" "}
              <a
                className="font-semibold text-[#174331] underline underline-offset-3 hover:text-[#b85c2c]"
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
                <div data-testid="model-file-slot" key={filename}>
                  <label
                    className={`flex min-h-13 cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition-colors ${
                      modelFiles[filename]
                        ? "border-[#8fbea1] bg-[#edf7f0] hover:bg-[#e5f3e9]"
                        : "border-dashed border-[#aeb5ae] bg-[#f8f7f1] hover:border-[#779181] hover:bg-[#f3f5ef]"
                    }`}
                  >
                    <span
                      className={`flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                        modelFiles[filename]
                          ? "bg-[#78d09b] text-[#102b1d]"
                          : "border border-[#aeb5ae] text-[#536059]"
                      }`}
                      aria-hidden="true"
                    >
                      {modelFiles[filename] ? "✓" : "+"}
                    </span>
                    <code className="min-w-0 flex-1 overflow-hidden text-sm font-semibold text-ellipsis text-[#18201b]">
                      {filename}
                    </code>
                    <span className="shrink-0 text-sm font-bold text-[#245f46]">
                      {modelFiles[filename] ? "Ready" : "Choose file"}
                    </span>
                    <input
                      className="sr-only"
                      type="file"
                      aria-label={`Select ${filename}`}
                      accept={filename.endsWith(".onnx") ? ".onnx" : ".bin"}
                      onChange={(event) => {
                        addModelFiles(
                          [...(event.target.files ?? [])],
                          filename,
                        );
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {modelFileErrors[filename] && (
                    <p className="mt-1.5 text-sm text-[#9b3f2b]">
                      {modelFileErrors[filename]}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-[#667068]">
              Alternatively,{" "}
              <label className="cursor-pointer font-semibold text-[#174331] underline underline-offset-3 hover:text-[#b85c2c]">
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
              <p className="mt-2 text-sm text-[#9b3f2b]">
                Unsupported files: {unsupportedModelFiles.join(", ")}.
              </p>
            )}
          </section>

          <section className="min-w-0 rounded-lg border border-[#d9d8ce] bg-[rgb(255_253_247/90%)] p-6 shadow-[0_20px_50px_rgb(34_47_39/8%)] max-[480px]:p-5">
            <h2 className="mb-4 text-xl font-semibold text-[#18201b]">
              4. Separate
            </h2>
            <button
              className="min-h-13 w-full cursor-pointer rounded-md border border-transparent bg-[#78d09b] font-bold text-[#102b1d] shadow-[0_8px_18px_rgb(23_67_49/16%)] hover:not-disabled:bg-[#91dfad] disabled:cursor-not-allowed disabled:border-[#aecdb9] disabled:bg-[#dcebe1] disabled:text-[#526a5b] disabled:shadow-none"
              id="run"
              disabled={running || !decoded || !modelsReady}
              onClick={handleRun}
            >
              Separate track
            </button>
            {runProgress && (
              <RunProgressPanel progress={runProgress} now={now} />
            )}
            {!running && status && (
              <p
                className="mt-3.5 text-sm leading-normal whitespace-pre-line text-[#667068]"
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
          className="mt-12 min-w-0 rounded-lg border border-[#d9d8ce] bg-[rgb(255_253_247/90%)] p-9 shadow-[0_20px_50px_rgb(34_47_39/8%)] max-[480px]:px-5 max-[480px]:py-6"
          aria-labelledby="results-title"
        >
          <div className="mb-7">
            <p className="mb-2.5 text-xs font-extrabold tracking-[0.14em] text-[#245f46] uppercase">
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
                className="grid min-w-0 grid-cols-[1fr_auto] items-center gap-3.5 rounded-md border border-[#d9d8ce] bg-[#f8f7f1] p-4.5"
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
                  className="text-sm font-semibold text-[#174331] underline underline-offset-3 hover:text-[#b85c2c]"
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
    </main>
  );
}
