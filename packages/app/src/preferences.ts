const STORAGE_KEY = "demucs-onnx:main:v1";

const MODELS = ["htdemucs", "htdemucs_ft"] as const;
const OUTPUT_MODES = ["four-stems", "two-stems"] as const;
const STEMS = ["drums", "bass", "other", "vocals"] as const;
const METHODS = ["add", "minus"] as const;

export type Preferences = {
  model: (typeof MODELS)[number];
  outputMode: (typeof OUTPUT_MODES)[number];
  targetStem: (typeof STEMS)[number];
  method: (typeof METHODS)[number];
  shifts: number;
};

const DEFAULT_PREFERENCES: Preferences = {
  model: "htdemucs",
  outputMode: "four-stems",
  targetStem: "vocals",
  method: "add",
  shifts: 1,
};

function includes<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function loadPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    if (typeof value !== "object" || value === null) {
      return DEFAULT_PREFERENCES;
    }
    const stored = value as Record<string, unknown>;
    return {
      model: includes(MODELS, stored.model)
        ? stored.model
        : DEFAULT_PREFERENCES.model,
      outputMode: includes(OUTPUT_MODES, stored.outputMode)
        ? stored.outputMode
        : DEFAULT_PREFERENCES.outputMode,
      targetStem: includes(STEMS, stored.targetStem)
        ? stored.targetStem
        : DEFAULT_PREFERENCES.targetStem,
      method: includes(METHODS, stored.method)
        ? stored.method
        : DEFAULT_PREFERENCES.method,
      shifts:
        Number.isInteger(stored.shifts) &&
        (stored.shifts as number) >= 1 &&
        (stored.shifts as number) <= 4
          ? (stored.shifts as number)
          : DEFAULT_PREFERENCES.shifts,
    };
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
