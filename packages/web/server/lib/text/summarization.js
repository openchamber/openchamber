/**
 * Shared text summarization service.
 *
 * Modes:
 * - tts: concise speakable text
 * - notification: concise notification text
 * - note: distilled project note
 */

function buildSummarizationPrompt(maxLength, mode = 'tts') {
  if (mode === 'note') {
    return `You are distilling selected assistant text into a single short project note.

Goal:
- Produce one concise note the user may want to keep in project notes.

Rules:
1. Output ONLY the final note text.
2. Keep the result under ${maxLength} characters.
3. Prefer one sentence or a short sentence fragment.
4. Keep the most useful insight, decision, constraint, or recommendation.
5. Be concrete and specific.
6. Do not use markdown, bullets, code fences, headings, or quotes.
7. Do not mention the assistant, the text, or that this is a summary.
8. Do not include filler like In summary or Heres a note.
9. If the text contains multiple ideas, keep only the most important one.
10. Rewrite and compress the input into a distilled note. Do not copy the source text verbatim unless it is already an extremely short note.
11. Prefer a shorter phrasing than the input whenever possible.
12. Write the result as a plain sentence or sentence fragment, not as a bullet point.`;
  }

  if (mode === 'notification') {
    return `Summarize the following text in approximately ${maxLength} characters. Be concise and capture the key point.

Rules:
1. Output plain text only.
2. Do not use markdown, bullets, headings, code fences, backticks, or quotes.
3. Output only the summary text.
4. Prefer a short notification-friendly sentence.`;
  }

  return `You are a text summarizer for text-to-speech output. Create a concise, natural-sounding summary that captures the key points. Keep the summary under ${maxLength} characters.

CRITICAL INSTRUCTIONS:
1. Output ONLY the final summary - no thinking, no reasoning, no explanations
2. Do not show your work or thought process
3. Do not use any special characters, markdown, code, URLs, file paths, or formatting
4. Do not include phrases like "Here's a summary" or "In summary"
5. Just provide clean, speakable text that can be read aloud
6. Stay within the ${maxLength} character limit

Your response should be ready to speak immediately.`;
}

const SUMMARIZE_TIMEOUT_MS = 30_000;

export function sanitizeForTTS(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    .replace(/[*_~`#]/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
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

function extractZenOutputText(data) {
  if (!data || typeof data !== 'object') return null;
  const output = data.output;
  if (!Array.isArray(output)) return null;

  const messageItem = output.find((item) => item && typeof item === 'object' && item.type === 'message');
  if (!messageItem) return null;

  const content = messageItem.content;
  if (!Array.isArray(content)) return null;

  const textItem = content.find((item) => item && typeof item === 'object' && item.type === 'output_text');
  const text = typeof textItem?.text === 'string' ? textItem.text.trim() : '';
  return text || null;
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

function fallbackByMode(text, maxLength, mode) {
  if (mode === 'note') return distillNoteFallback(text, maxLength);
  return sanitizeByMode(text, mode);
}

export async function summarizeText({ text, threshold = 200, maxLength = 500, zenModel, mode = 'tts' }) {
  if (!text || text.length <= threshold) {
    return {
      summary: fallbackByMode(text || '', maxLength, mode),
      summarized: false,
      reason: text ? 'Text under threshold' : 'No text provided',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

  try {
    const prompt = buildSummarizationPrompt(maxLength, mode);
    const response = await fetch('https://opencode.ai/zen/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: zenModel || 'gpt-5-nano',
        input: [{ role: 'user', content: `${prompt}\n\nText to summarize:\n${text}` }],
        stream: false,
        reasoning: { effort: 'low' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.error('[Summarize] zen API error:', response.status, errorBody);
      return {
        summary: fallbackByMode(text, maxLength, mode),
        summarized: false,
        reason: `zen API returned ${response.status}`,
      };
    }

    const data = await response.json();
    const summary = extractZenOutputText(data);

    if (summary) {
      const sanitized = sanitizeByMode(summary, mode);
      const finalSummary = mode === 'note'
        ? (sanitized && sanitized !== sanitizeForNote(text) ? sanitized : distillNoteFallback(text, maxLength))
        : sanitized;
      return {
        summary: finalSummary,
        summarized: true,
        originalLength: text.length,
        summaryLength: finalSummary.length,
      };
    }

    return {
      summary: fallbackByMode(text, maxLength, mode),
      summarized: false,
      reason: 'No response from model',
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[Summarize] Request timed out');
      return {
        summary: fallbackByMode(text, maxLength, mode),
        summarized: false,
        reason: 'Request timed out',
      };
    }
    console.error('[Summarize] Error:', error);
    return {
      summary: fallbackByMode(text, maxLength, mode),
      summarized: false,
      reason: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
