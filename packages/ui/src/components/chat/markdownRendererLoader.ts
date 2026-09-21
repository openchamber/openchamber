type MarkdownRendererModule = typeof import('./MarkdownRendererImpl');

let markdownRendererModulePromise: Promise<MarkdownRendererModule> | null = null;
let markdownRendererModule: MarkdownRendererModule | null = null;

export const loadMarkdownRendererModule = () => {
  markdownRendererModulePromise ??= import('./MarkdownRendererImpl')
    .then((module) => {
      markdownRendererModule = module;
      return module;
    })
    .catch((error) => {
      markdownRendererModulePromise = null;
      throw error;
    });
  return markdownRendererModulePromise;
};

/**
 * The module once it has loaded, so a renderer can mount synchronously instead
 * of suspending. A lazy component that suspends — even on an already-resolved
 * promise — shows its fallback for a tick, and React then throttles the reveal
 * of every boundary that resolves in the following ~300ms, which is how a
 * freshly opened session showed user text first and assistant text a third of
 * a second later.
 */
export const getLoadedMarkdownRendererModule = () => markdownRendererModule;

export const preloadMarkdownRenderer = () => {
  void loadMarkdownRendererModule().catch(() => undefined);
};
