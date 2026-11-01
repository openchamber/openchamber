// packages/sdk/examples/tracker-provider/service/main.ts
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
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
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
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
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
var TRACKER_PROVIDER_PATH = "/tracker";
var TRACKER_PROVIDER_WIRE_VERSION = 1;
var TRACKER_PROVIDER_METHODS = [
  "auth.probe",
  "auth.verify",
  "items.list",
  "items.get",
  "items.updateState",
  "items.liveSummaries",
  "states.list",
  "containers.list",
  "comments.create"
];
var TRACKER_PROVIDER_ERROR_MESSAGE_MAX = 2000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_OUTBOUND_PATH = "/tracker/outbound";
var TRACKER_OUTBOUND_TIMEOUT_MS = 20000;
var isTrackerProviderMethod = (value) => TRACKER_PROVIDER_METHODS.some((method) => method === value);
var readTrackerProviderRequest = (body) => {
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
  if (v !== TRACKER_PROVIDER_WIRE_VERSION)
    return null;
  if (String(requestId) !== requestId || requestId.length === 0)
    return null;
  if (String(provider) !== provider || provider.length === 0)
    return null;
  if (String(method) !== method || !isTrackerProviderMethod(method))
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
  return { v: TRACKER_PROVIDER_WIRE_VERSION, requestId, method, provider, session: { instance, handle, account }, input };
};

class TrackerOutboundError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "TrackerOutboundError";
    this.code = code;
    this.status = status;
  }
}
var createTrackerOutbound = ({ env }) => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base)
    throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "tracker" can reach a tracker's server.`);
  const url = `${base.replace(/\/+$/, "")}${TRACKER_OUTBOUND_PATH}`;
  return {
    request: (handle, request) => postOutbound(url, handle, request, TRACKER_OUTBOUND_TIMEOUT_MS, (message, code, status) => new TrackerOutboundError(message, code, status))
  };
};
// packages/sdk/src/service-surface.ts
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// packages/sdk/examples/tracker-provider/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !serviceToken) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var outbound = createTrackerOutbound({ env: process.env });
var CATEGORY = {
  triage: "triage",
  backlog: "backlog",
  unstarted: "todo",
  started: "in-progress",
  completed: "done",
  cancelled: "canceled"
};
var PRIORITY = ["none", "urgent", "high", "medium", "low"];
var STATE_FILTER = new Map([["open", "open"], ["all", "all"], ["todo", "unstarted"], ["in-progress", "started"], ["done", "completed"]]);
var PEOPLE_FILTER = { any: "anyone", me: "assigned", created: "created" };

