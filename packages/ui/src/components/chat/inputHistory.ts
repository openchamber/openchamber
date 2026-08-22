import type { MessageHistoryValue } from './composer/state/useMessageHistory';
import type { InputHistoryScope } from '@/lib/inputHistoryScope';
import {
  createInputHistorySubmission,
  type InputHistoryAttachment,
  type InputHistoryEntry,
  type InputHistoryIdentity,
  type InputHistorySubmission,
} from '@/stores/useInputHistoryStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';

type HistoryQueuedMessage = {
  content: string;
  attachments?: readonly AttachedFile[];
};

type BuildHistorySubmissionsArgs = {
  inputMode: 'normal' | 'shell';
  queuedMessages: readonly HistoryQueuedMessage[];
  composerText: string;
  composerAttachments: readonly AttachedFile[];
  includeComposer: boolean;
};

const FILE_URI_PREFIX = 'file://';

const encodeFilePath = (filepath: string): string => {
  let normalized = filepath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = `/${normalized}`;
  }
  return normalized
    .split('/')
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join('/');
};

const toFileUrl = (filepath: string): string => {
  const normalized = filepath.replace(/\\/g, '/').trim();
  if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
    return normalized;
  }
  return `${FILE_URI_PREFIX}${encodeFilePath(normalized)}`;
};

export function buildChatInputHistorySubmissions({
  inputMode,
  queuedMessages,
  composerText,
  composerAttachments,
  includeComposer,
}: BuildHistorySubmissionsArgs): InputHistorySubmission[] | undefined {
  if (inputMode === 'shell') return undefined;

  const submissions = queuedMessages.map((queued) => (
    createInputHistorySubmission(queued.content, queued.attachments ?? [])
  ));

  if (includeComposer) {
    submissions.push(createInputHistorySubmission(composerText, composerAttachments));
  }

  return submissions.length > 0 ? submissions : undefined;
}

function materializeHistoryAttachment(attachment: InputHistoryAttachment): AttachedFile | null {
  if (attachment.source === 'file-url') {
    if (!attachment.reference || attachment.reference.startsWith('data:')) return null;
    return {
      id: `history-${attachment.key}`,
      file: new File([], attachment.filename, { type: attachment.mimeType }),
      dataUrl: attachment.reference,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      size: attachment.size,
      source: 'local',
      serverPath: attachment.reference,
    };
  }

  if (attachment.source === 'vscode-file') {
    return {
      id: `history-${attachment.key}`,
      file: new File([], attachment.filename, { type: attachment.mimeType }),
      dataUrl: toFileUrl(attachment.reference),
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      size: attachment.size,
      source: 'vscode',
      vscodePath: attachment.reference,
      vscodeSource: 'file',
    };
  }

  return null;
}

export function mapInputHistoryEntriesToValues(
  entries: readonly InputHistoryEntry[],
): Array<MessageHistoryValue<AttachedFile>> {
  return entries.map((entry) => ({
    text: entry.text,
    attachments: entry.restorableAttachments
      .map(materializeHistoryAttachment)
      .filter((attachment): attachment is AttachedFile => attachment !== null),
  }));
}

export function buildInputHistoryNavigatorIdentity(
  scope: InputHistoryScope,
  identity: InputHistoryIdentity | null,
): string {
  if (!identity) return `${scope}\nmissing`;
  return [scope, identity.runtimeKey, identity.directory, identity.sessionId].join('\n');
}
