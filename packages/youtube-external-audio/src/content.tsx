import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import contentCss from "./content.css?inline";
import type { VideoClock } from "./lib/player-sync.ts";
import { videoStorage } from "./lib/storage.ts";
import { ErrorPanel, Fab, StoredPanel } from "./lib/ui.tsx";

const HOST_ID = "youtube-external-audio-host";
const queryClient = new QueryClient();

interface MountedController {
  cleanup(): void;
}

interface YouTubePlayer extends HTMLElement {
  getVolume?(): number;
  isMuted?(): boolean;
  mute?(): void;
  unMute?(): void;
}

// YouTube can overwrite video.muted from its own player state. In MAIN world,
// this adapter keeps mute state and its UI in sync through #movie_player while
// continuing to use the native video element as the playback clock.
class YouTubeVideoClock implements VideoClock {
  constructor(
    private video: HTMLVideoElement,
    private player: YouTubePlayer | null,
  ) {}

  get currentTime() {
    return this.video.currentTime;
  }

  set currentTime(value: number) {
    this.video.currentTime = value;
  }

  get muted() {
    return typeof this.player?.isMuted === "function"
      ? this.player.isMuted()
      : this.video.muted;
  }

  set muted(value: boolean) {
    const method = value ? this.player?.mute : this.player?.unMute;
    if (typeof method === "function") {
      method.call(this.player);
    } else {
      this.video.muted = value;
    }
  }

  get paused() {
    return this.video.paused;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  set playbackRate(value: number) {
    this.video.playbackRate = value;
  }

  get volume() {
    const volume = this.player?.getVolume?.();
    return typeof volume === "number"
      ? Math.max(0, Math.min(1, volume / 100))
      : this.video.volume;
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (callback) {
      this.video.addEventListener(type, callback, options);
    }
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (callback) {
      this.video.removeEventListener(type, callback, options);
    }
  }

  dispatchEvent(event: Event) {
    return this.video.dispatchEvent(event);
  }
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
  const video = document.querySelector<HTMLVideoElement>(
    "video.html5-main-video, video",
  );
  if (!video) {
    return null;
  }
  const player = document.querySelector<YouTubePlayer>("#movie_player");
  return new YouTubeVideoClock(video, player);
}

function App({ videoId }: { videoId: string }) {
  const [open, setOpen] = useState(
    () => videoStorage.getState(videoId).panelOpen,
  );
  const [error, setError] = useState<string>();
  const [zamakPresent, setZamakPresent] = useState(
    () => document.getElementById("zamak-host") !== null,
  );

  // Both extensions use the bottom-right slot; move this FAB left when Zamak
  // is loaded, including when either content script is injected later.
  useEffect(() => {
    const update = () =>
      setZamakPresent(document.getElementById("zamak-host") !== null);
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);

  const toggleOpen = () => {
    setOpen((currentOpen) => {
      const nextOpen = !currentOpen;
      videoStorage.updateState(videoId, { panelOpen: nextOpen });
      return nextOpen;
    });
  };

  return (
    <>
      <div className="pointer-events-none fixed right-4 bottom-14 flex flex-col items-end gap-2">
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
      <Fab open={open} shifted={zamakPresent} onClick={toggleOpen} />
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
