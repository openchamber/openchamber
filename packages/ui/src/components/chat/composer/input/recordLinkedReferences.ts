import * as sessionActions from '@/sync/session-actions';
import { toLinkedIssue, type ComposerReference } from '../../composer/composerReferences';

export /**
 * Record what a session was pointed at, so the work-status panel can show it
 * as a context source long after the message scrolled away. A snapshot only —
 * never re-fetched, never authoritative. Failures are swallowed: the message
 * went out (or was queued), and a missing bookkeeping entry must not surface
 * as an error.
 */
const recordLinkedReferences = (
    sessionId: string,
    directory: Parameters<typeof sessionActions.addLinkedIssues>[1],
    references: readonly ComposerReference[],
) => {
    const linkedAt = Date.now();
    // Another session or message attached here links nothing to this one.
    const linked = references.flatMap((reference) => toLinkedIssue(reference, linkedAt) ?? []);
    if (linked.length === 0) return;
    void sessionActions.addLinkedIssues(sessionId, directory, linked).catch(() => undefined);
};