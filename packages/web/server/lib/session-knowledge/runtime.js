/**
 * What a session must be told about the project's knowledge, and whether it has
 * been told yet.
 *
 * One owner, three moments. The block is attached to an outgoing prompt when
 * there is one (a message from the UI, a scheduled task, a session the agent
 * dispatched) and re-sent on its own after compaction, when there is no message
 * to attach it to. The decision is the same in every case, so it lives here
 * rather than in each sender — the client used to own it, which meant sessions
 * started without a UI got nothing at all.
 *
 * What was delivered is recorded in the session's own metadata rather than in
 * the browser. A signature held in a tab is lost when the tab closes, and worse,
 * it survives compaction: the tab goes on believing the agent still has context
 * that has just been summarised away.
 */

const KNOWLEDGE_METADATA_KEY = 'knowledge_context_delivered';
const PINS_METADATA_KEY = 'project_context_pins';

/** Total budget for the assembled block; anything past it is cut, loudly. */
const KNOWLEDGE_MAX_LENGTH = 8000;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const truncate = (value, budget) => (
  value.length <= budget ? value : `${value.slice(0, Math.max(0, budget - 1))}…`
);

/**
 * Identity of everything the session should be carrying, content revisions
 * included: editing a pinned note must re-send it, not merely renaming one.
 */
export const buildKnowledgeSignature = ({ notes, plans, memory }) => {
  const parts = [
    ...notes.map((note) => `n:${note.id}:${note.updatedAt}`),
    ...plans.map((plan) => `p:${plan.id}:${plan.title}`),
    ...memory.global.map((entry) => `mg:${entry.id}:${entry.updatedAt}`),
    ...memory.project.map((entry) => `mp:${entry.id}:${entry.updatedAt}`),
  ];
  return parts.length === 0 ? '' : parts.sort().join('|');
};

const renderMemorySection = (entries) => entries
  .slice()
  .sort((a, b) => a.createdAt - b.createdAt)
  .map((entry) => `- [${entry.type}] ${entry.title}`)
  .join('\n');

/**
 * Titles only for memory, never bodies: an index carrying full text grows
 * without bound until it crowds out the conversation it was meant to inform.
 */
const buildMemoryBlock = ({ global, project }) => {
  const sections = [];
  if (global.length > 0) sections.push(`### About the user\n\n${renderMemorySection(global)}`);
  if (project.length > 0) sections.push(`### About this project\n\n${renderMemorySection(project)}`);
  if (sections.length === 0) return '';

  return [
    'You have stored memory from earlier sessions. Only the titles are listed below.',
    'A title is an abbreviation, not the memory. Read the entry with the'
      + ' openchamber_memory tool before you act on it: titles routinely leave out'
      + ' the conditions, exceptions and reasons that decide how the memory'
      + ' applies, and a title that looks self-explanatory is the most likely to'
      + ' be hiding them. Read every title that could bear on the task at hand;'
      + ' you need not read the ones unrelated to what you are doing.',
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
    'The user pinned the following project context. Treat it as standing background, not as a new instruction.',
    ...sections,
  ].join('\n\n');
};

export const buildKnowledgeText = ({ notes, plans, memory }) => {
  const blocks = [buildPinnedBlock({ notes, plans }), buildMemoryBlock(memory)].filter(Boolean);
  if (blocks.length === 0) return '';

  const assembled = blocks.join('\n\n');
  return assembled.length <= KNOWLEDGE_MAX_LENGTH
    ? assembled
    : `${truncate(assembled, KNOWLEDGE_MAX_LENGTH)}\n\n(project knowledge truncated)`;
};

export const createSessionKnowledgeRuntime = (dependencies) => {
  const {
    projectContextRuntime,
    agentMemoryRuntime,
    resolveProjectId,
    isAgentMemoryEnabled,
    openCodeFetch = null,
  } = dependencies;

  /**
   * Everything the session should be carrying, read fresh. A failure in one
   * source never blanks the rest: a memory store that will not load must not
   * take the user's pinned notes down with it.
   */
  const readPins = (session) => {
    const metadata = isRecord(session?.metadata) ? session.metadata : {};
    const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    const pins = isRecord(openchamber[PINS_METADATA_KEY]) ? openchamber[PINS_METADATA_KEY] : {};
    const strings = (value) => Array.isArray(value)
      ? [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))]
      : [];
    return { notes: strings(pins.notes), plans: strings(pins.plans) };
  };

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

    let memory = { global: [], project: [] };
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
        };
      } catch {
        memory = { global: [], project: [] };
      }
    }

    return { notes, plans, memory };
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

  const readDeliveredSignature = (session) => {
    const metadata = isRecord(session?.metadata) ? session.metadata : {};
    const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    const delivered = openchamber[KNOWLEDGE_METADATA_KEY];
    return typeof delivered === 'string' ? delivered : '';
  };

  /**
   * The text this session still owes, or an empty string when it is already
   * carrying it. `deliveredSignature` comes from the session's metadata.
   */
  const resolvePending = async (directory, deliveredSignature, pins = { notes: [], plans: [] }) => {
    const collected = await collect(directory, pins);
    const signature = buildKnowledgeSignature(collected);
    if (!signature || signature === deliveredSignature) {
      return { text: '', signature };
    }
    return { text: buildKnowledgeText(collected), signature };
  };

  const readSession = async (sessionId, directory) => (
    openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
  );

  /**
   * What this session still owes, read from its own stored signature.
   */
  const resolvePendingForSession = async (sessionId, directory) => {
    const session = await readSession(sessionId, directory).catch(() => null);
    return resolvePending(directory, readDeliveredSignature(session), readPins(session));
  };

  const collectSummaryForSession = async (sessionId, directory) => {
    const session = await readSession(sessionId, directory).catch(() => null);
    return collectSummary(directory, readPins(session));
  };

  const setPin = async (sessionId, directory, kind, id, pinned) => {
    const fresh = await readSession(sessionId, directory);
    const metadata = isRecord(fresh?.metadata) ? fresh.metadata : {};
    const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    const pins = readPins(fresh);
    const key = kind === 'note' ? 'notes' : 'plans';
    const next = new Set(pins[key]);
    if (pinned) next.add(id);
    else next.delete(id);
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...metadata,
          openchamber: {
            ...openchamber,
            [PINS_METADATA_KEY]: { ...pins, [key]: [...next] },
            [KNOWLEDGE_METADATA_KEY]: '',
          },
        },
      },
    });
    return { ...pins, [key]: [...next] };
  };

  /**
   * Recorded only once the message carrying it has actually gone out. Writing
   * it when the text is handed over would leave a failed send believing the
   * agent had context it never received.
   *
   * Merged onto a fresh read, because the session's metadata holds other
   * OpenChamber state — pinned messages among it — and a blind write would
   * drop whatever changed in between.
   */
  const recordDelivered = async (sessionId, directory, signature) => {
    const fresh = await readSession(sessionId, directory);
    const metadata = isRecord(fresh?.metadata) ? fresh.metadata : {};
    const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...metadata,
          openchamber: { ...openchamber, [KNOWLEDGE_METADATA_KEY]: signature },
        },
      },
    });
  };

  return {
    collect,
    collectSummary,
    collectSummaryForSession,
    resolvePending,
    resolvePendingForSession,
    recordDelivered,
    readDeliveredSignature,
    readPins,
    setPin,
    metadataKey: KNOWLEDGE_METADATA_KEY,
    pinsMetadataKey: PINS_METADATA_KEY,
  };
};
