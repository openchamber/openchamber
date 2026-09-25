import {
  OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
  OPENCHAMBER_AGENT_TOOL_ACTIONS,
  OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
  OPENCHAMBER_MEMORY_ACTIONS,
  OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
  OPENCHAMBER_NOTIFY_ACTIONS,
  resolveAgentToolAction,
  OPENCHAMBER_WEB_ACTION_DEFINITIONS,
  OPENCHAMBER_WEB_ACTIONS,
} from '../openchamber-control/actions.js';

const TOOL_SCHEMA_VERSION = 1;
const PLUGIN_ID = 'openchamber-agent-tool';
// Everything either managed tool may ask for; the agent allowlist stays
// narrower than the full control surface.
const ACTIONS = new Set([
  ...OPENCHAMBER_AGENT_TOOL_ACTIONS,
  ...OPENCHAMBER_WEB_ACTIONS,
  ...OPENCHAMBER_MEMORY_ACTIONS,
  ...OPENCHAMBER_NOTIFY_ACTIONS,
]);
const AGENT_TOOL_ACTION_TITLES = Object.fromEntries(
  [
    ...OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
    ...OPENCHAMBER_WEB_ACTION_DEFINITIONS,
    ...OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
    ...OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
  ].map(({ action, title }) => [action, title]),
);

/**
 * Each tool carries only the inputs its own actions take.
 *
 * A shared parameter object would leave a disabled capability's inputs visible
 * in the other tool's schema, which is both misleading and paid for in context
 * on every call.
 */
const WEB_PARAMETER_NAMES = ['url', 'selector', 'text', 'value', 'submit', 'direction', 'viewport', 'label', 'tabId'];
// `title` is shared with the control tool, so it is not listed here — only the
// names memory alone introduces are kept out of the other schemas.
const MEMORY_ONLY_PARAMETER_NAMES = ['body', 'scope', 'memoryId', 'type'];
const MEMORY_PARAMETER_NAMES = [...MEMORY_ONLY_PARAMETER_NAMES, 'title'];

/**
 * `title` is shared with the control tool, where it means a session title, so
 * it carries no description in the shared map. Left undescribed for memory the
 * model has nothing to go on and invents a name for it — `name` was sent
 * repeatedly in practice — so memory states what its own `title` is.
 */
const MEMORY_PARAMETER_OVERRIDES = {
  title: { type: 'string', description: "The memory's title, exactly as the session index lists it. Use this to read an entry you can already see; use memoryId only when a result gave you one" },
  scope: { type: 'string', enum: ['global', 'project', 'both'], description: 'global is about the user and applies everywhere; project is about this codebase. Required for memory.save and memory.delete. Optional for memory.read and memory.list, which search both stores when it is omitted' },
};

