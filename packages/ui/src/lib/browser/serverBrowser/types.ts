/**
 * Wire shapes for the built-in server browser's HTTP service, reached through
 * the host's guest-service proxy (`@/lib/guests/service`).
 *
 * These mirror `/browser/state` and friends from the server-browser engine
 * (moved into core from the standalone extension; see
 * `.omo/plans/native-server-browser-contract.md`). Parsing is lenient on
 * purpose — extra fields are ignored rather than rejected — so a service that
 * is a little ahead or behind this file still renders instead of going blank.
 */

export type ServerBrowserController = 'none' | 'agent' | 'user';

/** A JavaScript dialog the page opened; the page is paused until it is answered. */
export type ServerBrowserDialog = {
  readonly id: number;
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  readonly message: string;
  readonly defaultPrompt?: string;
};

/** A file input the person clicked; the files go to `directory` on the server first. */
export type ServerBrowserFileChooser = {
  readonly id: number;
  readonly multiple: boolean;
  readonly accept: string;
  readonly directory: string;
};

export type ServerBrowserTab = {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly isLoading: boolean;
  readonly active: boolean;
  /** Older services do not report these. */
  readonly dialog?: ServerBrowserDialog | null;
  readonly fileChooser?: ServerBrowserFileChooser | null;
  /** The page's icon as a data URL, once the service fetched it for its origin. */
  readonly favicon?: string | null;
};

/** A file a page downloaded, kept on the server; `path` is set once it is complete. */
export type ServerBrowserDownload = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly state: 'downloading' | 'complete' | 'canceled' | 'failed';
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly path: string | null;
};

export type ServerBrowserViewportState = {
  readonly mode: 'auto' | 'fixed';
  readonly source?: string;
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
};

export type ServerBrowserProfile = {
  readonly id: string;
  readonly name: string;
  readonly copyVersion: number | null;
  readonly users: number;
};

export type ServerBrowserHelpKind = 'login' | 'page' | 'profile';

export type ServerBrowserHelp = {
  readonly scopeId: string;
  readonly kind?: ServerBrowserHelpKind;
  readonly reason: string;
  readonly tabId: string | null;
  readonly since: number;
  /** A `profile` request: the saved profile the agent asks to keep this chat's logins in. */
  readonly profile?: { readonly name: string; readonly exists: boolean };
};

export type ServerBrowserChromeStatus = {
  readonly status: 'ready' | 'installing' | 'missing-libraries' | 'failed' | 'system';
  readonly message: string;
  readonly path?: string | null;
  readonly version?: string | null;
};

export type ServerBrowserScope = {
  readonly id: string;
  readonly directory: string;
  readonly sessionId: string | null;
  readonly profile: ServerBrowserProfile | null;
  readonly signIn: boolean;
  readonly selected: boolean;
  readonly url: string;
  readonly title: string;
  readonly isLoading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly tabs: readonly ServerBrowserTab[];
  /** The tab the agent last opened or worked in, null before it used one; older services do not report it. */
  readonly agentTabId?: string | null;
  /** An agent action runs in this browser now. */
  readonly agentActive?: boolean;
  readonly viewport: ServerBrowserViewportState | null;
  readonly problems: { readonly errors: number; readonly warnings: number };
  /** Chrome zoom level, -5..+5 in the service's steps (factor 1.2^level). */
  readonly zoomLevel: number;
  /** Older services do not report it. */
  readonly colorScheme?: 'system' | 'light' | 'dark';
  /** Newest first; older services do not report it. */
  readonly downloads?: readonly ServerBrowserDownload[];
  /** The page in front gives no sound (an insecure page cannot be captured). */
  readonly audioUnavailable?: boolean;
};

export type ServerBrowserState = {
  /** Changes whenever anything else in the state does; used to wait for the next change. */
  readonly version?: string;
  readonly controller: ServerBrowserController;
  readonly viewerInControl: boolean;
  readonly selectedScopeId: string | null;
  /** The chat the agent holds the picture for; older services do not report it. */
  readonly agentScopeId?: string | null;
  readonly generation: number;
  readonly help: ServerBrowserHelp | null;
  readonly chrome: ServerBrowserChromeStatus;
  readonly scopes: readonly ServerBrowserScope[];
};

export type ServerBrowserConsoleRow = {
  readonly id: string;
  readonly level: string;
  readonly text: string;
  readonly source?: string;
  readonly timestamp?: number;
};

export type ServerBrowserNetworkRow = {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status: number | null;
  readonly statusText: string;
  readonly mimeType: string;
  readonly durationMs: number | null;
  readonly encodedBytes: number | null;
  readonly state: 'pending' | 'complete' | 'failed';
  readonly failureText: string | null;
  readonly fromCache: boolean;
};

export type ServerBrowserInspectorBatch = {
  readonly cursor: number;
  readonly more: boolean;
  readonly console: readonly ServerBrowserConsoleRow[];
  readonly network: readonly ServerBrowserNetworkRow[];
  readonly droppedConsole: number;
  readonly droppedNetwork: number;
};

export type ServerBrowserRequestDetail = {
  readonly row: ServerBrowserNetworkRow;
  readonly requestHeaders: readonly { name: string; value: string }[];
  readonly responseHeaders: readonly { name: string; value: string }[];
  readonly requestBody?: string | null;
  readonly responseBody?: string | null;
  readonly truncated?: boolean;
};

export const findSelectedScope = (state: ServerBrowserState | null): ServerBrowserScope | null => {
  if (!state) return null;
  return state.scopes.find((scope) => scope.id === state.selectedScopeId) ?? null;
};
