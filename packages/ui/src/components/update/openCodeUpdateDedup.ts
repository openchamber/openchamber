/**
 * Pure decision helpers for the OpenCode update toast and PWA install toast.
 *
 * Extracted from `OpenCodeUpdateToast.tsx` and `usePwaInstallPrompt.ts` so the
 * dedup decisions can be unit-tested without a DOM, storage, or React. The
 * React surfaces remain the sole owners of side effects (storage writes,
 * `toast.info`, event listeners). This module only answers the question
 * "given these inputs, should we show the toast?".
 *
 * Exposed for unit testing. Not part of the stable consumer surface.
 */

export interface PwaInstallToastDecisionInput {
  /** Persistent localStorage entry: `'true'` when the user dismissed once. */
  readonly dismissed: string | null;
  /** Session-scoped sessionStorage flag set the first time the toast is shown in this tab. */
  readonly sessionShown: string | null;
  /** Whether the current React effect already holds a toast id. */
  readonly hasActiveToast: boolean;
}

/**
 * Returns `true` if the PWA install prompt toast should be shown for the
 * incoming `beforeinstallprompt` event.
 *
 * The decision composes three gates (any failure short-circuits):
 *  1. Persistent dismissal wins for all future visits.
 *  2. Per-tab dedup avoids re-showing inside the same browsing session.
 *  3. Re-entrancy guard prevents stacking when the effect already owns one.
 */
export const shouldShowPwaInstallToast = (input: PwaInstallToastDecisionInput): boolean => {
  if (input.dismissed === 'true') return false;
  if (input.sessionShown === 'true') return false;
  if (input.hasActiveToast) return false;
  return true;
};

export interface OpenCodeUpdateToastDecisionInput {
  /** Version string reported by the server (already trimmed by the caller). */
  readonly version: string;
  /** Most recent version the user explicitly dismissed, or `null` if none. */
  readonly dismissedVersion: string | null;
  /** Set of versions already surfaced in this tab session. */
  readonly seenVersions: ReadonlySet<string>;
}

/**
 * Returns `true` if the OpenCode update toast should be shown for `version`.
 *
 * Empty/whitespace-only versions short-circuit to `false`. A non-null
 * `dismissedVersion` matching the incoming version also short-circuits; a
 * different `dismissedVersion` means a newer release has appeared since the
 * last dismissal and the toast surfaces again.
 */
export const shouldShowOpenCodeUpdateToast = (
  input: OpenCodeUpdateToastDecisionInput,
): boolean => {
  if (!input.version) return false;
  if (input.seenVersions.has(input.version)) return false;
  if (input.dismissedVersion !== null && input.dismissedVersion === input.version) return false;
  return true;
};

/**
 * Coerces the `detail.version` carried by an `openchamber:opencode-update-available`
 * CustomEvent into a trimmed string, or returns `''` when the payload is
 * missing or shaped unexpectedly.
 *
 * Only `string` is accepted; numeric or boolean payloads are rejected because
 * downstream callers compare versions by literal equality.
 */
export const resolveOpenCodeUpdateVersion = (detail: unknown): string => {
  if (detail === null || typeof detail !== 'object') return '';
  const candidate = (detail as { version?: unknown }).version;
  if (typeof candidate !== 'string') return '';
  return candidate.trim();
};

export interface OpenCodeUpgradeStatusLike {
  readonly available?: boolean | null;
  readonly latestVersion?: string | null;
}

/**
 * Pulls the candidate version out of an `/api/opencode/upgrade-status` JSON
 * payload. Returns `''` when the payload is missing the field, has the wrong
 * type, or reports `available !== true`.
 */
export const resolveOpenCodeUpgradeStatusVersion = (
  status: OpenCodeUpgradeStatusLike | null | undefined,
): string => {
  if (!status) return '';
  if (status.available !== true) return '';
  if (typeof status.latestVersion !== 'string') return '';
  return status.latestVersion.trim();
};