const ALL_PARAMETER_PROPERTIES = {
  projectId: { type: 'string', description: 'Configured project ID; do not combine with directory' },
  directory: { type: 'string', description: 'Absolute checkout or session directory; defaults to the current session directory' },
  sessionId: { type: 'string' },
  messageId: { type: 'string', description: 'Optional fork boundary message ID' },
  taskId: { type: 'string' },
  title: { type: 'string' },
  prompt: { type: 'string' },
  model: { type: 'string', description: 'Model in provider/model format. When the user names no model: for session.create pick a suitable one from models.list favorites or recents (omit if there are none); for send and fork omit it — the session reuses its previous model' },
  agent: { type: 'string', description: 'OpenCode agent name; new sessions default to the build agent and existing sessions keep their previous one. Set only when the user explicitly requests a different agent' },
  variant: { type: 'string', description: 'Model variant; use only when the user explicitly requests it' },
  worktree: { type: 'string', description: 'New worktree name for session.create. Omit by default; use only when the user explicitly asks for an isolated worktree. Uncommitted changes do not carry over into a new worktree' },
  branch: { type: 'string', description: 'Branch name for the new worktree' },
  startRef: { type: 'string', description: 'Git ref used to create the new worktree' },
  setUpstream: { type: 'boolean', description: 'Make the new worktree branch track its upstream' },
  goal: { type: 'boolean', description: 'Run the dispatched prompt in Goal Mode; use only when the user explicitly requests it' },
  goalTokenBudget: { type: 'integer', minimum: 1000, maximum: 100_000_000, description: 'Goal token budget; requires goal' },
  wait: { type: 'boolean', description: 'Wait for current session activity to become idle. Omit by default; use only when the user asks or the next step requires the completed result' },
  timeout: { type: 'integer', minimum: 1, maximum: 86_400, description: 'Wait timeout in seconds (default 600); requires wait' },
  lastAssistant: { type: 'boolean', description: 'Return the last assistant text; create/send/fork require wait' },
  limit: { type: 'integer', minimum: 1, description: 'Maximum sessions or messages to return (default 10)' },
  all: { type: 'boolean', description: 'Include archived sessions or all messages, depending on the action' },
  last: { type: 'boolean', description: 'Return only the last matching session message' },
  withStatus: { type: 'boolean', description: 'Include authoritative status in session.list' },
  role: { type: 'string', enum: ['all', 'user', 'assistant'], description: 'Message role filter' },
  name: { type: 'string' },
  daily: { type: 'string', description: 'Daily run time in HH:mm format' },
  weekly: { type: 'string', description: 'Comma-separated weekdays; 0=Sunday and 6=Saturday' },
  once: { type: 'string', description: 'One-time run date in YYYY-MM-DD format' },
  time: { type: 'string', description: 'Weekly or one-time run time in HH:mm format' },
  cron: { type: 'string', description: 'Cron expression' },
  timezone: { type: 'string', description: 'IANA timezone' },
  disabled: { type: 'boolean', description: 'true disables and false enables; required for schedule.toggle' },
  path: { type: 'string', description: 'File to show for file.open; absolute, or relative to the session directory' },
  url: { type: 'string', description: 'http(s) URL for browser.open' },
  selector: { type: 'string', description: 'CSS selector from a browser.snapshot result' },
  text: { type: 'string', description: 'Visible label to match when no selector is given' },
  value: { type: 'string', description: 'Text to type for browser.type' },
  submit: { type: 'boolean', description: 'Press Enter after typing' },
  direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction for browser.scroll' },
  viewport: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'fill'], description: 'Page layout size; snapshots report which one is in effect' },
  label: { type: 'string', description: 'Short name for a browser.capture image, such as before-fix' },
  tabId: { type: 'string', description: 'Browser tab to act on, an id from the tabs a browser.snapshot lists. Omit to use the tab the user is looking at' },
  body: { type: 'string', description: 'Full text of the memory; state it so it still makes sense in a session that has none of this conversation' },
  scope: { type: 'string', enum: ['global', 'project', 'both'], description: 'global is about the user and applies everywhere; project is about this codebase. both is only valid for memory.list' },
  memoryId: { type: 'string', description: 'Memory ID from a memory.list or memory.read result' },
  type: { type: 'string', enum: ['fact', 'preference', 'reference'], description: 'fact is something true, preference is how the user wants work done, reference points at a resource that is hard to find again' },
};

const pickParameters = (names) => Object.fromEntries(
  Object.entries(ALL_PARAMETER_PROPERTIES).filter(([name]) => names.includes(name)),
);

const CONTROL_PARAMETER_PROPERTIES = pickParameters(
  Object.keys(ALL_PARAMETER_PROPERTIES).filter((name) => (
    !WEB_PARAMETER_NAMES.includes(name) && !MEMORY_ONLY_PARAMETER_NAMES.includes(name)
  )),
);
const WEB_PARAMETER_PROPERTIES = pickParameters(WEB_PARAMETER_NAMES);
const MEMORY_PARAMETER_PROPERTIES = {
  ...pickParameters(MEMORY_PARAMETER_NAMES),
  ...MEMORY_PARAMETER_OVERRIDES,
};

// Its own names, not the shared map: `title` and `body` mean something else in
// the control and memory tools.
const NOTIFY_PARAMETER_PROPERTIES = {
  title: { type: 'string', description: 'Short headline the user reads first, up to 120 characters' },
  body: { type: 'string', description: 'One or two sentences of detail, up to 500 characters' },
  showWhenFocused: { type: 'boolean', description: 'Show it even while the user is looking at OpenChamber. Only for something that cannot wait' },
};

