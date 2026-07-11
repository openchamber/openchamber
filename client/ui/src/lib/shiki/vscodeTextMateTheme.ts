export type VSCodeTokenColorRule = {
  name?: string;
  scope?: string | string[];
  settings: Record<string, string | undefined>;
};

export type VSCodeTextMateTheme = {
  name: string;
  type: 'dark' | 'light';
  colors?: Record<string, string>;
  tokenColors?: VSCodeTokenColorRule[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, string>;
};
