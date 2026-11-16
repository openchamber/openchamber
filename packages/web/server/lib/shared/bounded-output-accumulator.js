import { StringDecoder } from 'string_decoder';

// Default bound for one stream's held output: once the rolling text or the
// held partial line grows past this many characters only the newest tail
// is kept, which is all a URL or a log line can occupy.
const BOUNDED_OUTPUT_MAX_CHARS = 64 * 1024;

// Accumulates one stream's output across chunk boundaries. Shared by the
// cloudflare and ngrok tunnel modules (extracted for #1705; the two local
// copies had already diverged, losing flush() in one and recentText in
// the other). `push` returns the decoded text of this chunk, the lines
// completed by it (a trailing partial line is held for the next chunk),
// and the bounded rolling `recentText` for substring/regex matching that
// does not care about lines. `flush` ends the decoder and releases the
// held partial line, so a final unterminated line is not lost when the
// stream ends. Oracle: StringDecoder semantics — a multi-byte character
// split across chunks must decode whole, never as replacement chars.
// A tail cut can land between the halves of a surrogate pair, leaving the
// kept text starting with a lone low surrogate that re-encodes as U+FFFD;
// drop that leading half so the kept tail starts on a character boundary.
const dropSplitTailHead = (text) => {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
};
const tailBounded = (text, maxChars) => dropSplitTailHead(text.slice(-maxChars));

export function createBoundedOutputAccumulator({ maxChars = BOUNDED_OUTPUT_MAX_CHARS } = {}) {
  // The bound is the contract: a non-positive or non-finite maxChars would
  // silently defeat it — slice(-0) is slice(0), which keeps the whole
  // string — so reject it at construction instead of un-bounding the
  // accumulator (#1825). Fractional bounds are rejected too: slice would
  // truncate them toward zero, a different bound than the caller asked for.
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError(`createBoundedOutputAccumulator: maxChars must be a positive integer, got ${maxChars}`);
  }
  const decoder = new StringDecoder('utf8');
  let pendingLine = '';
  let recentText = '';
  return {
    push(chunk) {
      const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      recentText = tailBounded(recentText + decoded, maxChars);
      pendingLine += decoded;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      if (pendingLine.length > maxChars) {
        pendingLine = tailBounded(pendingLine, maxChars);
      }
      return { decoded, lines, recentText };
    },
    flush() {
      const tail = decoder.end();
      recentText = tailBounded(recentText + tail, maxChars);
      const line = pendingLine + tail;
      pendingLine = '';
      return line ? [line] : [];
    },
  };
}
