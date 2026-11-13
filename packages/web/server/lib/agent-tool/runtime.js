import os from 'node:os';
import path from 'node:path';

import { asNonEmptyString, isBoolean } from '../shared/guards.js';
import {
  OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
  OPENCHAMBER_AGENT_TOOL_ACTIONS,
  OPENCHAMBER_IMAGE_ACTION_DEFINITIONS,
  OPENCHAMBER_IMAGE_ACTIONS,
  OPENCHAMBER_KNOWLEDGE_ACTION_DEFINITIONS,
  OPENCHAMBER_KNOWLEDGE_ACTIONS,
  OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
  OPENCHAMBER_MEMORY_ACTIONS,
  OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
  OPENCHAMBER_NOTIFY_ACTIONS,
  OPENCHAMBER_RENDER_ACTION_DEFINITIONS,
  OPENCHAMBER_RENDER_ACTIONS,
  OPENCHAMBER_SECRET_ACTION_DEFINITIONS,
  OPENCHAMBER_SECRET_ACTIONS,
  OPENCHAMBER_SCHEDULE_ACTION_DEFINITIONS,
  OPENCHAMBER_SCHEDULE_ACTIONS,
  OPENCHAMBER_USAGE_ACTION_DEFINITIONS,
  OPENCHAMBER_USAGE_ACTIONS,
  resolveAgentToolAction,
  OPENCHAMBER_WEB_ACTION_DEFINITIONS,
  OPENCHAMBER_WEB_ACTIONS,
  OPENCHAMBER_WORKFLOW_ACTION_DEFINITIONS,
  OPENCHAMBER_WORKFLOW_ACTIONS,
  OPENCHAMBER_WORKFLOW_ANSWER_ACTION_DEFINITIONS,
  OPENCHAMBER_WORKFLOW_ANSWER_ACTIONS,
  WORKFLOW_ANSWER_TOOL,
} from '../openchamber-control/actions.js';
import { MAX_AGENTS_PER_RUN, MAX_CONCURRENT_AGENTS } from '../workflows/runtime.js';
import {
  isAgentPrompt,
  RENDER_PAGE_CLOSED_IN_CHAT_NOTE,
  RENDER_PAGE_IMAGE_BUDGET_BYTES,
  RENDER_PAGE_MAX_HTML_LENGTH,
  RENDER_PAGE_MAX_TITLE_LENGTH,
} from '../openchamber-control/render-page.js';
import {
  SECRET_REQUEST_CLOSED_IN_CHAT_NOTE,
  SECRET_REQUEST_MAX_LABEL_LENGTH,
  SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH,
  SECRET_REQUEST_MAX_REASON_LENGTH,
} from '../openchamber-control/secret-request.js';
import {
  SECRET_RUN_DEFAULT_TIMEOUT_MS,
  SECRET_RUN_MAX_INPUTS,
  SECRET_RUN_MAX_LABEL_LENGTH,
  SECRET_RUN_MAX_PLACEHOLDER_LENGTH,
  SECRET_RUN_MAX_TIMEOUT_MS,
  secretRunCommand,
  secretRunCommandLine,
} from '../openchamber-control/secret-run.js';
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
  ...OPENCHAMBER_IMAGE_ACTIONS,
  ...OPENCHAMBER_SECRET_ACTIONS,
  ...OPENCHAMBER_USAGE_ACTIONS,
  ...OPENCHAMBER_WORKFLOW_ACTIONS,
  ...OPENCHAMBER_WORKFLOW_ANSWER_ACTIONS,
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
    ...OPENCHAMBER_IMAGE_ACTION_DEFINITIONS,
    ...OPENCHAMBER_SECRET_ACTION_DEFINITIONS,
    ...OPENCHAMBER_USAGE_ACTION_DEFINITIONS,
    ...OPENCHAMBER_WORKFLOW_ACTION_DEFINITIONS,
    ...OPENCHAMBER_WORKFLOW_ANSWER_ACTION_DEFINITIONS,
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
const SCHEDULE_ONLY_PARAMETER_NAMES = ['taskId', 'name', 'targetSessionId', 'daily', 'weekly', 'once', 'time', 'cron', 'timezone', 'disabled', 'runInWorktree', 'baseBranch', 'cleanupWorktree'];
const SCHEDULE_PARAMETER_NAMES = [...SCHEDULE_ONLY_PARAMETER_NAMES, 'projectId', 'directory', 'prompt', 'model', 'variant', 'agent', 'goal', 'goalTokenBudget'];

/**
 * `model` and `agent` describe a dispatched session in the shared map; a task
 * picks them for every run, so the schedule tool says what they mean there.
 */
const SCHEDULE_PARAMETER_OVERRIDES = {
  model: { type: 'string', description: 'provider/model; required unless targetSessionId is set. With targetSessionId, the task\'s model becomes that session\'s model; create the task without one to keep the session\'s own. A named model is checked against the catalog when the task is written' },
  agent: { type: 'string', description: 'Only when the user asks. Default: build for a new session. With targetSessionId, the task\'s agent becomes that session\'s agent; without one the session keeps its own' },
};

/**
 * `title` is shared with the control tool, where it means a session title, so
 * it carries no description in the shared map. Left undescribed for memory the
 * model has nothing to go on and invents a name for it — `name` was sent
 * repeatedly in practice — so memory states what its own `title` is.
 */
