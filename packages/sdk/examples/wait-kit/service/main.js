// packages/sdk/examples/wait-kit/service/main.ts
import http from "node:http";
// packages/sdk/src/scrollbar-style.ts
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// packages/sdk/src/manifest.ts
var GUEST_PROVIDER_LOGO_BYTES_MAX = 1024 * 1024;
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// packages/sdk/src/session-events.ts
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// packages/sdk/src/service-host.ts
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
// packages/sdk/src/waits.ts
var WAITS_START_PATH = "/waits/start";
var WAITS_CHECK_PATH = "/waits/check";
var WAITS_WIRE_VERSION = 1;
var WAIT_LABEL_MAX = 80;
var parseBody = (body) => {
  try {
    const parsed = JSON.parse(body);
    return Object(parsed) === parsed && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
var argsOf = (wire) => {
  if (Object(wire) !== wire || wire === undefined || Array.isArray(wire))
    return null;
  const args = {};
  for (const [name, entry] of Object.entries(wire)) {
    if (String(entry) !== entry && !Number.isFinite(entry) && entry !== true && entry !== false)
      return null;
    args[name] = entry;
  }
  return args;
};
var readWaitStartRequest = (body) => {
  const wire = parseBody(body);
  if (!wire || wire.v !== WAITS_WIRE_VERSION)
    return null;
  const { requestId, wait } = wire;
  if (String(requestId) !== requestId || requestId.length === 0)
    return null;
  if (Object(wait) !== wait || wait === undefined)
    return null;
  const { id, type, session } = wait;
  if (String(id) !== id || id.length === 0 || String(type) !== type || type.length === 0)
    return null;
  const args = argsOf(wait.args);
  if (!args)
    return null;
  if (Object(session) !== session || session === undefined)
    return null;
  const sessionId = session.id;
  if (String(sessionId) !== sessionId || sessionId.length === 0)
    return null;
  const directory = session.directory;
  if (directory !== null && (String(directory) !== directory || directory.length === 0))
    return null;
  return { v: WAITS_WIRE_VERSION, requestId, wait: { id, type, args, session: { id: sessionId, directory } } };
};
var readWaitCheckRequest = (body) => {
  const wire = parseBody(body);
  if (!wire || wire.v !== WAITS_WIRE_VERSION)
    return null;
  const { requestId } = wire;
  if (String(requestId) !== requestId || requestId.length === 0 || !Array.isArray(wire.waits))
    return null;
  const waits = [];
  for (const entry of wire.waits) {
    if (Object(entry) !== entry || entry.state === undefined)
      return null;
    const { id, type, state } = entry;
    if (String(id) !== id || id.length === 0 || String(type) !== type || type.length === 0)
      return null;
    const args = argsOf(entry.args);
    if (!args)
      return null;
    waits.push({ id, type, args, state });
  }
  return { v: WAITS_WIRE_VERSION, requestId, waits };
};
// packages/sdk/src/file-editor.ts
var patternExpressions = new Map;
// packages/sdk/src/contract.ts
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// packages/sdk/src/service-providers.ts
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// packages/sdk/src/service-surface.ts
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// packages/sdk/examples/wait-kit/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var MAX_SECONDS = 24 * 60 * 60;
var FETCH_TIMEOUT_MS = 5000;
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
var dueOf = (state) => {
  if (state === null || typeof state !== "object" || Array.isArray(state))
    return null;
  return typeof state.due === "number" ? state.due : null;
};
var start = (type, args) => {
  if (type === "timer") {
    const seconds = Number(args.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
      return { ok: false, error: `seconds must be a whole number from 1 to ${MAX_SECONDS}` };
    }
    return { ok: true, state: { due: Date.now() + seconds * 1000 }, label: `${seconds} s` };
  }
  if (type === "url-ready") {
    const address = String(args.url);
    if (!URL.canParse(address) || !["http:", "https:"].includes(new URL(address).protocol)) {
      return { ok: false, error: "url must be an http or https address" };
    }
    const url = new URL(address);
    return { ok: true, state: null, label: `${url.host}${url.pathname === "/" ? "" : url.pathname}`.slice(0, WAIT_LABEL_MAX) };
  }
  return { ok: false, error: `this service has no wait "${type}"` };
};
var check = async (wait) => {
  if (wait.type === "timer") {
    const due = dueOf(wait.state);
    if (due !== null && Date.now() >= due)
      return { id: wait.id, fired: true, summary: `${wait.args.seconds} seconds passed.` };
    return { id: wait.id, fired: false };
  }
  const expected = typeof wait.args.status === "number" ? wait.args.status : null;
  try {
    const response = await fetch(String(wait.args.url), { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    await response.body?.cancel();
    const ready = expected === null ? response.status >= 200 && response.status < 300 : response.status === expected;
    if (ready)
      return { id: wait.id, fired: true, summary: `${String(wait.args.url).slice(0, 1000)} answered HTTP ${response.status}.` };
    return { id: wait.id, fired: false, state: { lastStatus: response.status } };
  } catch (error) {
    return { id: wait.id, fired: false, state: { lastError: error instanceof Error ? error.message : String(error) } };
  }
};
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (req.method !== "POST" || url.pathname !== WAITS_START_PATH && url.pathname !== WAITS_CHECK_PATH) {
    json(res, 404, { error: "not-found" });
    return;
  }
  readBody(req).then(async (body) => {
    if (url.pathname === WAITS_START_PATH) {
      const request = readWaitStartRequest(body);
      if (!request) {
        json(res, 400, { error: "not a wait this service understands" });
        return;
      }
      json(res, 200, start(request.wait.type, request.wait.args));
      return;
    }
    const request = readWaitCheckRequest(body);
    if (!request) {
      json(res, 400, { error: "not a check this service understands" });
      return;
    }
    json(res, 200, { results: await Promise.all(request.waits.map(check)) });
  }).catch(() => json(res, 500, { error: "could not read the request" }));
});
server.listen(port, "127.0.0.1");
