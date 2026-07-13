import { IdbStore } from "./idb.ts";

export interface StoredAudio {
  videoId: string;
  blob: Blob;
  name: string;
}

export interface VideoState {
  panelOpen: boolean;
}

interface StoredVideoStates {
  videos: Record<string, VideoState>;
}

const VIDEO_STATE_KEY = "youtube-external-audio:video-state:v1";
const DEFAULT_VIDEO_STATE: VideoState = {
  panelOpen: false,
};

const audioStore = new IdbStore<StoredAudio>({
  databaseName: "youtube-external-audio",
  storeName: "audio",
  version: 1,
  keyPath: "videoId",
});

function readVideoStates(): StoredVideoStates {
  try {
    const value = localStorage.getItem(VIDEO_STATE_KEY);
    if (value) {
      const stored = JSON.parse(value) as StoredVideoStates;
      if (stored.videos && typeof stored.videos === "object") {
        return stored;
      }
    }
  } catch {}
  return { videos: {} };
}

export const videoStorage = {
  getState(videoId: string): VideoState {
    return {
      ...DEFAULT_VIDEO_STATE,
      ...readVideoStates().videos[videoId],
    };
  },

  updateState(videoId: string, update: Partial<VideoState>): VideoState {
    const stored = readVideoStates();
    const state = {
      ...DEFAULT_VIDEO_STATE,
      ...stored.videos[videoId],
      ...update,
    };
    try {
      localStorage.setItem(
        VIDEO_STATE_KEY,
        JSON.stringify({
          videos: { ...stored.videos, [videoId]: state },
        } satisfies StoredVideoStates),
      );
    } catch {}
    return state;
  },

  loadAudio: (videoId: string) => audioStore.get(videoId),
  storeAudio: (audio: StoredAudio) => audioStore.put(audio),
};
