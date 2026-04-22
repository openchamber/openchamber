/**
 * Pure helper for excerpting CI logs.
 * No external dependencies.
 */

const MAX_LINES_TAIL = 200;
const MAX_LINES_HEAD = 50;
const MAX_BYTES = 200 * 1024; // 200 KB

/**
 * Parses the raw log to extract the most relevant parts.
 *
 * Defaults:
 * - GitHub Actions: match `##[error]` and `##[group]Run …/##[endgroup]` markers.
 * - Others: last 200 lines of the job log + first 50 lines.
 *
 * @param {string} rawLog
 * @returns {string}
 */
export function extractLogExcerpt(rawLog) {
  if (!rawLog) return '';

  const lines = rawLog.split(/\r?\n/);
  if (lines.length <= MAX_LINES_HEAD + MAX_LINES_TAIL) {
    return enforceSizeLimit(rawLog);
  }

  const excerptLines = [];
  const errors = [];
  let inErrorGroup = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('##[error]')) {
      errors.push(line);
      inErrorGroup = true;
    } else if (line.includes('##[endgroup]')) {
      if (inErrorGroup) {
        errors.push(line);
      }
      inErrorGroup = false;
    } else if (line.includes('##[group]')) {
      if (inErrorGroup) {
        errors.push(line);
      }
      inErrorGroup = false;
    } else if (inErrorGroup) {
      errors.push(line);
    }
  }

  // First 50 lines
  excerptLines.push(...lines.slice(0, Math.min(MAX_LINES_HEAD, lines.length)));

  if (errors.length > 0) {
    excerptLines.push('', '... [omitted for brevity] ...', '', '### Extracted Errors:', '');
    excerptLines.push(...errors);
  }

  excerptLines.push('', '... [omitted for brevity] ...', '', '### Tail of Log:', '');

  // Last 200 lines
  excerptLines.push(...lines.slice(Math.max(0, lines.length - MAX_LINES_TAIL)));

  return enforceSizeLimit(excerptLines.join('\n'));
}

/**
 * Enforces a hard byte limit (roughly 200 KB).
 * @param {string} text 
 * @returns {string}
 */
function enforceSizeLimit(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_BYTES) {
    return text;
  }
  // Roughly trim if too large (convert to buffer, slice, convert back)
  const buf = Buffer.from(text, 'utf8');
  const truncated = buf.subarray(0, MAX_BYTES);
  return truncated.toString('utf8') + '\n\n[... log truncated due to size limit ...]';
}
