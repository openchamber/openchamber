/**
 * Shared text summarization service.
 *
 * Modes:
 * - tts: concise speakable text
 * - notification: concise notification text
 * - note: distilled project note
 */

export function sanitizeForTTS(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[*_~`#]/g, '')
    .replace(/^\s*[$#>]\s*/gm, '')
    .replace(/[|&;<>]/g, ' ')
    .replace(/\\/g, '')
    .replace(/[\[\]{}()]/g, '')
    .replace(/["']/g, '')
    .replace(/https?:\/\/[^\s]+/g, ' a link ')
    .replace(/\/[\w\-./]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeForNotification(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[\t ]*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeForNote(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeByMode(text, mode) {
  if (mode === 'note') return sanitizeForNote(text);
  if (mode === 'notification') return sanitizeForNotification(text);
  return sanitizeForTTS(text);
}

function distillNoteFallback(text, maxLength) {
  const sanitized = sanitizeForNote(text);
  if (!sanitized) return '';

  const normalized = sanitized
    .replace(/^In summary[:,]?\s*/i, '')
    .replace(/^Here(?:s| is) (?:a )?note[:,]?\s*/i, '')
    .trim();

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const best = (sentences[0] || normalized)
    .split(/[;:()-]\s+/)[0]
    .split(/,\s+/)[0]
    .trim();
  const idealLimit = Math.min(maxLength, Math.max(32, Math.floor(normalized.length * 0.65)));

  if (best.length <= idealLimit) return best;

  const clipped = best.slice(0, Math.max(0, idealLimit - 1)).trim();
  return clipped ? `${clipped}…` : best.slice(0, idealLimit).trim();
}

function distillNotificationFallback(text, maxLength) {
  const sanitized = sanitizeForNotification(text);
  if (!sanitized) return '';

  const sentences = sanitized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = sentences.find((sentence) => sentence.length >= 20) || sentences[0] || sanitized;
  const limit = Number.isFinite(maxLength) ? Math.max(20, Math.floor(maxLength)) : 100;
  if (candidate.length <= limit) return candidate;

  const clipped = candidate.slice(0, Math.max(0, limit - 1)).trim();
  return clipped ? `${clipped}…` : candidate.slice(0, limit).trim();
}

function fallbackByMode(text, maxLength, mode) {
  if (mode === 'note') return distillNoteFallback(text, maxLength);
  if (mode === 'notification') return distillNotificationFallback(text, maxLength);
  return sanitizeByMode(text, mode);
}

export async function summarizeText({ text, threshold = 200, maxLength = 500, zenModel, mode = 'tts' }) {
  void zenModel;

  const summary = fallbackByMode(text || '', maxLength, mode);
  if (!text || text.length <= threshold) {
    return {
      summary,
      summarized: false,
      reason: text ? 'Text under threshold' : 'No text provided',
    };
  }

  return {
    summary,
    summarized: false,
    reason: 'Model summarization provider unavailable',
    originalLength: text.length,
    summaryLength: summary.length,
  };
}
