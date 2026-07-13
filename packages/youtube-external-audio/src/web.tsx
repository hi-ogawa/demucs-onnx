import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  ExternalAudioPanel,
  ExternalAudioPanelView,
} from "./lib/external-audio-panel.tsx";
import type { VideoClock } from "./lib/player-sync.ts";

class FakeVideo extends EventTarget implements VideoClock {
  currentTime = 0;
  muted = false;
  paused = true;
  playbackRate = 1;
}

const fakeVideo = new FakeVideo();

// TODO: Add Playwright coverage for the standalone panel preview.
function Web() {
  const [dark, setDark] = useState(false);
  const [enabledPreview, setEnabledPreview] = useState(false);
  const [previewVolume, setPreviewVolume] = useState(80);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);

  return (
    <main className="flex min-h-screen items-start justify-center bg-button p-8 font-sans text-foreground">
      <div className="flex flex-col items-end gap-3">
        <div className="flex gap-2">
          <button
            className="cursor-pointer rounded-md border border-button-border bg-panel px-2.5 py-1.5 text-xs hover:bg-button-hover"
            type="button"
            onClick={() => setEnabledPreview((value) => !value)}
          >
            {enabledPreview ? "Live preview" : "Enabled preview"}
          </button>
          <button
            className="cursor-pointer rounded-md border border-button-border bg-panel px-2.5 py-1.5 text-xs hover:bg-button-hover"
            type="button"
            onClick={() => setDark((value) => !value)}
          >
            {dark ? "Light preview" : "Dark preview"}
          </button>
        </div>
        {/* TODO: Replace the fake clock with manual video upload or a YouTube
            IFrame API adapter when transport testing is in scope. */}
        {enabledPreview ? (
          <ExternalAudioPanelView
            fileName="preview-audio.wav"
            enabled
            currentTime={84}
            duration={258}
            volume={previewVolume}
            onChooseFile={() => {}}
            onToggle={() => setEnabledPreview(false)}
            onVolumeChange={setPreviewVolume}
          />
        ) : (
          <ExternalAudioPanel getVideo={() => fakeVideo} />
        )}
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <Web />
  </StrictMode>,
);
