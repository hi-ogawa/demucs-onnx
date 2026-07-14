import JSZip from "jszip";

export interface StemFile {
  name: string;
  blob: Blob;
}

export function toStemArchiveFilename(inputFilename: string): string {
  const basename = inputFilename.replaceAll(".", "_");
  return `${basename || "demucs"}.stems.zip`;
}

export async function createStemArchive(stems: StemFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const stem of stems) {
    zip.file(`${stem.name}.wav`, stem.blob, { compression: "STORE" });
  }
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

export function downloadBlob(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}
