import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// beautiful-mermaid brings ELK, about 1.6 MB of script that every chat would
// otherwise load and compile with the Markdown renderer. It loads when the
// first diagram is drawn; until then the block shows its source, as it does
// while the fence streams.
export type MermaidRenderers = typeof import('beautiful-mermaid');

let loaded: MermaidRenderers | null = null;
let loading: Promise<MermaidRenderers> | null = null;

/** The diagram renderer when it has already loaded, else null. */
export const loadedMermaidRenderers = (): MermaidRenderers | null => loaded;

/** Loads the diagram renderer; export paths await it before drawing. */
export function loadMermaidRenderers(): Promise<MermaidRenderers> {
  if (loading) return loading;
  const load = importWithChunkRecovery(() => import('beautiful-mermaid')).then((renderers) => (loaded = renderers));
  // A failed load is tried again by the next diagram.
  load.catch(() => {
    if (loading === load) loading = null;
  });
  loading = load;
  return load;
}
