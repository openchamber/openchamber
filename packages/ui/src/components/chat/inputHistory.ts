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
import type { TranscriptPrompt } from '@/sync/user-message-history';
import { toServerFileUrl } from './composer/attachments/filePaths';

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
      dataUrl: toServerFileUrl(attachment.reference),
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

/**
 * Session-scoped recall: the visible transcript's prompts (so sessions older
 * than the persisted store still recall) merged with the persisted bucket
 * (attachments, and prompts a revert hid from the transcript), oldest first.
 * A prompt present in both collapses to the persisted entry.
 */
export function mergeSessionInputHistory(
  transcript: readonly TranscriptPrompt[],
  entries: readonly InputHistoryEntry[],
): Array<MessageHistoryValue<AttachedFile>> {
  const persistedTexts = new Set(entries.map((entry) => entry.text));
  const timed: Array<{ at: number; value: MessageHistoryValue<AttachedFile> }> = [
    ...transcript
      .filter((prompt) => !persistedTexts.has(prompt.text))
      .map((prompt) => ({ at: prompt.createdAt, value: { text: prompt.text, attachments: [] } })),
    ...mapInputHistoryEntriesToValues(entries)
      // submittedAt is milliseconds × 1000 plus a sequence number.
      .map((value, index) => ({ at: Math.floor(entries[index]!.submittedAt / 1000), value })),
  ];
  return timed.sort((left, right) => left.at - right.at).map((item) => item.value);
}

export function buildInputHistoryNavigatorIdentity(
  scope: InputHistoryScope,
  identity: InputHistoryIdentity | null,
): string {
  if (!identity) return `${scope}\nmissing`;
  return [scope, identity.runtimeKey, identity.directory, identity.sessionId].join('\n');
}