const MEMORY_PARAMETER_OVERRIDES = {
  title: { type: 'string', description: 'As the session index spells it; prefer it over memoryId for an entry you can see. On save: at most 60 characters, no date (the store keeps dates)' },
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
  branch: { type: 'string', description: 'session.create: default the worktree name. work.name: the new name of a placeholder branch' },
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
  query: { type: 'string', description: 'Words to match: model names and ids for models.search, session titles for session.list' },
  inWork: { type: 'boolean', description: 'session.list: only sessions in In work' },
  busy: { type: 'boolean', description: 'session.list: only sessions running now' },
  children: { type: 'boolean', description: 'session.list: include subagent sessions' },
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
  runInWorktree: { type: 'boolean', description: 'Run each run in a fresh worktree of the project (git only); conflicts with targetSessionId' },
  baseBranch: { type: 'string', description: 'Source ref the isolated run branches from (git only); default the checked-out HEAD at run time' },
  cleanupWorktree: { type: 'boolean', description: 'False keeps the run\'s worktree and branch for review; default removes them when the run settles (git only)' },
  path: { type: 'string', description: 'Absolute, or relative to the session directory' },
  url: { type: 'string', description: 'http(s)' },
  selector: { type: 'string', description: 'From browser.snapshot' },
  text: { type: 'string', description: 'Visible label, when no selector' },
  value: { type: 'string', description: 'Text to type, or the option value for browser.select' },
  submit: { type: 'boolean', description: 'Press Enter after typing' },
  direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
  viewport: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'fill'] },
  label: { type: 'string', description: 'Option label for browser.select; otherwise the image name, such as before-fix' },
  tabId: { type: 'string', description: "From the tabs browser.snapshot lists. Default: the tab you last used; else the user's open tab, if they opened it in this project" },
  body: { type: 'string', description: 'At most 2000 characters; longer is rejected. Written to make sense without this conversation' },
  memoryId: { type: 'string', description: 'From memory.list or memory.read; on save it rewrites that entry' },
  type: { type: 'string', enum: ['fact', 'preference', 'reference'], description: 'fact: something true. preference: how the user wants work done. reference: a resource hard to find again' },
};

const pickParameters = (names) => Object.fromEntries(
  Object.entries(ALL_PARAMETER_PROPERTIES).filter(([name]) => names.includes(name)),
);

const CONTROL_PARAMETER_PROPERTIES = {
  ...pickParameters(
    Object.keys(ALL_PARAMETER_PROPERTIES).filter((name) => (
      !WEB_PARAMETER_NAMES.includes(name)
      && !MEMORY_ONLY_PARAMETER_NAMES.includes(name)
      && !SCHEDULE_ONLY_PARAMETER_NAMES.includes(name)
    )),
  ),
  // The web tool's `url` is a page to load; here it names what pr.watch
  // follows or which link session.unlink removes.
  url: { type: 'string', description: 'pr.watch, pr.unwatch: the pull or merge request address. session.unlink: the address of the link to remove' },
  identifier: { type: 'string', description: 'session.unlink: the identifier of the link to remove, when no url' },
  source: { type: 'string', description: 'wait.start: <extension>/<wait> as wait.list names it' },
  args: { type: 'object', description: 'wait.start: the arguments the source\'s params list, such as { "seconds": 60 }' },
  waitId: { type: 'string', description: 'wait.stop: the wait to stop; without it every wait of this session' },
};
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
  planId: { type: ['string', 'null'], description: 'The plan a note or todo belongs to; null unlinks, omission keeps it. On list: only that plan and its notes and todos' },
  dependsOn: { type: 'array', items: { type: 'string' }, description: 'Todo ids of the same plan to complete first; [] clears, omission keeps them. Deleting a todo drops it from the todos that depended on it' },
  ready: { type: 'boolean', description: 'On list: only unfinished todos whose dependencies are all completed' },
  sessionId: { type: ['string', 'null'], description: 'Existing plan, saved without body: the session linked to it; null clears. Links only, starts nothing' },
  expected: { type: 'string', description: "The text as you last read it; the save fails if it changed since. Then refresh (knowledge.list for a note's body, your file tools for a plan) and retry with the same id and the fresh text" },
};

// Its own names, not the shared map: `title` and `body` mean something else in
// the control and memory tools.
const NOTIFY_PARAMETER_PROPERTIES = {
  title: { type: 'string', description: 'Up to 120 characters' },
  body: { type: 'string', description: 'Up to 500 characters' },
  showWhenFocused: { type: 'boolean', description: 'Show it while the user is in OpenChamber too, otherwise it shows only while they are away. Only for what cannot wait' },
};

