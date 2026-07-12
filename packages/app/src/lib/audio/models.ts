const MODEL_FILENAMES = [
  "htdemucs.onnx",
  "htdemucs_ft_drums.onnx",
  "htdemucs_ft_bass.onnx",
  "htdemucs_ft_other.onnx",
  "htdemucs_ft_vocals.onnx",
] as const;

export type ModelFilename = (typeof MODEL_FILENAMES)[number];

export type ModelArtifact = { name: ModelFilename; blob: Blob };
export type ModelSource = { artifacts: ModelArtifact[] };

export function isModelFilename(name: string): name is ModelFilename {
  return MODEL_FILENAMES.includes(name as ModelFilename);
}

export function requiredModelFiles(
  model: string,
  source?: string,
  method?: "add" | "minus",
): ModelFilename[] {
  if (model === "htdemucs") {
    return ["htdemucs.onnx"];
  }
  if (source && method === "minus") {
    return [`htdemucs_ft_${source}.onnx` as ModelFilename];
  }
  return [
    "htdemucs_ft_drums.onnx",
    "htdemucs_ft_bass.onnx",
    "htdemucs_ft_other.onnx",
    "htdemucs_ft_vocals.onnx",
  ];
}

export async function readModelFile(
  source: ModelSource,
  filename: ModelFilename,
): Promise<Uint8Array> {
  const artifact = source.artifacts.find(
    (candidate) => candidate.name === filename,
  );
  if (!artifact) {
    throw new Error(`missing model file: ${filename}`);
  }
  return new Uint8Array(await artifact.blob.arrayBuffer());
}