const CONTROL_TOOL_DESCRIPTION = "Control OpenChamber projects, sessions, and scheduled tasks on the user's behalf. Sessions and scheduled tasks you create are for the user to follow and interact with. Do not decide on your own to hand parts of your current task to another session; when the user asks you to create a session, send a prompt to one, or schedule a task, do it, including when the work relates to your current task. Use one action per call. Scope with projectId or directory; omit both to use the current session directory. Session dispatches return immediately by default and you receive no notification when a dispatched session finishes, so never promise to report back on it; the user follows it in OpenChamber; a dispatched session needs no follow-up from you. If the user later asks how it went, use session.messages (add wait to block until it is idle, lastAssistant for just the final answer) — session.send always sends a NEW prompt and never just waits. Set wait only when the user asks or the next step requires the completed result. Session and worktree deletion are unavailable.";

const WEB_TOOL_DESCRIPTION = "Look at and interact with a web page in OpenChamber's browser panel, so you can check your own work rather than describing what you expect. Use one action per call. Open a page, snapshot it to read its text and its interactive elements, then click, type or scroll using the selectors the snapshot returned; snapshots also report any errors the page logged. Pass a selector to browser.snapshot to read one part of a long page. browser.inspect returns computed styles when the question is how something renders. Set viewport to check a layout at mobile, tablet or desktop size. The page runs with the user's real logins, so treat what you see as their live session.";

const MEMORY_TOOL_DESCRIPTION = "Keep what you learn across sessions, so the user does not have to explain the same thing twice. Use one action per call. The session already lists the titles of what is stored. A title is an abbreviation, not the memory: read the entry with memory.read once before acting on it (it then stays in your context; do not re-read it on later turns), because titles leave out the conditions and exceptions that decide how the memory applies, and the ones that look self-explanatory hide them most often. Save something only when it will still be true in a later session — a stable preference, a project convention, a decision and its reason, or a hard-won pointer. Do not save one-off task state, anything you can read from the code, secrets or credentials, or anything the user asked you not to keep; when the user explicitly asks you to remember something, save it, unless it is a secret or credential. Choose the scope deliberately: global is about the user and reaches every project, so put a project's conventions in project scope. Save in the moment, without asking first, when the user corrects how you work or states a preference, confirms that a non-obvious approach worked, or when you learn a project fact that took real effort to find. One fact per entry. The user can review and remove what you save, so save when it fits and mention it briefly.";

const NOTIFY_TOOL_DESCRIPTION = "Send the user a notification through OpenChamber, so they learn about something without watching the session. Use it when you finish work that took long enough for the user to step away, when you are blocked on something only the user can resolve, or when the user asked to be told about something. Do not use it for routine progress, for every finished step, or to repeat what your reply already says to a user who is present. Keep the title short and put detail in the body.";

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const createResult = ({ ok, action, data, error, exitCode }) => ({
  schemaVersion: TOOL_SCHEMA_VERSION,
  ok,
  action: action || 'unknown',
  ...(data !== undefined ? { data } : {}),
  ...(error ? { error } : {}),
  ...(Number.isInteger(exitCode) ? { exitCode } : {}),
});

// Node reports an IPv4 peer on a dual-stack socket as `::ffff:<ipv4>`.
const normalizeAddress = (value) => {
  const address = (asNonEmptyString(value) || '').toLowerCase();
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
};

const isLoopbackAddress = (value) => {
  const address = normalizeAddress(value);
  return address === '127.0.0.1' || address === '::1';
};

const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::']);

// A wildcard listener answers on loopback. A listener bound to one concrete
// address answers only there, so that address is the only way back in.
const resolveConcreteBoundAddress = (value) => {
  const address = normalizeAddress(value);
  return address && !WILDCARD_ADDRESSES.has(address) ? address : null;
};

/**
 * One template, one entry per enabled capability.
 *
 * Both tools speak to the same callback with the same envelope; only the action
 * set, the inputs and the description differ. Generating them from one template
 * keeps the transport, metadata and failure handling identical, which is what
 * the caller depends on.
 *
 * OpenCode 2 takes a tool's `input` as plain JSON Schema, so the generated file
 * needs no imports at all — which it must not have, because OpenCode loads the
 * entrypoint with a bare dynamic import and nothing resolves from the generated
 * directory.
 *
 * The action schema carries `oneOf` only. A node combining `enum` and `oneOf`
 * is valid JSON Schema, but some OpenAI-compatible gateways reject it and
 * answer with an empty completion instead of an error, and the `oneOf` branches
 * are what carry the per-action descriptions the model reads.
 */