class CallError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
var serverFailure = (response) => {
  if (response.status === 401)
    return new CallError("Teaboard refused the credential.", 401);
  let message = `Teaboard answered ${response.status}.`;
  try {
    const parsed = JSON.parse(response.body);
    if (parsed.error)
      message = `Teaboard answered ${response.status}: ${parsed.error}`;
  } catch {}
  return new CallError(message, response.status);
};
var api = async (call, method, path, options = {}) => {
  const response = await outbound.request(call.handle, {
    method,
    path,
    query: options.query,
    headers: options.body ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (response.status >= 400)
    throw serverFailure(response);
  try {
    const data = JSON.parse(response.body);
    return data;
  } catch {
    throw new CallError("Teaboard answered with something other than JSON.", 502);
  }
};
var orNull = async (request) => {
  try {
    return await request;
  } catch (error) {
    if (error instanceof CallError && error.status === 404)
      return null;
    throw error;
  }
};
var seg = encodeURIComponent;
var toContainer = (project) => ({ id: project.id, key: project.key, name: project.name });
var toPerson = (person) => person ? { name: person.name, avatarUrl: null } : null;
var toSummary = (call, raw) => {
  const identifier = raw.key.toUpperCase();
  return {
    id: raw.id,
    identifier,
    title: raw.title,
    url: `${call.instance}/items/${seg(identifier)}`,
    state: raw.state ? { id: raw.state.id, name: raw.state.name, category: CATEGORY[raw.state.kind] ?? null } : null,
    priority: PRIORITY[raw.priority] ?? "none",
    labels: raw.labels.map((label) => ({ id: label.id, name: label.name, color: label.color ?? null })),
    assignee: toPerson(raw.assignee),
    container: raw.project ? toContainer(raw.project) : null,
    updatedAt: raw.updatedAt
  };
};
var toComment = (raw) => ({ id: raw.id, body: raw.body, createdAt: raw.createdAt, author: toPerson(raw.author) });
var toItem = (call, raw) => raw ? {
  ...toSummary(call, raw),
  description: raw.description ?? null,
  comments: (raw.comments ?? []).map(toComment)
} : null;
var toWorkflowState = (raw) => ({ id: raw.id, name: raw.name, category: CATEGORY[raw.kind] ?? null, position: raw.position });
var toLiveSummary = (raw) => ({
  identifier: raw.key.toUpperCase(),
  title: raw.title,
  state: { name: raw.state.name, category: CATEGORY[raw.state.kind] ?? "todo" }
});
var handlers = {
  "auth.probe": async (call) => {
    const response = await outbound.request(call.handle, { method: "GET", path: "/api/health", headers: { accept: "application/json" } });
    if (response.status !== 200)
      return { supported: false, message: `${call.instance} answered ${response.status} to /api/health.` };
    let health;
    try {
      health = Object(JSON.parse(response.body));
    } catch {
      return { supported: false, message: `${call.instance} is not a Teaboard server.` };
    }
    return health.teaboard === true ? { supported: true } : { supported: false, message: `${call.instance} is not a Teaboard server.` };
  },
  "auth.verify": async (call) => {
    const me = await api(call, "GET", "/api/me");
    const account = { id: me.id, login: me.login };
    if (me.name)
      account.name = me.name;
    return { account };
  },
  "items.list": async (call, input) => {
    const query = {
      state: STATE_FILTER.get(input.state) ?? input.state,
      people: PEOPLE_FILTER[input.people],
      priority: input.priority === "all" ? "all" : String(PRIORITY.indexOf(input.priority)),
      ...input.query ? { query: input.query } : {},
      ...input.cursor ? { cursor: input.cursor } : {},
      ...input.containerId ? { project: input.containerId } : {}
    };
    const page = await api(call, "GET", "/api/items", { query });
    return { items: page.items.map((item) => toSummary(call, item)), cursor: page.nextCursor, hasMore: page.nextCursor !== null };
  },
  "items.get": async (call, input) => ({
    item: toItem(call, await orNull(api(call, "GET", `/api/items/${seg(input.id)}`)))
  }),
  "items.updateState": async (call, input) => ({
    item: toItem(call, await orNull(api(call, "POST", `/api/items/${seg(input.id)}/state`, { body: { stateId: input.stateId } })))
  }),
  "items.liveSummaries": async (call, input) => {
    const { items } = await api(call, "GET", "/api/summaries", { query: { identifiers: input.identifiers.join(",") } });
    return { items: items.map(toLiveSummary) };
  },
  "states.list": async (call, input) => {
    const { states } = await api(call, "GET", `/api/projects/${seg(input.containerId)}/states`);
    return { states: states.map(toWorkflowState) };
  },
  "containers.list": async (call) => {
    const { projects } = await api(call, "GET", "/api/projects");
    return { containers: projects.map(toContainer) };
  },
  "comments.create": async (call, input) => {
    const comment = await orNull(api(call, "POST", `/api/items/${seg(input.identifier)}/comments`, { body: { body: input.body } }));
    return { comment: comment ? { id: comment.id } : null };
  }
};
var failureOf = (error) => {
  const text = error.message;
  const failure = { message: text.slice(0, TRACKER_PROVIDER_ERROR_MESSAGE_MAX) || "Unexpected failure" };
  if (error instanceof TrackerOutboundError) {
    if (error.status >= 400 && error.status <= 599)
      failure.status = error.status;
    if (/^[A-Z_]{1,64}$/.test(error.code))
      failure.code = error.code;
  } else if (error instanceof CallError) {
    failure.status = error.status;
  }
  return failure;
};
var answer = async (method, call, input) => {
  try {
    const data = await handlers[method](call, input);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: failureOf(error instanceof Error ? error : new Error(String(error))) };
  }
};
var send = (res, status, body) => {
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
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${serviceToken}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== TRACKER_PROVIDER_PATH || req.method !== "POST") {
    send(res, 404, { error: "not-found" });
    return;
  }
  readBody(req).then(async (body) => {
    const request = readTrackerProviderRequest(body);
    if (!request) {
      send(res, 400, { error: "not a tracker call this service understands" });
      return;
    }
    send(res, 200, await answer(request.method, { instance: request.session.instance, handle: request.session.handle }, request.input));
  }).catch(() => send(res, 500, { error: "could not read the request" }));
});
server.listen(port, "127.0.0.1");
