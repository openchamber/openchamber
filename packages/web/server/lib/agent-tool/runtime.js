import os from 'node:os';
import path from 'node:path';

import { asNonEmptyString, isBoolean } from '../shared/guards.js';
import {
  OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
  OPENCHAMBER_AGENT_TOOL_ACTIONS,
  OPENCHAMBER_KNOWLEDGE_ACTION_DEFINITIONS,
  OPENCHAMBER_KNOWLEDGE_ACTIONS,
  OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
  OPENCHAMBER_MEMORY_ACTIONS,
  OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
  OPENCHAMBER_NOTIFY_ACTIONS,
  OPENCHAMBER_RENDER_ACTION_DEFINITIONS,
  OPENCHAMBER_RENDER_ACTIONS,
  OPENCHAMBER_SCHEDULE_ACTION_DEFINITIONS,
  OPENCHAMBER_SCHEDULE_ACTIONS,
  resolveAgentToolAction,
  OPENCHAMBER_WEB_ACTION_DEFINITIONS,
  OPENCHAMBER_WEB_ACTIONS,
} from '../openchamber-control/actions.js';
import {
  RENDER_PAGE_CLOSED_IN_CHAT_NOTE,
  RENDER_PAGE_MAX_HTML_LENGTH,
  RENDER_PAGE_MAX_TITLE_LENGTH,
} from '../openchamber-control/render-page.js';
import { createCallbackAddress } from './callback-address.js';

