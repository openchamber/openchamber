// packages/sdk/examples/source-control-provider/service/main.ts
import { execFile } from "node:child_process";
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
var SOURCE_CONTROL_PROVIDER_PATH = "/source-control";
var SOURCE_CONTROL_PROVIDER_WIRE_VERSION = 1;
var SOURCE_CONTROL_PROVIDER_METHODS = [
  "auth.verify",
  "auth.probe",
  "changeRequestStatus",
  "listChangeRequests",
  "changeRequestContext",
  "listIssues",
  "getIssue",
  "issueComments",
  "projectUpstream",
  "projectBranches",
  "listLabels",
  "listReviewerCandidates",
  "readChangeRequestPatch",
  "readChangeRequestFile",
  "liveSummaries",
  "readChangeRequestHead",
  "resolveChangeRequestSource",
  "mutation.resolveTarget",
  "mutation.perform",
  "mutation.reconcile"
];
var SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX = 2000;
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var OPENCHAMBER_HOST_CALLBACK_URL = "OPENCHAMBER_HOST_CALLBACK_URL";
var SOURCE_CONTROL_OUTBOUND_PATH = "/source-control/outbound";
var SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS = 20000;
var isSourceControlProviderMethod = (value) => SOURCE_CONTROL_PROVIDER_METHODS.some((method) => method === value);
var readSessionUser = (user) => {
  if (user === null)
    return null;
  if (Object(user) !== user || user === undefined)
    return;
  const { id, login } = user;
  if (!Number.isSafeInteger(id) || String(login) !== login || login.length === 0)
    return;
  return { id: Number(id), login };
};
var readSession = (session) => {
  if (session === null)
    return null;
  if (Object(session) !== session || session === undefined)
    return;
  const { instance, handle } = session;
  if (String(instance) !== instance || instance.length === 0 || String(handle) !== handle || handle.length === 0)
    return;
  const user = readSessionUser(session.user);
  if (user === undefined)
    return;
  return { instance, handle, user };
};
var readSourceControlProviderRequest = (body) => {
  let wire;
  try {
    const parsed = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null)
      return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, input } = wire;
  if (v !== SOURCE_CONTROL_PROVIDER_WIRE_VERSION)
    return null;
  if (String(requestId) !== requestId || requestId.length === 0)
    return null;
  if (String(provider) !== provider || provider.length === 0)
    return null;
  if (String(method) !== method || !isSourceControlProviderMethod(method))
    return null;
  if (Object(input) !== input || Array.isArray(input))
    return null;
  const session = readSession(wire.session);
  if (session === undefined)
    return null;
  return { v: SOURCE_CONTROL_PROVIDER_WIRE_VERSION, requestId, method, provider, session, input };
};

class SourceControlForgeError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "SourceControlForgeError";
    this.code = code;
    this.status = status;
  }
}
var createSourceControlForge = ({ env }) => {
  const base = env[OPENCHAMBER_HOST_CALLBACK_URL];
  if (!base)
    throw new Error(`${OPENCHAMBER_HOST_CALLBACK_URL} is not set: only a service that provides "source-control" can reach a forge.`);
  const url = `${base.replace(/\/+$/, "")}${SOURCE_CONTROL_OUTBOUND_PATH}`;
  return {
    async request(handle, request) {
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${handle}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(SOURCE_CONTROL_OUTBOUND_TIMEOUT_MS + 5000)
        });
      } catch (error) {
        throw new SourceControlForgeError(`OpenChamber did not answer: ${error instanceof Error ? error.message : String(error)}`, "HOST_UNAVAILABLE", 0);
      }
      let answer;
      try {
        answer = Object(await response.json());
      } catch {
        throw new SourceControlForgeError("OpenChamber answered with something other than JSON", "HOST_UNAVAILABLE", response.status);
      }
      if (!response.ok) {
        const message = answer.error?.message;
        const code = answer.error?.code;
        throw new SourceControlForgeError(String(message) === message && message.length > 0 ? message : `OpenChamber refused the request (${response.status})`, String(code) === code && code.length > 0 ? code : "OUTBOUND_REFUSED", response.status);
      }
      if (!Number.isSafeInteger(answer.status) || String(answer.body) !== answer.body) {
        throw new SourceControlForgeError("OpenChamber relayed a malformed forge answer", "HOST_UNAVAILABLE", response.status);
      }
      const headers = {};
      for (const [name, text] of Object.entries(Object(answer.headers ?? {}))) {
        if (String(text) === text)
          headers[name] = text;
      }
      return { status: Number(answer.status), headers, body: answer.body };
    }
  };
};
// packages/sdk/src/service-surface.ts
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// packages/sdk/examples/source-control-provider/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !serviceToken) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var forge = createSourceControlForge({ env: process.env });
var PAGE_SIZE = 20;
var SCAN_SIZE = 50;
var STATUS_SCAN_PAGES = 5;