const IMAGE_PARAMETER_PROPERTIES = {
  prompt: { type: 'string', description: 'What to draw, or for images what to change in them. Up to 8000 characters' },
  images: { type: 'array', items: { type: 'string' }, description: 'Paths of PNG, JPEG, GIF or WebP files to edit or to use as references, in order; at most 8' },
  aspect: { type: 'string', description: 'width:height, such as 16:9. Default: the model\'s' },
  resolution: { type: 'string', description: 'Size tier such as 1K, 2K or 4K. Default: the model\'s' },
  count: { type: 'integer', description: 'How many images, 1 to 4. Default 1' },
  path: { type: 'string', description: "Where to save, absolute or relative to the project; more images get -2, -3 before the extension. Default: OpenCode's temporary folder" },
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
  `One self-contained HTML document, at most ${RENDER_PAGE_MAX_HTML_LENGTH} characters, with inline <style> and <script>. Never data: a chart, table or comparison is an openui-lang block in your reply. Remote scripts and stylesheets do not load in every client, so draw with inline SVG or your own script.`,
  "Layout: fluid width, as wide as the reply column (about 720px on desktop, 360px on phones), no horizontal padding on the outermost element, nothing wider; stack or wrap, and give a wide table its own overflow-x:auto box. The frame takes the page's height, so keep it short, give drawings fixed pixel heights, and never use 100vh or height:100% on html or body.",
  "Ready classes in the app's look, so these need no CSS of your own: .oc-box (a box; a box inside it steps up a tone), .oc-muted (secondary text), .oc-table on a div around a <table> (scrolls sideways when wide), .oc-num (tabular figures, end-aligned), .oc-badge with optional data-tone=\"success|warning|error|info\", .oc-dot (a legend dot) and .oc-bar (a horizontal bar) colored by --color (default --chart-1), the bar as long as --value (a percentage), .oc-field (a <label> around its text and control), .oc-input on an input, select or textarea, .oc-switch on a checkbox, .oc-segmented around <button>s (aria-pressed=\"true\" on the chosen one; also tabs). A line only where it means something, such as a divider between sections.",
  "Theme variables on :root, updated live on a theme switch: --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --border, --primary, --primary-foreground, --destructive, --warning, --success, --info, --code-background, --code-foreground, --chart-1 to --chart-6 (series), --radius, --font-sans, --font-mono. A base stylesheet already sets text color, font and size; the root font size is the chat's text size and follows the user's interface size, so size text in rem or em, not px. A page with its own colors, such as a mockup of the user's project, sets a color on all its text and gives itself a background: text without a color takes the theme's, and without a background the page shows the chat's.",
  "Scripts may add tooltips, tabs, toggles, sorting. On a phone a tap shows a hover tooltip, so keep tooltips and popups inside the page and flip them near an edge.",
  `Images: https, data:, or local PNG, JPEG, GIF or WebP files named by complete absolute paths in src, CSS url() or quoted script strings. The renderer finds and inlines these paths before the page runs, so do not build paths from directory and filename fragments. To switch images, put each full path in a script string and assign the selected value to img.src, for example: const images = { a: '/absolute/path/a.png', b: '/absolute/path/b.png' }; image.src = images[key]. Each file can be 10 MB; all images together can be ${RENDER_PAGE_IMAGE_BUDGET_BYTES / (1024 * 1024)} MB per page. The result names any that do not show. Save a screenshot for a page in ${OPENCODE_TEMP_DIRECTORY}.`,
  "The page is sandboxed: no access to OpenChamber, the network session or local files; links open in the user's browser.",
].join(' ');

const RENDER_PAGE_AWAIT_DESCRIPTION = [
  "Wait for the user to choose, fill in fields, or both, on the page. With ui, the form adds its own Send button; add a Button only when the choice is between actions, and any Button sends the whole form. With html, give it one button whose click calls openchamber.submit(data, summary): data is the JSON your next step needs, summary the choice in a few words of the user's language, shown under the page. submit works only from a click on a waiting page and returns a promise; disable the button once it resolves.",
  "The call returns summary and data, or answered: false when the user declined or wrote in the chat instead; the note says which and what to do.",
  "Reloaded, the page gets openchamber.answer set to its data, to show the choice. Base classes: .oc-options (a grid), .oc-option on a <button> (aria-pressed=\"true\" when chosen), .oc-button (the send button; data-variant=\"outline\" for a secondary action, \"destructive\" for a dangerous one).",
].join(' ');

// Its own names: `title` here names the page.
// A question asked with `ui` looks the same whatever model writes it, which is
// why the description sends questions there first.
const RENDER_PAGE_UI_DESCRIPTION = [
  "Instead of html: one complete openui-lang program, the language of UI blocks, without the fence. Prefer it to html for a question: Choice and Input fields, drawn with the chat's own controls.",
  "With awaitAnswer the call returns summary (the button and the values in words) and data: { button, value, values, note }: the pressed button's label and value, each field's value under its name, and the note the user added, if any.",
].join(' ');

const RENDER_PARAMETER_PROPERTIES = {
  ui: { type: 'string', description: RENDER_PAGE_UI_DESCRIPTION },
  html: { type: 'string', description: RENDER_PAGE_HTML_DESCRIPTION },
  title: { type: 'string', description: `At most ${RENDER_PAGE_MAX_TITLE_LENGTH} characters; without it the page's <title> or first heading names it` },
  awaitAnswer: { type: 'boolean', description: RENDER_PAGE_AWAIT_DESCRIPTION },
};