const TOOL_SCHEMA_VERSION = 1;
const PLUGIN_ID = 'openchamber-agent-tool';
// Everything either managed tool may ask for; the agent allowlist stays
// narrower than the full control surface.
const ACTIONS = new Set([
  ...OPENCHAMBER_AGENT_TOOL_ACTIONS,
  ...OPENCHAMBER_SCHEDULE_ACTIONS,
  ...OPENCHAMBER_WEB_ACTIONS,
  ...OPENCHAMBER_MEMORY_ACTIONS,
  ...OPENCHAMBER_KNOWLEDGE_ACTIONS,
  ...OPENCHAMBER_NOTIFY_ACTIONS,
  ...OPENCHAMBER_RENDER_ACTIONS,
]);
const AGENT_TOOL_ACTION_TITLES = Object.fromEntries(
  [
    ...OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
    ...OPENCHAMBER_SCHEDULE_ACTION_DEFINITIONS,
    ...OPENCHAMBER_WEB_ACTION_DEFINITIONS,
    ...OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
    ...OPENCHAMBER_KNOWLEDGE_ACTION_DEFINITIONS,
    ...OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
    ...OPENCHAMBER_RENDER_ACTION_DEFINITIONS,
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
// The task inputs; the schedule tool shares the scope and the run settings
// (prompt, model, agent, goal) with the control tool.
const SCHEDULE_ONLY_PARAMETER_NAMES = ['taskId', 'name', 'targetSessionId', 'daily', 'weekly', 'once', 'time', 'cron', 'timezone', 'disabled'];
const SCHEDULE_PARAMETER_NAMES = [...SCHEDULE_ONLY_PARAMETER_NAMES, 'projectId', 'directory', 'prompt', 'model', 'variant', 'agent', 'goal', 'goalTokenBudget'];

/**
 * `model` and `agent` describe a dispatched session in the shared map; a task
 * picks them for every run, so the schedule tool says what they mean there.
 */
const SCHEDULE_PARAMETER_OVERRIDES = {
  model: { type: 'string', description: 'provider/model; required unless targetSessionId is set, which keeps that session\'s model' },
  agent: { type: 'string', description: 'Only when the user asks. Default: build' },
};

/**
 * `title` is shared with the control tool, where it means a session title, so
 * it carries no description in the shared map. Left undescribed for memory the
 * model has nothing to go on and invents a name for it — `name` was sent
 * repeatedly in practice — so memory states what its own `title` is.
 */
const MEMORY_PARAMETER_OVERRIDES = {
  title: { type: 'string', description: 'As the session index spells it; prefer it over memoryId for an entry you can see' },
  scope: { type: 'string', enum: ['global', 'project', 'both'], description: 'global: about the user, every project. project: this codebase. Required for save and delete; read and list search both when omitted' },
};

const ALL_PARAMETER_PROPERTIES = {
  projectId: { type: 'string', description: 'Not with directory' },
  directory: { type: 'string', description: "Absolute path; default: this session's directory" },
  sessionId: { type: 'string' },
  messageId: { type: 'string', description: 'Fork boundary' },
  link: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string', enum: ['change', 'issue'], description: 'change: pull, merge or change request. issue: task or ticket' },
      identifier: { type: 'string', description: 'Short label such as !42 or OPS-7' },
    },
    required: ['url', 'title', 'kind'],
    additionalProperties: false,
  },
  taskId: { type: 'string' },
  targetSessionId: { type: 'string', description: 'Run in this session instead of a new one; empty on update clears it' },
  title: { type: 'string' },
  prompt: { type: 'string' },
  model: { type: 'string', description: "provider/model. session.create with an agent and no model runs that agent's bound model; with neither, it picks from models.list favorites or recents, or omits it; send and fork omit it to keep the session's model" },
  agent: { type: 'string', description: 'Only when the user asks. Default: build for a new session, unchanged for an existing one' },
  variant: { type: 'string', description: 'Only when the user asks' },
  worktree: { type: 'string', description: 'Folder name of a new worktree, named after the task (fix-login-timeout). Required for session.moveToWorktree; on session.create only when the user asks, and uncommitted changes stay behind' },
  branch: { type: 'string', description: 'Default: the worktree name' },
  startRef: { type: 'string', description: "Ref the new branch starts from; default: the repository's default branch" },
  carry: { type: 'array', items: { type: 'string' }, description: 'Files you changed whose uncommitted changes move along; nothing else moves' },
  existingBranch: { type: 'string', description: 'Check out this existing local or remote branch (origin/feature) instead of a new one; not with branch or startRef' },
  setUpstream: { type: 'boolean', description: 'Track the upstream branch' },
  pullRequest: { type: 'integer', minimum: 1, description: "session.create only, when the user asks to work on that pull or merge request: the session starts in a new worktree on its branch. worktree and branch then only rename the folder and local branch" },
  goal: { type: 'boolean', description: 'Goal Mode; only when the user asks' },
  goalTokenBudget: { type: 'integer', minimum: 1000, maximum: 100_000_000, description: 'Requires goal' },
  returnResult: { type: 'boolean', description: 'create, send or fork with a prompt: the final answer arrives here as a message when the session finishes. Only when the user wants the outcome or your next step needs it' },
  lastAssistant: { type: 'boolean', description: 'Only the last assistant message' },
  limit: { type: 'integer', minimum: 1, description: 'Default 10' },
  all: { type: 'boolean', description: 'Include archived sessions, all messages, or older model versions' },
  query: { type: 'string', description: 'Words to match in model names and ids' },
  provider: { type: 'string', description: 'Provider id or name' },
  offset: { type: 'integer', minimum: 0, description: 'Results to skip, for the next page' },
  last: { type: 'boolean', description: 'Only the last matching message' },
  withStatus: { type: 'boolean' },
  role: { type: 'string', enum: ['all', 'user', 'assistant'] },
  name: { type: 'string' },
  daily: { type: 'string', description: 'HH:mm' },
  weekly: { type: 'string', description: 'Comma-separated weekdays, 0 is Sunday' },
  once: { type: 'string', description: 'YYYY-MM-DD' },
  time: { type: 'string', description: 'HH:mm for weekly or once' },
  cron: { type: 'string' },
  timezone: { type: 'string', description: 'IANA' },
  disabled: { type: 'boolean' },
  path: { type: 'string', description: 'Absolute, or relative to the session directory' },
  url: { type: 'string', description: 'http(s)' },
  selector: { type: 'string', description: 'From browser.snapshot' },
  text: { type: 'string', description: 'Visible label, when no selector' },
  value: { type: 'string' },
  submit: { type: 'boolean', description: 'Press Enter after typing' },
  direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
  viewport: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'fill'] },
  label: { type: 'string', description: 'Image name, such as before-fix' },
  tabId: { type: 'string', description: "From the tabs browser.snapshot lists. Default: the tab you last used; else the user's open tab, if they opened it in this project" },
  body: { type: 'string', description: 'At most 2000 characters; longer is rejected. Written to make sense without this conversation' },
  memoryId: { type: 'string', description: 'From memory.list or memory.read; on save it rewrites that entry' },
  type: { type: 'string', enum: ['fact', 'preference', 'reference'], description: 'fact: something true. preference: how the user wants work done. reference: a resource hard to find again' },
};

const pickParameters = (names) => Object.fromEntries(
  Object.entries(ALL_PARAMETER_PROPERTIES).filter(([name]) => names.includes(name)),
);

