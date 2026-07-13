const STORAGE_KEY = "youtube-external-audio:video-state";

// TODO: Adopt toy-midi's versioned localStorage schema and migration pattern.
export interface VideoState {
  panelOpen: boolean;
  volume: number;
}

const defaultState: VideoState = {
  panelOpen: false,
  volume: 100,
};

function readAll() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? (JSON.parse(value) as Record<string, VideoState>) : {};
  } catch {
    return {};
  }
}

export function getVideoState(videoId: string): VideoState {
  return { ...defaultState, ...readAll()[videoId] };
}

export function updateVideoState(
  videoId: string,
  update: Partial<VideoState>,
): VideoState {
  const all = readAll();
  const state = { ...defaultState, ...all[videoId], ...update };
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...all, [videoId]: state }),
    );
  } catch {}
  return state;
}
