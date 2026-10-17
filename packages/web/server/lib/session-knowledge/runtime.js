/**
 * What a session must be told about the project's knowledge.
 *
 * The text lives in OpenCode as the session's instruction entries
 * (`/api/experimental/session/:id/instructions/entries/:key`). OpenCode keeps
 * them with the session: the first values go into the system prompt, a value
 * that changes or goes away is announced to the agent at its next step, and
 * compaction, revert and fork keep them. So OpenChamber holds no record of what
 * a session was told; every sender writes what the session should carry now,
 * right before its message, and OpenCode tells the agent only what changed.
 *
 * One owner for every sender (a message from the UI, the queue, a scheduled
 * task, a session the agent dispatched): sessions started without a UI must
 * carry the same context as the ones a tab sends to.
 */
import { isRecord } from '../shared/guards.js';
import { RENDER_PAGE_WHEN } from '../openchamber-control/render-page.js';

const PINS_METADATA_KEY = 'project_context_pins';

/**
 * One entry per source, so a memory saved mid-session re-sends the memory
 * index and nothing else. OpenCode orders entries by key.
 */
export const KNOWLEDGE_ENTRY_KEYS = {
  checkout: 'openchamber.checkout',
  pinned: 'openchamber.pinned',
  memory: 'openchamber.memory',
  guidance: 'openchamber.guidance',
};

/** Budget for each entry; anything past it is cut, loudly. */
const KNOWLEDGE_MAX_LENGTH = 8000;

const truncate = (value) => (
  value.length <= KNOWLEDGE_MAX_LENGTH
    ? value
    : `${value.slice(0, KNOWLEDGE_MAX_LENGTH - 1)}…\n\n(truncated)`
);

/**
 * Where the session works, as the agent cannot see it for itself between two
 * messages: another session sharing the checkout may have switched the branch,
 * and the agent would go on editing that session's work. The directory is
 * named too, so a session moved to another worktree reads as a move.
 */
const describeCheckout = ({ directory, branch }) => (
  branch
    ? `This session works in \`${directory}\`, on branch \`${branch}\`.`
    : `This session works in \`${directory}\`, with no branch checked out.`
);

const renderMemorySection = (entries) => entries
  .slice()
  .sort((a, b) => a.createdAt - b.createdAt)
  .map((entry) => `- [${entry.type}] ${entry.title}`)
  .join('\n');

/**
 * When to save, stated in every session where memory is on. The tool
 * description alone is read only when the agent already means to call it, so
 * agents told nothing here saved only when the user said "remember".
 */
const MEMORY_SAVE_GUIDANCE = 'You have memory that persists across sessions, through the'
  + ' openchamber_memory tool. Save to it in the moment, without asking first, when:'
  + ' the user corrects how you work or states a preference; the user confirms that'
  + ' a non-obvious approach worked; or you learn a project fact that took real'
  + ' effort to find and is not in the code or docs. Before saving a project fact,'
  + ' check: would an agent reading the relevant code, docs and skills learn it,'
  + ' including why and whether it may change? Then skip it; otherwise save only'
  + ' the part they do not state. One fact per entry. The user'
  + ' can review and remove what you save, so save when it fits and mention it'
  + ' briefly. Save before you write your final reply and mention the save in it:'
  + ' the app shows only the text after a turn\'s last tool call as the reply and'
  + ' folds everything earlier into its activity log.';

/**
 * When to link, stated in every session that has the `openchamber` tool. The
 * same rule leads that tool's description; stated only there, an agent given
 * an issue to investigate never opened the tool and so never linked it.
 * The tool description states the same rule; change both together.
 */
export const SESSION_LINK_GUIDANCE = "When the user gives you an issue or a change under"
  + " review (a pull or merge request) to work on, fix, investigate or review, when you"
  + " open one for this work, and when the work resolves one, link it to this session"
  + " with the openchamber tool's session.link as soon as you know it, so the user"
  + " sees it with the session. Not one merely mentioned in passing. No need to"
  + " mention in your reply that you linked it.";

