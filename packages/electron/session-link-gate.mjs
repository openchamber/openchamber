// Tells whether the main window's current document listens for session links.
// A document that asks for its pending links (desktop_take_pending_session_links)
// has mounted its listener, and until then an event sent to it reaches nobody:
// the splash and an application document that finished loading look ready but
// are not. A remote page never asks, so an application document counts as
// listening once the fallback delay has passed without a request.
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
