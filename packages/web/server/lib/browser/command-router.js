/**
 * Browser-control policy core.
 *
 * This module is PURE (no I/O, no transport, no Electron) so the safety and
 * capability rules can be unit-tested in isolation and enforced regardless of
 * output mode. The runtime (runtime.js) calls into here to decide, for every
 * incoming model tool call, (a) whether the op is supported on the current
 * browser surface and (b) whether consent policy allows it — BEFORE any backend
 * (desktop CDP or web iframe) is touched.
 *
 * Policy is enforced HERE, never only in the UI.
 */

export const BROWSER_ERROR_CODES = Object.freeze({
  NO_BROWSER_PANE: 'NO_BROWSER_PANE',
  CONTROLLER_GONE: 'CONTROLLER_GONE',
  BROWSER_TIMEOUT: 'BROWSER_TIMEOUT',
  UNSUPPORTED_ON_SURFACE: 'UNSUPPORTED_ON_SURFACE',
  CROSS_ORIGIN_BLOCKED: 'CROSS_ORIGIN_BLOCKED',
  SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND',
  STALE_REF: 'STALE_REF',
  CONSENT_DENIED: 'CONSENT_DENIED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  DEBUGGER_BUSY: 'DEBUGGER_BUSY',
  BAD_ARGS: 'BAD_ARGS',
  EXEC_ERROR: 'EXEC_ERROR',
  UNKNOWN_OP: 'UNKNOWN_OP',
});

export const OP_TIER = Object.freeze({
  READ: 'read',
  INTERACT: 'interact',
  ADVANCED: 'advanced',
});

export const BROWSER_BACKEND = Object.freeze({
  DESKTOP_CDP: 'desktop-cdp',
  WEB_IFRAME: 'web-iframe',
});

export const ORIGIN_CLASS = Object.freeze({
  LOCALHOST: 'localhost',
  EXTERNAL: 'external',
  BLANK: 'blank',
});

const TOOL_PREFIX = 'browser_';

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Validators return null on success or a human-readable reason string on failure. */
const requireTarget = (args) => {
  if (isNonEmptyString(args?.ref) || isNonEmptyString(args?.selector)) return null;
  if (Array.isArray(args?.coords) && args.coords.length === 2 && args.coords.every(isFiniteNumber)) {
    return null;
  }
  return 'requires one of: ref, selector, or coords [x, y]';
};

const requireRefOrSelector = (args) => {
  if (isNonEmptyString(args?.ref) || isNonEmptyString(args?.selector)) return null;
  return 'requires a ref or selector';
};

/**
 * Op catalog. Each entry:
 *  - tier: base consent tier (may be promoted by dynamicTier for set-operations)
 *  - support: which (backend, originClass) combinations can execute it
 *      desktop      → desktop CDP (any origin)
 *      webLocalhost → web iframe over same-origin proxied content
 *      webExternal  → web iframe over a sandboxed cross-origin site
 *  - validate(args): arg shape gate
 *  - domOp: true when the op needs same-origin DOM access (drives the
 *      CROSS_ORIGIN_BLOCKED vs UNSUPPORTED_ON_SURFACE distinction on web)
 */
