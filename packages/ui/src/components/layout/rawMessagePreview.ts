import type { Part } from '@/lib/opencode/model';
import type { TimeFormatPreference } from '@/stores/useUIStore';


const PREVIEW_ID_LENGTH = 8;

const partRecord = (part: Part): Record<string, unknown> => part as unknown as Record<string, unknown>;

const partTypeOf = (part: Part): string => {
  const value = partRecord(part).type;
  return typeof value === 'string' ? value : '';
};

const partToolOf = (part: Part): string => {
  const value = partRecord(part).tool;
  return typeof value === 'string' ? value : '';
};

const partTextOf = (part: Part): string => {
  const value = partRecord(part).text;
  return typeof value === 'string' ? value : '';
};

const labelForPart = (part: Part): string => {
  const type = partTypeOf(part);
  if (type === 'tool') {
    const tool = partToolOf(part).trim().toLowerCase();
    return tool || 'tool';
  }
  return type || 'unknown';
};

export const derivePartsLabel = (parts: Part[]): string => {
  if (parts.length === 0) return '';
  const seen: string[] = [];
  for (const part of parts) {
    const label = labelForPart(part);
    if (!seen.includes(label)) {
      seen.push(label);
    }
  }
  return seen.join(' + ');
};

export const truncateMessageId = (id: string, length: number = PREVIEW_ID_LENGTH): string => {
  if (typeof id !== 'string') return '';
  return id.length <= length ? id : id.slice(-length);
};

const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/g, ' ').trim();

export const deriveUserSnippet = (parts: Part[]): string => {
  for (const part of parts) {
    if (partTypeOf(part) === 'text') {
      const cleaned = collapseWhitespace(partTextOf(part));
      if (cleaned.length === 0) continue;
      return cleaned;
    }
  }
  const nonTextCount = parts.filter((part) => partTypeOf(part) !== 'text').length;
  if (nonTextCount === 0) return '';
  return `${nonTextCount} attachment${nonTextCount === 1 ? '' : 's'}`;
};

export const formatAssistantTokens = (
  input: number,
  output: number,
  formatNumber: (value: number) => string,
): string => `${formatNumber(input)} / ${formatNumber(output)}`;

const resolveHour12 = (preference: TimeFormatPreference): boolean | undefined => {
  if (preference === '12h') return true;
  if (preference === '24h') return false;
  return undefined;
};

export const formatMessagePreviewTime = (
  timestamp: number | null,
  preference: TimeFormatPreference,
): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  const hour12 = resolveHour12(preference);
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: hour12 === false ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(hour12 === undefined ? {} : { hour12 }),
  });
};
