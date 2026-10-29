import { validation } from "./errors.js";

export type DevelopmentMode = "simple" | "container";
export interface DevelopmentModeSelection {
  mode: DevelopmentMode;
  source: "argument" | "environment" | "configuration" | "interactive";
}

export function validateDevelopmentMode(value: unknown, field = "development-mode"): DevelopmentMode {
  if (value !== "simple" && value !== "container") {
    throw validation(field, "must be simple or container");
  }
  return value;
}

/** Resolve only the selected source: explicit input overrides even an invalid default. */
export function resolveDevelopmentMode(input: {
  argument?: string;
  environment?: string;
  configuration?: string;
}): DevelopmentModeSelection | undefined {
  for (const source of ["argument", "environment", "configuration"] as const) {
    if (input[source] !== undefined) return { mode: validateDevelopmentMode(input[source], source), source };
  }
  return undefined;
}

/** Resuming is not a new selection. Ambient defaults never change an existing run. */
export function resumeDevelopmentMode(recorded: DevelopmentMode, requested?: string): DevelopmentMode {
  validateDevelopmentMode(recorded, "recorded development mode");
  if (requested !== undefined && validateDevelopmentMode(requested) !== recorded) {
    throw validation("development-mode", "cannot change the mode of an existing DevRun; start a new DevRun");
  }
  return recorded;
}

export function validateModeSelection(value: unknown): asserts value is DevelopmentModeSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation("execution_mode", "must be an object");
  const record = value as Record<string, unknown>;
  validateDevelopmentMode(record.mode);
  if (Object.keys(record).sort().join(",") !== "mode,source" ||
      !["argument", "environment", "configuration", "interactive"].includes(record.source as string)) {
    throw validation("execution_mode", "requires mode and a recognized selection source");
  }
}
