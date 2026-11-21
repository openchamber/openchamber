import { z } from 'zod';
import { isRecord, isString } from '../shared/object-guards.js';

const ATTACHMENT_SOURCES = new Set(['local', 'server', 'vscode']);

export interface QueuedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  source: 'local' | 'server' | 'vscode';
  serverPath?: string;
  agentPath?: string;
  dataUrl: string;
  original?: { mimeType: string; dataUrl: string; saveOnSend?: true };
}

export type PublicQueuedAttachment = Omit<QueuedAttachment, 'dataUrl' | 'original'>;

const text = z.unknown().transform((value) => (isString(value) ? value : '')).parse;
const nonEmpty = z.unknown().transform((value) => (isString(value) ? value.trim() : '')).parse;
const isAttachmentSource = (value: unknown): value is QueuedAttachment['source'] => isString(value) && ATTACHMENT_SOURCES.has(value);

const parseOriginal = z.unknown().transform((value): QueuedAttachment['original'] => {
  if (!isRecord(value)) return undefined;
  const mimeType = nonEmpty(value.mimeType);
  const dataUrl = text(value.dataUrl);
  if (!mimeType || !dataUrl) return undefined;
  return value.saveOnSend === true ? { mimeType, dataUrl, saveOnSend: true } : { mimeType, dataUrl };
}).parse;

export const parseAttachment = z.unknown().transform((value): QueuedAttachment | null => {
  if (!isRecord(value)) return null;
  const filename = nonEmpty(value.filename);
  const mimeType = nonEmpty(value.mimeType);
  const dataUrl = text(value.dataUrl);
  if (!filename || !mimeType || !dataUrl) return null;
  const size = Number.isFinite(value.size) && Number(value.size) >= 0 ? Math.floor(Number(value.size)) : 0;
  const attachment: QueuedAttachment = {
    id: nonEmpty(value.id) || `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    filename,
    mimeType,
    size,
    source: isAttachmentSource(value.source) ? value.source : 'local',
    dataUrl,
  };
  const serverPath = nonEmpty(value.serverPath);
  if (serverPath) attachment.serverPath = serverPath;
  const agentPath = nonEmpty(value.agentPath);
  if (agentPath) attachment.agentPath = agentPath;
  const original = parseOriginal(value.original);
  if (original) attachment.original = original;
  return attachment;
}).parse;

export const toPublicAttachment = ({ dataUrl: _dataUrl, original: _original, ...attachment }: QueuedAttachment): PublicQueuedAttachment => attachment;
