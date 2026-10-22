/**
 * Putting the export's events into one readable order.
 *
 * The parent session's history is the spine. A subagent's transcript is a
 * block placed where the call that started it sits in that spine, so the
 * reader meets the work at the point where it was delegated. The block keeps
 * the subagent's own order inside it.
 *
 * The order itself comes from recorded timestamps, with the source order of
 * the records as the tiebreaker. Nothing is invented: an event without a
 * timestamp keeps the place its source gave it, and the export says so once
 * at the end rather than on every line.
 */

import type { ExportEvent, ExportFinding, ExportSessionInfo, ExportTimeline } from './events';
import { readTimestamp } from './values';
import { orderByRecordedTime } from './ordering';
import { exportText } from './i18n';

/**
 * A piece of work that ran at the same time as another.
 *
 * The agent and the title are kept apart, because the title alone does not
 * tell two sub-agents apart: the runtime names a child after the call that
 * started it, so two children of one call share a title.
 */
export type ConcurrentWork = {
  /** The agent that did the work, when the session recorded one. */
  agent?: string;
  /** The session's own title. */
  title: string;
};

/** One entry of the export's spine: a single event, or a subagent's block. */
export type ExportNode =
  | { kind: 'event'; event: ExportEvent }
  | {
      kind: 'subagent';
      childSessionID: string;
      session: ExportSessionInfo;
      /** How deep the subagent sits below the exported root. */
      depth: number;
      /**
       * The subagent's own history, in order.
       *
       * The sequence is mixed: a subagent's own records and the blocks of
       * the subagents it started share one list, so a nested block sits at
       * the call that started it rather than after everything the parent
       * said.
       */
      children: ExportNode[];
      /** When the subagent's work started, when the source recorded it. */
      startedAt?: number;
      /** When the subagent's work ended, when the source recorded it. */
      endedAt?: number;
      /**
       * The call that started it, when one could be identified. It carries
       * the task the call carried and how the call itself ended, so the
       * block can show the delegation and not only the work.
       */
      dispatchedBy?: {
        sessionID: string;
        partID: string;
        timestamp?: number;
        /** The call's place in the parent's recorded order. */
        sourceOrder?: number;
        /** The task the call carried, when it had one. */
        task?: string;
        /** How the call itself ended. */
        status?: string;
        /** The failure text of the call, when it failed. */
        error?: string;
        /** The result the call returned, when it returned one. */
        output?: string;
        /** When the call settled, when the source recorded it. */
        endedAt?: number;
        /**
         * The call itself, verbatim.
         *
         * The call's own arguments, metadata and identifier are the record
         * of what the parent asked for. The detailed view shows them.
         */
        call?: ExportEvent & { kind: 'tool' };
      };
      /** Further calls that named the same session, which resumed it. */
      resumedBy?: Array<{ sessionID: string; partID: string; timestamp?: number }>;
      /** The subagents whose work overlapped this one's. */
      concurrentWith?: ConcurrentWork[];
    };

/** A subagent's block in the export's spine. */
type SubagentBlock = Extract<ExportNode, { kind: 'subagent' }>;

/** The ordered export, ready to project. */
export type ExportTree = {
  rootSessionID: string;
  nodes: ExportNode[];
  sessions: Map<string, ExportSessionInfo>;
  findings: ExportFinding[];
};

type Sortable = {
  timestamp?: number;
  sourceOrder: number;
  sessionID: string;
};

/**
 * The events of one session in the order the export writes them.
 *
 * The order comes from the recorded times, and an event without a time keeps
 * the place the source gave it: it stays between the timed events around it
 * instead of jumping to the end of the session.
 */
const orderedEvents = (events: readonly ExportEvent[]): ExportEvent[] => orderByRecordedTime(
  events.map((event) => ({
    event,
    timestamp: event.timestamp,
    sourceOrder: event.origin.sourceOrder,
    sessionID: event.sessionID,
  })),
).map((entry) => entry.event);


