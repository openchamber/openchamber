// Runtime options and env overrides (SR 10, architecture 4). A set option wins over its env var, which
// wins over the default. Never throws: a bad value keeps the default and becomes an issue that index.ts
// logs once, next to the install/auth issues.

import { DEFAULT_TIMINGS, type RuntimeTimings } from "./constants.ts";
import { parseEnvBoolean } from "./install/config.ts";

export interface RuntimeConfig {
  idleShutdownMs: number;
  sessionIdleCloseMs: number;
  parkedToolTtlMs: number;
  cancelSettleMs: number;
  stallTimeoutMs: number;
  retryStallTimeoutMs: number;
  statusNoteAfterMs: number;
  statusNotes: boolean;
  breakerCooldownMs: number;
  processPerSession: boolean;
  sessionStore: boolean;
  resumeAfterRestart: boolean;
  sessionTtlDays: number;
  maxStoredSessions: number;
  steering: boolean;
  maxSystemPromptBytes: number;
  maxToolsPromptBytes: number;
  replayMaxChars: number;
  toolGuardHook: boolean;
  debug: boolean;
  debugContent: boolean;
  /** IA 3 and 15.3 item 9: lives here. 0 picks a random loopback port. */
  proxyPort: number;
  /** Fixed internal limits; only tests change them (third argument of `resolveRuntimeConfig`). */
  timings: RuntimeTimings;
}

export interface ResolvedRuntimeConfig {
  config: RuntimeConfig;
  issues: string[];
}

type NumberKey =
  | "idleShutdownMs"
  | "sessionIdleCloseMs"
  | "parkedToolTtlMs"
  | "cancelSettleMs"
  | "stallTimeoutMs"
  | "retryStallTimeoutMs"
  | "statusNoteAfterMs"
  | "breakerCooldownMs"
  | "sessionTtlDays"
  | "maxStoredSessions"
  | "maxSystemPromptBytes"
  | "maxToolsPromptBytes"
  | "replayMaxChars"
  | "proxyPort";

type BooleanKey =
  | "statusNotes"
  | "processPerSession"
  | "sessionStore"
  | "resumeAfterRestart"
  | "steering"
  | "toolGuardHook"
  | "debug"
  | "debugContent";

interface NumberSpec {
  fallback: number;
  env?: string;
  /** Smallest accepted value; 0 when absent. */
  min?: number;
  max?: number;
}

const NUMBERS: Readonly<Record<NumberKey, NumberSpec>> = {
  idleShutdownMs: { fallback: 600_000, env: "OPENCODE_ANTIGRAVITY_IDLE_MS" },
  sessionIdleCloseMs: { fallback: 1_800_000 },
  parkedToolTtlMs: { fallback: 1_800_000, min: 1 },
  cancelSettleMs: { fallback: 15_000, min: 1 },
  stallTimeoutMs: { fallback: 180_000, env: "OPENCODE_ANTIGRAVITY_STALL_MS", min: 1 },
  retryStallTimeoutMs: { fallback: 300_000, min: 1 },
  statusNoteAfterMs: { fallback: 20_000, min: 1 },
  breakerCooldownMs: { fallback: 30_000 },
  sessionTtlDays: { fallback: 14, min: 1 },
  maxStoredSessions: { fallback: 500, min: 1 },
  maxSystemPromptBytes: { fallback: 32_768, min: 1024 },
  maxToolsPromptBytes: { fallback: 49_152, min: 1024 },
  replayMaxChars: { fallback: 600_000, min: 1000 },
  proxyPort: { fallback: 0, env: "OPENCODE_ANTIGRAVITY_PROXY_PORT", max: 65_535 },
};

const BOOLEANS: Readonly<Record<BooleanKey, boolean>> = {
  statusNotes: true,
  processPerSession: false,
  sessionStore: true,
  resumeAfterRestart: true,
  steering: true,
  toolGuardHook: true,
  debug: false,
  debugContent: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validNumber(value: number, spec: NumberSpec): boolean {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return false;
  if (value < (spec.min ?? 0)) return false;
  return spec.max === undefined || value <= spec.max;
}

function rangeText(spec: NumberSpec): string {
  const min = spec.min ?? 0;
  return spec.max === undefined ? `an integer >= ${min}` : `an integer from ${min} to ${spec.max}`;
}

export function resolveRuntimeConfig(
  options: unknown,
  env: NodeJS.ProcessEnv,
  timings: Partial<RuntimeTimings> = {},
): ResolvedRuntimeConfig {
  const opts = isRecord(options) ? options : {};
  const issues: string[] = [];

  const num = (key: NumberKey): number => {
    const spec = NUMBERS[key];
    let value = spec.fallback;
    const fromEnv = spec.env ? env[spec.env] : undefined;
    if (fromEnv !== undefined && fromEnv.trim() !== "") {
      const parsed = Number(fromEnv.trim());
      if (validNumber(parsed, spec)) value = parsed;
      else issues.push(`${spec.env} must be ${rangeText(spec)}; using ${spec.fallback}.`);
    }
    const fromOption = opts[key];
    if (fromOption !== undefined) {
      if (typeof fromOption === "number" && validNumber(fromOption, spec)) value = fromOption;
      else issues.push(`Antigravity option ${key} must be ${rangeText(spec)}; using ${value}.`);
    }
    return value;
  };
  const bool = (key: BooleanKey): boolean => {
    const fromOption = opts[key];
    if (fromOption === undefined) return BOOLEANS[key];
    if (typeof fromOption === "boolean") return fromOption;
    const parsed = typeof fromOption === "string" ? parseEnvBoolean(fromOption) : null;
    if (parsed !== null) return parsed;
    issues.push(`Antigravity option ${key} must be true or false; using ${BOOLEANS[key]}.`);
    return BOOLEANS[key];
  };

  const config: RuntimeConfig = {
    idleShutdownMs: num("idleShutdownMs"),
    sessionIdleCloseMs: num("sessionIdleCloseMs"),
    parkedToolTtlMs: num("parkedToolTtlMs"),
    cancelSettleMs: num("cancelSettleMs"),
    stallTimeoutMs: num("stallTimeoutMs"),
    retryStallTimeoutMs: num("retryStallTimeoutMs"),
    statusNoteAfterMs: num("statusNoteAfterMs"),
    statusNotes: bool("statusNotes"),
    breakerCooldownMs: num("breakerCooldownMs"),
    processPerSession: bool("processPerSession"),
    sessionStore: bool("sessionStore"),
    resumeAfterRestart: bool("resumeAfterRestart"),
    sessionTtlDays: num("sessionTtlDays"),
    maxStoredSessions: num("maxStoredSessions"),
    steering: bool("steering"),
    maxSystemPromptBytes: num("maxSystemPromptBytes"),
    maxToolsPromptBytes: num("maxToolsPromptBytes"),
    replayMaxChars: num("replayMaxChars"),
    toolGuardHook: bool("toolGuardHook"),
    debug: bool("debug"),
    debugContent: bool("debugContent"),
    proxyPort: num("proxyPort"),
    timings: { ...DEFAULT_TIMINGS, ...timings },
  };

  if (config.retryStallTimeoutMs < config.stallTimeoutMs) {
    issues.push("Antigravity option retryStallTimeoutMs is shorter than stallTimeoutMs; using stallTimeoutMs for both.");
    config.retryStallTimeoutMs = config.stallTimeoutMs;
  }
  // debugContent implies debug: content logs without the metadata around them would be unreadable.
  if (config.debugContent) config.debug = true;
  return { config, issues };
}
