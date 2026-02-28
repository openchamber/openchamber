/**
 * Text Summarization Service
 * 
 * Uses the opencode.ai zen API with gpt-5-nano for fast, lightweight summarization.
 * Used by all TTS implementations (Browser, Say, OpenAI).
 */

function buildSummarizationPrompt(maxLength) {
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

/**
 * Sanitize text for TTS output
 * Removes markdown, URLs, file paths, and other non-speakable content
 */
export function sanitizeForTTS(text) {
  if (!text || typeof text !== 'string') return '';
  
  return text
    // Remove markdown formatting
    .replace(/[*_~`#]/g, '')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    // Remove shell-like command patterns
    .replace(/^\s*[$#>]\s*/gm, '')
    // Remove common shell operators
    .replace(/[|&;<>]/g, ' ')
    // Remove backslashes (escape characters)
    .replace(/\\/g, '')
    // Remove brackets that might be interpreted specially
    .replace(/[[\]{}()]/g, '')
    // Remove quotes that might cause issues
    .replace(/["']/g, '')
    // Remove URLs
    .replace(/https?:\/\/[^\s]+/g, ' a link ')
    // Remove file paths
    .replace(/\/[\w\-./]+/g, '')
    // Collapse multiple spaces/newlines
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract text from zen API response
 */
function extractZenOutputText(data) {
  if (!data || typeof data !== 'object') return null;
  const output = data.output;
  if (!Array.isArray(output)) return null;

  const messageItem = output.find(
    (item) => item && typeof item === 'object' && item.type === 'message'
  );
  if (!messageItem) return null;

  const content = messageItem.content;
  if (!Array.isArray(content)) return null;

  const textItem = content.find(
    (item) => item && typeof item === 'object' && item.type === 'output_text'
  );

  const text = typeof textItem?.text === 'string' ? textItem.text.trim() : '';
  return text || null;
}

/**
 * Summarize text using the opencode.ai zen API
 * 
 * @param {Object} options
 * @param {string} options.text - The text to summarize
 * @param {number} options.threshold - Character threshold (don't summarize if under this length)
 * @param {number} options.maxLength - Maximum character length for the summary output (50-2000)
 * @param {string} [options.zenModel] - Override zen model (defaults to gpt-5-nano)
 * @returns {Promise<{summary: string, summarized: boolean, reason?: string}>}
 */
export async function summarizeText({
  text,
  threshold = 200,
  maxLength = 500,
  zenModel,
}) {
  // Don't summarize if text is under threshold
  if (!text || text.length <= threshold) {
    return {
      summary: sanitizeForTTS(text || ''),
      summarized: false,
      reason: text ? 'Text under threshold' : 'No text provided',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

  try {
    const prompt = buildSummarizationPrompt(maxLength);

    const response = await fetch('https://opencode.ai/zen/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: zenModel || 'gpt-5-nano',
        input: [
          { role: 'user', content: `${prompt}\n\nText to summarize:\n${text}` },
        ],
        stream: false,
        reasoning: { effort: 'low' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.error('[Summarize] zen API error:', response.status, errorBody);
      return {
        summary: sanitizeForTTS(text),
        summarized: false,
        reason: `zen API returned ${response.status}`,
      };
    }

    const data = await response.json();
    const summary = extractZenOutputText(data);

    if (summary) {
      const sanitized = sanitizeForTTS(summary);
      return {
        summary: sanitized,
        summarized: true,
        originalLength: text.length,
        summaryLength: sanitized.length,
      };
    }

    return {
      summary: sanitizeForTTS(text),
      summarized: false,
      reason: 'No response from model',
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[Summarize] Request timed out');
      return {
        summary: sanitizeForTTS(text),
        summarized: false,
        reason: 'Request timed out',
      };
    }
    console.error('[Summarize] Error:', error);
    return {
      summary: sanitizeForTTS(text),
      summarized: false,
      reason: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
