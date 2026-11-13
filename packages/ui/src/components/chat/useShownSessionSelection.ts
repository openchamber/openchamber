import React from 'react';

type SessionSelection = { sessionId: string | null; directory: string | null };

/**
 * The selection the chat column renders: a deferred copy of `target`, so a
 * session switch paints its cheap reactions first while the previous
 * conversation stays on screen (sync/DOCUMENTATION.md, "Session switch commit").
 *
 * A selection arriving from nothing is taken at once. Leaving a draft or an
 * empty chat has no conversation to keep, and a deferred null beside the draft
 * the store has already closed read as "nothing selected": the column fell
 * back to its empty state for a commit and remounted, composer and work-status
 * card included.
 *
 * The same session in another directory is taken at once too, whatever
 * changed it: the old directory either no longer holds the session or was
 * only a guess, so reading the session there is wrong. A move is the main
 * case: it has already taken the session out of the old directory's store,
 * and a deferred old directory had the chat find it missing there and read
 * it back into the directory it left.
 */
export const useShownSessionSelection = <T extends SessionSelection>(target: T): T => {
    const deferred = React.useDeferredValue(target);
    if (deferred.sessionId === target.sessionId) return target;
    return deferred.sessionId === null && target.sessionId !== null ? target : deferred;
};
