import { useEffect, useRef, useState } from "react";
import {
  isModelFilename,
  requiredModelFiles,
  type ModelSource,
} from "./audio/models";
import type { SeparateRequest, SeparatedStem } from "./audio/separate";
import { encodeWavF32 } from "./wav";
import type { WorkerResponse } from "./worker";

declare const __MODELS_URL__: string | null;

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
  const [model, setModel] = useState("htdemucs");
  const [twoStems, setTwoStems] = useState("");
  const [method, setMethod] = useState<"add" | "minus">("add");
  const [shifts, setShifts] = useState(1);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState("pick a file");
  const [outputs, setOutputs] = useState<Output[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const outputUrlsRef = useRef<string[]>([]);
  const decodeIdRef = useRef(0);

  const modelSource: ModelSource | null = selectedModelFiles
    ? { kind: "files", files: selectedModelFiles }
    : __MODELS_URL__
      ? { kind: "url", baseUrl: __MODELS_URL__ }
      : null;
  const missingModelFiles =
    modelSource?.kind === "url"
      ? []
      : requiredModelFiles(
          model,
          twoStems || undefined,
          twoStems ? method : undefined,
        ).filter(
          (filename) =>
            !selectedModelFiles?.some((file) => file.name === filename),
        );
  const modelsReady = modelSource !== null && missingModelFiles.length === 0;
  let modelFilesStatus =
    modelSource?.kind === "url"
      ? "Using development model files."
      : missingModelFiles.length > 0
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
    setProgress(null);
    return true;
  }

  function handleRun() {
    if (!decoded || !modelSource) {
      return;
    }

    clearOutputs();
    setRunning(true);
    setProgress(0);
    const started = performance.now();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onerror = (event) => {
      if (finishRun(worker)) {
        setStatus(`error: worker failed: ${event.message}`);
      }
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (workerRef.current !== worker) {
        return;
      }
      const message = event.data;
      if (message.type === "status") {
        setStatus(message.text);
      } else if (message.type === "progress") {
        setProgress(message.done / message.total);
        setStatus(`inference ${message.done}/${message.total} chunks`);
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
    <main>
      <h1>demucs-web prototype</h1>
      <fieldset>
        <legend>input</legend>
        <input
          type="file"
          id="file"
          accept="audio/*"
          onChange={(event) => void handleAudioFile(event.target.files?.[0])}
        />
      </fieldset>
      <fieldset>
        <legend>models</legend>
        <p>
          Download model assets from the{" "}
          <a
            href="https://github.com/hi-ogawa/demucs-onnx/releases"
            target="_blank"
            rel="noreferrer"
          >
            GitHub Releases page
          </a>
          , then select the required files.
        </p>
        <input
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
        <p id="modelFilesStatus">{modelFilesStatus}</p>
      </fieldset>
      <fieldset>
        <legend>options</legend>
        <label>
          model{" "}
          <select
            id="model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option>htdemucs</option>
            <option>htdemucs_ft</option>
          </select>
        </label>
        <label>
          two-stems{" "}
          <select
            id="twoStems"
            value={twoStems}
            onChange={(event) => setTwoStems(event.target.value)}
          >
            <option value="">off</option>
            <option>drums</option>
            <option>bass</option>
            <option>other</option>
            <option>vocals</option>
          </select>
        </label>
        <label>
          method{" "}
          <select
            id="method"
            value={method}
            onChange={(event) =>
              setMethod(event.target.value as "add" | "minus")
            }
          >
            <option>add</option>
            <option>minus</option>
          </select>
        </label>
        <label>
          shifts{" "}
          <input
            type="number"
            id="shifts"
            value={shifts}
            min="1"
            max="4"
            onChange={(event) => setShifts(Number(event.target.value))}
          />
        </label>
      </fieldset>
      <button
        id="run"
        disabled={running || !decoded || !modelsReady}
        onClick={handleRun}
      >
        separate
      </button>
      {progress !== null && <progress id="progress" value={progress} max="1" />}
      <p id="status">{status}</p>
      <div id="stems">
        {outputs.map((output) => (
          <div key={output.name}>
            <b>{output.name} </b>
            <audio controls src={output.url} />{" "}
            <a href={output.url} download={`${output.name}.wav`}>
              download
            </a>
          </div>
        ))}
      </div>
    </main>
  );
}
