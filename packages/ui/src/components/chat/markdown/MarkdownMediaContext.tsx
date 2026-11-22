import React from 'react';
import type { ToolPopupContent } from '../message/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { MarkdownMediaOwner, MediaContext, type MarkdownDocumentAssets } from './markdown-media-context';

export type { MarkdownDocumentAssets } from './markdown-media-context';

export function MarkdownMediaProvider({
  content,
  mode,
  sessionId,
  messageId,
  directory,
  settled,
  documentAssets,
  onShowPopup,
  children,
}: {
  content: string;
  mode: 'assistant' | 'local' | 'document';
  sessionId?: string;
  messageId?: string;
  directory: string;
  settled: boolean;
  documentAssets?: MarkdownDocumentAssets;
  onShowPopup?: (content: ToolPopupContent) => void;
  children: React.ReactNode;
}) {
  const [transportRevision, advanceTransport] = React.useReducer((revision: number) => revision + 1, 0);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => advanceTransport()), []);
  const runtimeKey = getRuntimeKey();
  const resolver = getRuntimeUrlResolver();
  const filePath = documentAssets?.filePath;
  const workspaceRoot = documentAssets?.workspaceRoot;
  const ownerContent = mode === 'assistant' && settled ? content : '';
  const owner = React.useMemo(() => {
    void ownerContent;
    void runtimeKey;
    void transportRevision;
    void resolver;
    return new MarkdownMediaOwner({
      mode,
      directory,
      sessionId,
      messageId,
      documentAssets: filePath ? { filePath, workspaceRoot: workspaceRoot ?? null } : undefined,
    });
  }, [ownerContent, mode, directory, sessionId, messageId, runtimeKey, transportRevision, resolver, filePath, workspaceRoot]);
  React.useLayoutEffect(() => {
    if (runtimeKey !== getRuntimeKey() || resolver !== getRuntimeUrlResolver()) {
      owner.dispose();
      advanceTransport();
      return;
    }
    owner.connect();
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => owner.dispose());
    return () => {
      unsubscribe();
      owner.disconnect();
    };
  }, [owner, resolver, runtimeKey]);
  const value = React.useMemo(
    () => ({ owner, mode, settled, documentAssets, onShowPopup }),
    [owner, mode, settled, documentAssets, onShowPopup],
  );
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}
