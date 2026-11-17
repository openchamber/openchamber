import React from 'react';

export const PresenceContext = React.createContext<((id: string, present: boolean) => void) | null>(null);

export const useReportWorkStatusPresence = (id: string, present: boolean): void => {
  const report = React.useContext(PresenceContext);
  React.useEffect(() => {
    report?.(id, present);
    return () => report?.(id, false);
  }, [id, present, report]);
};
