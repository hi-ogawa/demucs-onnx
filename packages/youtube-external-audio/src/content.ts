import contentCss from "./content.css?inline";
import { PlayerSync } from "./player-sync.ts";

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
  });

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = contentCss;
  shadow.append(style);

  const panel = document.createElement("div");
  panel.className = "panel";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "External audio";

  const actions = document.createElement("div");
  actions.className = "actions";

  const chooseButton = document.createElement("button");
  chooseButton.type = "button";
  chooseButton.textContent = "Choose file";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.textContent = "Enable";
  toggleButton.disabled = true;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*";
  input.hidden = true;

  const fileName = document.createElement("div");
  fileName.className = "file-name";
  fileName.textContent = "No audio selected";

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "YouTube audio is active";

  actions.append(chooseButton, toggleButton);
  panel.append(title, actions, fileName, status, input);
  shadow.append(panel);
  document.body.append(host);

  const audio = document.createElement("audio");
  audio.preload = "auto";
  let sync: PlayerSync | undefined;
  let objectUrl: string | undefined;

  chooseButton.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    sync?.destroy();
    sync = undefined;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    audio.load();

    fileName.textContent = file.name;
    status.textContent = "Ready; YouTube audio is active";
    toggleButton.disabled = false;
    toggleButton.dataset.active = "false";
    toggleButton.textContent = "Enable";
  });

  toggleButton.addEventListener("click", () => {
    if (sync?.enabled) {
      sync.destroy();
      sync = undefined;
      toggleButton.dataset.active = "false";
      toggleButton.textContent = "Enable";
      status.textContent = "YouTube audio is active";
    } else {
      const video = getMainVideo();
      if (!video) {
        status.textContent = "YouTube video element not found";
        return;
      }
      sync = new PlayerSync(video, audio, (error) => {
        status.textContent = `Playback failed: ${String(error)}`;
      });
      sync.enable();
      toggleButton.dataset.active = "true";
      toggleButton.textContent = "Disable";
      status.textContent = "External audio is active";
    }
  });

  return {
    cleanup() {
      sync?.destroy();
      audio.removeAttribute("src");
      audio.load();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
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
 * This standalone prototype rewrites those patterns without its React UI or
 * caption-specific behavior.
 */
function init() {
  inject();
  document.addEventListener("yt-navigate-start", remove);
  document.addEventListener("yt-navigate-finish", inject);
}

init();