export const OP_SPECS = Object.freeze({
  // ---- Navigation ----
  navigate: { tier: OP_TIER.INTERACT, support: { desktop: true, webLocalhost: true, webExternal: true }, validate: (a) => (isNonEmptyString(a?.url) ? null : 'url is required') },
  back: { tier: OP_TIER.INTERACT, support: { desktop: true, webLocalhost: true, webExternal: true } },
  forward: { tier: OP_TIER.INTERACT, support: { desktop: true, webLocalhost: true, webExternal: true } },
  reload: { tier: OP_TIER.INTERACT, support: { desktop: true, webLocalhost: true, webExternal: true } },
  wait_for: {
    tier: OP_TIER.READ,
    support: { desktop: true, webLocalhost: true, webExternal: true },
    validate: (a) => {
      const kind = a?.kind;
      if (!['load', 'selector', 'function', 'navigation', 'timeout'].includes(kind)) {
        return "kind must be one of: load, selector, function, navigation, timeout";
      }
      if ((kind === 'selector' || kind === 'function') && !isNonEmptyString(a?.value)) {
        return `kind '${kind}' requires a value`;
      }
      return null;
    },
  },

  // ---- Interaction (same-origin DOM) ----
  click: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: requireTarget },
  double_click: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: requireTarget },
  right_click: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: requireTarget },
  hover: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: requireTarget },
  fill: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => requireRefOrSelector(a) || (typeof a?.text === 'string' ? null : 'text is required') },
  type: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => (typeof a?.text === 'string' ? null : 'text is required') },
  press_key: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => (isNonEmptyString(a?.key) ? null : 'key is required') },
  scroll: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false } },
  select_option: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => requireRefOrSelector(a) || (a?.values !== undefined ? null : 'values is required') },
  drag: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => (a?.from && a?.to ? null : 'from and to are required') },
  file_upload: { tier: OP_TIER.ADVANCED, support: { desktop: true, webLocalhost: false, webExternal: false }, validate: (a) => requireRefOrSelector(a) || (Array.isArray(a?.paths) && a.paths.length > 0 ? null : 'paths[] is required') },

  // ---- Reading (same-origin DOM) ----
  snapshot: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false } },
  get_text: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false } },
  query: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => (isNonEmptyString(a?.selector) ? null : 'selector is required') },
  get_attributes: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: requireRefOrSelector },
  get_computed_style: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: requireRefOrSelector },
  get_url_title: { tier: OP_TIER.READ, support: { desktop: true, webLocalhost: true, webExternal: true } },

  // ---- Visual ----
  screenshot: { tier: OP_TIER.READ, support: { desktop: true, webLocalhost: true, webExternal: true } },
  highlight: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: requireRefOrSelector },

  // ---- Diagnostics ----
  console_messages: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false } },
  network_requests: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false } },
  page_errors: { tier: OP_TIER.READ, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false } },

  // ---- Scripting (advanced) ----
  evaluate: { tier: OP_TIER.ADVANCED, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => (isNonEmptyString(a?.js) ? null : 'js is required') },

  // ---- Environment ----
  set_viewport: { tier: OP_TIER.INTERACT, support: { desktop: true, webLocalhost: true, webExternal: true }, validate: (a) => (isFiniteNumber(a?.width) && isFiniteNumber(a?.height) ? null : 'width and height are required') },
  emulate_device: { tier: OP_TIER.INTERACT, support: { desktop: true, webLocalhost: true, webExternal: true }, validate: (a) => (isNonEmptyString(a?.device) ? null : 'device is required') },
  cookies: { tier: OP_TIER.READ, setTier: OP_TIER.ADVANCED, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => (['get', 'set'].includes(a?.mode) ? null : "mode must be 'get' or 'set'") },
  storage: {
    tier: OP_TIER.READ,
    setTier: OP_TIER.ADVANCED,
    domOp: true,
    support: { desktop: true, webLocalhost: true, webExternal: false },
    validate: (a) => {
      if (!['get', 'set'].includes(a?.mode)) return "mode must be 'get' or 'set'";
      if (!['local', 'session'].includes(a?.area)) return "area must be 'local' or 'session'";
      return null;
    },
  },
  handle_dialog: { tier: OP_TIER.INTERACT, domOp: true, support: { desktop: true, webLocalhost: true, webExternal: false }, validate: (a) => (['accept', 'dismiss'].includes(a?.action) ? null : "action must be 'accept' or 'dismiss'") },

  // ---- Lifecycle (handled by the runtime, not a backend) ----
  open: { tier: OP_TIER.INTERACT, lifecycle: true, support: { desktop: true, webLocalhost: true, webExternal: true } },
  close: { tier: OP_TIER.INTERACT, lifecycle: true, support: { desktop: true, webLocalhost: true, webExternal: true } },
  status: { tier: OP_TIER.READ, lifecycle: true, support: { desktop: true, webLocalhost: true, webExternal: true } },
  list_panes: { tier: OP_TIER.READ, lifecycle: true, support: { desktop: true, webLocalhost: true, webExternal: true } },
});

export const opFromToolName = (toolName) =>
  typeof toolName === 'string' && toolName.startsWith(TOOL_PREFIX)
    ? toolName.slice(TOOL_PREFIX.length)
    : null;

export const toolNameFromOp = (op) => `${TOOL_PREFIX}${op}`;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Classify a URL's origin for capability + consent decisions. Loopback and
 * *.localhost are treated as local dev targets; about:blank/empty as 'blank'.
 */
export const classifyOrigin = (url) => {
  if (!isNonEmptyString(url) || url === 'about:blank') return ORIGIN_CLASS.BLANK;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return ORIGIN_CLASS.BLANK;
  }
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    return ORIGIN_CLASS.LOCALHOST;
  }
  return ORIGIN_CLASS.EXTERNAL;
};

/** Some ops change tier based on their args (e.g. cookies/storage get vs set). */
export const dynamicTier = (op, args) => {
  const spec = OP_SPECS[op];
  if (!spec) return null;
  if (spec.setTier && args?.mode === 'set') return spec.setTier;
  return spec.tier;
};

/**
 * Decide whether (op) is executable on the controller's (backend, originClass).
 * Returns { supported: true } or { supported: false, code, message }.
 */
