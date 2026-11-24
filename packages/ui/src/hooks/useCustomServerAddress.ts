import * as React from 'react';

import { approveSpeechServer } from '@/lib/voice/speechServerKey';

export function useCustomServerAddress(serverUrl: string) {
  const [committedUrl, commitUrl] = React.useState(serverUrl);
  const [keyRevision, reloadVoices] = React.useReducer((revision: number) => revision + 1, 0);
  const keyServer = serverUrl.trim() === committedUrl.trim() ? committedUrl.trim() : null;

  const approveAddress = React.useCallback(() => {
    if (!keyServer) return;
    void approveSpeechServer(keyServer).then((changed) => { if (changed) reloadVoices(); });
  }, [keyServer]);

  return { committedUrl, commitUrl, keyRevision, keyServer, reloadVoices, approveAddress };
}
