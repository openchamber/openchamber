import { asNonEmptyString, isRecord } from '../shared/object-guards.js';
import type { PublicQueuedItem, QueuedAttachment, QueuedItem } from './runtime.js';

const toPublicAttachment = ({ dataUrl: _dataUrl, ...attachment }: QueuedAttachment) => attachment;

export const toPublicItem = (item: QueuedItem): PublicQueuedItem => {
  const publicItem: PublicQueuedItem = {
    id: item.id,
    createdAt: item.createdAt,
    content: item.content,
    text: item.text,
    attachments: item.attachments.map(toPublicAttachment),
    sendConfig: { ...item.sendConfig },
  };
  if (item.clientRequestId) publicItem.clientRequestId = item.clientRequestId;
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  const contextPreview = item.contextPreview || item.context
    .filter((part) => part.kind !== 'instruction')
    .map((part) => {
      const metadata = part.metadata?.openchamberContext;
      return (isRecord(metadata) && asNonEmptyString(metadata.text)) || part.text.trim();
    })
    .find(Boolean);
  if (contextPreview) {
    const [firstLine = ''] = contextPreview.split('\n', 1);
    publicItem.contextPreview = firstLine.slice(0, 100)
      + (contextPreview.length > firstLine.length || firstLine.length > 100 ? '...' : '');
  }
  if (item.goal) publicItem.goal = { ...item.goal };
  if (item.scheduledTask) publicItem.scheduledTask = { ...item.scheduledTask };
  return publicItem;
};