class CallError extends Error {
  status;
  code;
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
var forgeFailure = (response) => {
  let message = `The forge answered ${response.status}`;
  try {
    const parsed = JSON.parse(response.body);
    if (parsed.message)
      message = parsed.message;
  } catch {}
  return new CallError(message, response.status);
};
var api = async (call, method, path, options = {}) => {
  const response = await forge.request(call.session.handle, {
    method,
    path: `/api/v1${path}`,
    query: options.query,
    headers: options.body ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (response.status >= 400)
    throw forgeFailure(response);
  const total = response.headers["x-total-count"];
  const data = response.body ? JSON.parse(response.body) : null;
  return { data, total: total === undefined ? null : Number(total) };
};
var apiText = async (call, path, query) => {
  const response = await forge.request(call.session.handle, { method: "GET", path: `/api/v1${path}`, query, headers: { accept: "text/plain" } });
  if (response.status >= 400)
    throw forgeFailure(response);
  return response.body;
};
var seg = encodeURIComponent;
var repoPath = (repo) => `/repos/${seg(repo.owner)}/${seg(repo.name)}`;
var remoteUrl = (directory, remote) => new Promise((resolve, reject) => {
  execFile("git", ["-C", directory, "remote", "get-url", "--", remote], { timeout: 5000 }, (error, stdout) => {
    if (error)
      reject(new CallError(`The remote "${remote}" could not be read`, 404, "REMOTE_NOT_FOUND"));
    else
      resolve(stdout.trim());
  });
});
var repositoryOfRemote = (raw, instance) => {
  const origin = new URL(instance);
  let host;
  let path;
  const scp = raw.includes("://") ? null : raw.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
    if (host !== origin.hostname.toLowerCase())
      return null;
  } else {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const web = url.protocol === "https:" || url.protocol === "http:";
    if (web && url.host.toLowerCase() !== origin.host.toLowerCase())
      return null;
    if (!web && url.hostname.toLowerCase() !== origin.hostname.toLowerCase())
      return null;
    path = decodeURIComponent(url.pathname);
  }
  const segments = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === "." || segment === ".."))
    return null;
  return { owner: segments[0], name: segments[1] };
};
var mapProject = (call, raw, remoteName) => {
  const project = { ...call.identity, id: String(raw.id), owner: raw.owner.login, name: raw.name, url: raw.html_url };
  if (raw.clone_url)
    project.cloneUrl = raw.clone_url;
  if (raw.default_branch)
    project.defaultBranch = raw.default_branch;
  if (remoteName !== undefined)
    project.remoteName = remoteName;
  return project;
};
var compact = (project) => ({ id: project.id, owner: project.owner, name: project.name });
var resolveRepo = async (call, directory, remote, selector) => {
  const named = selector ?? repositoryOfRemote(await remoteUrl(directory, remote), call.session.instance);
  if (!named)
    throw new CallError(`The remote "${remote}" is not a repository on ${call.session.instance}`, 404, "REMOTE_NOT_ON_INSTANCE");
  const { data } = await api(call, "GET", repoPath(named));
  return { raw: data, project: mapProject(call, data, selector ? undefined : remote) };
};
var WIP = /^\s*(?:wip:|\[wip\])\s*/i;
var mapUser = (call, raw) => {
  if (!raw)
    return null;
  const user = { ...call.identity, id: String(raw.id), username: raw.login };
  if (raw.full_name)
    user.name = raw.full_name;
  if (raw.avatar_url)
    user.avatarUrl = raw.avatar_url;
  return user;
};
var stamp = (target, raw) => {
  if (raw.created_at)
    target.createdAt = raw.created_at;
  if (raw.updated_at)
    target.updatedAt = raw.updated_at;
};
var pullState = (raw) => raw.merged ? "merged" : raw.state;
var mapPull = (call, raw, project) => {
  const request = {
    ...call.identity,
    id: `${project.id}#${raw.number}`,
    number: raw.number,
    project,
    title: raw.title,
    url: raw.html_url,
    state: pullState(raw),
    draft: raw.draft === true || WIP.test(raw.title),
    base: raw.base.ref,
    head: raw.head.ref,
    headSha: raw.head.sha,
    author: mapUser(call, raw.user),
    labels: []
  };
  if (raw.body !== undefined)
    request.body = raw.body;
  stamp(request, raw);
  if (request.state === "open" && raw.mergeable !== undefined) {
    request.mergeable = raw.mergeable;
    request.mergeableState = raw.mergeable ? "clean" : "dirty";
  }
  return request;
};
var mapIssue = (call, raw, project) => {
  const issue = {
    ...call.identity,
    id: `${project.id}#${raw.number}`,
    number: raw.number,
    project,
    title: raw.title,
    url: raw.html_url,
    state: raw.state,
    author: mapUser(call, raw.user),
    labels: []
  };
  if (raw.body !== undefined)
    issue.body = raw.body;
  stamp(issue, raw);
  return issue;
};
var mapComment = (call, raw, fallbackUrl) => {
  const comment = {
    ...call.identity,
    id: String(raw.id),
    url: raw.html_url ?? fallbackUrl,
    body: raw.body,
    author: mapUser(call, raw.user)
  };
  stamp(comment, raw);
  return comment;
};
var FILE_STATUSES = new Map([["added", "added"], ["deleted", "removed"], ["removed", "removed"], ["renamed", "renamed"]]);
var mapChangedFile = (raw) => {
  const file = { path: raw.filename, status: FILE_STATUSES.get(raw.status ?? "") ?? "modified" };
  if (raw.additions !== undefined)
    file.additions = raw.additions;
  if (raw.deletions !== undefined)
    file.deletions = raw.deletions;
  if (raw.changes !== undefined)
    file.changes = raw.changes;
  return file;
};
var splitUnifiedDiff = (diff) => {
  const parts = new Map;
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.split(`
`);
    const plus = lines.find((line) => line.startsWith("+++ "));
    const minus = lines.find((line) => line.startsWith("--- "));
    const renamed = lines.find((line) => line.startsWith("rename to "));
    let path = "";
    if (plus && plus !== "+++ /dev/null")
      path = plus.slice(4).replace(/^b\//, "");
    else if (renamed)
      path = renamed.slice("rename to ".length);
    else if (minus && minus !== "--- /dev/null")
      path = minus.slice(4).replace(/^a\//, "");
    else
      path = lines[0].match(/^diff --git a\/.+? b\/(.+)$/)?.[1] ?? "";
    if (path)
      parts.set(path.replace(/\t.*$/, ""), chunk.endsWith(`
`) ? chunk : `${chunk}
`);
  }
  return parts;
};
var listState = (state) => {
  if (state === "closed" || state === "merged")
    return "closed";
  return state === "all" ? "all" : "open";
};
var pageQuery = (page, state) => ({ state: listState(state), page: String(page), limit: String(PAGE_SIZE) });
var hasMore = (page, count, total) => total === null ? count === PAGE_SIZE : page * PAGE_SIZE < total;
var text = (input, key) => {
  const value = input[key];
  return String(value) === value ? value : "";
};
var integer = (input, key) => {
  const value = input[key];
  return Number.isSafeInteger(value) ? Number(value) : 0;
};
var selectorOf = (input, key) => {
  const value = input[key];
  if (Object(value) !== value || Array.isArray(value) || value === null)
    return;
  const object = Object(value);
  const owner = text(object, "owner");
  const name = text(object, "name") || text(object, "repo");
  return owner && name ? { owner, name } : undefined;
};
var objectOf = (input, key) => {
  const value = input[key];
  return Object(value) === value && !Array.isArray(value) && value !== null ? Object(value) : {};
};
var readPull = async (call, repo, number) => (await api(call, "GET", `${repoPath(repo)}/pulls/${number}`)).data;
var changeRequestRepo = async (call, input) => {
  const { raw, project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"));
  const source = objectOf(input, "sourceRepo");
  const owner = text(source, "owner").toLowerCase();
  const name = text(source, "repo").toLowerCase();
  const names = (repo) => repo.owner.login.toLowerCase() === owner && repo.name.toLowerCase() === name;
  if (!owner || !name || names(raw))
    return project;
  if (raw.fork && raw.parent && names(raw.parent))
    return mapProject(call, raw.parent);
  throw new CallError(`${owner}/${name} is not in this project's repository network`, 404, "NOT_IN_NETWORK");
};
var rawPath = (repo, filePath) => {
  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new CallError(`"${filePath}" is not a file path`, 400);
  return `${repoPath(repo)}/raw/${segments.map(seg).join("/")}`;
};
var FILE_SCAN_PAGES = 10;
var readChangedFiles = async (call, repo, number) => {
  const files = [];
  for (let page = 1;page <= FILE_SCAN_PAGES; page += 1) {
    const { data, total } = await api(call, "GET", `${repo}/pulls/${number}/files`, {
      query: { page: String(page), limit: String(SCAN_SIZE) }
    });
    files.push(...data);
    if (data.length < SCAN_SIZE || total !== null && files.length >= total)
      return files;
  }
  throw new CallError(`The pull request changes more files than this Git host reads (${FILE_SCAN_PAGES * SCAN_SIZE})`, 502, "SCAN_LIMIT");
};
var COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
var branchRepoId = (ref) => ref.repo_id ?? ref.repo?.id;
var findBranchPull = async (call, repo, branch) => {
  const matches = (pull) => pull.head.ref === branch && branchRepoId(pull.head) === repo.id;
  const pulls = `${repoPath({ owner: repo.owner.login, name: repo.name })}/pulls`;
  for (let page = 1;page <= STATUS_SCAN_PAGES; page += 1) {
    const { data, total } = await api(call, "GET", pulls, {
      query: { state: "open", sort: "recentupdate", page: String(page), limit: String(SCAN_SIZE) }
    });
    const open = data.find(matches);
    if (open)
      return open;
    if (total === null ? data.length === SCAN_SIZE : page * SCAN_SIZE < total)
      continue;
    const { data: closed } = await api(call, "GET", pulls, {
      query: { state: "closed", sort: "recentupdate", page: "1", limit: String(SCAN_SIZE) }
    });
    return closed.filter(matches).reduce((newest, pull) => !newest || pull.number > newest.number ? pull : newest, null);
  }
  throw new CallError(`The repository has more open pull requests than this Git host scans (${STATUS_SCAN_PAGES * SCAN_SIZE})`, 502, "SCAN_LIMIT");
};
var unsupported = async (_call, _input, request) => {
  throw new CallError(`${request.method} is not something this Git host offers`, 501, "UNSUPPORTED");
};
var handlers = {
  "auth.verify": async (call) => {
    const { data } = await api(call, "GET", "/user");
    const user = { id: data.id, login: data.login };
    if (data.full_name)
      user.name = data.full_name;
    if (data.email)
      user.email = data.email;
    if (data.avatar_url)
      user.avatarUrl = data.avatar_url;
    return { user };
  },
  "auth.probe": async (call) => {
    try {
      const { data } = await api(call, "GET", "/version");
      return { supported: true, version: data.version };
    } catch (error) {
      if (error instanceof CallError && error.status === 404)
        return { supported: false, message: "This server does not answer /api/v1/version." };
      throw error;
    }
  },
  changeRequestStatus: async (call, input) => {
    const { raw, project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"));
    const branch = text(input, "branch");
    const found = await findBranchPull(call, raw, branch);
    const status = {
      identity: call.identity,
      project,
      branch,
      changeRequest: found ? mapPull(call, found, project) : null,
      ci: null,
      resolvedRemoteName: text(input, "remote") || null,
      defaultBranch: raw.default_branch ?? null
    };
    if (found)
      status.canMerge = pullState(found) === "open" && found.mergeable === true;
    return status;
  },
  listChangeRequests: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"));
    const page = integer(input, "page") || 1;
    const state = text(input, "state");
    const { data, total } = await api(call, "GET", `${repoPath(project)}/pulls`, { query: pageQuery(page, state) });
    const items = data.filter((pull) => state !== "merged" || pull.merged).map((pull) => mapPull(call, pull, project));
    return { items, page, hasMore: hasMore(page, data.length, total) };
  },
  changeRequestContext: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"), selectorOf(input, "project"));
    const number = integer(input, "number");
    const repo = repoPath(project);
    const includeDiff = input.includeDiff === true;
    const [raw, { data: comments }, diff, changed] = await Promise.all([
      readPull(call, project, number),
      api(call, "GET", `${repo}/issues/${number}/comments`),
      includeDiff ? apiText(call, `${repo}/pulls/${number}.diff`) : Promise.resolve(""),
      includeDiff ? readChangedFiles(call, repo, number) : Promise.resolve([])
    ]);
    const pull = mapPull(call, raw, project);
    const patches = splitUnifiedDiff(diff);
    const files = changed.map((file) => {
      const mapped = mapChangedFile(file);
      const patch = patches.get(mapped.path);
      if (patch)
        mapped.patch = patch;
      return mapped;
    });
    return {
      identity: call.identity,
      project,
      changeRequest: pull,
      issueComments: comments.map((comment) => mapComment(call, comment, pull.url)),
      reviewComments: [],
      files,
      diff,
      ci: null
    };
  },
  listIssues: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"));
    const page = integer(input, "page") || 1;
    const { data, total } = await api(call, "GET", `${repoPath(project)}/issues`, {
      query: { ...pageQuery(page, text(input, "state")), type: "issues" }
    });
    const items = data.filter((issue) => !issue.pull_request).map((issue) => mapIssue(call, issue, project));
    return { items, page, hasMore: hasMore(page, data.length, total) };
  },
  getIssue: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"), selectorOf(input, "project"));
    const { data } = await api(call, "GET", `${repoPath(project)}/issues/${integer(input, "number")}`);
    if (data.pull_request)
      throw new CallError(`#${data.number} is a pull request`, 404);
    return mapIssue(call, data, project);
  },
  issueComments: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"), selectorOf(input, "project"));
    const number = integer(input, "number");
    const { data: issue } = await api(call, "GET", `${repoPath(project)}/issues/${number}`);
    const { data } = await api(call, "GET", `${repoPath(project)}/issues/${number}/comments`);
    return data.map((comment) => mapComment(call, comment, issue.html_url));
  },
  projectUpstream: async (call, input) => {
    const { raw } = await resolveRepo(call, text(input, "directory"), text(input, "remote"));
    const parent = raw.fork && raw.parent ? mapProject(call, raw.parent) : null;
    return { identity: call.identity, isFork: Boolean(parent), upstream: parent };
  },
  projectBranches: async (call, input) => {
    const selector = selectorOf(input, "project");
    if (!selector)
      throw new CallError("project is required", 400);
    const { data } = await api(call, "GET", `${repoPath(selector)}/branches`, { query: { limit: String(SCAN_SIZE) } });
    return data.map((branch) => branch.name);
  },
  listLabels: unsupported,
  listReviewerCandidates: unsupported,
  readChangeRequestPatch: async (call, input) => {
    const project = await changeRequestRepo(call, input);
    const number = integer(input, "number");
    const patch = await apiText(call, `${repoPath(project)}/pulls/${number}.diff`);
    return { patch, meta: { owner: project.owner, repo: project.name, number } };
  },
  readChangeRequestFile: async (call, input) => {
    const project = await changeRequestRepo(call, input);
    const pull = await readPull(call, project, integer(input, "number"));
    const baseSha = pull.merge_base ?? "";
    const headSha = pull.head.sha;
    if (!COMMIT_SHA.test(baseSha) || !COMMIT_SHA.test(headSha))
      throw new CallError("The forge returned invalid pull request refs", 502);
    const path = text(input, "path");
    const status = text(input, "status");
    const [original, modified] = await Promise.all([
      status === "A" ? "" : apiText(call, rawPath(project, text(input, "previousPath") || path), { ref: baseSha }),
      status === "D" ? "" : apiText(call, rawPath(project, path), { ref: headSha })
    ]);
    return { original, modified };
  },
  liveSummaries: async (call, input) => {
    const refsOf = (key) => {
      const value = input[key];
      return (Array.isArray(value) ? value : []).flatMap((ref) => {
        if (Object(ref) !== ref || Array.isArray(ref) || ref === null)
          return [];
        const object = Object(ref);
        const owner = text(object, "owner");
        const repo = text(object, "repo");
        const number = integer(object, "number");
        return owner && repo && number ? [{ owner, repo, number }] : [];
      });
    };
    const skipUnknown = async (task) => {
      try {
        return await task();
      } catch (error) {
        if (error instanceof CallError && error.status === 401)
          throw error;
        return null;
      }
    };
    const summaries = await Promise.all(refsOf("refs").map((ref) => skipUnknown(async () => {
      const pull = await readPull(call, { owner: ref.owner, name: ref.repo }, ref.number);
      const state = pullState(pull);
      return {
        owner: ref.owner,
        repo: ref.repo,
        number: pull.number,
        state,
        draft: pull.draft === true || WIP.test(pull.title),
        title: pull.title,
        mergeable: state === "open" && pull.mergeable !== undefined ? pull.mergeable : null,
        mergeableState: state === "open" && pull.mergeable !== undefined ? pull.mergeable ? "clean" : "dirty" : null,
        checks: null,
        headSha: pull.head.sha,
        base: pull.base.ref
      };
    })));
    const issueSummaries = await Promise.all(refsOf("issueRefs").map((ref) => skipUnknown(async () => {
      const { data } = await api(call, "GET", `${repoPath({ owner: ref.owner, name: ref.repo })}/issues/${ref.number}`);
      return { owner: ref.owner, repo: ref.repo, number: data.number, title: data.title, state: data.state === "open" ? "open" : "completed" };
    })));
    return { summaries: summaries.filter((item) => item !== null), issueSummaries: issueSummaries.filter((item) => item !== null) };
  },
  readChangeRequestHead: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"));
    const pull = await readPull(call, project, integer(input, "number"));
    return { project: compact(project), headSha: pull.head.sha.toLowerCase(), headBranch: pull.head.ref, headOwner: pull.head.repo?.owner.login ?? project.owner };
  },
  resolveChangeRequestSource: async (call, input) => {
    const target = selectorOf(input, "project");
    if (!target)
      throw new CallError("project is required", 400);
    const pull = await readPull(call, target, integer(input, "number"));
    const expected = text(input, "expectedHeadSha").toLowerCase();
    if (pull.head.sha.toLowerCase() !== expected)
      throw new CallError("The pull request head changed", 409, "SOURCE_CONTROL_CHANGE_REQUEST_STALE");
    const targetProject = mapProject(call, pull.base.repo ?? (await api(call, "GET", repoPath(target))).data);
    const headProject = pull.head.repo ? mapProject(call, pull.head.repo) : targetProject;
    return {
      sourceProject: compact(headProject),
      targetProject: compact(targetProject),
      classification: headProject.id === targetProject.id ? "same-repository" : "contributor-fork",
      headSha: expected,
      headRef: `refs/heads/${pull.head.ref}`,
      endpoint: headProject.cloneUrl ?? `${headProject.url}.git`
    };
  },
  "mutation.resolveTarget": async (call, input) => resolveTarget(call, input),
  "mutation.perform": async (call, input) => perform(call, input),
  "mutation.reconcile": async (call, input) => reconcile(call, input)
};
var TARGET_KEYS = ["number", "head", "base", "headSha"];
var mutationTarget = (context, project, fields) => {
  const target = {
    repositoryId: text(context, "repositoryId"),
    bindingRevision: integer(context, "bindingRevision"),
    primaryRemote: text(context, "primaryRemote"),
    project: compact(project)
  };
  for (const key of TARGET_KEYS) {
    const value = fields[key];
    if (value === undefined)
      continue;
    if (key === "number")
      target.number = Number(value);
    else
      target[key] = String(value);
  }
  return target;
};
var asJson = (resolution) => ({
  providerTarget: resolution.providerTarget,
  target: { ...resolution.target, project: { ...resolution.target.project } }
});
var resolveHeadSource = async (call, directory, primaryRemote, target, normalized) => {
  const remote = text(normalized, "remote");
  if (remote && remote !== primaryRemote) {
    throw new CallError(`Pull requests open on the bound remote "${primaryRemote}", not "${remote}"`, 409, "SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH");
  }
  const headRemote = text(normalized, "headRemote");
  if (!headRemote || headRemote === primaryRemote)
    return target;
  const { raw: head } = await resolveRepo(call, directory, headRemote);
  if (head.id !== target.id && head.parent?.id !== target.id) {
    throw new CallError(`The remote "${headRemote}" is neither ${target.owner.login}/${target.name} nor a fork of it on this forge`, 409, "SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH");
  }
  return head;
};
var resolveTarget = async (call, input) => {
  const context = objectOf(input, "context");
  const expected = objectOf(context, "target");
  const kind = text(input, "kind");
  const replayOf = objectOf(input, "replayOf");
  const primaryRemote = text(context, "primaryRemote");
  const { raw, project } = await resolveRepo(call, text(context, "directory"), primaryRemote);
  const providerTarget = { repoId: raw.id, owner: project.owner, name: project.name };
  if (kind === "change-request-create") {
    const source = await resolveHeadSource(call, text(context, "directory"), primaryRemote, raw, objectOf(input, "input"));
    return asJson({
      providerTarget: { ...providerTarget, sourceRepoId: source.id, sourceOwner: source.owner.login },
      target: mutationTarget(context, project, { head: text(expected, "head"), base: text(expected, "base") })
    });
  }
  const replayTarget = objectOf(replayOf, "target");
  const number = integer(replayTarget, "number") || integer(expected, "number");
  if (!number)
    throw new CallError("target number is required", 400, "INVALID_SOURCE_CONTROL_MUTATION_CONTEXT");
  if (Object.keys(replayTarget).length > 0) {
    return { providerTarget: { ...providerTarget, number }, target: replayTarget };
  }
  if (kind.startsWith("issue-")) {
    const { data } = await api(call, "GET", `${repoPath(project)}/issues/${number}`);
    return asJson({ providerTarget: { ...providerTarget, number }, target: mutationTarget(context, project, { number: data.number }) });
  }
  const pull = await readPull(call, project, number);
  for (const [key, actual] of [["head", pull.head.ref], ["base", pull.base.ref], ["headSha", pull.head.sha]]) {
    const wanted = text(expected, key);
    if (wanted && wanted !== actual)
      throw new CallError(`The pull request ${key} changed`, 409, "SOURCE_CONTROL_MUTATION_TARGET_MISMATCH");
  }
  return asJson({
    providerTarget: { ...providerTarget, number },
    target: mutationTarget(context, project, { number, head: pull.head.ref, base: pull.base.ref, headSha: pull.head.sha })
  });
};
var readResolved = (input) => {
  const resolved = objectOf(input, "resolved");
  const providerTarget = objectOf(resolved, "providerTarget");
  return {
    providerTarget: {
      repoId: integer(providerTarget, "repoId"),
      owner: text(providerTarget, "owner"),
      name: text(providerTarget, "name"),
      number: integer(providerTarget, "number") || undefined,
      sourceRepoId: integer(providerTarget, "sourceRepoId") || undefined,
      sourceOwner: text(providerTarget, "sourceOwner") || undefined
    },
    target: objectOf(resolved, "target")
  };
};
var perform = async (call, input) => {
  const kind = text(input, "kind");
  const normalized = objectOf(input, "input");
  const { providerTarget, target } = readResolved(input);
  const repo = repoPath(providerTarget);
  switch (kind) {
    case "change-request-create": {
      const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
      const fork = sourceRepoId !== providerTarget.repoId;
      const head = text(target, "head");
      const payload = {
        head: fork ? `${providerTarget.sourceOwner}:${head}` : head,
        base: text(target, "base"),
        title: text(normalized, "title")
      };
      const body = text(normalized, "body");
      if (body)
        payload.body = body;
      const { data } = await api(call, "POST", `${repo}/pulls`, { body: payload });
      if (branchRepoId(data.base) !== providerTarget.repoId || branchRepoId(data.head) !== sourceRepoId) {
        throw new CallError("The forge opened the pull request somewhere other than asked", 502);
      }
      return { number: data.number };
    }
    case "change-request-update": {
      const payload = { title: text(normalized, "title") };
      if (Object.hasOwn(normalized, "body"))
        payload.body = text(normalized, "body");
      await api(call, "PATCH", `${repo}/pulls/${providerTarget.number}`, { body: payload });
      return {};
    }
    case "change-request-merge": {
      const payload = { Do: text(normalized, "method") || "merge" };
      const headSha = text(target, "headSha");
      if (headSha)
        payload.head_commit_id = headSha;
      await api(call, "POST", `${repo}/pulls/${providerTarget.number}/merge`, { body: payload });
      const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
      return { merged: pull.merged === true };
    }
    case "change-request-comment":
    case "issue-comment":
      await api(call, "POST", `${repo}/issues/${providerTarget.number}/comments`, { body: { body: text(normalized, "body") } });
      return {};
    case "change-request-state":
    case "issue-state": {
      const state = text(normalized, "state");
      const { data } = await api(call, "PATCH", `${repo}/issues/${providerTarget.number}`, { body: { state } });
      if (data.state !== state)
        throw new CallError("The forge did not change the state", 502);
      return { state };
    }
    default:
      throw new CallError(`${kind} is not something this Git host offers`, 501, "UNSUPPORTED");
  }
};
var NOT_APPLIED = { state: "failed", result: { failureStatus: 409, failureCode: "SOURCE_CONTROL_MUTATION_NOT_APPLIED" } };
var reconcile = async (call, input) => {
  const kind = text(input, "kind");
  const normalized = objectOf(input, "input");
  const { providerTarget, target } = readResolved(input);
  const repo = repoPath(providerTarget);
  switch (kind) {
    case "change-request-create": {
      const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
      const { data } = await api(call, "GET", `${repo}/pulls`, { query: { state: "all", sort: "recentupdate", limit: String(SCAN_SIZE) } });
      const matches = data.filter((pull) => pull.head.ref === text(target, "head") && pull.base.ref === text(target, "base") && branchRepoId(pull.head) === sourceRepoId && branchRepoId(pull.base) === providerTarget.repoId);
      return matches.length === 1 ? { state: "succeeded", result: { number: matches[0].number } } : { state: "outcome-unknown" };
    }
    case "change-request-update": {
      const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
      const landed = pull.title === text(normalized, "title") && (!Object.hasOwn(normalized, "body") || (pull.body ?? "") === text(normalized, "body"));
      return landed ? { state: "succeeded", result: {} } : { state: "outcome-unknown" };
    }
    case "change-request-merge": {
      const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
      return pull.merged ? { state: "succeeded", result: { merged: true } } : NOT_APPLIED;
    }
    case "change-request-state":
    case "issue-state": {
      const { data } = await api(call, "GET", `${repo}/issues/${providerTarget.number}`);
      return data.state === text(normalized, "state") ? { state: "succeeded", result: { state: data.state } } : NOT_APPLIED;
    }
    default:
      return { state: "outcome-unknown" };
  }
};
var failureOf = (error) => {
  const message = error.message.slice(0, SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX) || "Unexpected failure";
  if (error instanceof SourceControlForgeError)
    return { message, status: 502, code: "FORGE_UNREACHABLE" };
  if (!(error instanceof CallError))
    return { message, status: 500 };
  const failure = { message, status: error.status };
  if (error.code)
    failure.code = error.code;
  return failure;
};
var answer = async (request) => {
  if (!request.session)
    return { ok: false, error: { message: "Every call to this Git host needs a session", status: 400 } };
  const call = { session: request.session, identity: { provider: request.provider, instance: request.session.instance } };
  try {
    return { ok: true, data: await handlers[request.method](call, request.input, request) };
  } catch (error) {
    return { ok: false, error: failureOf(error instanceof Error ? error : new Error(String(error))) };
  }
};
var send = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
var server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${serviceToken}`) {
    send(response, 401, { error: "unauthorized" });
    return;
  }
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && path === "/health") {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || path !== SOURCE_CONTROL_PROVIDER_PATH) {
    send(response, 404, { error: "not found" });
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const call = readSourceControlProviderRequest(Buffer.concat(chunks).toString("utf8"));
    if (!call) {
      send(response, 400, { error: "not a source-control call" });
      return;
    }
    answer(call).then((result) => send(response, 200, result), () => send(response, 500, { error: "unexpected failure" }));
  });
});
server.listen(port, "127.0.0.1");
