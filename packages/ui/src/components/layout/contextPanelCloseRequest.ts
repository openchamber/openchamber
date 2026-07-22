type ContextPanelCloseHandler = (directory: string) => boolean;

const handlers = new Set<ContextPanelCloseHandler>();

export const registerContextPanelCloseHandler = (next: ContextPanelCloseHandler): (() => void) => {
  handlers.add(next);
  return () => { handlers.delete(next); };
};

export const requestContextPanelClose = (directory: string): boolean => {
  for (const handler of handlers) {
    if (handler(directory)) return true;
  }
  return false;
};
