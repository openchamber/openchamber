type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export type LoadingOverlayMessages = {
  connectionError: string;
  disconnected: string;
};

export const createLoadingOverlayController = (messages: LoadingOverlayMessages) => {
  let uiMounted = false;

  const fadeOutLoadingScreen = () => {
    const loadingEl = document.getElementById('initial-loading');
    if (!loadingEl) return;
    loadingEl.classList.add('fade-out');
    setTimeout(() => {
      try {
        loadingEl.remove();
      } catch {
        // ignore
      }
    }, 300);
  };

  const setLoadingStatusText = (text: string, variant: 'normal' | 'error' = 'normal') => {
    const statusEl = document.getElementById('loading-status');
    if (!statusEl) return;
    statusEl.textContent = text;
    if (variant === 'error') {
      statusEl.classList.add('error-text');
    } else {
      statusEl.classList.remove('error-text');
    }
  };

  const waitForUiMount = (timeoutMs = 8000): Promise<boolean> => {
    if (typeof document === 'undefined') return Promise.resolve(false);
    const root = document.getElementById('root');
    if (!root) return Promise.resolve(false);

    const hasContent = () => root.childNodes.length > 0;
    if (hasContent()) return Promise.resolve(true);

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (hasContent()) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve(true);
        }
      });

      observer.observe(root, { childList: true, subtree: true });

      const timeout = setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, timeoutMs);
    });
  };

  const maybeHideLoadingOverlay = () => {
    const connectionStatus = (window.__OPENCHAMBER_CONNECTION__?.status ?? 'connecting') as ConnectionStatus;

    if (!uiMounted) {
      return;
    }

    if (connectionStatus === 'connected') {
      // The UI hydrates pickers and the sidebar from cache and refreshes
      // providers/agents in the background, so once it's mounted and OpenCode is
      // connected there's real interactive content underneath the splash. Don't
      // keep the overlay up waiting on the live provider/agent fetches — on a cold
      // start those are the slowest tail, and gating on them makes the splash
      // linger long after the app is usable. Per-widget loaders convey any
      // remaining background work.
      fadeOutLoadingScreen();
      return;
    }

    if (connectionStatus === 'error') {
      const error = window.__OPENCHAMBER_CONNECTION__?.error;
      setLoadingStatusText(error || messages.connectionError, 'error');
      fadeOutLoadingScreen();
      return;
    }

    if (connectionStatus === 'disconnected') {
      setLoadingStatusText(messages.disconnected, 'error');
      fadeOutLoadingScreen();
      return;
    }

    // Connecting — no jargon; the animated logo conveys progress.
    setLoadingStatusText('');
  };

  return {
    markUiMounted: () => {
      uiMounted = true;
      maybeHideLoadingOverlay();
    },
    forceHideLoadingScreen: fadeOutLoadingScreen,
    maybeHideLoadingOverlay,
    waitForUiMount,
    setLoadingStatusText,
  };
};