const createToolEntry = ({ name, description, definitions, parameters }) => String.raw`    tools.add({
      name: ${JSON.stringify(name)},
      description: ${JSON.stringify(description)},
      input: {
        type: "object",
        properties: {
          action: { type: "string", oneOf: ${JSON.stringify(definitions.map((entry) => ({ const: entry.action, description: entry.description })))}, description: "OpenChamber action to perform" },
          parameters: { type: "object", properties: ${JSON.stringify(parameters)}, additionalProperties: false, description: "Inputs for the action; use an empty object when none are needed" },
        },
        required: ["action"],
        // Models routinely put the inputs next to the action; the schema has to
        // let that reach execute() instead of rejecting the call.
        additionalProperties: true,
      },
      async execute(input, context) {
        // Models routinely put the inputs next to the action instead of inside
        // the parameters object, and dropping them there produced a
        // "url is required" error for a call that plainly carried a url. Both
        // shapes are accepted; an explicit parameters object wins on a conflict.
        const { action: requestedAction, parameters, ...flattened } = input ?? {}
        const args = { ...flattened, ...(parameters ?? {}), action: requestedAction }
        const actionTitles = ${JSON.stringify(AGENT_TOOL_ACTION_TITLES)}
        const title = Object.hasOwn(actionTitles, args.action) ? actionTitles[args.action] : args.action
        const progress = (extra) => context.progress({
          ${name}: {
            schemaVersion: ${TOOL_SCHEMA_VERSION},
            action: args.action,
            description: title,
            ...extra,
          },
        })
        await progress()
        const endpoint = process.env.OPENCHAMBER_AGENT_TOOL_URL
        const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
        // No output schema is declared, so a result must never carry an output
        // field: OpenCode rejects that with "Tool result declared output
        // without an output schema". The envelope travels as text content.
        const failure = (payload) => ({
          content: JSON.stringify(payload),
          metadata: { openchamber: { schemaVersion: ${TOOL_SCHEMA_VERSION}, action: args.action, description: title, ok: false } },
        })
        if (!endpoint || !token) {
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: "OpenChamber managed tool connection is unavailable" } })
        }

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: "Bearer " + token,
              "content-type": "application/json",
            },
            // OpenCode 2 no longer hands a tool its session directory, so the
            // session id goes over instead and OpenChamber resolves the
            // directory on its own side. The signal fires when the session is
            // aborted, so the OpenChamber side stops the action too.
            body: JSON.stringify({ input: args, sessionID: context.sessionID, tool: ${JSON.stringify(name)} }),
            signal: context.signal,
          })
          const content = await response.text()
          let result = null
          try { result = JSON.parse(content) } catch {}
          const valid = result?.schemaVersion === ${TOOL_SCHEMA_VERSION} && typeof result?.ok === "boolean" && typeof result?.action === "string"
          await progress({ ok: valid && result.ok === true })
          if (valid) return { content, metadata: { openchamber: { schemaVersion: ${TOOL_SCHEMA_VERSION}, action: args.action, description: title, ok: result.ok === true } } }
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: "OpenChamber returned an invalid response", kind: "runtime", status: response.status } })
        } catch (error) {
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: error instanceof Error ? error.message : String(error), kind: "runtime" } })
        }
      },
    })
`;

