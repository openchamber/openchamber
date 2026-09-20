/**
 * Contracts a service fulfils when it stands in for a host role
 * (`contributes.service.provides`).
 *
 * Browser: the host's `openchamber_web` tool sends its `browser.*` actions to
 * the service instead of the in-app browser view. The service answers with the
 * same shapes the in-app view answers with, so the agent sees one tool whoever
 * drives the page. The host starts the service on the first action, needs no
 * panel, and stops it after `BROWSER_PROVIDER_IDLE_MS` without actions.
 */

/** Route on the service loopback the host posts every action to. */
export const BROWSER_PROVIDER_PATH = '/browser-control';

export const BROWSER_CONTROL_ACTIONS = [
  'browser.open',
  'browser.snapshot',
  'browser.click',
  'browser.type',
  'browser.scroll',
  'browser.back',
  'browser.forward',
  'browser.inspect',
  'browser.capture',
  'browser.resize',
] as const;
export type BrowserControlAction = (typeof BROWSER_CONTROL_ACTIONS)[number];

export const BROWSER_VIEWPORT_MODES = ['mobile', 'tablet', 'desktop', 'fill'] as const;
export type BrowserViewportMode = (typeof BROWSER_VIEWPORT_MODES)[number];

export const BROWSER_SCROLL_DIRECTIONS = ['up', 'down', 'top', 'bottom'] as const;
export type BrowserScrollDirection = (typeof BROWSER_SCROLL_DIRECTIONS)[number];

/** `browser.open` may wait for a slow page; every other action is quick. */
export const BROWSER_PROVIDER_OPEN_TIMEOUT_MS = 45_000;
export const BROWSER_PROVIDER_ACTION_TIMEOUT_MS = 20_000;
/** A screenshot is the largest answer; snapshots are capped by the provider itself. */
export const BROWSER_PROVIDER_RESPONSE_MAX = 12_000_000;
/** No action for this long stops the service; the next action starts it again. */
export const BROWSER_PROVIDER_IDLE_MS = 10 * 60_000;

export type BrowserOpenParameters = { url: string; viewport?: BrowserViewportMode };
export type BrowserSnapshotParameters = { selector?: string };
export type BrowserClickParameters = { selector?: string; text?: string };
export type BrowserTypeParameters = { selector: string; value: string; submit: boolean };
export type BrowserScrollParameters = { selector?: string; direction?: BrowserScrollDirection };
export type BrowserInspectParameters = { selector: string };
export type BrowserCaptureParameters = { label?: string };
export type BrowserResizeParameters = { viewport: BrowserViewportMode };

/**
 * Where an action came from: the project the agent works in and the chat it
 * runs in. Filled by the host from the tool call, never typed by the model.
 * A provider that keeps one browser per project or chat keys on these; one
 * that keeps a single browser ignores them. Either is `null` when the host
 * had none (a call from the CLI, for example): treat that as "unknown", not
 * as a scope of its own.
 */
export type BrowserProviderContext = { directory: string | null; sessionId: string | null };

type ProviderRequestEnvelope = { requestId: string; context: BrowserProviderContext };

/** One action, as the host posts it. Parameters were validated by the host. */
export type BrowserProviderRequest = ProviderRequestEnvelope & (
  | { action: 'browser.open'; parameters: BrowserOpenParameters }
  | { action: 'browser.snapshot'; parameters: BrowserSnapshotParameters }
  | { action: 'browser.click'; parameters: BrowserClickParameters }
  | { action: 'browser.type'; parameters: BrowserTypeParameters }
  | { action: 'browser.scroll'; parameters: BrowserScrollParameters }
  | { action: 'browser.back'; parameters: Record<never, never> }
  | { action: 'browser.forward'; parameters: Record<never, never> }
  | { action: 'browser.inspect'; parameters: BrowserInspectParameters }
  | { action: 'browser.capture'; parameters: BrowserCaptureParameters }
  | { action: 'browser.resize'; parameters: BrowserResizeParameters }
);

export type BrowserViewportSummary = {
  mode: BrowserViewportMode | 'custom';
  width: number | null;
  height: number | null;
};

export type BrowserElementBounds = { x: number; y: number; width: number; height: number };

