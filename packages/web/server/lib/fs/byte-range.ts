
export type ByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'whole' }
  | { kind: 'unsatisfiable' };

export const resolveByteRange = (header: string | string[] | undefined, size: number): ByteRange => {
  if (!header || size <= 0) return { kind: 'whole' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { kind: 'whole' };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'whole' };

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
