/**
 * Two capabilities, two tools.
 *
 * Controlling sessions and driving a page are different intents, and a single
 * tool description covering both is vaguer than either — which is how a model
 * ends up calling the wrong one. Separate tools also mean turning one off
 * removes it entirely, parameters included, rather than leaving its inputs
 * visible in a shared schema.
 */
export const OPENCHAMBER_CONTROL_ACTION_DEFINITIONS = Object.freeze([
  { action: 'projects.list', title: 'List session destinations', description: 'Projects and Chats; use an id as projectId for session.create. No parameters' },
  { action: 'models.list', title: 'Show model preferences', description: 'Default, favorite and recent models; no parameters' },
  { action: 'models.search', title: 'Search models', description: 'The model catalog, favorites and recent models first; optional query, provider, all, limit, offset' },
  { action: 'session.list', title: 'List sessions', description: 'Optional limit, all, withStatus' },
  { action: 'session.create', title: 'Create a session', description: 'In this directory by default; projectId from projects.list selects a project or openchamber:chats for a new Chat. Use the returned directory for later session actions. Prompt optional' },
  { action: 'session.send', title: 'Send a prompt', description: 'New prompt to sessionId' },
  { action: 'session.fork', title: 'Fork a session', description: 'Fork sessionId at messageId; prompt optional' },
  { action: 'session.status', title: 'Check session status', description: 'Status of sessionId' },
  { action: 'session.messages', title: 'Read session messages', description: 'Text messages and sessionStatus of sessionId' },
  { action: 'session.moveToWorktree', title: 'Move a session into a new worktree', description: 'Move sessionId (default: this session) and its carry files into a new worktree, made the way the New worktree dialog makes one; requires worktree. Nothing moves when carry cannot be applied; directory is ignored' },
  { action: 'session.link', title: 'Link a change or issue to a session', description: 'Add link to sessionId (default: this session); the same link again updates its title. Only the user removes links' },
  { action: 'pr.watch', title: 'Wait on a pull request', description: 'Requires url of a GitHub pull request or GitLab merge request. A message arrives in this session when a check fails or every check passes, someone comments or reviews, the branch conflicts or falls behind, or it is merged or closed. One wake ends the watch: watch again to keep waiting. Never wait with a sleep loop' },
  { action: 'pr.unwatch', title: 'Stop waiting on a pull request', description: 'This session stops waiting; no parameters' },
  { action: 'work.name', title: 'Name the task', description: 'Name the task sessionId (default: this session) works on, in title: at most 4 words saying what the task is; rename only when it becomes a different task. Names its worktree, or in the main checkout the session it grew from. Answers the current name; a name the user gave stays. Only while the branch of a worktree is a placeholder OpenChamber generated (its checkout context says so), it also requires branch, the branch named after the task, and renames it; any other branch stays' },
  { action: 'schedule.status', title: 'Check scheduler status', description: 'No parameters', agentExposed: false },
  { action: 'schedule.list', title: 'List scheduled tasks', description: 'Tasks and scheduler status' },
  { action: 'schedule.create', title: 'Create a scheduled task', description: 'Requires name, prompt, one schedule selector, and model unless targetSessionId is set, which keeps that session\'s model' },
  { action: 'schedule.update', title: 'Change a scheduled task', description: 'Change taskId in place, keeping its id and run state; pass only what changes' },
  { action: 'schedule.run', title: 'Run a scheduled task', description: 'Run taskId now' },
  { action: 'schedule.delete', title: 'Delete a scheduled task', description: 'Delete taskId' },
  { action: 'schedule.toggle', title: 'Enable or disable a scheduled task', description: 'Requires taskId and disabled' },
  { action: 'file.open', title: 'Show a file to the user', description: 'Put path in front of the user\'s file panel, for a result worth seeing: a screenshot, report, CSV, recording, generated page' },
]);

const OPENCHAMBER_CONTROL_ACTIONS = Object.freeze(
  OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.map(({ action }) => action),
);

const AGENT_EXPOSED_CONTROL_ACTION_DEFINITIONS = OPENCHAMBER_CONTROL_ACTION_DEFINITIONS
  .filter(({ agentExposed }) => agentExposed !== false);
const isScheduleAction = ({ action }) => action.startsWith('schedule.');

/**
 * The control service runs sessions and scheduled tasks alike, for the CLI
 * too, but agents get them as two tools: scheduling is its own intent, carries
 * ten inputs of its own, and the user can switch it off without losing
 * session control.
 */
