import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore, type InputState } from '@/sync/input-store';
import { afterDelay } from '@/lib/timing/afterDelay';
import { generateUuid } from '@/lib/uuid';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { contextWindowOwnerId } from './role';
import { setSharedFieldsListener } from './storage';
import { contextWindowMessageSchema, openContextWindowChannel, type ContextWindowFollowState, type ContextWindowMessage } from './protocol';
import type { RoutedContextAction } from './routing';
import { useContextWindowStore } from './store';

const OWNER_REPLY_MS = 8000;
const ATTACH_TIMEOUT_MS = 30_000;

let sendReturned: (() => void) | null = null;

export const returnPanelToOwner = (): void => {
  sendReturned?.();
  window.close();
};

const applyFollowState = (state: ContextWindowFollowState): void => {
  useContextWindowStore.setState({ followedDirectory: state.effectiveDirectory });
  const session = useSessionUIStore.getState();
  if (state.sessionId) {
    if (session.currentSessionId !== state.sessionId) session.setCurrentSession(state.sessionId, state.sessionDirectory);
  } else {
    session.setCurrentSession(null, state.directory);
    const draft = useSessionUIStore.getState().newSessionDraft;
    useSessionUIStore.setState({ newSessionDraft: state.draft ? { ...draft, ...state.draft } : { ...draft, open: false } });
  }
  useInputStore.getState().setComposerAddress(state.composerAddress);
};

const runRoutedAction = (action: RoutedContextAction, args: readonly unknown[]): void => {
  // SAFETY: the owner posts the arguments of a call to this same action (routing.ts), copied by the channel's structured clone.
  const run = useUIStore.getState()[action] as (...values: readonly unknown[]) => void;
  try {
    run(...args);
  } catch (error) {
    console.warn(`[context-window] ${action} failed`, error);
  }
};

const forwardAttachments = (ownerId: string, channel: BroadcastChannel) => {
  const waiting = new Map<string, (files: AttachedFile[] | null) => void>();
  const addAttachedFile: InputState['addAttachedFile'] = async (file, target, onAttached, options) => {
    const requestId = generateUuid();
    let cancelTimeout = () => {};
    const answer = new Promise<AttachedFile[] | null>((resolve) => {
      waiting.set(requestId, resolve);
      cancelTimeout = afterDelay(ATTACH_TIMEOUT_MS, () => resolve(null));
    });
    try {
      channel.postMessage({ kind: 'attach', ownerId, requestId, file, name: file.name, target: target ?? null, options } satisfies ContextWindowMessage);
    } catch {
      waiting.get(requestId)?.(null);
    }
    const landed = await answer;
    cancelTimeout();
    waiting.delete(requestId);
    if (!landed) return false;
    onAttached?.(landed);
    return true;
  };
  return {
    addAttachedFile,
    settle: (requestId: string, files: AttachedFile[] | null) => waiting.get(requestId)?.(files),
  };
};

export const startContextWindowPanel = (): (() => void) => {
  const ownerId = contextWindowOwnerId();
  const channel = ownerId ? openContextWindowChannel() : null;
  if (!ownerId || !channel) return () => {};
  const post = (message: ContextWindowMessage) => {
    try {
      channel.postMessage(message);
    } catch (error) {
      console.warn('[context-window] could not reach the main window', error);
    }
  };

  const attachments = forwardAttachments(ownerId, channel);
  const localAddAttachedFile = useInputStore.getState().addAttachedFile;
  useInputStore.setState({ addAttachedFile: attachments.addAttachedFile });

  let cancelClose: (() => void) | null = null;
  const ownerBack = () => {
    cancelClose?.();
    cancelClose = null;
  };

  channel.onmessage = (event: MessageEvent) => {
    const parsed = contextWindowMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.ownerId !== ownerId) return;
    const message = parsed.data;
    switch (message.kind) {
      case 'follow':
        ownerBack();
        applyFollowState(message.state);
        return;
      case 'action':
        runRoutedAction(message.action, message.args);
        return;
      case 'owner-hello':
        ownerBack();
        post({ kind: 'panel-hello', ownerId });
        return;
      case 'owner-gone':
        ownerBack();
        cancelClose = afterDelay(OWNER_REPLY_MS, () => window.close());
        return;
      case 'close':
        window.close();
        return;
      case 'return':
        returnPanelToOwner();
        return;
      case 'attached':
        attachments.settle(message.requestId, message.files);
        return;
      default:
        return;
    }
  };

  post({ kind: 'panel-hello', ownerId });
  sendReturned = () => post({ kind: 'panel-returned', ownerId });
  setSharedFieldsListener((fields) => post({ kind: 'prefs', ownerId, fields }));
  const onPageHide = () => post({ kind: 'panel-gone', ownerId });
  window.addEventListener('pagehide', onPageHide);

  return () => {
    sendReturned = null;
    setSharedFieldsListener(null);
    ownerBack();
    window.removeEventListener('pagehide', onPageHide);
    useInputStore.setState({ addAttachedFile: localAddAttachedFile });
    channel.close();
  };
};