const CONTROL_PARAMETER_PROPERTIES = pickParameters(
  Object.keys(ALL_PARAMETER_PROPERTIES).filter((name) => (
    !WEB_PARAMETER_NAMES.includes(name)
    && !MEMORY_ONLY_PARAMETER_NAMES.includes(name)
    && !SCHEDULE_ONLY_PARAMETER_NAMES.includes(name)
  )),
);
const SCHEDULE_PARAMETER_PROPERTIES = {
  ...pickParameters(SCHEDULE_PARAMETER_NAMES),
  ...SCHEDULE_PARAMETER_OVERRIDES,
};
const WEB_PARAMETER_PROPERTIES = pickParameters(WEB_PARAMETER_NAMES);
const MEMORY_PARAMETER_PROPERTIES = {
  ...pickParameters(MEMORY_PARAMETER_NAMES),
  ...MEMORY_PARAMETER_OVERRIDES,
};

// Its own names, not the shared map: `title`, `body` and `text` mean something
// else in the other tools.
const KNOWLEDGE_PARAMETER_PROPERTIES = {
  ...pickParameters(['projectId', 'directory']),
  kind: { type: 'string', enum: ['note', 'todo', 'plan'] },
  id: { type: 'string', description: 'From list or save; omit on save to create' },
  body: { type: 'string', description: 'Note at most 3000 characters, todo 1000, plan (whole markdown) 200000' },
  completed: { type: 'boolean', description: 'Todo state; false reopens it' },
  expected: { type: 'string', description: "The text as you last read it; the save fails if it changed since. Then refresh (knowledge.list for a note's body, your file tools for a plan) and retry with the same id and the fresh text" },
};

// Its own names, not the shared map: `title` and `body` mean something else in
// the control and memory tools.
const NOTIFY_PARAMETER_PROPERTIES = {
  title: { type: 'string', description: 'Up to 120 characters' },
  body: { type: 'string', description: 'Up to 500 characters' },
  showWhenFocused: { type: 'boolean', description: 'Show it while the user is in OpenChamber too, otherwise it shows only while they are away. Only for what cannot wait' },
};

// Where the agent saves a screenshot for a page, so it stays out of the
// project. The image grant route (../markdown-image-grants/routes.js) reads a
// page's images from anywhere on the machine.
const OPENCODE_TEMP_DIRECTORY = path.join(os.tmpdir(), 'opencode');

// How to write a page lives on `html` and how to ask on one on `awaitAnswer`.
// Claude Code cuts a tool description at 2048 characters on older CLIs and
// 4096 on newer ones, and leaves the input schema whole, so the long rules sit
// where they are read anyway: while the agent writes that input.
// The variables are the ones packages/ui/src/components/chat/message/parts/htmlRender.ts
// injects; change both together.
const RENDER_PAGE_HTML_DESCRIPTION = [
  `One self-contained HTML document, at most ${RENDER_PAGE_MAX_HTML_LENGTH} characters, with inline <style> and <script>. Remote scripts and stylesheets do not load in every client, so draw charts with inline SVG or your own script.`,
  "Layout: fluid width, as wide as the reply column (about 720px on desktop, 360px on phones), no horizontal padding on the outermost element, nothing wider; stack or wrap, and give a wide table its own overflow-x:auto box. The frame takes the page's height, so keep it short, give charts fixed pixel heights, and never use 100vh or height:100% on html or body.",
  "Ready classes in the app's look, so these need no CSS of your own: .oc-box (a box; a box inside it steps up a tone), .oc-muted (secondary text), .oc-table on a div around a <table> (scrolls sideways when wide), .oc-num (tabular figures, end-aligned), .oc-badge with optional data-tone=\"success|warning|error|info\", .oc-dot (a legend dot) and .oc-bar (a horizontal bar) colored by --color (default --chart-1), the bar as long as --value (a percentage), .oc-field (a <label> around its text and control), .oc-input on an input, select or textarea, .oc-switch on a checkbox, .oc-segmented around <button>s (aria-pressed=\"true\" on the chosen one; also tabs). A line only where it means something, such as a divider between sections.",
  "Theme variables on :root, updated live on a theme switch: --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --border, --primary, --primary-foreground, --destructive, --warning, --success, --info, --code-background, --code-foreground, --chart-1 to --chart-6 (series), --radius, --font-sans, --font-mono. A base stylesheet already sets text color, font and size; the root font size is the chat's text size and follows the user's interface size, so size text in rem or em, not px. A page with its own colors, such as a mockup of the user's project, sets a color on all its text and gives itself a background: text without a color takes the theme's, and without a background the page shows the chat's.",
  "Scripts may add tooltips, tabs, toggles, sorting. On a phone a tap shows a hover tooltip, so keep tooltips and popups inside the page and flip them near an edge.",
  `Images: https, data:, or a local PNG, JPEG, GIF or WebP named by absolute path in src, CSS url() or a quoted script string, at most 10 MB each and 12 per page. Save a screenshot for a page in ${OPENCODE_TEMP_DIRECTORY}.`,
  "The page is sandboxed: no access to OpenChamber, the network session or local files; links open in the user's browser.",
].join(' ');

