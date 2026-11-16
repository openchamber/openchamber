export const createSessionLinkGate = ({ fallbackMs, onFallback }) => {
  let listening = false;
  let fallbackTimer = null;

  const cancelFallback = () => {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };

  return {
    isListening: () => listening,
    documentAsked() {
      cancelFallback();
      listening = true;
    },
    documentReplaced() {
      cancelFallback();
      listening = false;
    },
    applicationDocumentLoaded() {
      if (listening || fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        listening = true;
        onFallback();
      }, fallbackMs);
      fallbackTimer.unref?.();
    },
  };
};
