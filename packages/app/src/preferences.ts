import { z } from "zod";

const STORAGE_KEY = "demucs-onnx:main:v1";

const preferencesSchema = z.preprocess(
  (value) => (typeof value === "object" && value !== null ? value : {}),
  z.object({
    model: z.enum(["htdemucs", "htdemucs_ft"]).catch("htdemucs"),
    outputMode: z.enum(["four-stems", "two-stems"]).catch("four-stems"),
    targetStem: z.enum(["drums", "bass", "other", "vocals"]).catch("vocals"),
    method: z.enum(["add", "minus"]).catch("add"),
    shifts: z.number().int().min(1).max(4).catch(1),
  }),
);

export type Preferences = z.output<typeof preferencesSchema>;

export function loadPreferences(): Preferences {
  try {
    return preferencesSchema.parse(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return preferencesSchema.parse({});
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be disabled or unavailable without preventing separation.
  }
}
