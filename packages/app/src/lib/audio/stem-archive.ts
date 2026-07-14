import JSZip from "jszip";

export interface StemFile {
  name: string;
  blob: Blob;
}

export function orderStemFiles<T extends { name: string }>(
  stems: T[],
  twoStemSource: string | null,
): T[] {
  if (!twoStemSource) {
    return stems;
  }

  const order = [`no_${twoStemSource}`, twoStemSource];
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return [...stems].sort((a, b) => rank(a.name) - rank(b.name));
}

export function stemArchiveFilename(inputFilename: string): string {
  const extensionIndex = inputFilename.lastIndexOf(".");
  const basename =
    extensionIndex > 0 ? inputFilename.slice(0, extensionIndex) : inputFilename;
  return `${basename || "stems"}.stems.zip`;
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