export const OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS = Object.freeze(
  AGENT_EXPOSED_CONTROL_ACTION_DEFINITIONS.filter((definition) => !isScheduleAction(definition)),
);

export const OPENCHAMBER_AGENT_TOOL_ACTIONS = Object.freeze(
  OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENCHAMBER_SCHEDULE_ACTION_DEFINITIONS = Object.freeze(
  AGENT_EXPOSED_CONTROL_ACTION_DEFINITIONS.filter(isScheduleAction),
);

export const OPENCHAMBER_SCHEDULE_ACTIONS = Object.freeze(
  OPENCHAMBER_SCHEDULE_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENCHAMBER_WEB_ACTION_DEFINITIONS = Object.freeze([
  { action: 'browser.open', title: 'Open a page in the browser panel', description: 'Load url; without tabId into a new background tab, whose tabId the result returns for later actions. drivable false means display-only: no further actions there' },
  { action: 'browser.snapshot', title: 'Read the open page', description: 'url, title, visible text, interactive elements with selectors, logged errors, and open tabs with their ids and who opened each; selector reads one part' },
  { action: 'browser.click', title: 'Click on the open page', description: 'By selector, or text for a link or button label' },
  { action: 'browser.type', title: 'Type into the open page', description: 'Type value into selector' },
  { action: 'browser.select', title: 'Select an option on the open page', description: 'One exact option by label or value in the native select matched by selector' },
  { action: 'browser.scroll', title: 'Scroll the open page', description: 'By direction, or to bring selector into view' },
  { action: 'browser.back', title: 'Go back in the browser panel', description: 'No parameters' },
  { action: 'browser.forward', title: 'Go forward in the browser panel', description: 'No parameters' },
  { action: 'browser.inspect', title: 'Read how an element renders', description: 'Computed styles of selector as rendered' },
  { action: 'browser.capture', title: 'Save a screenshot of the page', description: 'Save the visible panel as an image in the project; returns its path to cite in your answer' },
  { action: 'browser.resize', title: 'Change the page viewport', description: 'Lay the page out at viewport; fill uses the whole panel' },
  { action: 'browser.close', title: 'Close a browser tab', description: 'Close a tab this session opened; without tabId, its most recent one. Never a tab the user opened' },
]);

export const OPENCHAMBER_WEB_ACTIONS = Object.freeze(
  OPENCHAMBER_WEB_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Memory is its own tool for the same reason web is: remembering across
 * sessions is a distinct intent from controlling one, and a shared description
 * would blur both. It also has to switch off cleanly and completely, which a
 * shared schema cannot do.
 *
 * The session already carries an index of stored titles and says to read an
 * entry before acting on it (../session-knowledge/runtime.js), so memory.read
 * takes a title as the index spells it and memory.list is for a missing or
 * stale index.
 */
export const OPENCHAMBER_MEMORY_ACTION_DEFINITIONS = Object.freeze([
  { action: 'memory.read', title: 'Read a stored memory', description: 'Full text of one memory; requires title or memoryId' },
  { action: 'memory.list', title: 'List stored memories', description: 'Titles, when the session index is missing or stale' },
  { action: 'memory.save', title: 'Remember something', description: 'Requires title, body, scope. Saving the same thing updates it; memoryId rewrites that entry, to correct one or merge several into it' },
  { action: 'memory.delete', title: 'Forget a memory', description: 'For a memory that turned out wrong or obsolete; requires memoryId and scope' },
]);

export const OPENCHAMBER_MEMORY_ACTIONS = Object.freeze(
  OPENCHAMBER_MEMORY_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Project knowledge is its own tool: keeping the Notes, Todos and Plans the
 * user sees in the panel is a distinct intent from running sessions, and the
 * user switches it off on its own without losing session control. One small
 * vocabulary with `kind` keeps the bare verbs unambiguous, the way memory's are.
 * Plans are markdown files, so reading one and small edits use the agent's
 * own file tools on the path list gives.
 */
export const OPENCHAMBER_KNOWLEDGE_ACTION_DEFINITIONS = Object.freeze([
  { action: 'knowledge.list', title: 'List project knowledge', description: 'Notes with text, todos with state and links, plans with their file paths and session. Optional planId and ready filters. List before adding, to avoid duplicates' },
  { action: 'knowledge.save', title: 'Save project knowledge', description: 'Requires kind and body; with id it replaces. A plan body is the whole markdown, and the answer gives its path. An update may send only the fields it changes: completed, planId or dependsOn; sessionId on a plan, without body' },
  { action: 'knowledge.delete', title: 'Delete project knowledge', description: 'Requires kind and id' },
  { action: 'knowledge.show', title: 'Show a plan to the user', description: 'Open a plan for the user to read, comment on and send to a session; requires kind plan and id' },
]);

export const OPENCHAMBER_KNOWLEDGE_ACTIONS = Object.freeze(
  OPENCHAMBER_KNOWLEDGE_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Notify is its own tool so it can stay off by default and disappear
 * completely: an agent that can page the user is a choice the user makes.
 */
export const OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS = Object.freeze([
  { action: 'notify.send', title: 'Notify the user', description: 'Requires title' },
]);

export const OPENCHAMBER_NOTIFY_ACTIONS = Object.freeze(
  OPENCHAMBER_NOTIFY_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Render is its own tool: a page drawn into the chat is a distinct intent from
 * any of the others, and its long layout guidance should cost context only for
 * users who keep it on. The page itself travels in the call's input, which the
 * chat already stores and syncs, so the action only checks it.
 */
export const OPENCHAMBER_RENDER_ACTION_DEFINITIONS = Object.freeze([
  { action: 'render.page', title: 'Show a page', description: 'Requires html and title' },
]);

export const OPENCHAMBER_RENDER_ACTIONS = Object.freeze(
  OPENCHAMBER_RENDER_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Image generation is its own tool: off by default, and while on it calls a
 * second model the user chose, which costs money of its own.
 */
export const OPENCHAMBER_IMAGE_ACTION_DEFINITIONS = Object.freeze([
  { action: 'image.generate', title: 'Generate an image', description: 'Requires prompt' },
]);

export const OPENCHAMBER_IMAGE_ACTIONS = Object.freeze(
  OPENCHAMBER_IMAGE_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Asking for a secret is its own tool: it is the one action that takes a
 * credential from the user, so it can be switched off alone. The value goes
 * to a private file and only its path reaches the agent.
 */
export const OPENCHAMBER_SECRET_ACTION_DEFINITIONS = Object.freeze([
  { action: 'secret.request', title: 'Ask for a secret', description: 'Requires label and reason' },
]);

export const OPENCHAMBER_SECRET_ACTIONS = Object.freeze(
  OPENCHAMBER_SECRET_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Workflows are their own tool: fanning a large task out to many agents is a
 * distinct intent with its own scripting guidance, and it ships dark behind
 * OPENCHAMBER_WORKFLOWS_ENABLE, so it has to disappear completely.
 */
export const OPENCHAMBER_WORKFLOW_ACTION_DEFINITIONS = Object.freeze([
  { action: 'workflow.check', title: 'Check a workflow', description: 'Compile script, or a saved workflow by name, without running it: its name, description and phases' },
  { action: 'workflow.run', title: 'Propose a workflow run', description: 'script, or name of a saved workflow, with optional args. The user approves the plan in the chat; the report arrives here as a message when the run ends. Returns runId at once' },
  { action: 'workflow.status', title: 'Check a workflow run', description: 'Phases, agents with their state, key and session id, recent log lines and a result preview of runId' },
  { action: 'workflow.result', title: 'Read a workflow result', description: "The whole result of runId; with agent (its key or session id) that agent's prompt and full answer" },
  { action: 'workflow.stop', title: 'Stop a workflow run', description: 'Stop runId; its running agents are interrupted' },
  { action: 'workflow.resume', title: 'Resume a workflow run', description: 'Run a stopped or failed runId again: agents asked the same as before return their saved answer, the rest run' },
  { action: 'workflow.save', title: 'Save a workflow', description: 'Save script as .openchamber/workflows/<meta.name>.js in this project, to run later by name; overwrite replaces one' },
  { action: 'workflow.list', title: 'List workflows', description: "This project's saved workflows and this session's runs" },
]);

export const OPENCHAMBER_WORKFLOW_ACTIONS = Object.freeze(
  OPENCHAMBER_WORKFLOW_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * How a workflow agent asked for a schema answer hands it over. A tool of its
 * own: the managed config denies it in every session
 * (`../agent-tool/runtime.js`, `managedPermissionRules`) and the session of a
 * workflow agent asked for one allows it (`../workflows/agent-session.js`), so
 * no other session carries its declaration.
 */
export const WORKFLOW_ANSWER_TOOL = 'openchamber_workflow_answer';

export const OPENCHAMBER_WORKFLOW_ANSWER_ACTION_DEFINITIONS = Object.freeze([
  { action: 'workflow.answer', title: 'Submit a workflow answer', description: 'Only for a workflow agent whose prompt asks for it: answer, a JSON value matching the schema in that prompt. Checked on the spot; a mismatch says what to fix' },
]);

export const OPENCHAMBER_WORKFLOW_ANSWER_ACTIONS = Object.freeze(
  OPENCHAMBER_WORKFLOW_ANSWER_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Which actions each managed tool may ask for.
 *
 * The callback needs this because models routinely drop the namespace: asked
 * for `memory.read` from a tool already called `openchamber_memory`, they send
 * `read`, since the tool's own name appears to have said "memory" already. The
 * name is unambiguous inside one tool's action set even when it is not across
 * all of them (`delete` belongs to both schedule and memory), so resolution
 * starts from the tool that asked.
 */
const ACTIONS_BY_TOOL = Object.freeze({
  openchamber: OPENCHAMBER_AGENT_TOOL_ACTIONS,
  openchamber_schedule: OPENCHAMBER_SCHEDULE_ACTIONS,
  openchamber_web: OPENCHAMBER_WEB_ACTIONS,
  openchamber_memory: OPENCHAMBER_MEMORY_ACTIONS,
  openchamber_knowledge: OPENCHAMBER_KNOWLEDGE_ACTIONS,
  openchamber_notify: OPENCHAMBER_NOTIFY_ACTIONS,
  openchamber_render: OPENCHAMBER_RENDER_ACTIONS,
  openchamber_image: OPENCHAMBER_IMAGE_ACTIONS,
  openchamber_secret: OPENCHAMBER_SECRET_ACTIONS,
  openchamber_workflow: OPENCHAMBER_WORKFLOW_ACTIONS,
  [WORKFLOW_ANSWER_TOOL]: OPENCHAMBER_WORKFLOW_ANSWER_ACTIONS,
});

const bareName = (action) => {
  const separator = action.indexOf('.');
  return separator === -1 ? action : action.slice(separator + 1);
};

const uniqueMatch = (candidates, requested) => {
  const matches = candidates.filter((candidate) => bareName(candidate) === requested);
  return matches.length === 1 ? matches[0] : null;
};

/**
 * The canonical action for what a tool asked, or the reason it could not be
 * resolved. The reason lists what the tool can actually do: an error that only
 * says "unsupported" leaves the model to guess again, which is how one wrong
 * name becomes three.
 */
export const resolveAgentToolAction = (requested, toolName) => {
  const value = typeof requested === 'string' ? requested.trim() : '';
  const scoped = ACTIONS_BY_TOOL[toolName] ?? null;
  const known = scoped ?? OPENCHAMBER_ALL_ACTIONS;

  if (value && known.includes(value)) {
    return { action: value };
  }
  if (value) {
    const resolved = uniqueMatch(known, value)
      // A tool that did not identify itself still gets the benefit when the
      // bare name means only one thing across every action.
      ?? (scoped ? null : uniqueMatch(OPENCHAMBER_ALL_ACTIONS, value));
    if (resolved) {
      return { action: resolved };
    }
  }

  return {
    error: `Unsupported OpenChamber action: ${value || 'missing'}. Use one of: ${known.join(', ')}`,
  };
};

/** Everything the callback route will dispatch, whichever tool asked. */
export const OPENCHAMBER_ALL_ACTIONS = Object.freeze([
  ...OPENCHAMBER_CONTROL_ACTIONS,
  ...OPENCHAMBER_WEB_ACTIONS,
  ...OPENCHAMBER_MEMORY_ACTIONS,
  ...OPENCHAMBER_KNOWLEDGE_ACTIONS,
  ...OPENCHAMBER_NOTIFY_ACTIONS,
  ...OPENCHAMBER_RENDER_ACTIONS,
  ...OPENCHAMBER_IMAGE_ACTIONS,
  ...OPENCHAMBER_SECRET_ACTIONS,
  ...OPENCHAMBER_WORKFLOW_ACTIONS,
  ...OPENCHAMBER_WORKFLOW_ANSWER_ACTIONS,
]);
