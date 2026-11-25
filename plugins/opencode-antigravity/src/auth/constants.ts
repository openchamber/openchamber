// Auth constants shared by index.ts, the runtime's proxy and the auth modules (IA 10, 11, 13).

/**
 * The OpenCode credential's `access` and `refresh`. It proves only that OpenCode holds an Antigravity
 * credential; tokens stay in agy's files. The proxy checks `Authorization: Bearer agy-managed` (IA 13.3).
 */
export const MARKER_ACCESS = "agy-managed";

export const OAUTH_METHOD_ID = "oauth-personal";
export const OAUTH_METHOD_LABEL = "Sign in with Google";

/** Auth timeouts in milliseconds (IA 10.4, 11.3, 13.2). Tests pass smaller ones. */
export interface AuthTimeouts {
  /** `resolveBinary` wait during sign-in. */
  binaryWaitMs: number;
  /** agy printing the sign-in URL. */
  urlMs: number;
  /** Waiting for the user to paste the code; also `expiresAt`. */
  pasteMs: number;
  /** Code exchange after the paste. */
  exchangeMs: number;
  /** Probe after a successful login. */
  verifyProbeMs: number;
  /** Any other status probe. */
  probeMs: number;
  /** Whole logout after the lock. */
  logoutMs: number;
  /** Auth lock wait for logout. */
  logoutLockWaitMs: number;
  /** SIGTERM to SIGKILL. */
  killGraceMs: number;
  /** `credential.updated` debounce. */
  credentialDebounceMs: number;
  /** Setup probe when a credential exists and the runtime has not reported. */
  setupProbeDelayMs: number;
  /** `authEpoch()` re-reads the file at most this often. */
  epochRereadMs: number;
}

export const DEFAULT_AUTH_TIMEOUTS: AuthTimeouts = {
  binaryWaitMs: 120_000,
  urlMs: 60_000,
  pasteMs: 5 * 60_000,
  exchangeMs: 60_000,
  verifyProbeMs: 30_000,
  probeMs: 30_000,
  logoutMs: 90_000,
  logoutLockWaitMs: 10_000,
  killGraceMs: 3_000,
  credentialDebounceMs: 500,
  setupProbeDelayMs: 10_000,
  epochRereadMs: 1_000,
};

export const CODE_INSTRUCTIONS =
  "Sign in with Google in the browser tab that opened. Antigravity then shows an authorization code. Copy the code, or that page's full address, and paste it below.";

export const SHARED_READY = "Antigravity is already signed in on this machine. Connecting to it.";

/** Login errors users see (IA 10.2, 10.3). */
export const LOGIN_MESSAGES = {
  otherWindow: "Sign-in is already in progress in another OpenCode window.",
  urlTimeout: "Antigravity did not start sign-in within 60 seconds.",
  earlyExit: (code: number | null) => `Antigravity sign-in exited early (exit ${code ?? "unknown"}).`,
  badUrl: "Antigravity returned an unexpected sign-in link.",
  replaced: "This sign-in was replaced by a newer one.",
  expired: "This sign-in expired after 5 minutes. Start sign-in again.",
  badPaste:
    "That is not an Antigravity authorization code. Start sign-in again and paste the code, or the full address of the Antigravity page.",
  stopped: "Antigravity sign-in stopped. Start sign-in again.",
  exchangeTimeout: "Antigravity did not finish Google sign-in within 60 seconds. Start sign-in again.",
  invalidGrant: "Google rejected that code. It may be expired or already used. Start sign-in again.",
  notApproved: "Google sign-in was not approved. Start sign-in again.",
  subscription: "Google requires an eligible Antigravity subscription for this account.",
  generic: "Antigravity could not finish Google sign-in. Start sign-in again.",
  notConfirmed: "Signed in, but Antigravity could not confirm access. Try again.",
} as const;
