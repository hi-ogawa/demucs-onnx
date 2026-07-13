import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { VideoClock } from "./lib/player-sync.ts";
import type { StoredAudio } from "./lib/storage.ts";
import { ErrorPanel, Fab, Panel } from "./lib/ui.tsx";

class FakeVideo extends EventTarget implements VideoClock {
  currentTime = 0;
  muted = false;
  paused = true;
  playbackRate = 1;
}

const fakeVideo = new FakeVideo();
const previewAudio: StoredAudio = {
  videoId: "preview-video",
  blob: new Blob(),
  name: "preview-audio.wav",
};
const queryClient = new QueryClient();

// TODO: Add Playwright coverage for the standalone panel preview.
function Web() {
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string>();

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
            onClick={() => setDark((value) => !value)}
          >
            {dark ? "Light preview" : "Dark preview"}
          </button>
        </div>
        {/* TODO: Replace the fake clock with manual video upload or a YouTube
            IFrame API adapter when transport testing is in scope. */}
        <div className="pointer-events-none fixed right-4 bottom-14 flex flex-col items-end gap-2">
          {error && (
            <ErrorPanel message={error} onClose={() => setError(undefined)} />
          )}
          <div className={open ? "pointer-events-auto" : "hidden"}>
            <Panel
              videoId="preview-video"
              getVideo={() => fakeVideo}
              initialSelectedAudio={previewAudio}
              onSelectAudio={() => undefined}
              onError={setError}
            />
          </div>
        </div>
        <Fab open={open} onClick={() => setOpen((value) => !value)} />
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
    <QueryClientProvider client={queryClient}>
      <Web />
    </QueryClientProvider>
  </StrictMode>,
);
