type FileContentPollerOptions = {
  readContent: () => Promise<string>;
  getLoadedContent: () => string;
  getLoadedRevision: () => number;
  isDirty: () => boolean;
  applyContent: (content: string) => void;
};

// The caller serializes polls and decides which files qualify (text, within
// the byte limit); this owns only the read-compare-confirm-apply step.
export const createFileContentPoller = (options: FileContentPollerOptions) => {
  let active = true;

  return {
    /** Resolves true only when the poll observed the file's current content. */
    poll: async (): Promise<boolean> => {
      if (!active || options.isDirty()) return false;
      const loadedContent = options.getLoadedContent();
      const loadedRevision = options.getLoadedRevision();
      try {
        const content = await options.readContent();
        if (!active || options.isDirty() || loadedRevision !== options.getLoadedRevision()) return false;
        if (content === loadedContent) return true;

        // A second read guards against applying a half-written file.
        const confirmedContent = await options.readContent();
        if (!active || options.isDirty() || confirmedContent !== content || loadedRevision !== options.getLoadedRevision()) {
          return false;
        }
        options.applyContent(content);
        return true;
      } catch {
        // A failed read is not proof the file is unchanged; the next poll retries.
        return false;
      }
    },
    dispose: () => {
      active = false;
    },
  };
};
