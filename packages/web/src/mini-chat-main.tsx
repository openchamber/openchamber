import { createWebAPIs } from './api';
import type { RuntimeAPIs } from '@alias-ade/ui/lib/api/types';
import '@alias-ade/ui/index.css';
import '@alias-ade/ui/styles/fonts';

declare global {
  interface Window {
    __ALIAS_ADE_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__ALIAS_ADE_RUNTIME_APIS__ = createWebAPIs();

void import('@alias-ade/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__ALIAS_ADE_RUNTIME_APIS__ ?? createWebAPIs());
  });
