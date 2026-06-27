import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

// The pet overlay never calls OpenCode APIs itself (it gets its sprite over
// desktop IPC and its live state over BroadcastChannel), but it still needs the
// configured web runtime so the shared Theme/i18n providers can load settings.
window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@openchamber/ui/apps/renderElectronPetApp')
  .then(({ renderElectronPetApp }) => {
    renderElectronPetApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
