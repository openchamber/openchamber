import { BLOCK_PATH_TOKEN_RE, localPathFromFileUrl, normalizeReferencePath, parseFileReference } from '../fileReferenceParser';
import { fileReferenceExists, findUniqueFileByName } from '../fileReferenceStat';
import { isAbsoluteFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import type { ConfirmedCodePath } from './streamdownCode';
import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { isBrowserClientRuntime, isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { useMarkdownPresentation } from './MarkdownPresentationContext';
import { HighlightResultCache } from './highlightResultCache';
import { hasTextSelectionInside } from '@/lib/textSelection';

/** A selection-ending click is consumed without navigating, as before migration. */
export function activateMarkdownFile(event: React.MouseEvent | React.KeyboardEvent, open: (external: boolean) => void): void {
  if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  if (!('key' in event) && hasTextSelectionInside(event.currentTarget.closest('[data-markdown-content]'))) return;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  open(isMac ? event.metaKey : event.ctrlKey);
}

// Only lexical matches are cached globally. Resolution and existence remain
// directory/runtime-bound and continue through the caller's confirmation path.
const codePathCandidates = new HighlightResultCache<Array<{ raw: string; start: number }>>({ maxEntries: 64, maxBytes: 1024 * 1024 });

export function useOpenMarkdownFile() {
  const { directory } = useMarkdownPresentation();
  const apis = React.useContext(RuntimeAPIContext);
  const editor = apis?.editor;
  const isVSCode = apis?.runtime.isVSCode;
  const mobileActions = useMobileAppActions();
  return React.useCallback(async (raw: string, path?: string, external = false) => {
    const reference = resolveMarkdownFile(raw, directory, 'click');
    if (!reference) return;
    const target = path ?? reference.resolvedPath;
    if (external && isDesktopLocalOriginActive() && await openDesktopPath(target)) return;
    if (isVSCode && editor) { void editor.openFile(target, reference.line, reference.column); return; }
    const ui = useUIStore.getState();
    if (reference.line) ui.openContextFileAtLine(directory, target, reference.line, reference.column ?? 1);
    else ui.openContextFile(directory, target);
    // On the phone the viewer lives in the workspace drawer; the staged file
    // shows only once the drawer is open on Files (#5486).
    mobileActions?.openFiles();
  }, [directory, editor, isVSCode, mobileActions]);
}

// A `file:` link the click rules do not take as a file is usually a folder.
// It opens in the system file manager, as "Reveal in Finder" in the Files
// tree does, and only where that tree offers it: not in a browser, which
// hides the item, and not in VS Code, which mounts no Files tree (#5521).
export function useRevealMarkdownPath(): ((path: string) => void) | null {
  const apis = React.useContext(RuntimeAPIContext);
  const { t } = useI18n();
  const files = apis?.files;
  const platform = apis?.runtime.platform;
  return React.useMemo(() => {
    const reveal = files?.revealPath?.bind(files);
    if (!reveal || !platform || platform === 'vscode' || isBrowserClientRuntime(platform)) return null;
    return (path: string) => {
      void reveal(path).catch(() => {
        toast.error(t('sidebarFilesTree.toast.revealFailed'));
      });
    };
  }, [files, platform, t]);
}

const KNOWN_FILE_BASENAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', '.env', '.gitignore', '.npmrc']);

// Clicks keep the broad rules so a file-looking link never falls through to
// its target="_blank" default (#3858). Probes are automatic and skip emails
// handles and digit-leading suffixes such as `user@gmail.com`, `v1.2.3` or `93.00`.
type FileReferencePurpose = 'probe' | 'click';

const isLikelyFilePath = (path: string, purpose: FileReferencePurpose): boolean => {
  if (!path || path.startsWith('--') || path.includes('://') || /[<>]/.test(path) || /\s{2,}/.test(path)) return false;
  // An `@` without a slash is an email or a handle; with one it is usually a
  // scoped package or pnpm path (`node_modules/@types/node/index.d.ts`).
  if (purpose === 'probe' && path.includes('@') && !path.includes('/')) return false;
  const normalized = normalizeReferencePath(path);
  const name = normalized.split('/').filter(Boolean).pop() ?? '';
  if (!name || name === '.' || name === '..') return false;
  const lower = name.toLowerCase();
  if (KNOWN_FILE_BASENAMES.has(lower) || (lower.startsWith('.') && lower.length > 1)) return true;
  if (name.endsWith('.')) return false;
  return purpose === 'click' ? /\.[A-Za-z0-9_-]{1,16}$/.test(name) : /\.[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(name);
};

export function resolveMarkdownFile(raw: string, directory: string, purpose: FileReferencePurpose = 'probe') {
  // Most code tokens are paths, not URLs. Avoid constructing and throwing a URL
  // for every ordinary identifier/path in a highlighted fence.
  const reference = parseFileReference(/^\s*file:/i.test(raw) ? localPathFromFileUrl(raw) ?? raw : raw);
  if (!reference || !directory || !isLikelyFilePath(reference.path, purpose)) return null;
  const path = isAbsoluteFilePath(reference.path) ? normalizeReferencePath(reference.path) : toAbsoluteFilePath(directory, reference.path);
  return path ? { ...reference, resolvedPath: path } : null;
}

export async function confirmMarkdownFile(raw: string, directory: string): Promise<string | null> {
  const reference = resolveMarkdownFile(raw, directory);
  if (!reference) return null;
  if (!isFilePathWithinDirectory(reference.resolvedPath, directory)) return reference.resolvedPath;
  if (await fileReferenceExists(reference.resolvedPath, directory)) return reference.resolvedPath;
  return !/[\\/]/.test(reference.path) ? findUniqueFileByName(reference.path, directory) : null;
}

export async function confirmCodePaths(code: string, directory: string, limit: number, confirm: (raw: string) => Promise<string | null> = (raw) => confirmMarkdownFile(raw, directory)): Promise<ConfirmedCodePath[]> {
  if (code.length > 200_000) return [];
  let matches = codePathCandidates.get(code);
  if (!matches) {
    matches = Array.from(code.matchAll(BLOCK_PATH_TOKEN_RE), (match) => ({ raw: match[0], start: match.index }));
    const bytes = code.length * 2 + matches.reduce((sum, match) => sum + match.raw.length * 2 + 32, 0);
    if (bytes <= 1024 * 1024) codePathCandidates.set(code, matches, bytes);
  }
  const candidates = matches.filter((match) => resolveMarkdownFile(match.raw, directory)).slice(0, limit);
  const confirmed = await Promise.all(candidates.map(async (match) => {
    const path = await confirm(match.raw);
    return path ? { start: match.start, end: match.start + match.raw.length, raw: match.raw, path } : null;
  }));
  return confirmed.filter((value): value is ConfirmedCodePath => value !== null);
}