/**
 * When to draw a page, stated in every session that has the
 * `openchamber_render` tool, for the reason the link rule is: the tool
 * description is read only once the agent already means to draw. The cases
 * are shared with the tool description (RENDER_PAGE_WHEN).
 */
export const RENDER_PAGE_GUIDANCE = "You can show the user a chart, table, diagram or a mockup of an interface inline in the chat with the openchamber_render tool. "
  + RENDER_PAGE_WHEN
  + " A mockup of the user's own project takes its look from the project's code (theme tokens, CSS variables, styles), not from OpenChamber's theme."
  + " Draw a page that only shows right before your final reply, and keep the reply to what the page does not show."
  + " When the user has to choose between options a page shows better than text, such as layouts or designs, ask on a page with awaitAnswer and continue from the answer the call returns.";

/**
 * Titles only for memory, never bodies: an index carrying full text grows
 * without bound until it crowds out the conversation it was meant to inform.
 */
const buildMemoryBlock = ({ global, project, enabled = false, complete = false }) => {
  const sections = [];
  if (global.length > 0) sections.push(`### About the user\n\n${renderMemorySection(global)}`);
  if (project.length > 0) sections.push(`### About this project\n\n${renderMemorySection(project)}`);
  if (sections.length === 0) {
    if (!enabled) return '';
    // "Empty" only when both scopes loaded: a failed read is not an empty store.
    return complete
      ? `${MEMORY_SAVE_GUIDANCE}\n\nNothing is stored yet.`
      : MEMORY_SAVE_GUIDANCE;
  }

  return [
    ...(enabled ? [MEMORY_SAVE_GUIDANCE] : []),
    'Stored memory from earlier sessions: only the titles are listed below.',
    'A title is an abbreviation, not the memory. Read the entry with the'
      + ' openchamber_memory tool before you act on it: titles routinely leave out'
      + ' the conditions, exceptions and reasons that decide how the memory'
      + ' applies, and a title that looks self-explanatory is the most likely to'
      + ' be hiding them. Read every title that could bear on the task at hand;'
      + ' you need not read the ones unrelated to what you are doing. Read each'
      + ' entry once per conversation: what you read stays in your context, so do'
      + ' not read it again on later turns unless your context was summarized.',
    'Memory records what was true when it was written. Verify anything it says'
      + ' about files, flags or commands before relying on it.',
    ...sections,
  ].join('\n\n');
};

const buildPinnedBlock = ({ notes, plans }) => {
  const sections = [];
  if (notes.length > 0) {
    const rendered = notes
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((note) => `- ${note.body.trim()}`)
      .join('\n');
    sections.push(`## Pinned notes\n\n${rendered}`);
  }
  for (const plan of plans) {
    // A plan whose markdown cannot be read is marked rather than dropped:
    // losing one attachment must not silently shrink the context.
    sections.push(plan.body
      ? `## Pinned plan: ${plan.title}\n\n${plan.body}`
      : `## Pinned plan: ${plan.title}\n\n(plan content unavailable)`);
  }
  if (sections.length === 0) return '';

  return [
    'The user pinned the following project context.',
    ...sections,
  ].join('\n\n');
};

const buildGuidance = ({ linking, rendering }) => [
  linking ? SESSION_LINK_GUIDANCE : '',
  rendering ? RENDER_PAGE_GUIDANCE : '',
].filter(Boolean).join('\n\n');

/**
 * The text each entry should hold now. An empty text means the entry goes
 * away; a key left out keeps what the session holds, which is what a branch
 * that could not be read means.
 */
export const buildKnowledgeEntries = ({ notes, plans, memory, linking = false, rendering = false, checkout = null }) => {
  const entries = {
    [KNOWLEDGE_ENTRY_KEYS.pinned]: truncate(buildPinnedBlock({ notes, plans })),
    [KNOWLEDGE_ENTRY_KEYS.memory]: truncate(buildMemoryBlock(memory)),
    [KNOWLEDGE_ENTRY_KEYS.guidance]: buildGuidance({ linking, rendering }),
  };
  // The branch is told while the agent has the tool, whose worktree move is
  // the one thing it can do about a busy branch.
  if (!linking) entries[KNOWLEDGE_ENTRY_KEYS.checkout] = '';
  else if (checkout) entries[KNOWLEDGE_ENTRY_KEYS.checkout] = describeCheckout(checkout);
  return entries;
};

