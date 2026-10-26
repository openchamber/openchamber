/**
 * One HTTP `Range` header, reduced to the single byte span this server serves.
 *
 * Media elements ask for `bytes=0-` first and then for `bytes=<offset>-` on
 * every seek; without a 206 answer Chromium and WebKit refuse to seek at all,
 * and Safari refuses to play. Multi-range requests are answered with the whole
 * file: no media consumer sends them, and a multipart body is not worth
 * carrying for a viewer.
 */

/**
 * @param {unknown} header
 * @param {number} size
 * @returns {{ kind: 'range', start: number, end: number } | { kind: 'whole' } | { kind: 'unsatisfiable' }}
 */
export const resolveByteRange = (header, size) => {
  if (!header || size <= 0) return { kind: 'whole' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { kind: 'whole' };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'whole' };

  // `bytes=-500` means the final 500 bytes.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
};
