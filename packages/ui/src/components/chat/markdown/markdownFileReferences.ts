import { BLOCK_PATH_TOKEN_RE, localPathFromFileUrl, normalizeReferencePath, parseFileReference } from '../fileReferenceParser';
import { checkFileReference, fileReferenceExists, findUniqueFileByName, lookupFilesByName } from '../fileReferenceStat';
import { toastContextFileOpenFailure } from '@/lib/contextFileOpenGuard';
import { isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { ConfirmedCodePath } from './streamdownCode';
import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { isBrowserClientRuntime, isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { useMarkdownPresentation, type FileReferenceSource } from './MarkdownPresentationContext';
import { HighlightResultCache } from './highlightResultCache';
import { hasTextSelectionInside } from '@/lib/textSelection';
import { runNextTask } from '@/lib/timing/runNextTask';

const DRAG_START_DISTANCE_PX = 4;
let press: { reference: HTMLElement; tabIndex: string; x: number; y: number; dragged: boolean } | null = null;

export function activateMarkdownFile(event: React.MouseEvent | React.KeyboardEvent, open: (external: boolean) => void): void {
  if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  if (!('key' in event)) {
    const pressed = event.detail > 0 && press && event.target instanceof Node && press.reference.contains(event.target) ? press : null;
    if (event.detail > 0) press = null;
    if (pressed && (pressed.dragged || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > DRAG_START_DISTANCE_PX)) return;
    if (hasTextSelectionInside(event.currentTarget.closest('[data-markdown-content]'))) return;
    if (pressed) {
      pressed.reference.setAttribute('tabindex', pressed.tabIndex);
      pressed.reference.focus({ preventScroll: true });
    }
  }
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  open(isMac ? event.metaKey : event.ctrlKey);
}

export function releaseFileReferenceTabStop(event: React.PointerEvent): void {
  press = null;
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const reference = event.target.closest<HTMLElement>('[data-openchamber-file-link="true"][tabindex]');
  const tabIndex = reference?.getAttribute('tabindex');
  if (!reference || tabIndex == null) return;
  reference.removeAttribute('tabindex');
  const gesture = { reference, tabIndex, x: event.clientX, y: event.clientY, dragged: false };
  press = gesture;
  const track = (move: PointerEvent) => {
    if (move.pointerId === event.pointerId && Math.hypot(move.clientX - gesture.x, move.clientY - gesture.y) > DRAG_START_DISTANCE_PX) gesture.dragged = true;
  };
  const end = (done: PointerEvent) => {
    if (done.pointerId !== event.pointerId) return;
    window.removeEventListener('pointermove', track, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    if (done.type === 'pointercancel' && press === gesture) press = null;
  };
  window.addEventListener('pointermove', track, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  runNextTask(() => {
    if (reference.isConnected) reference.setAttribute('tabindex', tabIndex);
  });
}

const codePathCandidates = new HighlightResultCache<Array<{ raw: string; start: number }>>({ maxEntries: 64, maxBytes: 1024 * 1024 });

export function useOpenMarkdownFile() {
  const { directory } = useMarkdownPresentation();
  const apis = React.useContext(RuntimeAPIContext);
  const editor = apis?.editor;
  const isVSCode = apis?.runtime.isVSCode;
  const mobileActions = useMobileAppActions();
  return React.useCallback(async (raw: string, path?: string, external = false, inputKind: FileReferenceSource = 'path') => {
    const reference = resolveMarkdownFile(raw, directory, 'click', inputKind);
    if (!reference) return;
    const target = path ?? reference.resolvedPath;
    if (external && isDesktopLocalOriginActive() && await openDesktopPath(target)) return;
    if (isVSCode && editor) { void editor.openFile(target, reference.line, reference.column); return; }
    const ui = useUIStore.getState();
    if (reference.line) ui.openContextFileAtLine(directory, target, reference.line, reference.column ?? 1);
    else ui.openContextFile(directory, target);
    mobileActions?.openFiles();
  }, [directory, editor, isVSCode, mobileActions]);
}

export function useOpenTappedMarkdownFile() {
  const { directory } = useMarkdownPresentation();
  const open = useOpenMarkdownFile();
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return React.useCallback(async (raw: string) => {
    const reference = resolveMarkdownFile(raw, directory);
    if (!reference) return;
    const runtimeKey = getRuntimeKey();
    const check = await checkFileReference(reference.resolvedPath, directory);
    const named = check === 'missing' && !/[\\/]/.test(reference.path)
      ? await lookupFilesByName(reference.path, directory)
      : [];
    if (!mounted.current || getRuntimeKey() !== runtimeKey) return;
    if (check === 'failed' || !named || named.length > 1) toastContextFileOpenFailure(reference.resolvedPath, { reason: 'unreadable', message: null });
    else if (check === 'missing' && named.length === 0) toastContextFileOpenFailure(reference.resolvedPath, { reason: 'missing' });
    else await open(raw, named[0] ?? reference.resolvedPath);
  }, [directory, open]);
}

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

type FileReferencePurpose = 'probe' | 'click';

const isLikelyFilePath = (path: string, purpose: FileReferencePurpose, explicitHref: boolean): boolean => {
  if (!path) return false;
  if (!explicitHref && (path.startsWith('--') || path.includes('://') || /[<>]/.test(path) || /\s{2,}/.test(path))) return false;
  if (!explicitHref && purpose === 'probe' && path.includes('@') && !path.includes('/')) return false;
  const normalized = normalizeReferencePath(path);
  const name = normalized.split('/').filter(Boolean).pop() ?? '';
  if (!name || name === '.' || name === '..') return false;
  const lower = name.toLowerCase();
  if (KNOWN_FILE_BASENAMES.has(lower) || (lower.startsWith('.') && lower.length > 1)) return true;
  if (name.endsWith('.')) return false;
  return purpose === 'click' ? /\.[A-Za-z0-9_-]{1,16}$/.test(name) : /\.[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(name);
};

export function resolveMarkdownFile(raw: string, directory: string, purpose: FileReferencePurpose = 'probe', inputKind: FileReferenceSource = 'path') {
  const fileUrl = /^\s*file:/i.test(raw);
  const reference = parseFileReference(fileUrl ? localPathFromFileUrl(raw) ?? raw : raw);
  const explicitHref = inputKind === 'href' && !fileUrl;
  if (reference && explicitHref) {
    if (reference.path.startsWith('//') || (/^[A-Za-z][A-Za-z\d+.-]*:/.test(reference.path) && !/^[A-Za-z]:[\\/]/.test(reference.path))) return null;
    try {
      reference.path = decodeURIComponent(reference.path);
    } catch {
      // Malformed escapes retain their literal spelling, as native paths do.
    }
  }
  if (!reference || !directory || !isLikelyFilePath(reference.path, purpose, explicitHref)) return null;
  const path = toAbsoluteFilePath(directory, reference.path, { preserveWhitespace: explicitHref });
  return path ? { ...reference, resolvedPath: path } : null;
}

export async function confirmMarkdownFile(raw: string, directory: string, inputKind: FileReferenceSource = 'path'): Promise<string | null> {
  const reference = resolveMarkdownFile(raw, directory, 'probe', inputKind);
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
