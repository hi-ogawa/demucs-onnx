import { z } from "zod";

const STORAGE_KEY = "demucs-onnx:main:v2";

const preferencesSchema = z.object({
  model: z.enum(["htdemucs", "htdemucs_ft"]),
  targetStem: z.enum(["drums", "bass", "other", "vocals"]).nullable(),
  method: z.enum(["add", "minus"]),
  shifts: z.number().int().min(1).max(4),
});

export type Preferences = z.infer<typeof preferencesSchema>;

const DEFAULT_PREFERENCES: Preferences = {
  model: "htdemucs",
  targetStem: null,
  method: "add",
  shifts: 1,
};

export function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return preferencesSchema.parse({ ...DEFAULT_PREFERENCES, ...stored });
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be disabled or unavailable without preventing separation.
  }
}
