import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import contentCss from "./content.css?inline";
import { PlayerSync } from "./player-sync.ts";

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const syncRef = useRef<PlayerSync>(null);
  const objectUrlRef = useRef<string>(null);
  const [fileName, setFileName] = useState<string>();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("YouTube audio is active");

  useEffect(() => {
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audioRef.current = audio;

    return () => {
      syncRef.current?.destroy();
      audio.removeAttribute("src");
      audio.load();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  function chooseFile(file: File | undefined) {
    const audio = audioRef.current;
    if (!file || !audio) {
      return;
    }

    syncRef.current?.destroy();
    syncRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }

    const objectUrl = URL.createObjectURL(file);
    objectUrlRef.current = objectUrl;
    audio.src = objectUrl;
    audio.load();

    setFileName(file.name);
    setEnabled(false);
    setStatus("Ready; YouTube audio is active");
  }

  function toggle() {
    const sync = syncRef.current;
    if (sync?.enabled) {
      sync.destroy();
      syncRef.current = null;
      setEnabled(false);
      setStatus("YouTube audio is active");
      return;
    }

    const video = getMainVideo();
    const audio = audioRef.current;
    if (!video || !audio) {
      setStatus("YouTube video element not found");
      return;
    }

    const nextSync = new PlayerSync(video, audio, (error) => {
      setStatus(`Playback failed: ${String(error)}`);
    });
    nextSync.enable();
    syncRef.current = nextSync;
    setEnabled(true);
    setStatus("External audio is active");
  }

  return (
    <div className="w-75 rounded-lg border border-border bg-panel p-3 text-sm text-foreground shadow-lg">
      <div className="mb-2 font-semibold">External audio</div>
      <div className="flex gap-2">
        <button
          className="min-w-0 flex-1 cursor-pointer rounded-lg border border-button-border bg-button px-2.5 py-2 text-inherit hover:bg-button-hover disabled:cursor-default disabled:opacity-45"
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </button>
        <button
          className="min-w-0 flex-1 cursor-pointer rounded-lg border border-button-border bg-button px-2.5 py-2 text-inherit hover:bg-button-hover disabled:cursor-default disabled:opacity-45 data-[active=true]:border-accent-border data-[active=true]:bg-accent data-[active=true]:text-white"
          type="button"
          disabled={!fileName}
          data-active={enabled}
          onClick={toggle}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <div className="mt-2 truncate text-muted-foreground">
        {fileName ?? "No audio selected"}
      </div>
      <div className="mt-2 truncate text-muted-foreground">{status}</div>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        hidden
        onChange={(event) => chooseFile(event.target.files?.[0])}
      />
    </div>
  );
}

const HOST_ID = "youtube-external-audio-host";

interface MountedController {
  cleanup(): void;
}

function isWatchPage() {
  return (
    location.pathname === "/watch" &&
    new URL(location.href).searchParams.has("v")
  );
}

function getMainVideo() {
  return document.querySelector<HTMLVideoElement>(
    "video.html5-main-video, video",
  );
}

function createUi(): MountedController {
  const host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    right: "16px",
    bottom: "72px",
    zIndex: "2147483647",
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
      <App />
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

function mountWhenVideoIsReady(): MountedController {
  let mounted: MountedController | undefined;

  const mount = () => {
    if (mounted || document.getElementById(HOST_ID)) {
      return;
    }
    if (getMainVideo()) {
      observer.disconnect();
      mounted = createUi();
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
  if (isWatchPage()) {
    current = mountWhenVideoIsReady();
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
