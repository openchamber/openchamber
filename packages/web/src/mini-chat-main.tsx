import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
import '@openchamber/ui/styles/katex-css';
import { importWithChunkRecovery } from '@openchamber/ui/lib/chunkLoadRecovery';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

// Tried again, then reloaded once, when a module fails to load.
void importWithChunkRecovery(() => import('@openchamber/ui/apps/renderElectronMiniChatApp'))
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
