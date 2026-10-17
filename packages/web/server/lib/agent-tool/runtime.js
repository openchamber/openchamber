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
  resolveAgentToolAction,
  OPENCHAMBER_WEB_ACTION_DEFINITIONS,
  OPENCHAMBER_WEB_ACTIONS,
} from '../openchamber-control/actions.js';
import {
  RENDER_PAGE_CLOSED_IN_CHAT_NOTE,
  RENDER_PAGE_MAX_HTML_LENGTH,
  RENDER_PAGE_MAX_TITLE_LENGTH,
  RENDER_PAGE_WHEN,
} from '../openchamber-control/render-page.js';
import { createCallbackAddress } from './callback-address.js';

const TOOL_SCHEMA_VERSION = 1;
const PLUGIN_ID = 'openchamber-agent-tool';
// Everything either managed tool may ask for; the agent allowlist stays
// narrower than the full control surface.
const ACTIONS = new Set([
  ...OPENCHAMBER_AGENT_TOOL_ACTIONS,
  ...OPENCHAMBER_WEB_ACTIONS,
  ...OPENCHAMBER_MEMORY_ACTIONS,
  ...OPENCHAMBER_KNOWLEDGE_ACTIONS,
  ...OPENCHAMBER_NOTIFY_ACTIONS,
  ...OPENCHAMBER_RENDER_ACTIONS,
]);
const AGENT_TOOL_ACTION_TITLES = Object.fromEntries(
  [
    ...OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
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
  link: {
    type: 'object',
    description: 'What session.link records, on any service',
    properties: {
      url: { type: 'string', description: 'Its web address' },
      title: { type: 'string' },
      kind: { type: 'string', enum: ['change', 'issue'], description: 'change is a code change under review (pull, merge or change request); issue is a task or ticket' },
      identifier: { type: 'string', description: 'Its short label on that service, such as !42 or OPS-7; optional' },
    },
    required: ['url', 'title', 'kind'],
    additionalProperties: false,
  },
  taskId: { type: 'string' },
  targetSessionId: { type: 'string', description: 'Scheduled task target; omit for a new session, empty on update clears it' },
  title: { type: 'string' },
  prompt: { type: 'string' },
  model: { type: 'string', description: 'Model in provider/model format. When the user names no model: for session.create pick a suitable one from models.list favorites or recents (omit if there are none); for send and fork omit it — the session reuses its previous model' },
  agent: { type: 'string', description: 'OpenCode agent name; new sessions default to the build agent and existing sessions keep their previous one. Set only when the user explicitly requests a different agent' },
  variant: { type: 'string', description: 'Model variant; use only when the user explicitly requests it' },
  worktree: { type: 'string', description: 'Folder name of a new worktree. For session.create omit it by default and use it only when the user explicitly asks for an isolated worktree; uncommitted changes do not carry over there. Required for session.moveToWorktree: short and named after the task, such as fix-login-timeout' },
  branch: { type: 'string', description: 'Branch name for the new worktree; defaults to the worktree name' },
  startRef: { type: 'string', description: 'Git ref the new worktree branches from; session.moveToWorktree defaults to the repository\'s default branch' },
  carry: { type: 'array', items: { type: 'string' }, description: 'session.moveToWorktree: the files you changed, whose uncommitted changes go along into the new worktree; nothing else moves' },
  existingBranch: { type: 'string', description: 'session.moveToWorktree: check out this branch that already exists instead of making a new one; a local branch, or a remote one such as origin/feature, which gets a local branch tracking it. Do not combine with branch or startRef' },
  setUpstream: { type: 'boolean', description: 'Make the new worktree branch track its upstream' },
  pullRequest: { type: 'integer', minimum: 1, description: "Pull or merge request number in this project for session.create: the session starts in a new worktree on that request's branch, made the way the New worktree dialog makes it. worktree and branch only rename the folder and the local branch. Use only when the user asks to work on that pull request" },
  goal: { type: 'boolean', description: 'Run the dispatched prompt in Goal Mode; use only when the user explicitly requests it' },
  goalTokenBudget: { type: 'integer', minimum: 1000, maximum: 100_000_000, description: 'Goal token budget; requires goal' },
  returnResult: { type: 'boolean', description: 'For session.create, send and fork with a prompt: deliver the session\'s final answer back to you as a message when it finishes, waking you to continue. The call still returns at once. Set only when the user wants the outcome back or your next step needs it' },
  lastAssistant: { type: 'boolean', description: 'session.messages: return only the last assistant message' },
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
  tabId: { type: 'string', description: 'Browser tab to act on, an id from the tabs a browser.snapshot lists. Omit to use the tab this session last opened or worked in; a session with no tab of its own uses the tab the user is looking at, only when the user opened it and it is in this session\'s project' },
  body: { type: 'string', description: 'Full text of the memory, at most 2000 characters; a longer body is rejected rather than trimmed. State it so it still makes sense in a session that has none of this conversation' },
  scope: { type: 'string', enum: ['global', 'project', 'both'], description: 'global is about the user and applies everywhere; project is about this codebase. both is only valid for memory.list' },
  memoryId: { type: 'string', description: 'Memory ID from a memory.list or memory.read result. On memory.save it rewrites that entry instead of matching one by wording' },
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

// Its own names, not the shared map: `title`, `body` and `text` mean something
// else in the other tools.
const KNOWLEDGE_PARAMETER_PROPERTIES = {
  ...pickParameters(['projectId', 'directory']),
  kind: { type: 'string', enum: ['note', 'todo', 'plan'], description: 'What the action is about; list needs none' },
  id: { type: 'string', description: 'ID from list or from the save that created it; leave it out of save to create' },
  body: { type: 'string', description: 'Note text (at most 3000 characters), todo text (at most 1000) or the whole plan markdown (at most 200000)' },
  completed: { type: 'boolean', description: 'Todo state; false reopens it' },
  expected: { type: 'string', description: 'The note text or plan file exactly as you last read it; replacing fails if it changed since' },
};

// Its own names, not the shared map: `title` and `body` mean something else in
// the control and memory tools.
const NOTIFY_PARAMETER_PROPERTIES = {
  title: { type: 'string', description: 'Short headline the user reads first, up to 120 characters' },
  body: { type: 'string', description: 'One or two sentences of detail, up to 500 characters' },
  showWhenFocused: { type: 'boolean', description: 'Show it even while the user is looking at OpenChamber. Only for something that cannot wait' },
};

// Its own names: `title` here names the page.
const RENDER_PARAMETER_PROPERTIES = {
  html: { type: 'string', description: `One complete, self-contained HTML document, at most ${RENDER_PAGE_MAX_HTML_LENGTH} characters` },
  title: { type: 'string', description: `Short name for the page, at most ${RENDER_PAGE_MAX_TITLE_LENGTH} characters` },
  awaitAnswer: { type: 'boolean', description: 'Wait for the user to answer on the page; the call returns their answer' },
};

// The linking rule leads: stated only inside the session.link action, an
// agent handed an issue to investigate never opened this tool and never
// linked it. SESSION_LINK_GUIDANCE in ../session-knowledge/runtime.js states
// the same rule in every session's context; change both together.
//
// The worktree move follows as an introduction, not a rule: whether a busy
// checkout calls for a worktree depends on how the user works, and users ask
// for a pull request or for work kept apart rather than for a worktree.
const WORKTREE_MOVE_INTRO = "session.moveToWorktree moves this session into its own worktree, branching from the default branch, so its work stays apart from whatever else happens in this checkout. It can help when the checkout looks busy: the branch carries someone's pull request or uncommitted changes, another session works here, or the branch changed between your messages. Whether that fits depends on how the user works. When it looks like it would help, you can ask the user. Move when they agree, or when what they asked for already calls for work kept apart from this checkout, such as a pull request of its own while the checkout holds other work. Use it rather than git worktree add: the session moves along, so the user finds it under that worktree in OpenChamber. Unlike worktree_create, it makes a new branch from the default branch instead of a detached copy of where you are, and can carry the files you changed. Uncommitted changes stay where they are unless you name the files you changed in carry. "

const CONTROL_TOOL_DESCRIPTION = "When the user gives you an issue or a change under review (a pull or merge request) to work on, fix, investigate or review, when you open one for this work, and when the work resolves one, link it to this session with session.link as soon as you know it, so the user sees it with the session. Not one merely mentioned in passing. No need to mention in your reply that you linked it. "
  + WORKTREE_MOVE_INTRO
  + "The tool also runs OpenChamber projects, sessions and scheduled tasks for the user. A session you create, send to or fork belongs to the user: they follow it in OpenChamber and talk to it themselves. Dispatch one when the user asks for it, even when the work relates to your current task; any agent, optionally in a new worktree. To delegate part of your own task and get the answer yourself, use the subagent tool instead. A dispatch returns at once. Set returnResult when the user wants the outcome back or your next step needs it: the session's final answer then arrives in this session as a message when it finishes, and you continue from there. Without it, the session is the user's to follow and you move on. To see how a session went, read it with session.messages (lastAssistant for the final answer); session.send always starts a new prompt. One action per call; scope with projectId or directory, or leave both out for this session's directory. Deleting sessions and worktrees is not available.";

const WEB_TOOL_DESCRIPTION = "Look at and interact with a web page in OpenChamber's browser panel, so you can check your own work rather than describing what you expect. Use one action per call. Open a page, snapshot it to read its text and its interactive elements, then click, type or scroll using the selectors the snapshot returned; snapshots also report any errors the page logged. Pass a selector to browser.snapshot to read one part of a long page. browser.inspect returns computed styles when the question is how something renders. Set viewport to check a layout at mobile, tablet or desktop size. The page runs with the user's real logins, so treat what you see as their live session.";

const MEMORY_TOOL_DESCRIPTION = "Keep what you learn across sessions, so the user does not have to explain the same thing twice. Use one action per call. The session already lists the titles of what is stored. A title is an abbreviation, not the memory: read the entry with memory.read once before acting on it (it then stays in your context; do not re-read it on later turns), because titles leave out the conditions and exceptions that decide how the memory applies, and the ones that look self-explanatory hide them most often. Save something only when it will still be true in a later session — a stable preference, a project convention, a decision and its reason, or a hard-won pointer. Before saving something about the project, ask: would an agent that reads the relevant code, docs and skills learn all of it, including why it is so and whether it may be changed? If yes, do not save it. Code shows what was done, not why, nor that it was deliberate: save the decision, its reason, a rejected alternative or a \"leave this as it is\", without retelling how the code works, because that retelling goes stale first. Corrections and preferences from the user are never in the code, so this check does not hold them back. Do not save one-off task state, secrets or credentials, or anything the user asked you not to keep; when the user explicitly asks you to remember something, save it, unless it is a secret or credential. Choose the scope deliberately: global is about the user and reaches every project, so put a project's conventions in project scope. Save in the moment, without asking first, when the user corrects how you work or states a preference, confirms that a non-obvious approach worked, or when you learn a project fact that took real effort to find. One fact per entry. The user can review and remove what you save, so save when it fits and mention it briefly. Save before you write your final reply and mention the save in it: the app shows only the text after a turn's last tool call as the reply and folds everything earlier into its activity log.";

const KNOWLEDGE_TOOL_DESCRIPTION = "The project's Notes, Todos and Plans: what the user keeps in OpenChamber's Project knowledge panel, shared by every session in the project. Use one action per call; list shows everything at once. Notes are short facts and decisions the user wants at hand; what you learn for yourself belongs in memory. Todos are the user's backlog: add one when the user asks, or when you stop with work left for later, never to track the steps of your current task. Plans are markdown files: list gives each one's path, so read a plan and make small changes to it with your own file tools, and use save to create a plan or replace it whole. Start a plan with a # title line and a short ## Steps checklist of its coarse steps (- [ ] each), then the detail. When you write a plan for the user, save it, show it, and wait: the user reads it, comments on lines, asks for changes, and sends it to a session when it is ready. When you implement a saved plan, tick its step (- [x]) in the file as you finish each one, so the user sees the progress; change nothing else in it unless the user asks, and never drop a constraint from it on your own. Before replacing a note or a plan whole, pass the text you last read as expected: the save then fails instead of overwriting a change made after your read. Scope with projectId or directory, or leave both out for this session's project.";

const NOTIFY_TOOL_DESCRIPTION = "Send the user a notification through OpenChamber, so they learn about something without watching the session. Use it when you finish work that took long enough for the user to step away, when you are blocked on something only the user can resolve, or when the user asked to be told about something. Do not use it for routine progress, for every finished step, or to repeat what your reply already says to a user who is present. Keep the title short and put detail in the body.";

// Where the agent saves a screenshot for a page, so it stays out of the
// project. The image grant route (../markdown-image-grants/routes.js) reads a
// page's images from anywhere on the machine.
const OPENCODE_TEMP_DIRECTORY = path.join(os.tmpdir(), 'opencode');

// The variables are the ones packages/ui/src/components/chat/message/parts/htmlRender.ts
// injects; change both together.
const RENDER_TOOL_DESCRIPTION = [
  "Show the user a finished HTML page (a chart, table, diagram, comparison or mockup) inline in the chat, or ask them to choose on one (awaitAnswer, below).",
  RENDER_PAGE_WHEN,
  "Call a page that only shows right before you write your final reply. The user already sees the page above that reply, so the reply does not announce it, say where it is or restate it; add only what the page does not say.",
  "The page can be interactive with its own script: hover tooltips on a chart, tabs, toggles, sorting or filtering a table. On a phone a tap shows a hover tooltip and the page is about 360px wide, so place tooltips and popups inside the page, flipping them to the other side near an edge.",
  "To ask the user something a page shows better than text (pick one of several layouts or designs, tune values, choose or order many items), set awaitAnswer: the call waits until the user answers on the page and returns their summary and data, so call it at the point where you need the choice, in the middle of the work if that is where it falls, and continue from the answer. Ask a yes/no or one short choice in text. Give that page one clear button whose click calls openchamber.submit(data, summary): data is the JSON your next step needs, summary is the choice in a few words of the user's language, shown under the page. submit returns a promise; disable the button once it resolves. submit only works from a click on a page that waits, so a page without awaitAnswer has no submit button. If the user writes in the chat instead, the call returns answered: false and their message follows. After an answer, the page loads with openchamber.answer set to the data it sent, so it can show the choice. The base stylesheet has classes in the app's look for such a page; use them instead of styling your own: .oc-options (a grid of options), .oc-option on a <button> (an option card; set aria-pressed=\"true\" on the chosen one) and .oc-button (the button that sends).",
  `Write one self-contained document with inline <style> and <script>. Draw charts with inline SVG or your own script: remote scripts and stylesheets do not load in every OpenChamber client. Images are https URLs, data: URLs or image files on this machine. Name a file by its absolute path in an src attribute, a CSS url() or a quoted string in your script, and the chat puts the file in its place: a PNG, JPEG, GIF or WebP of at most 10 MB, at most 12 per page, from anywhere on this machine; save a screenshot you take for a page in ${OPENCODE_TEMP_DIRECTORY}, not in the project. The page runs in a sandbox with no access to OpenChamber, the network session or local files; links open in the user's browser.`,
  "The page sits on the chat's own background, as wide as the reply column (about 720px on desktop, about 360px on phones), and the frame takes the page's full height, so keep the page as short as its content allows. Leave html, body and the outermost element without a background color, use a fluid width with no horizontal padding on the outermost element and nothing wider than the column (stack or wrap on narrow widths, and give a wide table its own overflow-x:auto box rather than making the whole page scroll sideways), and add no outer card, border or banner title: the page is part of your reply. Set a box apart by tone, never by a border, the way the app does: background color-mix(in srgb, var(--foreground) 4%, transparent), the next step (6%) for a box inside it, at least 16px of padding and var(--radius) corners. Draw a line only where it means something, such as a divider between sections. Give charts fixed pixel heights, and never use 100vh or height:100% on html or body.",
  "OpenChamber sets its active theme as CSS custom properties on :root and updates them live when the user switches theme: --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --border, --primary, --primary-foreground, --destructive, --warning, --success, --info, --code-background, --code-foreground, --chart-1 to --chart-6 (categorical series), --radius, --font-sans, --font-mono. Style with them so the page matches the app in light and dark themes; a base stylesheet already sets the page's text color and font from them. A mockup of the user's own project is the exception: it shows how their product will look, so take its colors, fonts, spacing and radii from the project's code (theme tokens, CSS variables, Tailwind config, global styles) and write them into the page, inside a box that carries the project's own background.",
].join(' ');

// A field means the same thing in every tool that declares it, so one set
// covers them all.
const BOOLEAN_PARAMETER_NAMES = [...new Set([
  ALL_PARAMETER_PROPERTIES,
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
const createToolEntry = ({ name, description, definitions, parameters, codeMode, answers = false }) => String.raw`    tools.add({
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
            signal: ${answers ? 'waitSignal' : 'context.signal'},
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

const createPluginSource = ({ includeControl, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, codeMode }) => {
  const entries = [];
  if (includeControl) {
    entries.push(createToolEntry({
      name: 'openchamber',
      description: CONTROL_TOOL_DESCRIPTION,
      definitions: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
      parameters: CONTROL_PARAMETER_PROPERTIES,
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

  const { callbackHost, isSameMachineAddress } = createCallbackAddress(getActiveHost);

  /**
   * Write the plugin for the requested tool set and return its directory.
   *
   * Called both before a managed child starts and whenever the tool settings
   * change while it runs, so the source on disk always matches the settings —
   * the running OpenCode reloads the directory it already has configured.
   */
  const materializePlugin = async ({ includeControl = true, includeWeb = true, includeMemory = true, includeKnowledge = false, includeNotify = false, includeRender = false, codeMode = false } = {}) => {
    if (!includeControl && !includeWeb && !includeMemory && !includeKnowledge && !includeNotify && !includeRender) {
      throw new Error('At least one OpenChamber managed tool must be enabled to inject the plugin');
    }
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginManifestPath, PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(pluginPath, createPluginSource({ includeControl, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, codeMode }), { mode: 0o600 });
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
