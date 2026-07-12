import { AUDIO_SAMPLE_RATE } from "./constants";

export interface DecodedAudio {
  left: Float32Array;
  right: Float32Array;
  duration: number;
  numberOfChannels: number;
  sampleRate: number;
}

export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 1,
    sampleRate: AUDIO_SAMPLE_RATE,
  });
  const buffer = await context.decodeAudioData(await file.arrayBuffer());
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

  return {
    left,
    right,
    duration: buffer.duration,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  };
}