// Its own names: `label` means something else in the web tool.
const SECRET_PARAMETER_PROPERTIES = {
  program: { type: 'string', description: 'secret.run: the executable, by name on PATH or absolute path. No shell: for a script use "sh" (or "bash") with args ["-c", "<script>"]' },
  args: { type: 'array', items: { type: 'string' }, description: 'secret.run: arguments, without secrets' },
  inputs: {
    type: 'array',
    minItems: 1,
    maxItems: SECRET_RUN_MAX_INPUTS,
    description: 'secret.run: one field per secret, which the command reads from the named environment variable',
    items: {
      type: 'object',
      properties: {
        env: { type: 'string', description: 'Environment variable name, such as CLOUDFLARE_API_TOKEN' },
        label: { type: 'string', description: `What the secret is, shown above its field, in the user's language. At most ${SECRET_RUN_MAX_LABEL_LENGTH} characters` },
        placeholder: { type: 'string', description: `The value's shape, such as sk-ant-...; at most ${SECRET_RUN_MAX_PLACEHOLDER_LENGTH} characters` },
      },
      required: ['env', 'label'],
      additionalProperties: false,
    },
  },
  timeoutMs: { type: 'integer', minimum: 1, maximum: SECRET_RUN_MAX_TIMEOUT_MS, description: `secret.run: how long the command may run once the user answered, default ${SECRET_RUN_DEFAULT_TIMEOUT_MS}` },
  label: { type: 'string', description: `secret.request: what the secret is, the card's title, such as Cloudflare API token. At most ${SECRET_REQUEST_MAX_LABEL_LENGTH} characters` },
  reason: { type: 'string', description: `In the user's language: what you will do with the secrets, and where to create them when that is not obvious. At most ${SECRET_REQUEST_MAX_REASON_LENGTH} characters` },
  placeholder: { type: 'string', description: `secret.request: the value's shape, such as sk-ant-...; at most ${SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH} characters` },
};

const USAGE_PARAMETER_PROPERTIES = {
  providerId: { type: 'string', description: 'One provider, such as claude or codex, from an earlier read; omit for every configured provider' },
};

// How to write a script lives on `script`, read while the agent writes it,
// for the same reason the page rules live on render's `html`.
const WORKFLOW_SCRIPT_DESCRIPTION = [
  "JavaScript. It starts with export const meta = { name: 'audit-routes', description: 'One sentence', phases: ['Find', 'Audit'] }, then a body with top-level await and return.",
  "The body sees: agent(prompt, { label, phase, agent, model, schema }) runs one agent in a fresh session and resolves to its final answer text, to the JSON value matching schema (JSON Schema: type, properties, required, items, enum; the agent hands it over through a checking tool), or to null when it failed. model is provider/model, optionally #variant; without it the agent runs on this session's model. The agent has none of this conversation, so the prompt carries everything it needs: paths, the question, what to answer.",
  "parallel([() => agent(...), ...]) runs tasks together and waits for all of them: a barrier, resolving to their results, null for a failed one. pipeline(items, stage1, stage2, ...) runs each item through the stages on its own, each stage called as (previous, item, index) with previous the last stage's result (the item itself for the first), with no wait between stages; a stage that gives null ends that item as null; prefer it, and use parallel() between steps only when a step needs every earlier result at once, such as deduplicating across them. phase(title) groups the agents that follow under a title listed in meta.phases; inside parallel() or pipeline() pass phase to agent() instead. log(message) shows a line in the run. args is the JSON passed to workflow.run, {} when none was.",
  `At most ${MAX_CONCURRENT_AGENTS} agents work at once and ${MAX_AGENTS_PER_RUN} per run. No imports, files, network, timers, Date.now(), new Date() or Math.random(): agents read and write files and run commands, the script only coordinates them, and a resumed run replays it.`,
  "Return a short report value: each agent's full answer stays readable with workflow.result.",
].join(' ');

const WORKFLOW_PARAMETER_PROPERTIES = {
  script: { type: 'string', description: WORKFLOW_SCRIPT_DESCRIPTION },
  name: { type: 'string', description: 'A saved workflow, instead of script' },
  args: { type: 'object', description: 'An object the script reads as args, such as { paths: [...] }' },
  runId: { type: 'string', description: 'From workflow.run' },
  agent: { type: 'string', description: "workflow.result: one agent's key or session id, from workflow.status" },
  overwrite: { type: 'boolean', description: 'workflow.save: replace a saved workflow of the same name' },
};

// A JSON object, not JSON text in a string: text made models escape JSON
// inside JSON, and some looped on it until their output budget ran out.
const WORKFLOW_ANSWER_PARAMETER_PROPERTIES = {
  answer: { type: 'object', description: 'Your answer, the JSON value matching the schema in your prompt. When that schema is not an object, pass { "value": <your value> }' },
};

const WORKFLOW_ANSWER_TOOL_DESCRIPTION = 'Hand over your answer when your prompt asks for one matching a JSON Schema. It is checked on the spot: a mismatch says what to fix, so call again until it is accepted, then end your turn.';

/**
 * Permission rules the managed config adds for the tools of this plugin.
 * OpenCode appends config rules to every agent, and a session's own rules are
 * read after them, which is what lets one session allow what all others deny.
 */
export const managedPermissionRules = ({ includeWorkflow = false } = {}) => (
  includeWorkflow ? [{ action: WORKFLOW_ANSWER_TOOL, resource: '*', effect: 'deny' }] : []
);

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

const WEB_TOOL_DESCRIPTION = "OpenChamber's browser panel, to check your work by looking at it. One action per call: open, snapshot for text, selectors and errors, then click, type, select or scroll by those selectors. Close tabs you opened for your own work with browser.close; leave open the ones you opened to show the user something. The page runs with the user's real logins; treat it as their live session.";

const MEMORY_TOOL_DESCRIPTION = "Memory that persists across sessions. One fact per entry, under a title that names what it holds, so the session index tells when to read it: \"PR lists: one or two sentences per PR\", not \"Reporting preferences\". Save what code and docs do not show: the user's corrections and preferences, people and private context, a hard-won pointer; a project's decisions, rejected alternatives and deliberate \"leave this as it is\" only when it keeps no agent docs to put them in. Never one-off task state, secrets or credentials, or what the user asked you not to keep; what the user explicitly asks you to remember, save. Project scope holds what concerns this project, global what concerns the user in every project.";