const RENDER_PAGE_AWAIT_DESCRIPTION = [
  "Wait for the user to choose, fill in fields, or both, on the page. Give it one button whose click calls openchamber.submit(data, summary): data is the JSON your next step needs, summary the choice in a few words of the user's language, shown under the page. submit works only from a click on a waiting page and returns a promise; disable the button once it resolves.",
  "The call returns summary and data, or answered: false when the user wrote in the chat instead; their message follows.",
  "Reloaded, the page gets openchamber.answer set to its data, to show the choice. Base classes: .oc-options (a grid), .oc-option on a <button> (aria-pressed=\"true\" when chosen), .oc-button (the send button; data-variant=\"outline\" for a secondary action, \"destructive\" for a dangerous one).",
].join(' ');

// Its own names: `title` here names the page.
const RENDER_PARAMETER_PROPERTIES = {
  html: { type: 'string', description: RENDER_PAGE_HTML_DESCRIPTION },
  title: { type: 'string', description: `At most ${RENDER_PAGE_MAX_TITLE_LENGTH} characters; without it the page's <title> or first heading names it` },
  awaitAnswer: { type: 'boolean', description: RENDER_PAGE_AWAIT_DESCRIPTION },
};

// When to act (link an issue, save a memory, draw a page) is stated once, in
// every session's context (../session-knowledge/runtime.js): a rule the agent
// must apply before it thinks of a tool cannot live in the tool. The
// descriptions say what the tool is and how to use it.
//
// The worktree move is an introduction, not a rule: whether a busy checkout
// calls for a worktree depends on how the user works, and users ask for a pull
// request or for work kept apart rather than for a worktree.
const CONTROL_TOOL_DESCRIPTION = "OpenChamber projects, sessions and worktrees. One action per call; projectId or directory scope it, default this session's directory. "
  + "A session you create, send to or fork belongs to the user, who follows and talks to it. Dispatch one when the user asks, even for work related to yours, with any agent, optionally in a new worktree; to delegate part of your own task, use the subagent tool. A dispatch returns at once; returnResult brings its final answer back here as a message. session.send always starts a new prompt. "
  + "session.moveToWorktree moves this session into a new worktree on a new branch from the default branch, taking the changed files you name in carry. It can help when the checkout looks busy: someone's pull request branch, uncommitted changes, another session here, a branch changed between your messages. Whether that fits depends on how the user works: ask, unless the request already calls for separate work, such as a pull request of its own. Unlike git worktree add, the session moves along and the branch starts from the default branch. "
  + "This tool cannot delete sessions or worktrees.";

const SCHEDULE_TOOL_DESCRIPTION = "Scheduled tasks: prompts OpenChamber runs on a schedule, in a new session each run or in targetSessionId. A task is the user's; create or change one when the user asks. One action per call; projectId or directory scope it, default this session's directory.";

const WEB_TOOL_DESCRIPTION = "OpenChamber's browser panel, to check your work by looking at it. One action per call: open, snapshot for text, selectors and errors, then click, type or scroll by those selectors. Close tabs you opened for your own work with browser.close; leave open the ones you opened to show the user something. The page runs with the user's real logins; treat it as their live session.";

const MEMORY_TOOL_DESCRIPTION = "Memory that persists across sessions. One fact per entry. Save what code and docs do not show: a decision and its reason, a rejected alternative, a deliberate \"leave this as it is\", the user's corrections and preferences, a hard-won pointer. Never one-off task state, secrets or credentials, or what the user asked you not to keep; what the user explicitly asks you to remember, save. Put project conventions in project scope.";

const KNOWLEDGE_TOOL_DESCRIPTION = "The project's Notes, Todos and Plans, shown in OpenChamber's Project knowledge panel and shared by its sessions. One action per call; list returns everything. "
  + "Notes: short facts the user wants at hand; your own learnings go to memory. Todos: the user's backlog; add one when asked or when you stop with work left, never for the steps of your current task. "
  + "Plans: markdown files. list gives their paths; read and edit them with your file tools, save creates or replaces one whole. A plan starts with a # title and a ## Steps checklist (- [ ] per coarse step), then detail. A plan written for the user: save, show, wait for their comments; they send it to a session. Implementing one: tick each step (- [x]) as you finish it and change nothing else unless asked; never drop a constraint. "
  + "Replacing a note or plan: pass expected. If the save fails on it, refresh and retry the save with the same id.";

