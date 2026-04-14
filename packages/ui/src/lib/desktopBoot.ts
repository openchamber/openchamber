/**
 * Authoritative desktop boot outcome types and UI-facing resolver.
 *
 * The Rust backend computes a `DesktopBootOutcome` at startup and injects
 * it as `window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__`. This module provides
 * pure functions to read that outcome and derive the minimal UI state
 * needed for the loading/chooser/recovery/main decision.
 */

// ── Boot outcome (must match Rust injection) ──

/**
 * Structured boot outcome type.
 *
 * Instead of 8 magic string kinds, we use a structured type that clearly
 * separates the target (local/remote/null) from the status (ok/not-configured/error).
 *
 * This makes it easier to add new states without updating multiple files and
 * allows UI to reason about outcomes with simple status checks.
 */
export type DesktopBootOutcome =
  // Main screens - CLI or remote connection is working
  | { target: 'local'; status: 'ok' }
  | { target: 'remote'; status: 'ok'; hostId: string; url: string }

  // First launch - user hasn't made a choice yet
  | { target: null; status: 'not-configured' }

  // Recovery screens - something is wrong
  | { target: 'local'; status: 'unreachable' }
  | { target: 'remote'; status: 'unreachable'; hostId: string; url: string }
  | { target: 'remote'; status: 'wrong-service'; hostId: string; url: string }
  | { target: 'remote'; status: 'missing'; hostId: string };

// ── UI-facing view ──

export type DesktopBootView =
  | { screen: 'main' }
  | { screen: 'main'; hostId: string; url: string }
  | { screen: 'chooser' }
  | { screen: 'recovery'; variant: 'local-unavailable' }
  | { screen: 'recovery'; variant: 'remote-unreachable'; hostId: string; url: string }
  | { screen: 'recovery'; variant: 'remote-wrong-service'; hostId: string; url: string }
  | { screen: 'recovery'; variant: 'remote-missing'; hostId: string };

// ── Resolver inputs ──

export type DesktopBootViewInput = {
  isDesktopShell: boolean;
  bootOutcome: DesktopBootOutcome | null;
};

// ── Public API ──

/** Valid target values */
const VALID_TARGETS = ['local', 'remote', null] as const;

/** Valid status values */
const VALID_STATUSES = ['ok', 'not-configured', 'unreachable', 'wrong-service', 'missing'] as const;

/** Return type for `validateBootOutcome`. */
type ValidationResult =
  | { valid: true; outcome: DesktopBootOutcome }
  | { valid: false };

/**
 * Runtime-validate a raw injected payload.
 * Returns a tagged result so callers can distinguish "not set yet" (null raw)
 * from "set but malformed" (valid: false).
 */
function validateBootOutcome(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { valid: false };
  }

  const record = raw as Record<string, unknown>;
  const target = record.target;
  const status = record.status;

  // Validate target
  if (target !== null && (typeof target !== 'string' || !VALID_TARGETS.includes(target as never))) {
    return { valid: false };
  }

  // Validate status
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as never)) {
    return { valid: false };
  }

  // Validate required fields per combination
  if (target === 'remote' || target === 'local') {
    if (status === 'ok' && target === 'local') {
      // { target: 'local'; status: 'ok' } is valid
      return { valid: true, outcome: { target: 'local', status: 'ok' } };
    }

    if (status === 'ok' && target === 'remote') {
      // { target: 'remote'; status: 'ok' } requires hostId and url
      if (typeof record.hostId !== 'string' || typeof record.url !== 'string') {
        return { valid: false };
      }
      return { valid: true, outcome: { target: 'remote', status: 'ok', hostId: record.hostId, url: record.url } };
    }

    if (status === 'unreachable') {
      if (target === 'local') {
        // { target: 'local'; status: 'unreachable' } is valid
        return { valid: true, outcome: { target: 'local', status: 'unreachable' } };
      } else {
        // { target: 'remote'; status: 'unreachable' } requires hostId and url
        if (typeof record.hostId !== 'string' || typeof record.url !== 'string') {
          return { valid: false };
        }
        return { valid: true, outcome: { target: 'remote', status: 'unreachable', hostId: record.hostId, url: record.url } };
      }
    }

    if (status === 'wrong-service') {
      if (target !== 'remote') return { valid: false };
      if (typeof record.hostId !== 'string' || typeof record.url !== 'string') {
        return { valid: false };
      }
      return { valid: true, outcome: { target: 'remote', status: 'wrong-service', hostId: record.hostId, url: record.url } };
    }

    if (status === 'missing') {
      if (target !== 'remote') return { valid: false };
      if (typeof record.hostId !== 'string') {
        return { valid: false };
      }
      return { valid: true, outcome: { target: 'remote', status: 'missing', hostId: record.hostId } };
    }
  }

  if (target === null) {
    if (status === 'not-configured') {
      // { target: null; status: 'not-configured' } is valid (first launch)
      return { valid: true, outcome: { target: null, status: 'not-configured' } };
    }

    if (status === 'missing') {
      // { target: null; status: 'missing' } would be redundant with not-configured
      return { valid: false };
    }
  }

  return { valid: false };
}

