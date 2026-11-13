import type { Message } from '@/lib/opencode/model';

/**
 * The chat's records while a page or a secret card waits for the user's answer.
 * A background message that arrives meanwhile (a dispatched session's result, a
 * pull request wake, a workflow report, a restart resume) stays in OpenCode's
 * inbox until the waiting call returns, and the chat would draw it as a new
 * turn after the question, which takes the question out of the chat. So it is
 * left out until the wait ends; the agent reads it right after the answer.
 *
 * Returns the same array when nothing is held, so the list keeps its identity.
 */
export const holdPendingSynthetic = <T extends { info: Message }>(records: T[]): T[] => {
    const shown = records.filter(({ info }) => !(info.role === 'synthetic' && info.pending));
    return shown.length === records.length ? records : shown;
};
