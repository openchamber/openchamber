import type { CodeHighlighterPlugin, HighlightOptions, HighlightResult, HighlightToken } from 'streamdown';
import { markdownCodeHighlighter } from './markdownCodeHighlighter';

const themes: ReturnType<CodeHighlighterPlugin['getThemes']> = [{ name: 'openchamber-md' }, { name: 'openchamber-md' }];
function nativeLanguage(language: string): string {
  return language.trim().toLowerCase() || 'text';
}

function plainCode(code: string): HighlightResult {
  return { tokens: code.split('\n').map((content) => [{ content }]) };
}

function canHighlight(options: HighlightOptions, isVSCode: boolean): boolean {
  const maxLines = isVSCode ? 200 : options.isIncomplete ? 300 : 1200;
  let lines = 1;
  for (let index = 0; index < options.code.length; index++) {
    if (options.code.charCodeAt(index) === 10 && ++lines > maxLines) return false;
  }
  return true;
}

export interface ConfirmedCodePath {
  start: number;
  end: number;
  raw: string;
  path: string;
}

function annotateCodePaths(result: HighlightResult, paths: readonly ConfirmedCodePath[]): HighlightResult {
  if (!paths.length) return result;
  let lineOffset = 0;
  const tokens = result.tokens.map((line) => {
    let cursor = lineOffset;
    let changed = false;
    const annotated = line.flatMap((token): HighlightToken[] => {
      const start = token.offset ?? cursor;
      const end = start + token.content.length;
      cursor = end;
      const matches = paths.filter((path) => path.start < end && path.end > start);
      if (!matches.length) return [token];

      changed = true;
      const cuts = new Set([start, end]);
      for (const path of matches) {
        if (path.start > start && path.start < end) cuts.add(path.start);
        if (path.end > start && path.end < end) cuts.add(path.end);
      }
      const offsets = [...cuts].sort((a, b) => a - b);
      return offsets.slice(0, -1).map((offset, index) => {
        const next = offsets[index + 1];
        const path = matches.find((candidate) => candidate.start <= offset && candidate.end >= next);
        return {
          ...token,
          offset,
          content: token.content.slice(offset - start, next - start),
          htmlAttrs: path ? {
            ...token.htmlAttrs,
            'data-openchamber-file-link': 'true',
            'data-openchamber-file-ref': path.raw,
            'data-openchamber-file-path': path.path,
            role: 'button',
            tabIndex: '0',
          } : token.htmlAttrs,
        };
      });
    });
    lineOffset = cursor + 1;
    return changed ? annotated : line;
  });
  return { ...result, tokens };
}

export interface MarkdownCodePlugin extends CodeHighlighterPlugin {
  cached: (input: HighlightOptions) => HighlightResult | null;
}

export function createMarkdownCodePlugin(options: {
  isVSCode: boolean;
  resolvePaths?: (code: string) => Promise<ConfirmedCodePath[]>;
  purpose?: 'copy' | 'image';
  prepared?: ReadonlyMap<string, ReadonlyMap<string, HighlightResult>>;
}): MarkdownCodePlugin {
  const annotated = new WeakMap<HighlightResult, HighlightResult>();
  const pendingPaths = new Map<string, Promise<ConfirmedCodePath[]>>();
  const cached = (input: HighlightOptions): HighlightResult | null => {
    const prepared = options.prepared?.get(input.language)?.get(input.code);
    if (prepared) return prepared;
    if (options.purpose === 'copy' || !canHighlight(input, options.isVSCode)) return plainCode(input.code);
    const language = nativeLanguage(input.language);
    const result = markdownCodeHighlighter.cached(input.code, language, input.isIncomplete ?? false);
    return result ? annotated.get(result) ?? result : null;
  };
  return {
    name: 'shiki',
    type: 'code-highlighter',
    getSupportedLanguages: () => [],
    getThemes: () => themes,
    supportsLanguage: () => true,
    cached,
    highlight(input, callback) {
      const finish = (result: HighlightResult) => {
        const cached = annotated.get(result);
        if (cached) return cached;
        if (options.resolvePaths) {
          let pending = pendingPaths.get(input.code);
          if (!pending) {
            pending = options.resolvePaths(input.code);
            pendingPaths.set(input.code, pending);
            void pending.finally(() => pendingPaths.delete(input.code)).catch(() => {});
          }
          void pending.then((paths) => {
            if (!paths.length) return;
            const next = annotated.get(result) ?? annotateCodePaths(result, paths);
            annotated.set(result, next);
            annotated.set(next, next);
            callback?.(next);
          }).catch(() => {});
        }
        return result;
      };
      const ready = cached(input);
      if (ready) return options.prepared?.get(input.language)?.has(input.code) ? ready : finish(ready);
      const language = nativeLanguage(input.language);
      void markdownCodeHighlighter.highlight(input.code, language, input.isIncomplete ?? false)
        .then((result) => callback?.(finish(result ?? plainCode(input.code))));
      return null;
    },
  };
}

export async function prepareExportHighlight(code: string, language: string): Promise<HighlightResult> {
  const plugin = createMarkdownCodePlugin({ isVSCode: false });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(plainCode(code)), 5000);
    const complete = (result: HighlightResult) => { clearTimeout(timer); resolve(result); };
    const result = plugin.highlight({ code, language, themes: plugin.getThemes() }, complete);
    if (result) complete(result);
  });
}