/**
 * Derive the minimal UI view from the injected boot outcome.
 *
 * Returns `null` when not in desktop shell, when the outcome is not yet
 * known, or when the injected payload is malformed.
 */
export function resolveDesktopBootView(
  input: DesktopBootViewInput,
): DesktopBootView | null {
  if (!input.isDesktopShell) {
    return null;
  }

  const outcome = input.bootOutcome;
  if (!outcome) {
    return null;
  }

  // Main screens - CLI or remote connection is working
  if (outcome.status === 'ok') {
    if (outcome.target === 'local') {
      return { screen: 'main' };
    } else if (outcome.target === 'remote') {
      return { screen: 'main', hostId: outcome.hostId, url: outcome.url };
    }
  }

  // First launch - user hasn't made a choice yet
  if (outcome.target === null && outcome.status === 'not-configured') {
    return { screen: 'chooser' };
  }

  // Recovery screens - something is wrong
  if (outcome.target === 'local' && outcome.status === 'unreachable') {
    return { screen: 'recovery', variant: 'local-unavailable' };
  }

  if (outcome.target === 'remote') {
    if (outcome.status === 'unreachable') {
      return { screen: 'recovery', variant: 'remote-unreachable', hostId: outcome.hostId, url: outcome.url };
    } else if (outcome.status === 'wrong-service') {
      return { screen: 'recovery', variant: 'remote-wrong-service', hostId: outcome.hostId, url: outcome.url };
    } else if (outcome.status === 'missing') {
      return { screen: 'recovery', variant: 'remote-missing', hostId: outcome.hostId };
    }
  }

  // Unknown outcome — defensive null.
  return null;
}

// ── Loading gate ──

export type BootInjectionStatus =
  | 'not-injected'
  | 'malformed'
  | 'valid';

export type InitialLoadingState = {
  isDesktopShell: boolean;
  isInitialized: boolean;
  bootOutcomeKnown: boolean;
  /**
   * Whether the resolved boot view is 'main'.
   * When false (chooser/recovery), splash dismisses on bootOutcomeKnown alone.
   * When true or absent, splash also requires isInitialized.
   */
  bootViewIsMain?: boolean;
};

export type DesktopBootFlowRestartInput = {
  isTauriShell: boolean;
  isDesktopLocalOriginActive: boolean;
};

/**
 * Whether the initial loading screen can be dismissed.
 *
 * Desktop shells must wait until a valid boot outcome is injected by Rust.
 * For non-main views (chooser, recovery), the splash can dismiss as soon as
 * the outcome is known — `isInitialized` is not required because OpenCode
 * may not be available in those flows.
 * For main views, both `isInitialized` and `bootOutcomeKnown` are required.
 * Non-desktop shells only need the app to be initialized.
 */
export function canDismissInitialLoading(state: InitialLoadingState): boolean {
  if (!state.isDesktopShell) {
    return state.isInitialized;
  }

  if (!state.bootOutcomeKnown) {
    return false;
  }

  // Non-main boot views (chooser, recovery) can dismiss without waiting for init.
  if (state.bootViewIsMain === false) {
    return true;
  }

  return state.isInitialized;
}

/**
 * Boot/recovery UI can render in the Tauri startup window before the local
 * desktop HTTP origin is active. In that state, same-origin reloads and
 * `/api/*` requests cannot recover the app, so callers must restart Tauri.
 */
export function shouldRestartDesktopBootFlow(input: DesktopBootFlowRestartInput): boolean {
  return input.isTauriShell && !input.isDesktopLocalOriginActive;
}

/**
 * Read the boot outcome injected by the Rust backend.
 * Returns `null` when not in desktop, when the outcome has not been set yet,
 * or when the injected payload is malformed.
 */
export function getInjectedBootOutcome(): DesktopBootOutcome | null {
  const status = getBootInjectionStatus();
  if (status !== 'valid') {
    return null;
  }

  const raw = (window as { __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__?: unknown })
    .__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__;

  const result = validateBootOutcome(raw);
  return result.valid ? result.outcome : null;
}

/**
 * Check the injection status of the desktop boot outcome.
 *
 * Distinguishes three states:
 * - `'not-injected'`: the global is absent or null (keep waiting)
 * - `'malformed'`: the global is present but failed validation (deterministic failure)
 * - `'valid'`: the global is present and passes validation
 */
export function getBootInjectionStatus(): BootInjectionStatus {
  if (typeof window === 'undefined') {
    return 'not-injected';
  }

  const raw = (window as { __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__?: unknown })
    .__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__;

  if (raw === undefined || raw === null) {
    return 'not-injected';
  }

  const result = validateBootOutcome(raw);
  return result.valid ? 'valid' : 'malformed';
}
