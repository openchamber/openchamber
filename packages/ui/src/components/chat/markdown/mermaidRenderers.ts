import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';

export type MermaidRenderers = typeof import('beautiful-mermaid');

let loaded: MermaidRenderers | null = null;
let loading: Promise<MermaidRenderers> | null = null;

export const loadedMermaidRenderers = (): MermaidRenderers | null => loaded;

export function loadMermaidRenderers(): Promise<MermaidRenderers> {
  if (loading) return loading;
  const load = importWithChunkRecovery(() => import('beautiful-mermaid')).then((renderers) => (loaded = renderers));
  load.catch(() => {
    if (loading === load) loading = null;
  });
  loading = load;
  return load;
}
