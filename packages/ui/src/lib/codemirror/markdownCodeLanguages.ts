import type { Language, LanguageDescription } from '@codemirror/language';

const COMMON_LANGUAGE_NAMES = new Set([
  'bash',
  'sh',
  'zsh',
  'shell',
  'shellsession',
  'console',
  'toml',
  'diff',
  'patch',
  'json',
  'jsonc',
  'json5',
  'js',
  'javascript',
  'jsx',
  'ts',
  'typescript',
  'tsx',
  'yaml',
  'yml',
  'html',
  'css',
  'xml',
  'svg',
  'py',
  'python',
  'sql',
  'rs',
  'rust',
  'c',
  'cpp',
  'h',
  'hpp',
  'go',
  'ex',
  'exs',
  'elixir',
  'erl',
  'hrl',
  'erlang',
  'heex',
  'eex',
  'leex',
]);

export function codeBlockLanguageResolver(info: string): Language | LanguageDescription | null {
  const normalized = info.trim().toLowerCase();
  if (!normalized || !COMMON_LANGUAGE_NAMES.has(normalized)) {
    return null;
  }

  return null;
}