const createPluginSource = ({ includeControl, includeWeb, includeMemory, includeNotify }) => {
  const entries = [];
  if (includeControl) {
    entries.push(createToolEntry({
      name: 'openchamber',
      description: CONTROL_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
      parameters: CONTROL_PARAMETER_PROPERTIES,
    }));
  }
  if (includeWeb) {
    entries.push(createToolEntry({
      name: 'openchamber_web',
      description: WEB_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_WEB_ACTION_DEFINITIONS,
      parameters: WEB_PARAMETER_PROPERTIES,
    }));
  }
  if (includeMemory) {
    entries.push(createToolEntry({
      name: 'openchamber_memory',
      description: MEMORY_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
      parameters: MEMORY_PARAMETER_PROPERTIES,
    }));
  }
  if (includeNotify) {
    entries.push(createToolEntry({
      name: 'openchamber_notify',
      description: NOTIFY_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
      parameters: NOTIFY_PARAMETER_PROPERTIES,
    }));
  }

  // The callback carries the per-child token over plain HTTP. With a proxy in
  // the child's environment, fetch would hand a non-loopback callback, token
  // included, to that proxy, and no per-request option turns that off. The
  // exemption is added inside the child because only there is the final
  // NO_PROXY, merged from the shell and server environments, visible.
  return `const exemptCallbackFromProxy = () => {
  const endpoint = process.env.OPENCHAMBER_AGENT_TOOL_URL
  if (!endpoint || !URL.canParse(endpoint)) return
  const host = new URL(endpoint).hostname.replace(/^\\[|\\]$/g, "")
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] || "").split(",").map((entry) => entry.trim()).filter(Boolean)
    if (!entries.includes(host)) process.env[key] = [...entries, host].join(",")
  }
}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    exemptCallbackFromProxy()
    await ctx.tool.transform((tools) => {
${entries.join('')}    })
  },
}
`;
};

// A configured plugin has to be a directory carrying a package.json that
// resolves an entrypoint; OpenCode skips a plain .js path.
const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: 'openchamber-agent-tool',
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

