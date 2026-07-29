export const getTerminalFocusOwner = (target: EventTarget | null): string | null => {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  const owner = target.closest<HTMLElement>('[data-terminal-owner]');
  if (!owner?.isConnected) return null;
  return owner.dataset.terminalOwner || null;
};

export const isTerminalEventTarget = (target: EventTarget | null): boolean => getTerminalFocusOwner(target) !== null;
