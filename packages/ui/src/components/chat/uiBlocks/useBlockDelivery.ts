import React from 'react';

export function useBlockDelivery(initiallySent: boolean, clearDraft?: (draft: null) => void) {
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState(initiallySent);
  const [failed, setFailed] = React.useState(false);
  const delivering = React.useRef(false);
  const deliver = React.useCallback((send: () => Promise<void>) => {
    if (delivering.current) return Promise.resolve(false);
    delivering.current = true;
    setSending(true);
    setFailed(false);
    return send().then(() => {
      clearDraft?.(null);
      setSent(true);
      return true;
    }, () => {
      delivering.current = false;
      setFailed(true);
      return false;
    }).finally(() => setSending(false));
  }, [clearDraft]);
  return { sending, sent, setSent, failed, delivering, deliver };
}
