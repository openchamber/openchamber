import React from 'react';

/**
 * Whether any section actually rendered.
 *
 * Every section decides for itself that it has nothing to say and returns
 * null, so the panel cannot know in advance whether it is empty — and an empty
 * panel is a bordered card holding nothing but its settings icon, which reads
 * as a fault. Re-deriving each section's emptiness at the panel level would
 * mean duplicating every data source it reads, so sections report instead.
 */
export const PresenceContext = React.createContext<((id: string, present: boolean) => void) | null>(null);

/** Call from a section with whether it rendered anything this pass. */
export const useReportWorkStatusPresence = (id: string, present: boolean): void => {
  const report = React.useContext(PresenceContext);
  React.useEffect(() => {
    report?.(id, present);
    // Leaving the set on unmount, so a section that stops rendering entirely
    // does not keep the panel alive.
    return () => report?.(id, false);
  }, [id, present, report]);
};
