import { createConfiguredWebAPIs, waitForDesktopRuntimeBootstrap } from './runtimeConfig';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
import '@openchamber/ui/styles/katex-css';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

const start = async (): Promise<void> => {
  await waitForDesktopRuntimeBootstrap();
  window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

  const { renderElectronMiniChatApp } = await import('@openchamber/ui/apps/renderElectronMiniChatApp');
  renderElectronMiniChatApp(window.__OPENCHAMBER_RUNTIME_APIS__);
};

void start();
