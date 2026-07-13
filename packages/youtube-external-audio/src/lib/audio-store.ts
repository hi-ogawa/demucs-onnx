import { IdbStore } from "./idb.ts";

// TODO: Unify audio-store and video-state behind one per-video persistence
// manager API while keeping their IndexedDB/localStorage responsibilities split.
export interface StoredAudio {
  videoId: string;
  blob: Blob;
  name: string;
}

const store = new IdbStore<StoredAudio>({
  databaseName: "youtube-external-audio",
  storeName: "audio",
  version: 1,
  keyPath: "videoId",
});

export const storedAudioManager = {
  load: (videoId: string) => store.get(videoId),
  store: (audio: StoredAudio) => store.put(audio),
};
