type FileContentPollerOptions = {
  readContent: () => Promise<string>;
  getLoadedContent: () => string;
  getLoadedRevision: () => number;
  isDirty: () => boolean;
  applyContent: (content: string) => void;
};

export const createFileContentPoller = (options: FileContentPollerOptions) => {
  let active = true;

  return {
    poll: async (): Promise<boolean> => {
      if (!active || options.isDirty()) return false;
      const loadedContent = options.getLoadedContent();
      const loadedRevision = options.getLoadedRevision();
      try {
        const content = await options.readContent();
        if (!active || options.isDirty() || loadedRevision !== options.getLoadedRevision()) return false;
        if (content === loadedContent) return true;

        const confirmedContent = await options.readContent();
        if (!active || options.isDirty() || confirmedContent !== content || loadedRevision !== options.getLoadedRevision()) {
          return false;
        }
        options.applyContent(content);
        return true;
      } catch {
        return false;
      }
    },
    dispose: () => {
      active = false;
    },
  };
};