const KNOWLEDGE_TOOL_DESCRIPTION = "The project's Notes, Todos and Plans, shown in OpenChamber's Project knowledge panel and shared by its sessions. One action per call; list returns everything unless planId or ready narrows it. "
  + "Notes: short facts the user wants at hand; your own learnings go to the project's agent docs or memory. Todos: the user's backlog; add one when asked or when you stop with work left, never for the steps of your current task. "
  + "A note or todo may belong to a plan (planId), and a todo may depend on other todos of that plan (dependsOn); list with ready for the todos that can start. "
  + "Plans: markdown files. list gives their paths; read and edit them with your file tools, save creates or replaces one whole. A plan starts with a # title, then a ## Steps heading with one - [ ] item per coarse step, then the detail. A plan written for the user: save, show, wait for their comments; they send it to a session. Implementing one: tick each step (- [x]) as you finish it and change nothing else unless asked; never drop a constraint. "
  + "Replacing a note or plan: pass expected. If the save fails on it, refresh and retry the save with the same id.";

const NOTIFY_TOOL_DESCRIPTION = "Notify the user outside the chat: when long work finishes and they have likely stepped away, when you are blocked on them, or when they asked to be told. Routine progress and what your reply already says stay in the chat.";

// The pointer to UI blocks sits here because a model choosing how to show
// data reads this description, and with the page as the only visual it named,
// a weak model drew HTML for a plain comparison.
const RENDER_TOOL_DESCRIPTION = "Draw a finished HTML page inline in the chat, above your reply, or ask the user to choose on one (awaitAnswer). "
  + "Never for data: tables, charts, comparisons, steps and flows are openui-lang UI blocks in your reply, even when the user asks to see them. "
  + "A choice that sets the direction of the work: send ui with awaitAnswer; the form adds a note field for the user's conditions. html is for mockups and custom drawings. "
  + "The page is part of your reply and sits on the chat's background: leave html, body and the outermost element without a background, add no outer card, border or banner title, and set boxes apart by tone. Style with the theme variables listed under html. "
  + "How to write a page is in the descriptions of the ui and html parameters, how to ask on one in awaitAnswer's; there is no read action.";

const IMAGE_TOOL_DESCRIPTION = "Generate or edit images with the image model the user chose in OpenChamber's settings; your own model stays. "
  + "The call returns the saved file paths, and the chat shows the images to the user, so do not repeat them in your reply. Read a file to look at it. "
  + "Without path the files go to OpenCode's temporary folder: move one into the project when it belongs there. Every call costs the user money: make what was asked, not extra variations.";

const SECRET_TOOL_DESCRIPTION = "Ask the user for secrets (API keys, tokens, passwords, one-time codes) on a private card in the chat, and wait for them. "
  + "secret.run is the default: name the command and the environment variables it reads the secrets from. After the user approves the command line and fills the card, it runs once in this session's directory with the secrets in its environment, and the call returns its exit code and output with every secret value replaced by [secret:NAME]. It runs without a shell or input; a command that fails can be fixed and run again. "
  + "On the card the user can let this chat remember a field for 10 minutes; the result's remembered lists those env names, and a new secret.run with the same env name uses it without asking. secret.forget drops them when the user asks or the work is done. "
  + "secret.request is for a secret a program must read from a file (a key file, a kubeconfig): the value goes to a file only this user can read, deleted after 24 hours, and the call returns only its path. Read it inside the command that needs it; never print, echo or log it, and never copy it into the project. "
  + "The call returns status declined when the user declines, or answered: false when they wrote in the chat instead.";

// What a read costs and how fresh it is, because an agent checking a limit
// before a task otherwise polls it in a loop or trusts an old sample.
const USAGE_TOOL_DESCRIPTION = "Provider usage limits as OpenChamber's Settings > Usage shows them: per provider, each window's used and remaining percent, its length and when it resets, plus plan, per-model windows and credit balances. "
  + "ok false with configured true is a failed read, not zero usage; notConfigured lists providers without a credential. "
  + "Every call asks each provider again, sometimes with several requests, so read once per decision and never poll in a loop. fetchedAt is when the result was built; a provider that is rate limiting answers with its last sample.";

const WORKFLOW_TOOL_DESCRIPTION = 'Workflows: a script that fans a large task out to many agents, which OpenChamber runs in the background while you stay free. '
  + 'For work with many similar independent pieces (a review per file, an audit across many routes, a migration of many files, research cross-checked across sources) or a check that must run on every piece. A single feature or a few steps is not one: do it yourself or with a subagent. '
  + 'One action per call. Check a script with workflow.check, then workflow.run: the user approves the plan in the chat, and the report arrives as a message when the run ends. Read script before writing one.';

