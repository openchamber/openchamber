import { describe, it, expect } from 'vitest';
import { extractLogExcerpt } from '../checks-logs.js';

describe('extractLogExcerpt', () => {
  it('returns empty string for empty log', () => {
    expect(extractLogExcerpt('')).toBe('');
    expect(extractLogExcerpt(null)).toBe('');
  });

  it('returns full log if within limits', () => {
    const log = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join('\n');
    expect(extractLogExcerpt(log)).toBe(log);
  });

  it('truncates log and includes head, errors, and tail', () => {
    const lines = [];
    for (let i = 0; i < 300; i++) {
      if (i === 100) lines.push('##[error] Something went wrong!');
      else if (i === 101) lines.push('Traceback (most recent call last):');
      else if (i === 102) lines.push('##[endgroup]');
      else lines.push(`Line ${i}`);
    }
    const log = lines.join('\n');
    const excerpt = extractLogExcerpt(log);

    expect(excerpt).toContain('Line 0');
    expect(excerpt).toContain('Line 49'); // Head
    expect(excerpt).toContain('##[error] Something went wrong!');
    expect(excerpt).toContain('Traceback (most recent call last):'); // Error group
    expect(excerpt).toContain('Line 103'); // Tail starts around 103 in the tail section
    expect(excerpt).toContain('Line 299'); // Tail end
    expect(excerpt).not.toContain('Line 70'); // Middle removed
  });

  it('enforces byte limits', () => {
    const heavyLine = 'a'.repeat(1000); // 1KB per line
    const log = Array.from({ length: 300 }, () => heavyLine).join('\n'); // 300KB
    const excerpt = extractLogExcerpt(log);
    
    // Convert to buffer to check size since the JS string length might not map exactly
    const size = Buffer.byteLength(excerpt, 'utf8');
    expect(size).toBeLessThanOrEqual(200 * 1024 + 100); // Roughly 200KB + truncation text
    expect(excerpt).toContain('[... log truncated due to size limit ...]');
  });
});