const NOTIFY_TOOL_DESCRIPTION = "Notify the user outside the chat: when long work finishes and they have likely stepped away, when you are blocked on them, or when they asked to be told. Routine progress and what your reply already says stay in the chat.";

const RENDER_TOOL_DESCRIPTION = "Draw a finished HTML page inline in the chat, above your reply, or ask the user to choose on one (awaitAnswer). "
  + "The page is part of your reply and sits on the chat's background: leave html, body and the outermost element without a background, add no outer card, border or banner title, and set boxes apart by tone. Style with the theme variables listed under html. "
  + "Read html before writing a page and awaitAnswer before asking on one.";

// A field means the same thing in every tool that declares it, so one set
// covers them all.
const BOOLEAN_PARAMETER_NAMES = [...new Set([
  ALL_PARAMETER_PROPERTIES,
  SCHEDULE_PARAMETER_PROPERTIES,
  MEMORY_PARAMETER_PROPERTIES,
  KNOWLEDGE_PARAMETER_PROPERTIES,
  NOTIFY_PARAMETER_PROPERTIES,
  RENDER_PARAMETER_PROPERTIES,
].flatMap((properties) => Object.entries(properties)
  .filter(([, schema]) => schema.type === 'boolean')
  .map(([name]) => name)))];

/**
 * The plugin forwards the model's arguments as raw JSON, so a boolean can
 * arrive as the string "true", and every `=== true` downstream would read it as
 * false and quietly do something else (a dispatch without Goal Mode, a result
 * never delivered). Such a call fails here with the field named, so the model
 * retries it with a real boolean.
 */
const nonBooleanParameterError = (input) => {
  const field = BOOLEAN_PARAMETER_NAMES.find((name) => input[name] !== undefined && !isBoolean(input[name]));
  return field ? `${field} must be a boolean` : null;
};

const DISPATCH_ACTIONS = new Set(['session.create', 'session.send', 'session.fork']);

/**
 * The control service still waits for the CLI, whose user sits at a terminal
 * with no session to deliver into. An agent never waits: a blocked tool call
 * holds its whole turn open, and `returnResult` brings the answer back
 * instead. A stale habit of sending `wait` gets the way that replaced it.
 */
const agentOnlyUsageError = (action, input) => {
  if (!action.startsWith('session.')) return null;
  if (input.wait === true || input.timeout !== undefined) {
    return action === 'session.messages'
      ? 'session.messages does not wait: it returns the current messages and sessionStatus. To get a session\'s answer when it finishes, dispatch the prompt with returnResult'
      : 'wait is not available to agents: a dispatch returns at once. Set returnResult to have the session\'s final answer delivered to you when it finishes';
  }
  if (input.lastAssistant === true && DISPATCH_ACTIONS.has(action)) {
    return 'lastAssistant belongs to session.messages. To get a dispatched session\'s answer when it finishes, set returnResult';
  }
  return null;
};

const createResult = ({ ok, action, data, error, exitCode }) => ({
  schemaVersion: TOOL_SCHEMA_VERSION,
  ok,
  action: action || 'unknown',
  ...(data !== undefined ? { data } : {}),
  ...(error ? { error } : {}),
  ...(Number.isInteger(exitCode) ? { exitCode } : {}),
});

/**
 * A page that waits for the user's answer (render.page with awaitAnswer)
 * holds its call open. A message the user writes in the chat meanwhile would
 * sit behind that call: OpenCode delivers it only after the call returns. So
 * the call registers itself under its session, and the plugin's prompt hook
 * (createPluginSource) aborts it the moment any prompt for that session
 * arrives, whichever way it was sent. The call then returns "answered in the
 * chat" and the agent reads the message next.
 */
const ANSWER_WAIT_SETUP = String.raw`        const chatController = new AbortController()
        const waiting = args.awaitAnswer === true
        if (waiting) {
          const set = pagesWaitingForChat.get(context.sessionID) ?? new Set()
          set.add(chatController)
          pagesWaitingForChat.set(context.sessionID, set)
        }
        const releaseWait = () => {
          const set = pagesWaitingForChat.get(context.sessionID)
          if (!set) return
          set.delete(chatController)
          if (set.size === 0) pagesWaitingForChat.delete(context.sessionID)
        }
        const waitSignal = AbortSignal.any([context.signal, chatController.signal].filter(Boolean))
`;

