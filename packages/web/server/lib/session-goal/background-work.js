// Background work under a goal's top-level session: running subagent sessions
// and running background shells. While any of it runs, an idle parent is
// paused, not finished, so the goal loop waits instead of judging the turn.
// Work without its own timeout gets a default one: once it runs past it, the
// loop asks the top-level session to confirm what is still happening, then
// waits another full window. A stalled job therefore cannot hold a goal
// silently forever.

/** How long untimed background work runs before the loop asks about it. */
export const DEFAULT_BACKGROUND_CHECK_MS = 30 * 60_000;

const BACKGROUND_TITLE_LIMIT = 120;

const finitePositive = (value) => (Number.isFinite(value) && value > 0 ? value : null);

const clip = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, BACKGROUND_TITLE_LIMIT);

/**
 * The work still running under `sessionId`. Subagents are its direct child
 * sessions that `/api/session/active` lists; shells are running entries of
 * `/api/shell` started by the session or one of those children (OpenCode's
 * shell tool stamps `metadata.sessionID`, and a background command started
 * with an explicit timeout also carries `metadata.timeout`).
 */
export const listBackgroundWork = ({ sessionId, statuses, children, shells }) => {
  const items = [];
  const owners = new Set([sessionId]);
  for (const child of children) {
    owners.add(child.id);
    if (!Object.hasOwn(statuses, child.id) || !statuses[child.id]) continue;
    items.push({
      kind: 'subagent',
      id: child.id,
      title: clip(child.title) || child.id,
      startedAt: finitePositive(child.time?.created) ?? null,
      timeoutMs: null,
    });
  }
  for (const shell of shells) {
    if (shell?.status !== 'running') continue;
    if (!owners.has(shell.metadata?.sessionID)) continue;
    items.push({
      kind: 'shell',
      id: String(shell.id),
      title: clip(shell.command) || String(shell.id),
      startedAt: finitePositive(shell.time?.started) ?? null,
      timeoutMs: finitePositive(shell.metadata?.timeout),
    });
  }
  return items;
};

/**
 * The items due for a status check: no timeout of their own, and running for
 * at least `checkMs` since they started or since the last check, whichever
 * is later. An item whose start is unknown counts from the last check, or from
 * `firstSeenAt` (when the loop first saw it) before any check.
 */
export const overdueBackgroundWork = (items, { now, checkMs, lastCheckAt = 0, firstSeenAt = now }) => items.filter((item) => {
  if (item.timeoutMs !== null) return false;
  const since = Math.max(item.startedAt ?? firstSeenAt, lastCheckAt);
  return now - since >= checkMs;
});

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

const describeItem = (item, now) => {
  const running = item.startedAt ? `, running ${minutes(now - item.startedAt)} min` : '';
  return item.kind === 'subagent'
    ? `- subagent session ${item.id} "${item.title}"${running}`
    : `- background shell ${item.id} \`${item.title}\`${running}`;
};

/** The lead of the status-check prompt the top-level session receives. */
export const buildBackgroundCheckLead = ({ items, overdue, checkMs, now }) => [
  `Background status check: this session stopped while ${items.length} background task${items.length === 1 ? ' is' : 's are'} still running, and ${overdue.length === 1 ? 'one has' : `${overdue.length} have`} run for over ${minutes(checkMs)} minutes with no timeout of ${overdue.length === 1 ? 'its' : 'their'} own:`,
  ...overdue.map((item) => describeItem(item, now)),
  '',
  'Confirm the status of each one now: read its output or its session. If it is still making progress, say so and end the turn; the goal waits for it and asks again later. If it is stalled, stuck on a question nobody will answer, or failed, stop it and finish that work another way.',
];
