export const AUDIO_SAMPLE_RATE = 44_100;
export const MODEL_SEGMENT = 343_980;
export const MODEL_INPUT_LENGTH = 2 * MODEL_SEGMENT;
export const MODEL_FREQUENCIES = 2_048;
export const MODEL_FRAMES = 336;
export const MODEL_CAC_CHANNELS = 4;
export const MODEL_SPECTROGRAM_LENGTH =
  MODEL_CAC_CHANNELS * MODEL_FREQUENCIES * MODEL_FRAMES;
export const MODEL_FREQUENCY_LENGTH =
  4 * MODEL_CAC_CHANNELS * MODEL_FREQUENCIES * MODEL_FRAMES;
export const MODEL_TIME_LENGTH = 4 * 2 * MODEL_SEGMENT;
export const SOURCES: readonly string[] = ["drums", "bass", "other", "vocals"];
