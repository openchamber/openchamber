let markdownRendererModulePromise: Promise<typeof import('./MarkdownRendererImpl')> | null = null;

export const loadMarkdownRendererModule = () => {
  markdownRendererModulePromise ??= import('./MarkdownRendererImpl').catch((error) => {
    markdownRendererModulePromise = null;
    throw error;
  });
  return markdownRendererModulePromise;
};

export const preloadMarkdownRenderer = () => {
  void loadMarkdownRendererModule().catch(() => undefined);
};
