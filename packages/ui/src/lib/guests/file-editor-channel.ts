import {
  GUEST_REQUEST_TIMEOUT_MS,
  OPENCHAMBER_SDK_API_VERSION,
  OPENCHAMBER_SDK_CHANNEL,
  type FileEditorChange,
  type FileEditorDocument,
  type FileEditorSnapshot,
  type FileSnapshotPurpose,
  type GuestFileChangeMessage,
  type GuestFileSaveMessage,
  type GuestFileSnapshotResultMessage,
  type GuestFileUnsupportedMessage,
  type GuestMessage,
  type HostMessage,
} from '@openchamber/sdk';

export type GuestFileMessage =
  | GuestFileSnapshotResultMessage
  | GuestFileChangeMessage
  | GuestFileSaveMessage
  | GuestFileUnsupportedMessage;

export const isGuestFileMessage = (message: GuestMessage): message is GuestFileMessage => (
  message.type === 'file-snapshot-result'
  || message.type === 'file-change'
  || message.type === 'file-save'
  || message.type === 'file-unsupported'
);

type GuestFileEditorEvents = {
  onChange: (change: FileEditorChange) => void;
  onSave: () => void;
  onUnsupported: () => void;
};

/** Why a snapshot request produced no snapshot. */
export class GuestFileSnapshotError extends Error {
  readonly reason: 'disconnected' | 'timeout' | 'refused';

  constructor(reason: 'disconnected' | 'timeout' | 'refused', message: string) {
    super(message);
    this.name = 'GuestFileSnapshotError';
    this.reason = reason;
  }
}

type SnapshotWaiter = {
  resolve: (snapshot: FileEditorSnapshot) => void;
  reject: (error: GuestFileSnapshotError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * The host end of one file editor frame: hands it the file when the frame
 * connects, asks it for the edited text, tells it which snapshot reached the
 * disk, and routes its notices. `PluginPane` connects it on `hello` / iframe
 * load and disconnects it when the frame goes away; a disconnect fails every
 * outstanding snapshot request instead of leaving a save waiting.
 */
export const createGuestFileChannel = (
  document: FileEditorDocument,
  events: GuestFileEditorEvents,
  timeoutMs: number = GUEST_REQUEST_TIMEOUT_MS,
) => {
  let post: ((message: HostMessage) => void) | null = null;
  const waiters = new Map<string, SnapshotWaiter>();
  let ids = 0;

  const failAll = (error: GuestFileSnapshotError) => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };

  return {
    connect: (next: (message: HostMessage) => void) => {
      post = next;
      next({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'file-open', payload: document });
    },
    disconnect: () => {
      post = null;
      failAll(new GuestFileSnapshotError('disconnected', 'The editor frame went away.'));
    },
    receive: (message: GuestFileMessage) => {
      switch (message.type) {
        case 'file-change':
          events.onChange(message.payload);
          return;
        case 'file-save':
          events.onSave();
          return;
        case 'file-unsupported':
          events.onUnsupported();
          return;
        case 'file-snapshot-result': {
          const waiter = waiters.get(message.id);
          if (!waiter) return;
          clearTimeout(waiter.timer);
          waiters.delete(message.id);
          if ('snapshot' in message.payload) waiter.resolve(message.payload.snapshot);
          else waiter.reject(new GuestFileSnapshotError('refused', message.payload.error));
        }
      }
    },
    requestSnapshot: (purpose: FileSnapshotPurpose): Promise<FileEditorSnapshot> => {
      const send = post;
      if (!send) return Promise.reject(new GuestFileSnapshotError('disconnected', 'The editor is not connected.'));
      ids += 1;
      const id = `file-snapshot-${ids}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new GuestFileSnapshotError('timeout', 'The editor did not answer in time.'));
        }, timeoutMs);
        waiters.set(id, { resolve, reject, timer });
        send({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'file-snapshot', id, payload: { purpose } });
      });
    },
    markSaved: (version: string) => {
      post?.({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'file-saved', payload: { version } });
    },
  };
};

export type GuestFileChannel = ReturnType<typeof createGuestFileChannel>;