export const createAgentToolRuntime = (dependencies) => {
  const {
    crypto,
    fsPromises,
    path,
    dataDir,
    getActivePort,
    getActiveHost = () => null,
    executeAction,
    resolveSessionDirectory,
  } = dependencies;
  const pluginRoot = path.join(dataDir, 'agent-tool');
  const pluginDirectory = path.join(pluginRoot, PLUGIN_ID);
  const pluginPath = path.join(pluginDirectory, 'index.js');
  const pluginManifestPath = path.join(pluginDirectory, 'package.json');
  let activeToken = null;

  const getConcreteBoundAddress = () => resolveConcreteBoundAddress(getActiveHost());

  /**
   * Write the plugin for the requested tool set and return its directory.
   *
   * Called both before a managed child starts and whenever the tool settings
   * change while it runs, so the source on disk always matches the settings —
   * the running OpenCode reloads the directory it already has configured.
   */
  const materializePlugin = async ({ includeControl = true, includeWeb = true, includeMemory = true, includeNotify = false } = {}) => {
    if (!includeControl && !includeWeb && !includeMemory && !includeNotify) {
      throw new Error('At least one OpenChamber managed tool must be enabled to inject the plugin');
    }
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginManifestPath, PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(pluginPath, createPluginSource({ includeControl, includeWeb, includeMemory, includeNotify }), { mode: 0o600 });
    return pluginDirectory;
  };

  /**
   * Callback URL and a fresh per-child token for a managed OpenCode process.
   *
   * These are always part of the child environment, including when every tool
   * is currently off: a tool switched on later reaches a process that already
   * knows where and how to call back, so the toggle needs no restart.
   */
  const createChildEnv = () => {
    const port = getActivePort();
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('OpenChamber listener port is unavailable for managed tool injection');
    }
    activeToken = crypto.randomBytes(32).toString('base64url');
    // A listener bound to one concrete address does not answer on loopback,
    // so the callback has to point at the bound address instead.
    const callbackAddress = getConcreteBoundAddress() || '127.0.0.1';
    const callbackHost = callbackAddress.includes(':') ? `[${callbackAddress}]` : callbackAddress;
    return {
      OPENCHAMBER_AGENT_TOOL_URL: `http://${callbackHost}:${port}/api/openchamber/agent-tool`,
      OPENCHAMBER_AGENT_TOOL_TOKEN: activeToken,
    };
  };

  // The managed child runs on this machine. Reaching a listener bound to one
  // concrete address makes the OS source the connection from that same address,
  // so it stands in for loopback there; any other machine arrives as itself.
  const isSameMachineAddress = (value) => {
    if (isLoopbackAddress(value)) return true;
    const boundAddress = getConcreteBoundAddress();
    return boundAddress !== null && normalizeAddress(value) === boundAddress;
  };

  const authorize = (req) => {
    if (!activeToken || !isSameMachineAddress(req.socket?.remoteAddress)) return false;
    const header = asNonEmptyString(req.headers?.authorization);
    if (!header?.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(activeToken);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  const execute = async (payload = {}, options = {}) => {
    const requested = asNonEmptyString(payload.input?.action);
    // Resolved against the calling tool's own actions: models drop the
    // namespace that the tool's name already implies, and answering "read" with
    // a bare "unsupported" leaves them to guess a second wrong name.
    const resolution = resolveAgentToolAction(requested, asNonEmptyString(payload.tool));
    if (resolution.error) {
      return createResult({ ok: false, action: requested, error: { message: resolution.error, kind: 'usage' } });
    }
    const action = resolution.action;
    if (!ACTIONS.has(action)) {
      return createResult({ ok: false, action, error: { message: `Unsupported OpenChamber action: ${action}`, kind: 'usage' } });
    }
    if (typeof executeAction !== 'function') {
      return createResult({ ok: false, action, error: { message: 'OpenChamber control service is unavailable', kind: 'runtime' } });
    }
    // OpenCode 2 tools no longer receive a directory, so the plugin sends the
    // session id and the directory is resolved here. An unresolvable session
    // falls through with no directory, exactly like the old "no directory" path.
    let contextDirectory = asNonEmptyString(payload.contextDirectory) ?? undefined;
    const sessionID = asNonEmptyString(payload.sessionID);
    if (!contextDirectory && sessionID && typeof resolveSessionDirectory === 'function') {
      contextDirectory = await Promise.resolve(resolveSessionDirectory(sessionID))
        .then((value) => asNonEmptyString(value) ?? undefined)
        .catch(() => undefined);
    }
    try {
      // The calling session scopes browser actions to that session's page.
      const contextSessionId = asNonEmptyString(payload.contextSessionId) ?? sessionID;
      const data = await executeAction(action, { ...payload.input, action }, contextDirectory, contextSessionId
        ? { ...options, contextSessionId }
        : options);
      return createResult({ ok: true, action, data });
    } catch (error) {
      return createResult({
        ok: false,
        action,
        ...(error?.partial === true ? { data: {
          partial: true,
          partialAction: error.partialAction,
          sessionId: error.sessionId,
          directory: error.directory,
        } } : {}),
        error: {
          message: error instanceof Error ? error.message : String(error),
          kind: Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 499 ? 'usage' : 'runtime',
        },
      });
    }
  };

  // In-flight actions per session. The plugin forwards OpenCode's abort
  // signal (2.0.12+), which closes its request and aborts the action here.
  // Before that release the request stayed open after the user cancelled the
  // turn, so the server also listens for the cancel on the event stream
  // (`session.idle` with `aborted: true`) and aborts the actions itself.
  const inflightBySession = new Map();
  const trackInflight = (sessionID, controller) => {
    if (!sessionID) return () => {};
    const set = inflightBySession.get(sessionID) ?? new Set();
    set.add(controller);
    inflightBySession.set(sessionID, set);
    return () => {
      set.delete(controller);
      if (set.size === 0) inflightBySession.delete(sessionID);
    };
  };
  const abortSession = (sessionID) => {
    const set = inflightBySession.get(asNonEmptyString(sessionID));
    if (!set) return 0;
    for (const controller of set) controller.abort();
    return set.size;
  };

  const registerRoutes = (app, express) => {
    app.post('/api/openchamber/agent-tool', express.json({ limit: '1mb' }), async (req, res) => {
      if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
      const controller = new AbortController();
      const abortOnDisconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once('aborted', abortOnDisconnect);
      res.once('close', abortOnDisconnect);
      const untrack = trackInflight(asNonEmptyString(req.body?.sessionID), controller);
      try {
        return res.json(await execute(req.body, { signal: controller.signal }));
      } catch (error) {
        return res.json(createResult({
          ok: false,
          action: req.body?.input?.action,
          error: { message: error instanceof Error ? error.message : String(error), kind: 'runtime' },
        }));
      } finally {
        untrack();
        req.off('aborted', abortOnDisconnect);
        res.off('close', abortOnDisconnect);
      }
    });
  };

  return {
    pluginDirectory,
    materializePlugin,
    createChildEnv,
    authorizeRequest: authorize,
    registerRoutes,
    execute,
    abortSession,
  };
};
