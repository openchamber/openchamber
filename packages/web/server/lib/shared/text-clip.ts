// Clipping text to a length without leaving half a character. A fork module.

// A plain slice at the cap can land between the halves of a surrogate
// pair, leaving a lone high surrogate that is persisted to settings and
// encodes as U+FFFD in the manifest and the installed app's name; move a
// cut that lands inside a pair back to the pair boundary.
export const clipPairSafe = (text: string, limit: number) => {
  const clipped = text.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

// Truncate on grapheme-cluster boundaries instead (#2147, mirroring
// pwa-manifest-routes.js): a pair-safe cut can still drop a combining
// mark off its base character or leave a dangling ZWJ in a joined emoji
// sequence, and the persisted name feeds the manifest. Where
// Intl.Segmenter is unavailable, fall back to the pair-safe slice.
export const clipGraphemeSafe = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const Segmenter = globalThis.Intl?.Segmenter;
  if (!Segmenter) return clipPairSafe(text, limit);
  let clipped = '';
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (clipped.length + segment.length > limit) break;
    clipped += segment;
  }
  return clipped;
};
