import * as sessionActions from '@/sync/session-actions';
import { toLinkedIssue, type ComposerReference } from '../../composer/composerReferences';

export const recordLinkedReferences = (
    sessionId: string,
    directory: Parameters<typeof sessionActions.addLinkedIssues>[1],
    references: readonly ComposerReference[],
) => {
    const linkedAt = Date.now();
    const linked = references.flatMap((reference) => toLinkedIssue(reference, linkedAt) ?? []);
    if (linked.length === 0) return;
    void sessionActions.addLinkedIssues(sessionId, directory, linked).catch(() => undefined);
};
