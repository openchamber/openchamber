const INVISIBLE_ONLY_RE = /^[\s\p{Default_Ignorable_Code_Point}]*$/u;

export const isInvisibleText = (text: string): boolean => INVISIBLE_ONLY_RE.test(text);
