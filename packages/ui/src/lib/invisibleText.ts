// Whitespace plus the characters Unicode marks as drawing nothing on their
// own (Default_Ignorable_Code_Point): zero-width space and joiners, BOM, word
// joiner, soft hyphen, bidi marks, variation selectors and the like.
const INVISIBLE_ONLY_RE = /^[\s\p{Default_Ignorable_Code_Point}]*$/u;

/**
 * Whether `text` draws nothing a person can see. Some models send text parts
 * holding only a zero-width space between steps; a plain `trim()` keeps them,
 * and each became a blank line in the chat (#5215). Only whole texts count:
 * a ZWJ inside an emoji or a ZWNJ inside a Persian word is left alone.
 */
export const isInvisibleText = (text: string): boolean => INVISIBLE_ONLY_RE.test(text);
