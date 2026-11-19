import React from 'react';

export const useDraftFill = <Draft extends object>() => {
  const filled = React.useRef<{ key: string; draft: Draft } | null>(null);
  return React.useCallback((editorKey: string, draft: Draft | null) => {
    if (!draft) {
      filled.current = null;
      return false;
    }
    if (filled.current?.key === editorKey && filled.current.draft === draft) return false;
    filled.current = { key: editorKey, draft };
    return true;
  }, []);
};
