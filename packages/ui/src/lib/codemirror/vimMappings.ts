/**
 * Persistent Vim mappings for the file editor, written as vimrc map lines
 * (`inoremap jk <Esc>`). Only key-to-key maps are understood; ex-command
 * mappings, `<expr>` and anything else is reported back as an invalid line
 * rather than half-applied.
 */

type VimMappingContext = 'normal' | 'insert' | 'visual' | 'operatorPending';

export interface VimMapping {
  context: VimMappingContext;
  lhs: string;
  rhs: string;
  recursive: boolean;
}

export interface ParsedVimMappings {
  mappings: VimMapping[];
  /** 1-based numbers of non-empty, non-comment lines that are not a supported map. */
  invalidLines: number[];
}

// `map` without a mode covers normal, visual and operator-pending, as in Vim.
const MAP_ALL: VimMappingContext[] = ['normal', 'visual', 'operatorPending'];

const COMMANDS = new Map<string, { contexts: VimMappingContext[]; recursive: boolean }>([
  ['map', { contexts: MAP_ALL, recursive: true }],
  ['noremap', { contexts: MAP_ALL, recursive: false }],
  ['nmap', { contexts: ['normal'], recursive: true }],
  ['nnoremap', { contexts: ['normal'], recursive: false }],
  ['imap', { contexts: ['insert'], recursive: true }],
  ['inoremap', { contexts: ['insert'], recursive: false }],
  ['vmap', { contexts: ['visual'], recursive: true }],
  ['vnoremap', { contexts: ['visual'], recursive: false }],
  ['xmap', { contexts: ['visual'], recursive: true }],
  ['xnoremap', { contexts: ['visual'], recursive: false }],
  ['omap', { contexts: ['operatorPending'], recursive: true }],
  ['onoremap', { contexts: ['operatorPending'], recursive: false }],
]);

// Arguments that change nothing for a key-to-key map in this editor.
const IGNORED_ARGUMENTS = new Set(['<silent>', '<nowait>', '<buffer>', '<unique>']);

const MAP_LINE = /^(\S+)((?:\s+<[a-z]+>)*)\s+(\S+)\s+(.+)$/i;

export function parseVimMappings(source: string): ParsedVimMappings {
  const mappings: VimMapping[] = [];
  const invalidLines: number[] = [];
  source.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('"')) return;
    const match = MAP_LINE.exec(line);
    const command = match ? COMMANDS.get(match[1]) : undefined;
    const argumentsSupported = match
      ? match[2].trim().split(/\s+/).filter(Boolean).every((argument) => IGNORED_ARGUMENTS.has(argument.toLowerCase()))
      : false;
    if (!match || !command || !argumentsSupported || match[3].startsWith(':')) {
      invalidLines.push(index + 1);
      return;
    }
    for (const context of command.contexts) {
      mappings.push({ context, lhs: match[3], rhs: match[4].trim(), recursive: command.recursive });
    }
  });
  return { mappings, invalidLines };
}
