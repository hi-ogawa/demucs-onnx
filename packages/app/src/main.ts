// Main thread: decode (platform does format + resample to 44.1k), hand planar f32 to the
// worker, render progress and resulting stems as players + downloads.
import { encodeWavF32 } from "./wav";
import type { SeparateRequest } from "./audio/separate";
import type { WorkerResponse } from "./worker";

declare const __MODELS_URL__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const runBtn = $<HTMLButtonElement>("run");
const progress = $<HTMLProgressElement>("progress");
const status = $<HTMLParagraphElement>("status");
const stemsDiv = $<HTMLDivElement>("stems");

let decoded: { left: Float32Array; right: Float32Array } | null = null;

fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  status.textContent = "decoding...";
  const bytes = await file.arrayBuffer();
  // OfflineAudioContext at 44.1k: decodeAudioData resamples to the context rate.
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
  const buf = await ctx.decodeAudioData(bytes);
  const left = buf.getChannelData(0);
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
  decoded = { left, right };
  status.textContent = `decoded: ${(buf.length / 44100).toFixed(2)}s, ${buf.numberOfChannels}ch @44.1k`;
  runBtn.disabled = false;
};

runBtn.onclick = () => {
  if (!decoded) return;
  runBtn.disabled = true;
  stemsDiv.innerHTML = "";
  progress.hidden = false;
  progress.value = 0;
  const started = performance.now();

  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onerror = (e) => {
    status.textContent = `error: worker failed: ${e.message ?? e}`;
    progress.hidden = true;
    runBtn.disabled = false;
  };
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "status") {
      status.textContent = msg.text;
    } else if (msg.type === "progress") {
      progress.value = msg.done / msg.total;
      status.textContent = `inference ${msg.done}/${msg.total} chunks`;
    } else if (msg.type === "done") {
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      status.textContent = `done in ${secs}s`;
      progress.hidden = true;
      for (const out of msg.outputs) {
        const blob = encodeWavF32([out.left, out.right], 44100);
        const url = URL.createObjectURL(blob);
        const div = document.createElement("div");
        const label = document.createElement("b");
        label.textContent = out.name + " ";
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = url;
        const a = document.createElement("a");
        a.href = url;
        a.download = `${out.name}.wav`;
        a.textContent = "download";
        div.append(label, audio, " ", a);
        stemsDiv.append(div);
      }
      runBtn.disabled = false;
      worker.terminate();
    } else if (msg.type === "error") {
      status.textContent = `error: ${msg.message}`;
      progress.hidden = true;
      runBtn.disabled = false;
      worker.terminate();
    }
  };

  const { left, right } = decoded;
  // copy: the decoded buffers stay usable for re-runs
  const l = left.slice();
  const r = right.slice();
  const twoStemsSource = $<HTMLSelectElement>("twoStems").value;
  const request: SeparateRequest = {
    left: l,
    right: r,
    model: $<HTMLSelectElement>("model").value,
    twoStems: twoStemsSource
      ? {
          source: twoStemsSource,
          // the select's only options are add and minus
          method: $<HTMLSelectElement>("method").value as "add" | "minus",
        }
      : undefined,
    shifts: Number($<HTMLInputElement>("shifts").value),
    modelsUrl: __MODELS_URL__,
  };
  worker.postMessage(request, [l.buffer, r.buffer]);
};
