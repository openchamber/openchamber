type FileContentPollerOptions = {
  readContent: () => Promise<string>;
  getLoadedContent: () => string;
  getLoadedRevision: () => number;
  isDirty: () => boolean;
  applyContent: (content: string) => void;
  maxBytes: number;
};

export const createFileContentPoller = (options: FileContentPollerOptions) => {
  let active = true;
  let polling = false;

  return {
    /** Resolves true only when the poll observed the file's current content. */
    poll: async (size: number): Promise<boolean> => {
      if (!active || polling || options.isDirty() || size > options.maxBytes) return false;
      polling = true;
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
        // A failed read is not proof the file is unchanged; the next poll retries.
        return false;
      } finally {
        polling = false;
      }
    },
    dispose: () => {
      active = false;
    },
  };
};