// Bun's fetch ends a request that gets no response for about six minutes with
// "The operation timed out", and a page waits as long as the user takes. Bun's
// own `timeout: false` lifts that; Stop and a chat message still end the wait
// through waitSignal.
const ANSWER_FETCH_TIMEOUT = String.raw`
            ...(waiting ? { timeout: false } : {}),`;

// The answer also lands in the call's metadata, which OpenCode stores and
// syncs, so every client shows the page as answered after a reload.
const ANSWER_METADATA = String.raw`, ...(result.ok === true && result.data && typeof result.data.answer === "object" && result.data.answer !== null ? { answer: result.data.answer } : {})`;

const ANSWER_WAIT_RELEASE = String.raw` finally {
          releaseWait()
        }`;

const ANSWER_CLOSED_IN_CHAT = String.raw`
          if (chatController.signal.aborted && !context.signal?.aborted) {
            const answer = { answered: false, reason: "chat" }
            const payload = { schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: true, action: args.action, data: { answer, note: ${JSON.stringify(RENDER_PAGE_CLOSED_IN_CHAT_NOTE)} } }
            await progress({ ok: true })
            return { content: JSON.stringify(payload), metadata: { openchamber: { schemaVersion: ${TOOL_SCHEMA_VERSION}, action: args.action, description: title, ok: true, answer } } }
          }`;

/**
 * The generated adapter normalizes exactly the two spellings a stringified
 * boolean takes, for the fields the tool's own parameter schema declares
 * boolean. The type comes from the schema the model is given, never from a
 * list maintained here. A tool with no boolean input gets no block at all.
 */
const booleanNormalizationBlock = (parameters) => {
  const booleanParameters = Object.entries(parameters)
    .filter(([, schema]) => schema.type === 'boolean')
    .map(([parameter]) => parameter);
  if (booleanParameters.length === 0) return '';
  return String.raw`        // A harness can stringify a boolean on the way here, and every
        // downstream === true would read "true" as false. Exactly the two
        // spellings are normalized, for the fields this tool declares boolean;
        // every other value keeps its identity for the server's strict check.
        for (const field of ${JSON.stringify(booleanParameters)}) {
          if (args[field] === "true") args[field] = true
          else if (args[field] === "false") args[field] = false
        }
`;
};

const multiActionSchema = (definitions) => ({
  property: { type: 'string', oneOf: definitions.map((entry) => ({ const: entry.action, description: entry.description })), description: 'OpenChamber action to perform' },
  required: ['action'],
  normalize: '',
});

/**
 * A tool with one action (render, notify) has nothing to choose, so its action
 * is optional, any string passes the schema, and the call always runs that one
 * action. A weaker model put the whole call into the action as a JSON string
 * (`{"action": "render.page", "title": "…"}` with the html beside it), which a
 * strict schema refused before the tool ran, and every retry sent the whole
 * page again. Fields revived from such a string fill only what the call did
 * not carry already.
 */
