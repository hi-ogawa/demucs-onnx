import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PlayerSync, type VideoClock } from "./player-sync.ts";
import { type StoredAudio, videoStorage } from "./storage.ts";

export function StoredPanel({
  videoId,
  getVideo,
  onError,
}: {
  videoId: string;
  getVideo: () => VideoClock | null | undefined;
  onError(message: string): void;
}) {
  const storedAudioQuery = useSuspenseQuery({
    queryKey: ["stored-audio", videoId],
    queryFn: async () => {
      try {
        return await videoStorage.loadAudio(videoId);
      } catch (error) {
        console.error(error);
        onError("Saved audio is unavailable. You can still choose a file.");
        return null;
      }
    },
  });

  const storeAudioMutation = useMutation({
    mutationFn: videoStorage.storeAudio,
    onError: (error) => {
      console.error(error);
      onError("Audio is available for this session but could not be saved.");
    },
  });

  return (
    <Panel
      videoId={videoId}
      getVideo={getVideo}
      initialSelectedAudio={storedAudioQuery.data}
      onSelectAudio={storeAudioMutation.mutate}
      onError={onError}
    />
  );
}

export function Panel({
  videoId,
  getVideo,
  initialSelectedAudio,
  onSelectAudio,
  onError,
}: {
  videoId: string;
  getVideo: () => VideoClock | null | undefined;
  initialSelectedAudio: StoredAudio | null;
  onSelectAudio(audio: StoredAudio): void;
  onError(message: string): void;
}) {
  const [selectedAudio, setSelectedAudio] = useState(
    initialSelectedAudio ?? undefined,
  );
  const [volume, setVolume] = useState(
    () => videoStorage.getState(videoId).volume,
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const syncRef = useRef<PlayerSync>(null);
  const [enabled, setEnabled] = useState(false);
  const [currentTime, setCurrentTime] = useState<number>();
  const [duration, setDuration] = useState<number>();

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
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !selectedAudio) {
      return;
    }

    const objectUrl = URL.createObjectURL(selectedAudio.blob);
    audio.src = objectUrl;
    audio.load();
    setCurrentTime(0);
    setDuration(undefined);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedAudio?.blob]);

  function chooseFile(file: File | undefined) {
    if (!file) {
      return;
    }

    syncRef.current?.destroy();
    syncRef.current = null;
    const nextAudio = {
      videoId,
      blob: file,
      name: file.name,
    };
    setSelectedAudio(nextAudio);
    onSelectAudio(nextAudio);
    setEnabled(false);
  }

  function changeVolume(nextVolume: number) {
    setVolume(nextVolume);
    videoStorage.updateState(videoId, { volume: nextVolume });
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
      return;
    }

    const video = getVideo();
    const audio = audioRef.current;
    if (!video || !audio) {
      onError("YouTube video player not found.");
      return;
    }

    const nextSync = new PlayerSync(video, audio, (error) => {
      console.error(error);
      onError("External audio playback failed.");
    });
    nextSync.enable();
    syncRef.current = nextSync;
    setCurrentTime(audio.currentTime);
    setEnabled(true);
  }

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
          disabled={!selectedAudio}
          data-active={enabled}
          onClick={toggle}
        >
          {enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <div className="mt-2 truncate text-muted-foreground">
        {selectedAudio?.name ?? "No audio selected"}
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
          disabled={!selectedAudio}
          aria-label="External audio volume"
          onChange={(event) => changeVolume(Number(event.target.value))}
        />
        <span className="w-9 text-right font-mono tabular-nums">{volume}%</span>
      </label>
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

export function Fab({ open, onClick }: { open: boolean; onClick(): void }) {
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

function formatTime(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return "--:--";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function ErrorPanel({
  message,
  onClose,
}: {
  message: string;
  onClose(): void;
}) {
  return (
    <div
      className="pointer-events-auto flex w-75 items-start gap-2 rounded-lg border border-error/40 bg-panel p-2 text-xs text-error shadow-lg"
      role="alert"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <button
        className="shrink-0 cursor-pointer rounded p-0.5 text-error hover:bg-button-hover"
        type="button"
        aria-label="Dismiss error"
        onClick={onClose}
      >
        <svg
          aria-hidden="true"
          className="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </svg>
      </button>
    </div>
  );
}
