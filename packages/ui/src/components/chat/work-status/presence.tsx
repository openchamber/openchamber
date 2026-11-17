import React from 'react';
import { PresenceContext } from './presenceContext';

export const WorkStatusPresenceProvider: React.FC<{
  onChange: (count: number) => void;
  children: React.ReactNode;
}> = ({ onChange, children }) => {
  const presentRef = React.useRef(new Set<string>());

  const report = React.useCallback((id: string, present: boolean) => {
    const set = presentRef.current;
    const had = set.has(id);
    if (present === had) return;
    if (present) set.add(id);
    else set.delete(id);
    onChange(set.size);
  }, [onChange]);

  return <PresenceContext.Provider value={report}>{children}</PresenceContext.Provider>;
};