const singleActionSchema = (definition) => ({
  property: { type: 'string', description: `${definition.action}: ${definition.description}` },
  required: [],
  normalize: String.raw`        if (typeof args.action === "string" && args.action.trim().startsWith("{")) {
          try {
            const revived = JSON.parse(args.action)
            if (revived !== null && typeof revived === "object" && !Array.isArray(revived)) {
              const { action: _revivedAction, parameters: revivedParameters, ...revivedFields } = revived
              const nested = revivedParameters !== null && typeof revivedParameters === "object" && !Array.isArray(revivedParameters) ? revivedParameters : {}
              for (const [field, value] of Object.entries({ ...revivedFields, ...nested })) {
                if (!Object.hasOwn(args, field)) args[field] = value
              }
            }
          } catch {}
        }
        args.action = ${JSON.stringify(definition.action)}
`,
});

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
const createToolEntry = ({ name, description, definitions, parameters, codeMode, answers = false }) => {
  const normalizeBooleans = booleanNormalizationBlock(parameters);
  const actionSchema = definitions.length === 1 ? singleActionSchema(definitions[0]) : multiActionSchema(definitions);
  return String.raw`    tools.add({
      name: ${JSON.stringify(name)},
      description: ${JSON.stringify(description)},
      // OpenCode 2 puts a plugin tool behind its Code Mode execute tool
      // unless told otherwise. There the model sees only a size-limited
      // catalog, and with a few large MCP servers ours dropped out of it, so
      // agents concluded the tool did not exist. Direct is the default.
      options: { codemode: ${codeMode ? 'true' : 'false'} },
      input: {
        type: "object",
        properties: {
          action: ${JSON.stringify(actionSchema.property)},
          parameters: { type: "object", properties: ${JSON.stringify(parameters)}, additionalProperties: false, description: "Inputs for the action; use an empty object when none are needed" },
        },
        required: ${JSON.stringify(actionSchema.required)},
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
        // Nested object values can arrive JSON-stringified (issue #4591). Only
        // 'link' is revived, once, and only into a plain object: free-form
        // strings such as prompts and titles must stay text. The field belongs
        // to session.link alone (its bare 'link' alias included), so this is
        // field-scoped rather than a general coercion.
        if (typeof args.link === 'string') {
          try {
            const revived = JSON.parse(args.link)
            if (revived !== null && typeof revived === 'object' && !Array.isArray(revived)) args.link = revived
          } catch {}
        }
${actionSchema.normalize}${normalizeBooleans}        const actionTitles = ${JSON.stringify(AGENT_TOOL_ACTION_TITLES)}
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
${answers ? ANSWER_WAIT_SETUP : ''}
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
            body: JSON.stringify({ input: args, sessionID: context.sessionID, callID: context.id, tool: ${JSON.stringify(name)} }),
            signal: ${answers ? 'waitSignal' : 'context.signal'},${answers ? ANSWER_FETCH_TIMEOUT : ''}
          })
          const content = await response.text()
          let result = null
          try { result = JSON.parse(content) } catch {}
          const valid = result?.schemaVersion === ${TOOL_SCHEMA_VERSION} && typeof result?.ok === "boolean" && typeof result?.action === "string"
          await progress({ ok: valid && result.ok === true })
          if (valid) return { content, metadata: { openchamber: { schemaVersion: ${TOOL_SCHEMA_VERSION}, action: args.action, description: title, ok: result.ok === true${answers ? ANSWER_METADATA : ''} } } }
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: "OpenChamber returned an invalid response", kind: "runtime", status: response.status } })
        } catch (error) {${answers ? ANSWER_CLOSED_IN_CHAT : ''}
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: error instanceof Error ? error.message : String(error), kind: "runtime" } })
        }${answers ? ANSWER_WAIT_RELEASE : ''}
      },
    })
`;
};

/**
 * OpenCode's own tools that duplicate the control tool, removed while it is on
 * so the agent has one way to do each thing. Effective names: namespace, then
 * tool. `worktree_create` makes a detached copy of the current commit and leaves
 * the session behind, where session.moveToWorktree and session.create with a
 * worktree branch from the default branch; `models` searches the catalog
 * without the user's hidden models and favorites, which models.search applies.
 * `session_move` stays: the control tool cannot move a session into a directory
 * that already exists.
 */
const OPENCODE_TOOLS_REPLACED_BY_CONTROL = ['opencode_worktree_create', 'opencode_models'];

