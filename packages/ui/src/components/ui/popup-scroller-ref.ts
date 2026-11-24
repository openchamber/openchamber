import * as React from "react";

function attachRef<T>(ref: React.Ref<T> | undefined, node: T | null): () => void {
  if (!ref) return () => {};
  if ("current" in ref) {
    ref.current = node;
    return () => { ref.current = null; };
  }
  const cleanup = ref(node);
  return cleanup ?? (() => { ref(null); });
}

export function usePopupScrollerRef<T extends HTMLElement>(ref: React.Ref<T> | undefined) {
  const [popup, setPopup] = React.useState<T | null>(null);
  const setPopupRef = React.useCallback((node: T | null) => {
    setPopup(node);
    const detach = attachRef(ref, node);
    return () => {
      setPopup(null);
      detach();
    };
  }, [ref]);
  return [popup, setPopupRef] as const;
}