export const createSessionKnowledgeRuntime = (dependencies) => {
  const {
    projectContextRuntime,
    agentMemoryRuntime,
    resolveProjectId,
    isAgentMemoryEnabled,
    // Whether this session's agent has the `openchamber` tool to link with.
    isSessionLinkingAvailable = null,
    // The checked-out branch, or '' when none is checked out. Failures throw;
    // read only while the agent has the tool.
    readCheckoutBranch = null,
    // Whether this session's agent has the `openchamber_render` tool.
    isPageRenderingAvailable = async () => false,
    // Pins live in OpenChamber's own session metadata store.
    readSessionMetadata = null,
    persistSessionMetadata = null,
    // The session's instruction entries in OpenCode: `put(sessionId,
    // directory, key, text)` and `remove(sessionId, directory, key)`. Both are
    // idempotent there, so writing an unchanged value tells the agent nothing.
    instructionEntries = null,
  } = dependencies;

  const requireMetadataStore = () => {
    if (typeof readSessionMetadata !== 'function' || typeof persistSessionMetadata !== 'function') {
      throw new Error('project knowledge needs a session metadata store');
    }
  };

  /** The session shape the readers below expect, built from our own store. */
  const readStoredSession = async (sessionId) => ({ metadata: await readSessionMetadata(sessionId) });

  const readPins = (session) => {
    const metadata = isRecord(session?.metadata) ? session.metadata : {};
    const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    const pins = isRecord(openchamber[PINS_METADATA_KEY]) ? openchamber[PINS_METADATA_KEY] : {};
    const strings = (value) => Array.isArray(value)
      ? [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))]
      : [];
    return { notes: strings(pins.notes), plans: strings(pins.plans) };
  };

  /**
   * Everything the session should be carrying, read fresh. A failure in one
   * source never blanks the rest: a memory store that will not load must not
   * take the user's pinned notes down with it.
   */
  const collect = async (directory, pins = { notes: [], plans: [] }) => {
    const projectId = directory ? await resolveProjectId(directory) : '';

    let notes = [];
    let plans = [];
    if (projectId) {
      try {
        const context = await projectContextRuntime.readContext(projectId);
        const noteIds = new Set(pins.notes);
        const planIds = new Set(pins.plans);
        notes = (context.notes || []).filter((note) => noteIds.has(note.id));
        const pinnedPlans = (context.plans || []).filter((plan) => planIds.has(plan.id));
        plans = await Promise.all(pinnedPlans.map(async (plan) => {
          try {
            const content = await projectContextRuntime.readPlan(projectId, plan.id);
            return { id: plan.id, title: plan.title, body: content?.body?.trim() || '' };
          } catch {
            return { id: plan.id, title: plan.title, body: '' };
          }
        }));
      } catch {
        notes = [];
        plans = [];
      }
    }

    let memory = { global: [], project: [], enabled: false, complete: false };
    const memoryEnabled = typeof isAgentMemoryEnabled === 'function'
      ? await isAgentMemoryEnabled().catch(() => false)
      : true;
    if (memoryEnabled) {
      try {
        const stored = await agentMemoryRuntime.readAll(projectId || null);
        // A scope that failed to load is left out entirely rather than indexed
        // as empty, which would teach the agent to store what it already has.
        //
        // Flagged entries are withheld from the model but left in the store, so
        // the user can see what was caught. Dropping them would hide the
        // attempt from the only person able to judge it.
        const visible = (entries) => entries.filter((entry) => !entry.flagged);
        memory = {
          global: stored.globalFailed ? [] : visible(stored.global),
          project: stored.projectFailed ? [] : visible(stored.project),
          enabled: true,
          complete: !stored.globalFailed && !stored.projectFailed,
        };
      } catch {
        memory = { global: [], project: [], enabled: true, complete: false };
      }
    }

    const linking = typeof isSessionLinkingAvailable === 'function'
      ? await Promise.resolve(isSessionLinkingAvailable()).catch(() => false)
      : false;
    // The branch is read only while the tool that moves a session off it is there.
    const branch = linking && directory && readCheckoutBranch
      ? await Promise.resolve(readCheckoutBranch(directory)).catch(() => null)
      : null;
    const checkout = branch !== null ? { directory, branch } : null;

    const rendering = await Promise.resolve(isPageRenderingAvailable()).catch(() => false);

    return { notes, plans, memory, linking, rendering, checkout };
  };

  /**
   * What the session is carrying, for display. Deliberately does not read plan
   * bodies: the panel states counts and names, and reading every pinned plan
   * off disk to show a number would make opening a panel cost what sending a
   * message costs.
   */
  const collectSummary = async (directory, pins = { notes: [], plans: [] }) => {
    const projectId = directory ? await resolveProjectId(directory) : '';
    const empty = { notes: [], plans: [], memory: { global: 0, project: 0 } };
    if (!projectId) return empty;

    let notes = [];
    let plans = [];
    try {
      const context = await projectContextRuntime.readContext(projectId);
      const noteIds = new Set(pins.notes);
      const planIds = new Set(pins.plans);
      notes = (context.notes || []).filter((note) => noteIds.has(note.id))
        .map((note) => ({ id: note.id, body: note.body }));
      plans = (context.plans || []).filter((plan) => planIds.has(plan.id))
        .map((plan) => ({ id: plan.id, title: plan.title }));
    } catch {
      notes = [];
      plans = [];
    }

    let memory = { global: 0, project: 0 };
    const memoryEnabled = typeof isAgentMemoryEnabled === 'function'
      ? await isAgentMemoryEnabled().catch(() => false)
      : true;
    if (memoryEnabled) {
      try {
        const stored = await agentMemoryRuntime.readAll(projectId);
        memory = {
          global: stored.globalFailed ? 0 : stored.global.length,
          project: stored.projectFailed ? 0 : stored.project.length,
        };
      } catch {
        memory = { global: 0, project: 0 };
      }
    }

    return { notes, plans, memory };
  };

  const collectSummaryForSession = async (sessionId, directory) => {
    const session = await readStoredSession(sessionId).catch(() => null);
    return collectSummary(directory, readPins(session));
  };

  /**
   * Writes what the session should carry now into its instruction entries.
   * Called right before a message goes out, so the agent reads it with that
   * message. Never throws: a message without its background costs the agent
   * some context, a failed send costs the user their message. One entry that
   * will not write does not hold back the others.
   */
  const sync = async (sessionId, directory) => {
    if (!instructionEntries || !sessionId) return false;
    try {
      const session = await readStoredSession(sessionId).catch(() => null);
      const entries = buildKnowledgeEntries(await collect(directory, readPins(session)));
      const writes = await Promise.allSettled(Object.entries(entries).map(([key, text]) => (text
        ? instructionEntries.put(sessionId, directory, key, text)
        : instructionEntries.remove(sessionId, directory, key))));
      const failed = writes.find((write) => write.status === 'rejected');
      if (failed) console.warn('[session-knowledge] entry write failed:', failed.reason?.message || failed.reason);
      return !failed;
    } catch (error) {
      console.warn('[session-knowledge] sync failed:', error?.message || error);
      return false;
    }
  };

  const setPin = async (sessionId, directory, kind, id, pinned) => {
    requireMetadataStore();
    const pins = readPins(await readStoredSession(sessionId));
    const key = kind === 'note' ? 'notes' : 'plans';
    const next = new Set(pins[key]);
    if (pinned) next.add(id);
    else next.delete(id);
    // The next send writes the changed pin set; the merge patch leaves
    // neighbouring state alone.
    await persistSessionMetadata(sessionId, directory, {
      openchamber: { [PINS_METADATA_KEY]: { ...pins, [key]: [...next] } },
    });
    return { ...pins, [key]: [...next] };
  };

  return {
    collect,
    collectSummary,
    collectSummaryForSession,
    sync,
    readPins,
    setPin,
  };
};
