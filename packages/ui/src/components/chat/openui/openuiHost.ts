import React from 'react';
import type { JsonValue } from '@/lib/opencode/model';

export interface OpenUISubmission {
  summary: string;
  data: JsonValue;
}

export interface OpenUIOwner {
  runtimeKey: string;
  directory: string;
  sessionId: string;
  messageId: string;
  partId: string;
}

export type OpenUISubmissionState =
  | { kind: 'ready'; answer: JsonValue | null }
  | { kind: 'pending'; answer: JsonValue | null }
  | { kind: 'accepted'; answer: JsonValue }
  | { kind: 'error'; message: string; answer: JsonValue | null };

export type OpenUIAccess =
  | { kind: 'preview' }
  | { kind: 'interactive' }
  | { kind: 'readonly'; reason: string }
  | { kind: 'revoked' };

export interface OpenUIHost {
  owner: OpenUIOwner;
  renderKey: string;
  initialMediaSources: readonly string[];
  canInteract: () => boolean;
  submit: (submission: OpenUISubmission) => Promise<void>;
  submission: OpenUISubmissionState;
  access: OpenUIAccess;
  answer: JsonValue | null;
}

export interface OpenUIMount {
  host: OpenUIHost;
  occurrence: string;
}

export const OpenUIHostContext = React.createContext<OpenUIMount | null>(null);

export function useOpenUIHost(): OpenUIMount {
  const value = React.useContext(OpenUIHostContext);
  if (!value) throw new Error('OpenUI components require an authorized host');
  return value;
}

/** Every container preserves the path used to identify its nested programs. */
export function OpenUIOccurrence({ occurrence, children }: { occurrence: string; children: React.ReactNode }) {
  const mount = useOpenUIHost();
  const nested = React.useMemo(() => ({ ...mount, occurrence: `${mount.occurrence}/${occurrence}` }), [mount, occurrence]);
  return React.createElement(OpenUIHostContext.Provider, { value: nested }, children);
}
