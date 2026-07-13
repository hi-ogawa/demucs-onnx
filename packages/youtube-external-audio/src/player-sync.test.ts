import { describe, expect, it, vi } from "vitest";
import { PlayerSync } from "./player-sync.ts";

class FakeVideo extends EventTarget {
  currentTime = 0;
  muted = false;
  paused = true;
  playbackRate = 1;
}

class FakeAudio {
  currentTime = 0;
  playbackRate = 1;
  play = vi.fn(async () => {});
  pause = vi.fn();
}

describe("PlayerSync", () => {
  it("aligns and plays when enabled during playback", async () => {
    const video = new FakeVideo();
    const audio = new FakeAudio();
    video.currentTime = 42;
    video.playbackRate = 1.5;
    video.paused = false;

    const sync = new PlayerSync(video, audio);
    sync.enable();
    await Promise.resolve();

    expect(video.muted).toBe(true);
    expect(audio.currentTime).toBe(42);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("follows play, pause, seek, and rate events", async () => {
    const video = new FakeVideo();
    const audio = new FakeAudio();
    const sync = new PlayerSync(video, audio);
    sync.enable();

    video.currentTime = 10;
    video.playbackRate = 1.25;
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    await Promise.resolve();
    expect(audio.currentTime).toBe(10);
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.play).toHaveBeenCalledOnce();

    video.dispatchEvent(new Event("pause"));
    expect(audio.pause).toHaveBeenCalledOnce();

    video.currentTime = 75;
    video.dispatchEvent(new Event("seeking"));
    expect(audio.currentTime).toBe(75);

    video.currentTime = 76;
    video.dispatchEvent(new Event("seeked"));
    await Promise.resolve();
    expect(audio.currentTime).toBe(76);
    expect(audio.play).toHaveBeenCalledTimes(2);

    video.playbackRate = 2;
    video.dispatchEvent(new Event("ratechange"));
    expect(audio.playbackRate).toBe(2);
  });

  it("restores the original mute state and stops following after disable", () => {
    const video = new FakeVideo();
    const audio = new FakeAudio();
    video.muted = true;
    const sync = new PlayerSync(video, audio);
    sync.enable();
    sync.disable();

    expect(video.muted).toBe(true);
    expect(audio.pause).toHaveBeenCalledOnce();

    video.currentTime = 99;
    video.dispatchEvent(new Event("play"));
    expect(audio.currentTime).toBe(0);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("removes event listeners when destroyed", () => {
    const video = new FakeVideo();
    const audio = new FakeAudio();
    const sync = new PlayerSync(video, audio);
    sync.enable();
    sync.destroy();

    video.dispatchEvent(new Event("play"));
    expect(audio.play).not.toHaveBeenCalled();
  });
});