const createPluginSource = ({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, codeMode }) => {
  const entries = [];
  if (includeControl) {
    entries.push(`    for (const id of ${JSON.stringify(OPENCODE_TOOLS_REPLACED_BY_CONTROL)}) tools.remove(id)
`);
  }
  if (includeControl) {
    entries.push(createToolEntry({
      name: 'openchamber',
      description: CONTROL_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
      parameters: CONTROL_PARAMETER_PROPERTIES,
      codeMode,
    }));
  }
  if (includeSchedule) {
    entries.push(createToolEntry({
      name: 'openchamber_schedule',
      description: SCHEDULE_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_SCHEDULE_ACTION_DEFINITIONS,
      parameters: SCHEDULE_PARAMETER_PROPERTIES,
      codeMode,
    }));
  }
  if (includeWeb) {
    entries.push(createToolEntry({
      name: 'openchamber_web',
      description: WEB_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_WEB_ACTION_DEFINITIONS,
      parameters: WEB_PARAMETER_PROPERTIES,
      codeMode,
    }));
  }
  if (includeMemory) {
    entries.push(createToolEntry({
      name: 'openchamber_memory',
      description: MEMORY_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
      parameters: MEMORY_PARAMETER_PROPERTIES,
      codeMode,
    }));
  }
  if (includeKnowledge) {
    entries.push(createToolEntry({
      name: 'openchamber_knowledge',
      description: KNOWLEDGE_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_KNOWLEDGE_ACTION_DEFINITIONS,
      parameters: KNOWLEDGE_PARAMETER_PROPERTIES,
      codeMode,
    }));
  }
  if (includeNotify) {
    entries.push(createToolEntry({
      name: 'openchamber_notify',
      description: NOTIFY_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
      parameters: NOTIFY_PARAMETER_PROPERTIES,
      codeMode,
    }));
  }
  if (includeRender) {
    entries.push(createToolEntry({
      name: 'openchamber_render',
      description: RENDER_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_RENDER_ACTION_DEFINITIONS,
      parameters: RENDER_PARAMETER_PROPERTIES,
      // Never behind Code Mode: the chat draws the page from this tool's own
      // call, its input and the result it stores. Called from an execute
      // script, the call is only an entry in execute's list, so the page
      // never showed and an answer had no call to reach.
      codeMode: false,
      answers: true,
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

// Session id -> abort controllers of the calls whose page waits for an answer.
const pagesWaitingForChat = new Map()

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    exemptCallbackFromProxy()
    await ctx.tool.transform((tools) => {
${entries.join('')}    })${includeRender ? `
    await ctx.session.hook("prompt", (event) => {
      for (const controller of pagesWaitingForChat.get(event.sessionID) ?? []) controller.abort()
    })` : ''}
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
    instanceDir,
    getActivePort,
    getActiveHost = () => null,
    executeAction,
    resolveSessionDirectory,
  } = dependencies;
  // The plugin embeds this server's tool declarations, so it lives in this
  // server's own directory (see ../opencode/instance-dir.js).
  const pluginRoot = path.join(instanceDir, 'agent-tool');
  const pluginDirectory = path.join(pluginRoot, PLUGIN_ID);
  const pluginPath = path.join(pluginDirectory, 'index.js');
  const pluginManifestPath = path.join(pluginDirectory, 'package.json');
  let activeToken = null;

  const { callbackHost, isSameMachineAddress } = createCallbackAddress(getActiveHost);

  /**
   * Write the plugin for the requested tool set and return its directory.
   *
   * Called both before a managed child starts and whenever the tool settings
   * change while it runs, so the source on disk always matches the settings —
   * the running OpenCode reloads the directory it already has configured.
   */
  const materializePlugin = async ({ includeControl = true, includeSchedule = false, includeWeb = true, includeMemory = true, includeKnowledge = false, includeNotify = false, includeRender = false, codeMode = false } = {}) => {
    if (!includeControl && !includeSchedule && !includeWeb && !includeMemory && !includeKnowledge && !includeNotify && !includeRender) {
      throw new Error('At least one OpenChamber managed tool must be enabled to inject the plugin');
    }
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginManifestPath, PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(pluginPath, createPluginSource({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, codeMode }), { mode: 0o600 });
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
    return {
      OPENCHAMBER_AGENT_TOOL_URL: `http://${callbackHost()}:${port}/api/openchamber/agent-tool`,
      OPENCHAMBER_AGENT_TOOL_TOKEN: activeToken,
    };
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
    const usageError = nonBooleanParameterError(payload.input ?? {}) ?? agentOnlyUsageError(action, payload.input ?? {});
    if (usageError) {
      return createResult({ ok: false, action, error: { message: usageError, kind: 'usage' } });
    }
    if (typeof executeAction !== 'function') {
      return createResult({ ok: false, action, error: { message: 'OpenChamber control service is unavailable', kind: 'runtime' } });
    }
    // OpenCode 2 tools no longer receive a directory, so the plugin sends the
    // session id and the directory is resolved here. An unresolvable session
    // falls through with no directory, exactly like the old "no directory" path.
    // Knowledge writes are attributed to the calling session, so no payload
    // field may stand in for the session OpenCode reported.
    const knowledgeAction = OPENCHAMBER_KNOWLEDGE_ACTIONS.includes(action);
    let contextDirectory = knowledgeAction ? undefined : asNonEmptyString(payload.contextDirectory) ?? undefined;
    const sessionID = asNonEmptyString(payload.sessionID);
    if (!contextDirectory && sessionID && typeof resolveSessionDirectory === 'function') {
      contextDirectory = await Promise.resolve(resolveSessionDirectory(sessionID))
        .then((value) => asNonEmptyString(value) ?? undefined)
        .catch(() => undefined);
    }
    try {
      // The calling session scopes browser actions to that session's page.
      const contextSessionId = knowledgeAction ? sessionID : asNonEmptyString(payload.contextSessionId) ?? sessionID;
      // The call id lets a page that waits for an answer be found again
      // when the user answers it.
      const contextCallId = asNonEmptyString(payload.callID);
      const actionOptions = { ...options };
      if (contextSessionId) actionOptions.contextSessionId = contextSessionId;
      if (contextCallId) actionOptions.contextCallId = contextCallId;
      const data = await executeAction(action, { ...payload.input, action }, contextDirectory, actionOptions);
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
