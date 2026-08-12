// Post-condition guard for small-model text. The model can answer in a language
// the prompt never asked for — account-side personalization overrides the
// instruction — so callers compare the generated text against the source text it
// was told to follow, and drop the output when the scripts disagree.
//
// A class must be DISJOINT across the languages we distinguish, or the guard
// produces false positives. Han is shared by Japanese and Chinese, so it stays
// in one class with Kana: splitting it would drop a legitimate Japanese output
// whose source text happened to carry no Han. Hangul is Korean-only, so it is
// its own class — that is what catches a Korean answer to a Japanese
// conversation. Japanese-versus-Chinese is therefore out of reach here by
// design, not by omission.
//
// Presence-only and one-directional: a script present in the output but absent
// from the source is a mismatch; the reverse is not, because a short note may
// legitimately use fewer scripts than the text it summarizes.
//
// A missing or non-string reference is treated as empty text, so any tracked
// script in the output counts as a mismatch. That fail-closed default is
// deliberate: a caller that cannot say what language was asked for should not
// get wrong-language text through.
//
// Keep this module dependency-free (no fs, settings, or network) so consumers
// that inject the small-model service can still import it directly.

const SCRIPT_RANGES = [
  /[\u0400-\u04FF]/,              // Cyrillic
  /[\u3040-\u30FF\u4E00-\u9FFF]/, // Kana + Han (Japanese, Chinese)
  /[\uAC00-\uD7AF]/,              // Hangul (Korean)
  /[\u0900-\u097F]/,              // Devanagari
  /[\u0600-\u06FF]/,              // Arabic
];

export const hasScriptMismatch = (text, referenceText) => {
  if (typeof text !== 'string' || !text) return false;
  const reference = typeof referenceText === 'string' ? referenceText : '';
  return SCRIPT_RANGES.some((range) => range.test(text) && !range.test(reference));
};
