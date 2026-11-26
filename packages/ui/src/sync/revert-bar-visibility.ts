import { create } from 'zustand';

const useHiddenRevertBars = create<{ hidden: ReadonlySet<string> }>(() => ({ hidden: new Set() }));

const barKey = (sessionId: string, messageID: string) => `${sessionId}\n${messageID}`;

export const hideRevertBar = (sessionId: string, messageID: string): void => {
  useHiddenRevertBars.setState((state) => ({ hidden: new Set(state.hidden).add(barKey(sessionId, messageID)) }));
};

export const showRevertBar = (sessionId: string, messageID: string): void => {
  useHiddenRevertBars.setState((state) => {
    const hidden = new Set(state.hidden);
    hidden.delete(barKey(sessionId, messageID));
    return { hidden };
  });
};

export const useRevertBarHidden = (sessionId: string | null | undefined, messageID: string | null | undefined): boolean =>
  useHiddenRevertBars((state) => Boolean(sessionId && messageID && state.hidden.has(barKey(sessionId, messageID))));
