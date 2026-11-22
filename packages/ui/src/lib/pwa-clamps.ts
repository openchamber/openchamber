const clipPairSafe = (value: string, limit: number): string => {
  const clipped = value.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

// Truncate to at most `limit` UTF-16 code units without splitting an
// extended grapheme cluster: a cluster that does not fit whole is dropped
// whole, so a cut never drops a combining mark off its base character or
// leaves a dangling ZWJ in a joined emoji sequence. Where Intl.Segmenter
// is unavailable (older Safari), fall back to the pair-safe slice, which
// still never leaves a lone high surrogate.
const clipGraphemeSafe = (value: string, limit: number): string => {
  if (value.length <= limit) {
    return value;
  }
  const Segmenter = globalThis.Intl?.Segmenter;
  if (!Segmenter) {
    return clipPairSafe(value, limit);
  }
  let clipped = '';
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    if (clipped.length + segment.length > limit) {
      break;
    }
    clipped += segment;
  }
  return clipped;
};

// Keep UI caps aligned with the server helpers: the install name clamps
// on grapheme-cluster boundaries like every other PWA name clamp (#2147),
// so a cut never drops a combining mark or splits a joined emoji sequence.
export const clipPwaInstallName = (value: string): string => clipGraphemeSafe(value, 64);

export const normalizeRecentTitle = (value: string | undefined, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }
  return clipGraphemeSafe(normalized, 48);
};
