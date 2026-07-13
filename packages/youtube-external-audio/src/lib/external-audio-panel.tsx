import { useEffect, useRef, useState } from "react";
import { PlayerSync, type VideoClock } from "./player-sync.ts";

function formatTime(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return "--:--";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

interface ExternalAudioPanelViewProps {
  fileName?: string;
  enabled: boolean;
  currentTime?: number;
  duration?: number;
  volume: number;
  error?: string;
  onChooseFile(file: File | undefined): void;
  onToggle(): void;
  onVolumeChange(volume: number): void;
}

export function ExternalAudioFab({
  open,
  onClick,
}: {
  open: boolean;
  onClick(): void;
}) {
  const label = open
    ? "Hide external audio controls"
    : "Show external audio controls";

  return (
    <button
      className={`pointer-events-auto fixed right-4 bottom-4 flex size-10 cursor-pointer items-center justify-center rounded-full border-0 shadow-lg ${open ? "bg-accent text-white" : "bg-foreground text-panel"}`}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg
        aria-hidden="true"
        className="size-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M11 5 6 9H2v6h4l5 4V5Z" />
        <path d="M15 9.5a4 4 0 0 1 0 5" />
        <path d="M18 7a7 7 0 0 1 0 10" />
      </svg>
    </button>
  );
}

export function ExternalAudioPanelView({
  fileName,
  enabled,
  currentTime,
  duration,
  volume,
  error,
  onChooseFile,
  onToggle,
  onVolumeChange,
}: ExternalAudioPanelViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="w-75 rounded-lg border border-border bg-panel p-3 text-sm text-foreground shadow-lg">
      <div className="mb-2 font-semibold">External audio</div>
      <div className="flex gap-2">
        <button
          className="min-w-0 flex-1 cursor-pointer rounded-md border border-button-border bg-button px-2.5 py-1.5 text-xs text-inherit hover:bg-button-hover disabled:cursor-default disabled:opacity-45"
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </button>
        <button
          className="min-w-0 flex-1 cursor-pointer rounded-md border border-button-border bg-button px-2.5 py-1.5 text-xs text-inherit hover:bg-button-hover disabled:cursor-default disabled:opacity-45 data-[active=true]:border-accent-border data-[active=true]:bg-accent data-[active=true]:text-white"
          type="button"
          disabled={!fileName}
          data-active={enabled}
          onClick={onToggle}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <div className="mt-2 truncate text-muted-foreground">
        {fileName ?? "No audio selected"}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>External</span>
        <span className="ml-auto font-mono tabular-nums">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Volume</span>
        <input
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent disabled:cursor-default disabled:opacity-45"
          type="range"
          min="0"
          max="100"
          step="1"
          value={volume}
          disabled={!fileName}
          aria-label="External audio volume"
          onChange={(event) => onVolumeChange(Number(event.target.value))}
        />
        <span className="w-9 text-right font-mono tabular-nums">{volume}%</span>
      </label>
      {error && (
        <div className="mt-2 text-error" role="alert">
          {error}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        hidden
        onChange={(event) => onChooseFile(event.target.files?.[0])}
      />
    </div>
  );
}

export function ExternalAudioPanel({
  getVideo,
}: {
  getVideo: () => VideoClock | null | undefined;
}) {
  // TODO: Persist the chosen audio per video, following ytsub-v5's per-video
  // state pattern.
  const audioRef = useRef<HTMLAudioElement>(null);
  const syncRef = useRef<PlayerSync>(null);
  const objectUrlRef = useRef<string>(null);
  const [fileName, setFileName] = useState<string>();
  const [enabled, setEnabled] = useState(false);
  const [currentTime, setCurrentTime] = useState<number>();
  const [duration, setDuration] = useState<number>();
  const [volume, setVolume] = useState(100);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.volume = volume / 100;
    audioRef.current = audio;

    const updateTime = () => setCurrentTime(audio.currentTime);
    const updateDuration = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : undefined);
    };
    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.addEventListener("durationchange", updateDuration);

    return () => {
      syncRef.current?.destroy();
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("loadedmetadata", updateDuration);
      audio.removeEventListener("durationchange", updateDuration);
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
    setCurrentTime(0);
    setDuration(undefined);
    setError(undefined);
  }

  function changeVolume(nextVolume: number) {
    setVolume(nextVolume);
    if (audioRef.current) {
      audioRef.current.volume = nextVolume / 100;
    }
  }

  function toggle() {
    const sync = syncRef.current;
    if (sync?.enabled) {
      sync.destroy();
      syncRef.current = null;
      setEnabled(false);
      setError(undefined);
      return;
    }

    const video = getVideo();
    const audio = audioRef.current;
    if (!video || !audio) {
      setError("Video source not found");
      return;
    }

    const nextSync = new PlayerSync(video, audio, (error) => {
      setError(`Playback failed: ${String(error)}`);
    });
    nextSync.enable();
    syncRef.current = nextSync;
    setCurrentTime(audio.currentTime);
    setEnabled(true);
    setError(undefined);
  }

  return (
    <ExternalAudioPanelView
      fileName={fileName}
      enabled={enabled}
      currentTime={currentTime}
      duration={duration}
      volume={volume}
      error={error}
      onChooseFile={chooseFile}
      onToggle={toggle}
      onVolumeChange={changeVolume}
    />
  );
}
