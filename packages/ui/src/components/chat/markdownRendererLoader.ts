type MarkdownRendererModule = Pick<typeof import('./MarkdownRendererImpl'), 'MarkdownContent' | 'MarkdownRenderer' | 'SimpleMarkdownRenderer'>;

let markdownRendererModulePromise: Promise<MarkdownRendererModule> | null = null;
let markdownRendererModule: MarkdownRendererModule | null = null;

export const loadMarkdownRendererModule = () => {
  markdownRendererModulePromise ??= import('./MarkdownRendererImpl')
    .then(({ MarkdownContent, MarkdownRenderer, SimpleMarkdownRenderer }) => {
      const module = { MarkdownContent, MarkdownRenderer, SimpleMarkdownRenderer };
      markdownRendererModule = module;
      return module;
    })
    .catch((error) => {
      markdownRendererModulePromise = null;
      throw error;
    });
  return markdownRendererModulePromise;
};

export const getLoadedMarkdownRendererModule = () => markdownRendererModule;

export const preloadMarkdownRenderer = () => {
  void loadMarkdownRendererModule().catch(() => undefined);
};