/**
 * The order the export reports events in, stated for the reader: timestamps
 * first, source order where a timestamp is missing.
 *
 * The wording is the reader's language, so it is resolved when the document
 * is written rather than when this module is loaded.
 */
export const orderingGuarantee = (): string => exportText('export.ordering');

/**
 * Builds the export's spine.
 *
 * A subagent's events move out of the flat list and into a block, anchored at
 * the call that started it. A call whose child could not be identified stays
 * an ordinary tool event, so the reader still sees the call.
 */
export const buildExportTree = (timeline: ExportTimeline): ExportTree => {
  const findings = [...timeline.findings];
  const events = [...timeline.events];

  // The child session each call named, and the call itself. A second call
  // that names the same session resumed it: the transcript appears once, and
  // the block names the call that resumed it.
  const dispatchByChildID = new Map<string, { event: ExportEvent; sessionID: string; partID: string }>();
  const resumedByChildID = new Map<string, Array<{ sessionID: string; partID: string; timestamp?: number }>>();
  for (const event of events) {
    if (event.kind !== 'tool') continue;
    const childSessionID = event.call.childSessionID;
    if (!childSessionID) continue;
    if (dispatchByChildID.has(childSessionID)) {
      // The transcript appears once, and the block says that it was
      // resumed. A child the export does not carry has no block and no
      // transcript, so there is nothing to say about it.
      if (timeline.sessions.has(childSessionID)) {
        findings.push({
          kind: 'resumed-session',
          sessionID: event.sessionID,
          childSessionID,
          messageKey: 'export.finding.resumedSessionBlock',
          messageParams: { id: childSessionID },
        });
      }
      const resumed = resumedByChildID.get(childSessionID) ?? [];
      resumed.push({
        sessionID: event.sessionID,
        partID: event.origin.partID,
        timestamp: event.timestamp,
      });
      resumedByChildID.set(childSessionID, resumed);
      continue;
    }
    dispatchByChildID.set(childSessionID, { event, sessionID: event.sessionID, partID: event.origin.partID });
  }

  // The events that belong to each session, and the child sessions of each
  // session, taken from the sessions' own parent links.
  const childSessionIDsByParent = new Map<string, string[]>();
  for (const session of timeline.sessions.values()) {
    if (!session.parentID) continue;
    const siblings = childSessionIDsByParent.get(session.parentID) ?? [];
    siblings.push(session.id);
    childSessionIDsByParent.set(session.parentID, siblings);
  }

  // The events a session owns, minus the ones a call consumed as a block.
  const eventsBySession = new Map<string, ExportEvent[]>();
  for (const event of events) {
    const list = eventsBySession.get(event.sessionID) ?? [];
    list.push(event);
    eventsBySession.set(event.sessionID, list);
  }

  const consumedDispatchEvents = new Set<string>();
  const consumedResultEvents = new Set<string>();

  /**
   * The block for one child session: its own events in order, with its own
   * child sessions nested inside.
   */
  const buildBlock = (childSessionID: string, depth: number, seen: Set<string>): SubagentBlock | null => {
    if (seen.has(childSessionID)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(childSessionID);

    const session = timeline.sessions.get(childSessionID);
    if (!session) return null;

    const own = (eventsBySession.get(childSessionID) ?? []).filter((event) => {
      // A completion report belongs to the parent's flow, not to the child's.
      if (event.kind === 'subagent-result' && event.sessionID !== childSessionID) return false;
      return true;
    });

    const dispatch = dispatchByChildID.get(childSessionID);
    if (dispatch) consumedDispatchEvents.add(dispatch.event.id);

    // A report the parent recorded for this child stays in the parent's flow.
    for (const event of events) {
      if (event.kind === 'subagent-result' && event.childSessionID === childSessionID) {
        consumedResultEvents.add(event.id);
      }
    }

    // When the subagent ran is the span of the call that started it: a
    // foreground call settles when the child settles, so the call's own
    // times are the work's times. A background call settles at once, so its
    // span says nothing and the child's own events do.
    const dispatchCall = dispatch?.event.kind === 'tool' ? dispatch.event.call : undefined;
    const background = dispatchCall?.background === true;
    const times = own
      .map((event) => event.timestamp)
      .filter((value): value is number => readTimestamp(value) !== undefined);

    const startedAt = dispatchCall && !background && dispatchCall.startedAt !== undefined
      ? dispatchCall.startedAt
      : (times.length > 0 ? Math.min(...times) : undefined);
    const endedAt = dispatchCall && !background && dispatchCall.endedAt !== undefined
      ? dispatchCall.endedAt
      : (times.length > 0 ? Math.max(...times) : undefined);

    // The nested blocks sit in the parent's own sequence, at the call that
    // started them. A parent that delegated work and then answered keeps the
    // answer after the work it depends on.
    const childBlocks: SubagentBlock[] = [];
    for (const child of childSessionIDsByParent.get(childSessionID) ?? []) {
      const block = buildBlock(child, depth + 1, nextSeen);
      if (block) childBlocks.push(block);
    }

    const ownNodes: ExportNode[] = orderedEvents(
      own.filter((event) => !consumedDispatchEvents.has(event.id)),
    ).map((event): ExportNode => ({ kind: 'event', event }));

    // A nested block takes the place of the call that started it, so the
    // sequence stays one list: the parent's own records and the work it
    // delegated, in the order they happened. The block's place comes from
    // the call's own record, and the call's record is one of the parent's
    // own records, so the two never disagree.
    const nodes = orderByRecordedTime(
      [...ownNodes, ...childBlocks].map((node) => {
        const position = positionInSequence(node);
        return {
          node,
          timestamp: position.timestamp,
          sourceOrder: position.sourceOrder,
          sessionID: position.sessionID,
        };
      }),
    ).map((entry) => entry.node);

    return {
      kind: 'subagent',
      childSessionID,
      session,
      depth,
      children: nodes,
      startedAt,
      endedAt,
      dispatchedBy: dispatch
        ? {
            sessionID: dispatch.sessionID,
            partID: dispatch.partID,
            timestamp: dispatch.event.timestamp,
            sourceOrder: dispatch.event.origin.sourceOrder,
            task: dispatch.event.kind === 'tool' ? dispatch.event.call.prompt : undefined,
            status: dispatch.event.kind === 'tool' ? dispatch.event.call.status : undefined,
            error: dispatch.event.kind === 'tool' ? dispatch.event.call.error : undefined,
            output: dispatch.event.kind === 'tool' ? dispatch.event.call.output : undefined,
            endedAt: dispatch.event.kind === 'tool' ? dispatch.event.call.endedAt : undefined,
            // The call itself, so the detailed view can show its arguments,
            // its metadata and its identifier.
            call: dispatch.event.kind === 'tool' ? dispatch.event : undefined,
          }
        : undefined,
      resumedBy: resumedByChildID.get(childSessionID),
    };
  };

  /**
   * Where a node sits in its parent's sequence.
   *
   * A block sits where its call sat, so the call's place in the parent's
   * recorded order decides between a block and the messages around it. A
   * block with no call to anchor it falls back to the time its own work
   * started.
   */
  const positionInSequence = (node: ExportNode): Sortable => {
    if (node.kind === 'event') {
      return {
        timestamp: node.event.timestamp,
        sourceOrder: node.event.origin.sourceOrder,
        sessionID: node.event.sessionID,
      };
    }
    const dispatched = node.dispatchedBy;
    return {
      timestamp: dispatched?.timestamp ?? node.startedAt,
      sourceOrder: dispatched?.sourceOrder ?? Number.MAX_SAFE_INTEGER,
      sessionID: node.session.id,
    };
  };

  // The blocks of the root session's direct children.
  const rootBlocks: SubagentBlock[] = [];
  for (const child of childSessionIDsByParent.get(timeline.rootSessionID) ?? []) {
    const block = buildBlock(child, 1, new Set([timeline.rootSessionID]));
    if (block) rootBlocks.push(block);

  }

  // A block with no call to anchor it has no recorded place in the parent's
  // flow. It keeps the position of the parent's own events: it is shown
  // after the parent event that was current when the child ran, and the
  // export says the relationship could not be established.
  const rootEventList = eventsBySession.get(timeline.rootSessionID) ?? [];
  const anchorless = rootBlocks.filter((block) => block.startedAt === undefined);
  const anchored = rootBlocks.filter((block) => block.startedAt !== undefined);

  for (const block of anchorless) {
    const first = block.children
      .filter((child): child is Extract<ExportNode, { kind: 'event' }> => child.kind === 'event')
      .map((child) => child.event.timestamp)
      .filter((value): value is number => readTimestamp(value) !== undefined)
      .sort((left, right) => left - right)[0];
    if (first === undefined) continue;
    const before = rootEventList.filter((event) => (event.timestamp ?? 0) <= first);
    block.startedAt = before.length > 0
      ? Math.max(...before.map((event) => event.timestamp ?? 0))
      : first;
  }


  // The root session's own events, with the calls that started a block
  // removed: the block's header carries that call.
  const rootEvents = orderedEvents(
    (eventsBySession.get(timeline.rootSessionID) ?? [])
      .filter((event) => !consumedDispatchEvents.has(event.id))
      .filter((event) => !consumedResultEvents.has(event.id) || event.kind !== 'subagent-result'),
  ).map((event): ExportNode => ({ kind: 'event', event }));

  // A child's result that the parent recorded belongs to the parent's flow,
  // so it is restored there.
  const rootResults = orderedEvents(
    (eventsBySession.get(timeline.rootSessionID) ?? [])
      .filter((event) => event.kind === 'subagent-result'),
  ).map((event): ExportNode => ({ kind: 'event', event }));

  const rootEventIDs = new Set(rootEvents.map((node) => (node.kind === 'event' ? node.event.id : '')));
  const missingResults = rootResults.filter((node) => node.kind === 'event' && !rootEventIDs.has(node.event.id));

  // The spine is the root's own events and the blocks of the sub-agents it
  // started, in one order. An event without a recorded time keeps the place
  // the source gave it, so the whole spine is ordered by the same rule the
  // events inside it are.
  const spine = orderByRecordedTime(
    [...rootEvents, ...missingResults, ...anchored].map((node) => ({
      node,
      timestamp: positionInSequence(node).timestamp,
      sourceOrder: positionInSequence(node).sourceOrder,
      sessionID: positionInSequence(node).sessionID,
    })),
  ).map((entry) => entry.node);

  return {
    rootSessionID: timeline.rootSessionID,
    nodes: markConcurrency([...spine, ...anchorless]),
    sessions: timeline.sessions,
    findings,
  };
};

/**
 * Marks the blocks whose work overlapped, so concurrent subagents are not
 * read as one after the other.
 */
const markConcurrency = (nodes: ExportNode[]): ExportNode[] => {
  const blocks = nodes.filter((node): node is Extract<ExportNode, { kind: 'subagent' }> => node.kind === 'subagent');
  for (const block of blocks) {
    const overlapping = blocks.filter((other) => {
      if (other === block) return false;
      if (block.startedAt === undefined || other.startedAt === undefined) return false;
      const blockEnd = block.endedAt ?? Number.MAX_SAFE_INTEGER;
      const otherEnd = other.endedAt ?? Number.MAX_SAFE_INTEGER;
      return block.startedAt <= otherEnd && other.startedAt <= blockEnd;
    });
    if (overlapping.length > 0) {
      block.concurrentWith = overlapping.map((other) => ({
        agent: other.session.agent,
        title: other.session.title || other.childSessionID,
      }));
    }
    block.children = markConcurrency(block.children);
  }
  return nodes;
};
