import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function main() {
  const SAMPLE_RATE = 44_100;
  const DURATION_SECONDS = 30;
  const CHANNELS = 2;
  const output = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.argv[2] ?? "data/benchmark/input-30s.wav",
  );
  const samples = SAMPLE_RATE * DURATION_SECONDS;
  const bytes = new Uint8Array(44 + samples * CHANNELS * 4);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * CHANNELS * 4, true);
  view.setUint16(32, CHANNELS * 4, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples * CHANNELS * 4, true);

  for (let i = 0; i < samples; i++) {
    const time = i / SAMPLE_RATE;
    const left = tone(time, 110, 220, 440);
    const right = tone(time, 137, 274, 548);
    view.setFloat32(44 + (i * CHANNELS + 0) * 4, left, true);
    view.setFloat32(44 + (i * CHANNELS + 1) * 4, right, true);
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  console.log(output);
}

function tone(time: number, ...frequencies: number[]) {
  return (
    frequencies.reduce(
      (sum, frequency, index) =>
        sum + Math.sin(2 * Math.PI * frequency * time) / (index + 1),
      0,
    ) * 0.2
  );
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (const [index, character] of [...value].entries()) {
    view.setUint8(offset + index, character.charCodeAt(0));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
