const MODEL_FILENAMES = [
  "dft.bin",
  "htdemucs.onnx",
  "htdemucs_ft_drums.onnx",
  "htdemucs_ft_bass.onnx",
  "htdemucs_ft_other.onnx",
  "htdemucs_ft_vocals.onnx",
] as const;

export type ModelFilename = (typeof MODEL_FILENAMES)[number];

export type ModelSource = { files: File[] };

export function isModelFilename(name: string): name is ModelFilename {
  return MODEL_FILENAMES.includes(name as ModelFilename);
}

export function requiredModelFiles(
  model: string,
  source?: string,
  method?: "add" | "minus",
): ModelFilename[] {
  if (model === "htdemucs") {
    return ["dft.bin", "htdemucs.onnx"];
  }
  if (source && method === "minus") {
    return ["dft.bin", `htdemucs_ft_${source}.onnx` as ModelFilename];
  }
  return [
    "dft.bin",
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
  const file = source.files.find((candidate) => candidate.name === filename);
  if (!file) {
    throw new Error(`missing model file: ${filename}`);
  }
  return new Uint8Array(await file.arrayBuffer());
}
