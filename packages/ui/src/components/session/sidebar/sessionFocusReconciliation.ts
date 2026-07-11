import type { SessionFocusIdentity } from '@/stores/useSessionFocusStore';

type ReconcileSessionFocusArgs = {
  currentSessionId: string | null;
  focus: SessionFocusIdentity | null;
  recentFocuses: readonly SessionFocusIdentity[];
  projectFocuses: readonly SessionFocusIdentity[];
  fallbackProjectId: string | null;
};

const findPreferredFocus = (
  focuses: readonly SessionFocusIdentity[],
  sessionId: string,
  preferredProjectId: string | null,
  fallbackProjectId: string | null,
): SessionFocusIdentity | null => {
  const candidates = focuses.filter((candidate) => candidate.sessionId === sessionId);
  if (candidates.length === 0) return null;

  if (preferredProjectId) {
    const preferred = candidates.find((candidate) => candidate.projectId === preferredProjectId);
    if (preferred) return preferred;
  }

  if (fallbackProjectId) {
    const fallback = candidates.find((candidate) => candidate.projectId === fallbackProjectId);
    if (fallback) return fallback;
  }

  return candidates[0] ?? null;
};

/**
 * Reconcile content authority with the concrete sidebar occurrence that owns
 * keyboard focus. This never changes the current session; it only repairs the
 * list scope/project identity after sidebar metadata or visibility changes.
 */
export const reconcileSessionFocus = ({
  currentSessionId,
  focus,
  recentFocuses,
  projectFocuses,
  fallbackProjectId,
}: ReconcileSessionFocusArgs): SessionFocusIdentity | null => {
  if (!currentSessionId) return null;

  const focusMatchesCurrentSession = focus?.sessionId === currentSessionId;
  const preferredProjectId = focusMatchesCurrentSession ? focus.projectId : null;
  const projectFocus = findPreferredFocus(
    projectFocuses,
    currentSessionId,
    preferredProjectId,
    fallbackProjectId,
  ) ?? {
    scope: 'project',
    sessionId: currentSessionId,
    projectId: fallbackProjectId,
  };

  if (!focusMatchesCurrentSession || focus.scope === 'project') {
    return projectFocus;
  }

  return findPreferredFocus(
    recentFocuses,
    currentSessionId,
    preferredProjectId,
    fallbackProjectId,
  ) ?? projectFocus;
};