/** One interactive element of a snapshot; absent fields mean empty or default. */
export type BrowserSnapshotElement = {
  selector: string;
  tag: string;
  bounds: BrowserElementBounds;
  inViewport?: true;
  type?: string;
  role?: string;
  label?: string;
  disabled?: true;
  missingAccessibleName?: true;
};

export type BrowserOpenData = {
  url: string;
  title: string;
  opened: true;
  /** `false` means the page is still loading, not that opening failed. */
  settled: boolean;
  viewport: BrowserViewportSummary;
};

export type BrowserSnapshotData = {
  url: string;
  title: string;
  scope: string;
  scrollY: number;
  maxScrollY: number;
  text: string;
  elements: BrowserSnapshotElement[];
  textTruncated?: true;
  textTotalChars?: number;
  elementsTruncated?: true;
  interactiveElementsOnPage?: number;
  viewport: BrowserViewportSummary;
  /** Warnings and errors the page logged since it was opened; absent when none. */
  consoleProblems?: BrowserConsoleProblem[];
};

export type BrowserConsoleProblem = {
  level: 'warning' | 'error';
  message: string;
  source: string;
};

export type BrowserClickData = { clicked: string; label: string; url: string };
export type BrowserTypeData = { selector: string; url: string };
export type BrowserScrollData = {
  scrollY: number;
  maxScrollY: number;
  atTop: boolean;
  atBottom: boolean;
  scrolledTo?: string;
  direction?: BrowserScrollDirection;
};
export type BrowserNavigationData = { url: string; title: string };
export type BrowserInspectData = {
  selector: string;
  tag: string;
  label: string;
  bounds: BrowserElementBounds;
  inViewport: boolean;
  styles: Record<string, string>;
};
/** The host writes the image to the project and hands the agent its path. */
export type BrowserCaptureData = {
  base64: string;
  mime: string;
  width: number;
  height: number;
  url: string;
  title: string;
  viewport: BrowserViewportSummary;
};
export type BrowserResizeData = { viewport: BrowserViewportSummary };

export type BrowserProviderData =
  | BrowserOpenData
  | BrowserSnapshotData
  | BrowserClickData
  | BrowserTypeData
  | BrowserScrollData
  | BrowserNavigationData
  | BrowserInspectData
  | BrowserCaptureData
  | BrowserResizeData;

/**
 * What the service answers. `error` is read by the agent, so it should say
 * what to do differently ("No element matches #save"), not what broke inside.
 */
export type BrowserProviderResult =
  | { ok: true; data: BrowserProviderData }
  | { ok: false; error: string };

const CONTROL_ACTIONS: ReadonlySet<string> = new Set(BROWSER_CONTROL_ACTIONS);

export const isBrowserControlAction = (value: string): value is BrowserControlAction => CONTROL_ACTIONS.has(value);

type WireContext = { directory?: unknown; sessionId?: unknown };
type WireRequest = { requestId?: unknown; action?: unknown; parameters?: unknown; context?: WireContext };

/** Hosts before the context field posted none; that reads as an unknown scope. */
const readContext = (wire: WireContext | undefined): BrowserProviderContext => {
  const directory = wire?.directory;
  const sessionId = wire?.sessionId;
  return {
    directory: String(directory) === directory && directory.length > 0 ? directory : null,
    sessionId: String(sessionId) === sessionId && sessionId.length > 0 ? sessionId : null,
  };
};

/**
 * A provider's read of the body the host posted to `BROWSER_PROVIDER_PATH`.
 * The host is trusted and validated the parameters against the action before
 * sending, so this checks the envelope and the action, not every field, and
 * the service bundle needs no schema library for it. `null` is a body that is
 * not a browser action; answer it with HTTP 400.
 */
export const readBrowserProviderRequest = (body: string): BrowserProviderRequest | null => {
  let wire: WireRequest;
  try {
    const parsed: WireRequest | null = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null) return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { requestId, action, parameters, context } = wire;
  if (String(requestId) !== requestId || requestId.length === 0) return null;
  if (String(action) !== action || !isBrowserControlAction(action)) return null;
  if (Object(parameters) !== parameters) return null;
  // SAFETY: requestId, action, and the parameters object were checked above,
  // and the host validated the parameters for this action before posting.
  return { requestId, action, parameters, context: readContext(context) } as BrowserProviderRequest;
};
