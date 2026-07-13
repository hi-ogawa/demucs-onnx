import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import contentCss from "./content.css?inline";
import { ErrorPanel, Fab, StoredPanel } from "./lib/ui.tsx";
import { getVideoState, updateVideoState } from "./lib/video-state.ts";

const HOST_ID = "youtube-external-audio-host";
const queryClient = new QueryClient();

interface MountedController {
  cleanup(): void;
}

function isWatchPage() {
  return (
    location.pathname === "/watch" &&
    new URL(location.href).searchParams.has("v")
  );
}

function getVideoId() {
  return new URL(location.href).searchParams.get("v");
}

function getMainVideo() {
  return document.querySelector<HTMLVideoElement>(
    "video.html5-main-video, video",
  );
}

function App({ videoId }: { videoId: string }) {
  const [open, setOpen] = useState(() => getVideoState(videoId).panelOpen);
  const [error, setError] = useState<string>();

  const toggleOpen = () => {
    setOpen((currentOpen) => {
      const nextOpen = !currentOpen;
      updateVideoState(videoId, { panelOpen: nextOpen });
      return nextOpen;
    });
  };

  return (
    <>
      <div className="pointer-events-none fixed right-4 bottom-18 flex flex-col items-end gap-2">
        {error && (
          <ErrorPanel message={error} onClose={() => setError(undefined)} />
        )}
        <div className={open ? "pointer-events-auto" : "hidden"}>
          <StoredPanel
            videoId={videoId}
            getVideo={getMainVideo}
            onError={setError}
          />
        </div>
      </div>
      <Fab open={open} onClick={toggleOpen} />
    </>
  );
}

function createUi(videoId: string): MountedController {
  const host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    fontFamily: "'Roboto', 'Arial', sans-serif",
  });

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = contentCss;
  shadow.append(style);

  const container = document.createElement("div");
  shadow.append(container);
  document.body.append(host);

  const applyTheme = () => {
    host.classList.toggle(
      "dark",
      document.documentElement.hasAttribute("dark"),
    );
  };
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["dark"],
  });

  const root = createRoot(container);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App videoId={videoId} />
      </QueryClientProvider>
    </StrictMode>,
  );

  return {
    cleanup() {
      themeObserver.disconnect();
      root.unmount();
      host.remove();
    },
  };
}

function mountWhenVideoIsReady(videoId: string): MountedController {
  let mounted: MountedController | undefined;

  const mount = () => {
    if (mounted || document.getElementById(HOST_ID)) {
      return;
    }
    if (getMainVideo()) {
      observer.disconnect();
      mounted = createUi(videoId);
    }
  };

  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  mount();

  return {
    cleanup() {
      observer.disconnect();
      mounted?.cleanup();
    },
  };
}

let current: MountedController | undefined;

function remove() {
  current?.cleanup();
  current = undefined;
}

function inject() {
  remove();
  const videoId = getVideoId();
  if (isWatchPage() && videoId) {
    current = mountWhenVideoIsReady(videoId);
  }
}

/**
 * The watch-page detection, shadow-root isolation, direct <video> access, and
 * yt-navigate lifecycle are adapted from Zamak (ytsub-v5)'s content script:
 * https://github.com/hi-ogawa/ytsub-v5/blob/main/src/extension/content.tsx
 * This standalone prototype reuses those lifecycle patterns without its
 * caption-specific behavior.
 */
function init() {
  inject();
  document.addEventListener("yt-navigate-start", remove);
  document.addEventListener("yt-navigate-finish", inject);
}

init();