export const resolveCapability = ({ op, backend, originClass }) => {
  const spec = OP_SPECS[op];
  if (!spec) {
    return { supported: false, code: BROWSER_ERROR_CODES.UNKNOWN_OP, message: `Unknown browser op: ${op}` };
  }

  if (backend === BROWSER_BACKEND.DESKTOP_CDP) {
    return spec.support.desktop
      ? { supported: true }
      : { supported: false, code: BROWSER_ERROR_CODES.UNSUPPORTED_ON_SURFACE, message: `${op} is not supported on the desktop browser` };
  }

  // web iframe
  if (originClass === ORIGIN_CLASS.EXTERNAL) {
    if (spec.support.webExternal) return { supported: true };
    // DOM ops fail specifically because of the cross-origin sandbox.
    if (spec.domOp) {
      return {
        supported: false,
        code: BROWSER_ERROR_CODES.CROSS_ORIGIN_BLOCKED,
        message: `${op} requires same-origin access; the page is cross-origin in a sandboxed iframe. Navigate to a localhost dev server (proxied) or use the desktop app for full automation.`,
      };
    }
    return { supported: false, code: BROWSER_ERROR_CODES.UNSUPPORTED_ON_SURFACE, message: `${op} is not supported on an external web page` };
  }

  // localhost / blank (proxied, same-origin)
  return spec.support.webLocalhost
    ? { supported: true }
    : { supported: false, code: BROWSER_ERROR_CODES.UNSUPPORTED_ON_SURFACE, message: `${op} is not supported on the web runtime` };
};

const allow = () => ({ decision: 'allow' });
const deny = (reason) => ({ decision: 'deny', reason });

/**
 * Consent gate. policy = { enabled, advancedEnabled, allowExternal }.
 *  - enabled=false            → everything denied (feature off / not opted in)
 *  - advanced tier            → denied unless advancedEnabled
 *  - external target          → allowed unless allowExternal is explicitly false
 *                               (reads stay allowed; capability layer still limits
 *                                what a cross-origin web iframe can actually do)
 */
export const evaluateConsent = ({ op, args, originClass, policy }) => {
  if (!policy || policy.enabled !== true) {
    return deny('Browser automation is disabled. Enable "Let agents drive the browser" in Settings.');
  }

  const tier = dynamicTier(op, args);
  if (tier === OP_TIER.ADVANCED && policy.advancedEnabled !== true) {
    return deny(`"${op}" is an advanced/destructive tool. Enable advanced browser tools in Settings to use it.`);
  }

  if (policy.allowExternal === false) {
    // Gate the navigation TARGET, not just the current page. Otherwise an agent
    // on localhost could simply navigate/redirect to an external site and escape
    // the localhost-only restriction entirely (the old gate only bit the *next*
    // op, never the escape hatch itself).
    if (op === 'navigate' && classifyOrigin(args?.url) === ORIGIN_CLASS.EXTERNAL) {
      return deny('Navigating to a non-localhost site is blocked. Enable "Allow agents on any website" in Settings.');
    }
    if (originClass === ORIGIN_CLASS.EXTERNAL) {
      if (tier === OP_TIER.READ) return allow();
      return deny('This page is not localhost. Enable "Allow agents on any website" in Settings to let agents act on external sites.');
    }
  }

  return allow();
};

/**
 * True when policy restricts automation to localhost and the given URL is a
 * non-localhost target. Used to gate navigation *targets* for the lifecycle
 * `open` op, which bypasses evaluateConsent (evaluateConsent enforces the same
 * for the `navigate` op).
 */
export const isExternalNavigationBlocked = (url, policy) =>
  Boolean(policy) && policy.allowExternal === false && classifyOrigin(url) === ORIGIN_CLASS.EXTERNAL;

/**
 * Full gate for a single MCP tool call. Returns either a typed failure
 * { ok:false, code, message } or { ok:true, op, args, tier } cleared for backend
 * dispatch. `controller` supplies { backend, originClass }. `policy` is the
 * resolved consent policy. Lifecycle ops (open/close/status/list_panes) bypass
 * the capability/consent gates here and are handled directly by the runtime.
 */
export const routeToolCall = ({ toolName, args = {}, controller, policy }) => {
  const op = opFromToolName(toolName);
  if (!op || !OP_SPECS[op]) {
    return { ok: false, code: BROWSER_ERROR_CODES.UNKNOWN_OP, message: `Unknown browser tool: ${toolName}` };
  }

  const spec = OP_SPECS[op];

  const validationError = typeof spec.validate === 'function' ? spec.validate(args) : null;
  if (validationError) {
    return { ok: false, code: BROWSER_ERROR_CODES.BAD_ARGS, message: `${toolName}: ${validationError}` };
  }

  if (spec.lifecycle) {
    // Consent for lifecycle is just the master enable gate.
    if (!policy || policy.enabled !== true) {
      return { ok: false, code: BROWSER_ERROR_CODES.CONSENT_DENIED, message: 'Browser automation is disabled.' };
    }
    return { ok: true, op, args, tier: spec.tier, lifecycle: true };
  }

  if (!controller) {
    return { ok: false, code: BROWSER_ERROR_CODES.NO_BROWSER_PANE, message: 'No browser pane is connected.' };
  }

  const capability = resolveCapability({ op, backend: controller.backend, originClass: controller.originClass });
  if (!capability.supported) {
    return { ok: false, code: capability.code, message: capability.message, capability: false };
  }

  const consent = evaluateConsent({ op, args, originClass: controller.originClass, policy });
  if (consent.decision === 'deny') {
    return { ok: false, code: BROWSER_ERROR_CODES.CONSENT_DENIED, message: consent.reason };
  }

  return { ok: true, op, args, tier: dynamicTier(op, args) };
};
