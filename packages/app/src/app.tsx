import { useEffect, useRef, useState } from "react";
import {
  isModelFilename,
  requiredModelFiles,
  type ModelSource,
} from "./audio/models";
import type { SeparateRequest, SeparatedStem } from "./audio/separate";
import { updateRunProgress, type RunProgress } from "./lib/progress/model";
import { RunProgressPanel } from "./lib/progress/panel";
import { loadPreferences, savePreferences } from "./preferences";
import { encodeWavF32 } from "./wav";
import type { WorkerResponse } from "./worker";

type DecodedAudio = { left: Float32Array; right: Float32Array };
type Output = SeparatedStem & { url: string };
export function App() {
  const [decoded, setDecoded] = useState<DecodedAudio | null>(null);
  const [selectedModelFiles, setSelectedModelFiles] = useState<File[] | null>(
    null,
  );
  const [unsupportedModelFiles, setUnsupportedModelFiles] = useState<string[]>(
    [],
  );
  const [preferences, setPreferences] = useState(loadPreferences);
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);
  const [now, setNow] = useState(Date.now());
  const [status, setStatus] = useState("pick a file");
  const [outputs, setOutputs] = useState<Output[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const outputUrlsRef = useRef<string[]>([]);
  const decodeIdRef = useRef(0);
  const { model, method, shifts } = preferences;
  const twoStems =
    preferences.outputMode === "two-stems" ? preferences.targetStem : "";

  const modelSource: ModelSource | null = selectedModelFiles
    ? { files: selectedModelFiles }
    : null;
  const missingModelFiles = requiredModelFiles(
    model,
    twoStems || undefined,
    twoStems ? method : undefined,
  ).filter(
    (filename) => !selectedModelFiles?.some((file) => file.name === filename),
  );
  const modelsReady = modelSource !== null && missingModelFiles.length === 0;
  let modelFilesStatus =
    missingModelFiles.length > 0
      ? `Missing model files: ${missingModelFiles.join(", ")}`
      : "Required model files selected.";
  if (unsupportedModelFiles.length > 0) {
    modelFilesStatus += ` Unsupported files: ${unsupportedModelFiles.join(", ")}`;
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
      setStatus("pick a file");
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
              <label className="grid gap-2 text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                <span>Model</span>
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
              </label>
              <label className="grid gap-2 text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                <span>Two-stems</span>
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
              </label>
              <label className="grid gap-2 text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                <span>Method</span>
                <select
                  className="min-h-11 w-full rounded-md border border-[#bdc2bc] bg-white px-2.5 py-2 text-base text-[#18201b] normal-case"
                  id="method"
                  value={method}
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
              </label>
              <label className="grid gap-2 text-xs font-bold tracking-[0.04em] text-[#667068] uppercase">
                <span>Shifts</span>
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
              </label>
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
            <input
              className="w-full rounded-md border border-dashed border-[#aeb5ae] bg-[#f8f7f1] p-3 text-[#667068] file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-[#dcebe1] file:px-3.5 file:py-2 file:font-bold file:text-[#174331]"
              type="file"
              id="modelFiles"
              accept=".bin,.onnx"
              multiple
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                setSelectedModelFiles(
                  files.filter((file) => isModelFilename(file.name)),
                );
                setUnsupportedModelFiles(
                  files
                    .filter((file) => !isModelFilename(file.name))
                    .map((file) => file.name),
                );
              }}
            />
            <p
              className="mt-4 text-sm leading-normal whitespace-pre-line text-[#667068]"
              id="modelFilesStatus"
            >
              {modelFilesStatus}
            </p>
          </section>

          <div className="min-w-0 rounded-lg border border-[#d9d8ce] bg-[rgb(255_253_247/90%)] p-6 shadow-[0_20px_50px_rgb(34_47_39/8%)] max-[480px]:p-5">
            <button
              className="min-h-13 w-full cursor-pointer rounded-md border border-transparent bg-[#78d09b] font-bold text-[#102b1d] hover:not-disabled:bg-[#91dfad] disabled:cursor-not-allowed disabled:border-[#c9ccc7] disabled:bg-[#eeeee9] disabled:text-[#777f79]"
              id="run"
              disabled={running || !decoded || !modelsReady}
              onClick={handleRun}
            >
              Separate track
            </button>
            {runProgress && (
              <RunProgressPanel progress={runProgress} now={now} />
            )}
            <p
              className="mt-3.5 min-h-[1.3em] text-sm leading-normal whitespace-pre-line text-[#667068]"
              id="status"
            >
              {running ? "" : status}
            </p>
          </div>
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