// A field means the same thing in every tool that declares it, so one set
// covers them all.
const BOOLEAN_PARAMETER_NAMES = [...new Set([
  ALL_PARAMETER_PROPERTIES,
  SCHEDULE_PARAMETER_PROPERTIES,
  MEMORY_PARAMETER_PROPERTIES,
  KNOWLEDGE_PARAMETER_PROPERTIES,
  NOTIFY_PARAMETER_PROPERTIES,
  RENDER_PARAMETER_PROPERTIES,
  IMAGE_PARAMETER_PROPERTIES,
  WORKFLOW_PARAMETER_PROPERTIES,
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
 * A call that waits for the user's answer (render.page with awaitAnswer, and
 * secret.request and secret.run) holds its call open. A message the user writes in the
 * chat meanwhile would sit behind that call: OpenCode delivers it only after
 * the call returns. So
 * the call registers itself under its session, and the plugin's prompt hook
 * (createPluginSource) aborts it the moment the user's prompt for that session
 * arrives. The call then returns "answered in the chat" and the agent reads the
 * message next. A prompt an agent sent (`isAgentPrompt`) and a queued one,
 * which OpenCode delivers only after the turn, leave the wait running; the
 * user's undelivered prompt ends it when the user moves it to steer.
 */
const answerWaitSetup = (waitsWhen) => String.raw`        const chatController = new AbortController()
        const waiting = ${waitsWhen}
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

const answerClosedInChat = (note) => String.raw`
          if (chatController.signal.aborted && !context.signal?.aborted) {
            const answer = { answered: false, reason: "chat" }
            const payload = { schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: true, action: args.action, data: { answer, note: ${JSON.stringify(note)} } }
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

/**
 * `dependsOn` can arrive as a JSON string although the knowledge schema
 * declares an array: a model that put it beside the action, where the schema
 * gives it no type, sent `"[\"id\"]"`. It is parsed once and kept only as an
 * array; any other value reaches the server's strict check unchanged. Only the
 * tool that declares the field gets the block.
 */
const dependsOnRevivalBlock = (parameters) => {
  if (!Object.hasOwn(parameters, 'dependsOn')) return '';
  return String.raw`        if (typeof args.dependsOn === "string") {
          try {
            const revived = JSON.parse(args.dependsOn)
            if (Array.isArray(revived)) args.dependsOn = revived
          } catch {}
        }
`;
};

const multiActionSchema = (definitions) => ({
  property: {
    type: 'string',
    enum: definitions.map((entry) => entry.action),
    description: `OpenChamber action to perform (${definitions.map((entry) => `${entry.action}: ${entry.description}`).join('; ')})`,
  },
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
 * The action schema validates with `enum` only, never together with `oneOf`.
 * A node combining `enum` and `oneOf` is valid JSON Schema, but some
 * OpenAI-compatible gateways reject it and answer with an empty completion
 * instead of an error. `oneOf` is not used alone either: OpenAPI 3.0 / Gemini
 * schema normalizers collapse it to its first branch. The per-action
 * descriptions the model reads live in the `action` property's description.
 */
/**
 * `answers` makes a tool's call wait for the user: `waitsWhen` is the JS
 * expression (over `args`) that says whether this call waits, and
 * `closedInChatNote` what the agent reads when the user wrote in the chat.
 */
/**
 * `secret.run` asks OpenCode's shell permission for its command line before
 * the call reaches OpenChamber, so the session's rules apply as they do to a
 * command the agent runs itself (an allowed `git *` allows `git push`, a
 * denied one refuses it), and a request for the secrets of a command the user
 * would not let run never appears. A deny or a rejection throws from
 * `assert`; it is rethrown, because a plain rejection ends the agent's step.
 * The check sits before the wait is registered, so nothing waits on a call
 * that was refused.
 */
const SECRET_RUN_PERMISSION = String.raw`        if (args.action === "secret.run") {
          const command = secretRunCommand(args)
          if (command.error) return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: command.error, kind: "usage" } })
          if (typeof ctx.permission?.assert !== "function") {
            return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: "This OpenCode cannot ask the user to approve a command, so secret.run is unavailable; use secret.request", kind: "runtime" } })
          }
          const line = secretRunCommandLine(command.program, command.args)
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "shell",
            resources: [line],
            save: [command.program + " *"],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })
        }
`;

const createToolEntry = ({ name, description, definitions, parameters, codeMode, answers = null, secretRun = false }) => {
  const normalizeBooleans = booleanNormalizationBlock(parameters);
  const reviveDependsOn = dependsOnRevivalBlock(parameters);
  const actionSchema = definitions.length === 1 ? singleActionSchema(definitions[0]) : multiActionSchema(definitions);
  // The bare name the server would resolve too, so the permission check sees it.
  const secretRunNormalize = secretRun ? '        if (args.action === "run") args.action = "secret.run"\n' : '';
  return String.raw`    tools.add({
      name: ${JSON.stringify(name)},
      description: ${JSON.stringify(description)},
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
${reviveDependsOn}${actionSchema.normalize}${secretRunNormalize}${normalizeBooleans}        const actionTitles = ${JSON.stringify(AGENT_TOOL_ACTION_TITLES)}
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
${secretRun ? SECRET_RUN_PERMISSION : ''}${answers ? answerWaitSetup(answers.waitsWhen) : ''}
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
        } catch (error) {${answers ? answerClosedInChat(answers.closedInChatNote) : ''}
          return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: error instanceof Error ? error.message : String(error), kind: "runtime" } })
        }${answers ? ANSWER_WAIT_RELEASE : ''}
      },
    })
`;
};

/**
 * The control, schedule, browser, memory, knowledge and notify tools always
 * sit behind OpenCode's Code Mode `execute` tool. Measured on
 * scripts/tool-use-bench with three models, that cut the first request of a
 * session by about 30% with the same or better use of the tools, and one
 * provider's tool-call streaming stalled on their direct schemas. The tools
 * whose call the chat draws (render, secret, image, workflow) stay direct.
 *
 * Behind Code Mode the catalog lists every namespace with its description, but
 * a tool only while its budget lasts, and with large MCP servers connected each
 * of ours showed as a bare row such as `openchamber_web (1 tool, none shown)`.
 * Agents asked to open a page in the browser panel then fetched it and said
 * they had no browser (scripts/tool-use-bench). So each Code Mode tool gets a
 * namespace of its own name, which OpenCode lets share the tool's path, and
 * the catalog row carries this line.
 *
 * Names and paths stay as they are: agents call `tools.openchamber(...)`
 * straight from the session guidance, and both a renamed control tool and one
 * with a namespace of other tools under it made them stop calling it.
 */
// A use the session guidance does not state lives here, where it is always
// seen, and not only in the tool description the agent reads once it has
// already picked the tool.
const CODE_MODE_CATALOG_LINES = {
  openchamber: 'OpenChamber projects, sessions and worktrees: dispatch a session, link a PR, list models, move this session into a worktree (it can help when the checkout looks busy; ask unless the request already calls for separate work)',
  openchamber_schedule: 'Scheduled tasks: prompts OpenChamber runs on a schedule',
  openchamber_web: "OpenChamber's browser panel, to check your work by looking at it: open a page, read it, click and type",
  openchamber_memory: 'Memory that persists across sessions',
  openchamber_knowledge: "The project's notes, todos and plans. Add a todo when asked or when you stop with work left",
  openchamber_notify: 'Notify the user outside the chat: when long work finishes and they have likely stepped away, when you are blocked on them, or when they asked to be told',
  openchamber_usage: 'Provider usage limits and reset times. Read it when the user asks about limits or usage, or when picking a model for work depends on them; never poll',
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

const createPluginSource = ({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, includeImage, includeSecret, includeUsage, includeWorkflow }) => {
  const entries = [];
  const included = { openchamber: includeControl, openchamber_schedule: includeSchedule, openchamber_web: includeWeb, openchamber_memory: includeMemory, openchamber_knowledge: includeKnowledge, openchamber_notify: includeNotify, openchamber_usage: includeUsage };
  for (const [name, description] of Object.entries(CODE_MODE_CATALOG_LINES)) {
    if (included[name]) entries.push(`    tools.namespace(${JSON.stringify({ name, description })})
`);
  }
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
      codeMode: true,
    }));
  }
  if (includeSchedule) {
    entries.push(createToolEntry({
      name: 'openchamber_schedule',
      description: SCHEDULE_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_SCHEDULE_ACTION_DEFINITIONS,
      parameters: SCHEDULE_PARAMETER_PROPERTIES,
      codeMode: true,
    }));
  }
  if (includeWeb) {
    entries.push(createToolEntry({
      name: 'openchamber_web',
      description: WEB_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_WEB_ACTION_DEFINITIONS,
      parameters: WEB_PARAMETER_PROPERTIES,
      codeMode: true,
    }));
  }
  if (includeMemory) {
    entries.push(createToolEntry({
      name: 'openchamber_memory',
      description: MEMORY_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_MEMORY_ACTION_DEFINITIONS,
      parameters: MEMORY_PARAMETER_PROPERTIES,
      codeMode: true,
    }));
  }
  if (includeKnowledge) {
    entries.push(createToolEntry({
      name: 'openchamber_knowledge',
      description: KNOWLEDGE_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_KNOWLEDGE_ACTION_DEFINITIONS,
      parameters: KNOWLEDGE_PARAMETER_PROPERTIES,
      codeMode: true,
    }));
  }
  if (includeNotify) {
    entries.push(createToolEntry({
      name: 'openchamber_notify',
      description: NOTIFY_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS,
      parameters: NOTIFY_PARAMETER_PROPERTIES,
      codeMode: true,
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
      answers: { waitsWhen: 'args.awaitAnswer === true', closedInChatNote: RENDER_PAGE_CLOSED_IN_CHAT_NOTE },
    }));
  }
  if (includeSecret) {
    entries.push(createToolEntry({
      name: 'openchamber_secret',
      description: SECRET_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_SECRET_ACTION_DEFINITIONS,
      parameters: SECRET_PARAMETER_PROPERTIES,
      // Never behind Code Mode, like render: the chat draws the card from
      // this tool's own call, and the answer has to reach that call.
      codeMode: false,
      // secret.forget answers at once; the other two wait on the card.
      answers: { waitsWhen: 'args.action !== "secret.forget" && args.action !== "forget"', closedInChatNote: SECRET_REQUEST_CLOSED_IN_CHAT_NOTE },
      secretRun: true,
    }));
  }
  if (includeImage) {
    entries.push(createToolEntry({
      name: 'openchamber_image',
      description: IMAGE_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_IMAGE_ACTION_DEFINITIONS,
      parameters: IMAGE_PARAMETER_PROPERTIES,
      // Never behind Code Mode, like render: the chat draws the images from
      // this tool's own call, which an execute script would hide.
      codeMode: false,
    }));
  }
  if (includeUsage) {
    entries.push(createToolEntry({
      name: 'openchamber_usage',
      description: USAGE_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_USAGE_ACTION_DEFINITIONS,
      parameters: USAGE_PARAMETER_PROPERTIES,
      codeMode: true,
    }));
  }
  if (includeWorkflow) {
    entries.push(createToolEntry({
      name: 'openchamber_workflow',
      description: WORKFLOW_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_WORKFLOW_ACTION_DEFINITIONS,
      parameters: WORKFLOW_PARAMETER_PROPERTIES,
      // Never behind Code Mode, like render: the chat draws the run's card
      // from this tool's own call, which an execute script would hide.
      codeMode: false,
    }));
    entries.push(createToolEntry({
      name: WORKFLOW_ANSWER_TOOL,
      description: WORKFLOW_ANSWER_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_WORKFLOW_ANSWER_ACTION_DEFINITIONS,
      parameters: WORKFLOW_ANSWER_PARAMETER_PROPERTIES,
      // Direct: only the sessions that allow it see it, and the prompt that
      // asks for it names it.
      codeMode: false,
    }));
  }

  // The callback carries the per-child token over plain HTTP. With a proxy in
  // the child's environment, fetch would hand a non-loopback callback, token
  // included, to that proxy, and no per-request option turns that off. The
  // exemption is added inside the child because only there is the final
  // NO_PROXY, merged from the shell and server environments, visible.
  // The plugin checks a secret.run call and shows its command line with the
  // server's own functions, so the line the user approves is the one the card shows.
  const secretRunHelpers = includeSecret ? `const secretRunCommand = ${secretRunCommand.toString()}
const secretRunCommandLine = ${secretRunCommandLine.toString()}

` : '';
  return `${secretRunHelpers}const exemptCallbackFromProxy = () => {
  const endpoint = process.env.OPENCHAMBER_AGENT_TOOL_URL
  if (!endpoint || !URL.canParse(endpoint)) return
  const host = new URL(endpoint).hostname.replace(/^\\[|\\]$/g, "")
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] || "").split(",").map((entry) => entry.trim()).filter(Boolean)
    if (!entries.includes(host)) process.env[key] = [...entries, host].join(",")
  }
}

// Session id -> abort controllers of the calls that wait for the user's answer
// (a page, or a secret card).
const pagesWaitingForChat = new Map()
${includeRender || includeSecret ? `const isAgentPrompt = ${isAgentPrompt.toString()}
const endWaits = (sessionID) => {
  for (const controller of pagesWaitingForChat.get(sessionID) ?? []) controller.abort()
}

// Inbox id -> session id of the user's prompts not yet delivered. The user can
// move one between queue and steer, and OpenCode does that without running the
// prompt hook again, so the plugin follows the inbox events for these ids.
const pendingByUser = new Map()
const followUserPrompts = async (events) => {
  for await (const event of events) {
    if (event.type === "session.deleted") {
      for (const [inboxID, sessionID] of pendingByUser) if (sessionID === event.data?.sessionID) pendingByUser.delete(inboxID)
      continue
    }
    const sessionID = pendingByUser.get(event.data?.inboxID)
    if (!sessionID) continue
    if (event.type !== "session.inbox.delivery.changed") pendingByUser.delete(event.data.inboxID)
    else if (event.data.delivery === "steer") endWaits(sessionID)
  }
}
` : ''}
export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    exemptCallbackFromProxy()
    await ctx.tool.transform((tools) => {
${entries.join('')}    })${includeRender || includeSecret ? `
    await ctx.session.hook("prompt", (event) => {
      // An agent's prompt is not the user writing, and a queued one arrives
      // only after the turn: the page keeps waiting for the user.
      if (isAgentPrompt(event.metadata)) return
      pendingByUser.set(event.messageID, event.sessionID)
      if (event.delivery !== "queue") endWaits(event.sessionID)
    })
    if (ctx.event?.subscribe) {
      followUserPrompts(ctx.event.subscribe({ types: ["session.inbox.delivery.changed", "session.inbox.delivered", "session.inbox.cancelled", "session.deleted"] }))
        .catch((error) => console.warn("[openchamber-agent-tool] stopped following the user's prompts:", error?.message ?? error))
    }` : ''}
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
  const materializePlugin = async ({ includeControl = true, includeSchedule = false, includeWeb = true, includeMemory = true, includeKnowledge = false, includeNotify = false, includeRender = false, includeImage = false, includeSecret = false, includeUsage = false, includeWorkflow = false } = {}) => {
    if (!includeControl && !includeSchedule && !includeWeb && !includeMemory && !includeKnowledge && !includeNotify && !includeRender && !includeImage && !includeSecret && !includeUsage && !includeWorkflow) {
      throw new Error('At least one OpenChamber managed tool must be enabled to inject the plugin');
    }
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginManifestPath, PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(pluginPath, createPluginSource({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, includeImage, includeSecret, includeUsage, includeWorkflow }), { mode: 0o600 });
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
      // Secrets the chat remembers belong to the session OpenCode reported, too.
      const secretAction = OPENCHAMBER_SECRET_ACTIONS.includes(action);
      const contextSessionId = knowledgeAction || secretAction ? sessionID : asNonEmptyString(payload.contextSessionId) ?? sessionID;
      // The call id lets a page that waits for an answer be found again
      // when the user answers it.
      const contextCallId = asNonEmptyString(payload.callID);
      const actionOptions = { ...options };
      // Only the secret tool's plugin asks the shell permission before a run.
      if (action === 'secret.run' && payload.tool === 'openchamber_secret') actionOptions.secretRunAuthorized = true;
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
