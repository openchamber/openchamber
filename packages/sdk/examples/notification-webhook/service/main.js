// packages/sdk/examples/notification-webhook/service/main.ts
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
// packages/sdk/src/session-events.ts
var GUEST_SESSION_EVENT_TYPES = ["turn-finished", "turn-failed", "permission-asked", "question-asked"];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
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
var OPENCHAMBER_HOST_CALLBACK_URL = "OPENCHAMBER_HOST_CALLBACK_URL";
var postOutbound = async (url, handle, request, timeoutMs, fail) => {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${handle}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs + 5000)
    });
  } catch (error) {
    throw fail(`OpenChamber did not answer: ${error instanceof Error ? error.message : String(error)}`, "HOST_UNAVAILABLE", 0);
  }
  let answer;
  try {
    answer = Object(await response.json());
  } catch {
    throw fail("OpenChamber answered with something other than JSON", "HOST_UNAVAILABLE", response.status);
  }
  if (!response.ok) {
    const message = answer.error?.message;
    const code = answer.error?.code;
    throw fail(String(message) === message && message.length > 0 ? message : `OpenChamber refused the request (${response.status})`, String(code) === code && code.length > 0 ? code : "OUTBOUND_REFUSED", response.status);
  }
  if (!Number.isSafeInteger(answer.status) || String(answer.body) !== answer.body) {
    throw fail("OpenChamber relayed a malformed answer", "HOST_UNAVAILABLE", response.status);
  }
  const headers = {};
  for (const [name, text] of Object.entries(Object(answer.headers ?? {}))) {
    if (String(text) === text)
      headers[name] = text;
  }
  return { status: Number(answer.status), headers, body: answer.body };
};
var NOTIFICATIONS_PROVIDER_PATH = "/notifications";
var NOTIFICATIONS_PROVIDER_WIRE_VERSION = 1;
var NOTIFICATIONS_PROVIDER_METHODS = ["auth.verify", "auth.probe", "notify"];
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_OUTBOUND_PATH = "/notifications/outbound";
var NOTIFICATIONS_OUTBOUND_TIMEOUT_MS = 20000;
var isNotificationsProviderMethod = (value) => NOTIFICATIONS_PROVIDER_METHODS.some((method) => method === value);
var readNotificationsAccount = (account) => {
  if (account === null)
    return null;
  if (Object(account) !== account || account === undefined)
    return;
  const { id, login } = account;
  if (String(id) !== id || id.length === 0)
    return;
  if (login !== null && (String(login) !== login || login.length === 0))
    return;
  return { id, login };
};
var readNotificationsProviderRequest = (body) => {
  let wire;
  try {
    const parsed = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null)
      return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, session, input } = wire;
  if (v !== NOTIFICATIONS_PROVIDER_WIRE_VERSION)
    return null;
  if (String(requestId) !== requestId || requestId.length === 0)
    return null;
  if (String(provider) !== provider || provider.length === 0)
    return null;
  if (String(method) !== method || !isNotificationsProviderMethod(method))
    return null;
  if (Object(input) !== input || Array.isArray(input))
    return null;
  if (Object(session) !== session || session === null || session === undefined)
    return null;
  const { instance, handle } = session;
  if (String(instance) !== instance || instance.length === 0 || String(handle) !== handle || handle.length === 0)
    return null;
  const account = readNotificationsAccount(session.account);
  if (account === undefined)
    return null;
  return { v: NOTIFICATIONS_PROVIDER_WIRE_VERSION, requestId, method, provider, session: { instance, handle, account }, input };
};

class NotificationsOutboundError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "NotificationsOutboundError";
    this.code = code;
    this.status = status;
  }
}
var createNotificationsOutbound = ({ env }) => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base)
    throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "notifications" can reach a channel's server.`);
  const url = `${base.replace(/\/+$/, "")}${NOTIFICATIONS_OUTBOUND_PATH}`;
  return {
    request: (handle, request) => postOutbound(url, handle, request, NOTIFICATIONS_OUTBOUND_TIMEOUT_MS, (message, code, status) => new NotificationsOutboundError(message, code, status))
  };
};
// packages/sdk/src/service-surface.ts
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// packages/sdk/examples/notification-webhook/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !serviceToken) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var outbound = createNotificationsOutbound({ env: process.env });
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
var failure = (message, status) => {
  const error = { message };
  if (status !== undefined)
    error.status = status;
  return { ok: false, error };
};

class RelayFailure extends Error {
  result;
  constructor(message) {
    super(message);
    this.result = failure(message);
  }
}
var relay = async (handle, request) => {
  try {
    return await outbound.request(handle, request);
  } catch (error) {
    if (error instanceof NotificationsOutboundError)
      throw new RelayFailure(`OpenChamber refused the request: ${error.message}`);
    throw new RelayFailure(error instanceof Error ? error.message : String(error));
  }
};
var whoami = async (handle) => {
  const answer = await relay(handle, { method: "GET", path: "/whoami" });
  if (answer.status === 401)
    return failure("The receiver refused the token.", 401);
  if (answer.status !== 200)
    return failure(`The receiver answered ${answer.status} to /whoami.`, answer.status);
  let who;
  try {
    who = Object(JSON.parse(answer.body));
  } catch {
    return failure("The receiver answered /whoami with something other than JSON.");
  }
  const { id, login, name } = who;
  if (String(id) !== id || String(login) !== login)
    return failure("The receiver did not say who the token belongs to.");
  const account = { id, login };
  if (String(name) === name && name.length > 0)
    account.name = name;
  return { ok: true, data: { account } };
};
var deliver = async (handle, notification, account) => {
  const answer = await relay(handle, {
    method: "POST",
    path: "/notify",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...notification, account })
  });
  if (answer.status === 401)
    return failure("The receiver refused the token.", 401);
  if (answer.status < 200 || answer.status >= 300)
    return failure(`The receiver answered ${answer.status}.`, answer.status);
  return { ok: true, data: { delivered: true } };
};
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${serviceToken}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === NOTIFICATIONS_PROVIDER_PATH && req.method === "POST") {
    readBody(req).then(async (body) => {
      const request = readNotificationsProviderRequest(body);
      if (!request) {
        json(res, 400, failure("not a notifications call this service understands"));
        return;
      }
      const { method, session, input } = request;
      try {
        if (method === "auth.probe") {
          const answer = await relay(session.handle, { method: "GET", path: "/" });
          const probe = { supported: answer.status < 500 };
          if (!probe.supported)
            probe.message = `The receiver answered ${answer.status}.`;
          json(res, 200, { ok: true, data: probe });
          return;
        }
        if (method === "auth.verify") {
          json(res, 200, await whoami(session.handle));
          return;
        }
        const { notification } = input;
        if (!notification) {
          json(res, 200, failure("notify needs a notification"));
          return;
        }
        json(res, 200, await deliver(session.handle, notification, session.account));
      } catch (error) {
        json(res, 200, error instanceof RelayFailure ? error.result : failure(error instanceof Error ? error.message : String(error)));
      }
    }).catch(() => json(res, 500, failure("could not read the request")));
    return;
  }
  json(res, 404, { error: "not-found" });
});
server.listen(port, "127.0.0.1");
