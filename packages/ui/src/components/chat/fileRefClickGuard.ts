// File references are marked asynchronously: the annotation pass in
// `MarkdownRendererImpl` debounces and issues a filesystem stat probe per
// candidate, so a click can land before the `data-openchamber-file-link`
// attribute exists. Without a guard the unannotated anchor falls through to
// its `target="_blank"` default and opens a new app window at a bogus route
// (issue #3858). This guard routes such clicks to the file viewer instead,
// using the same `openFileReference` path the annotation would have taken.
//
// Only primary clicks are intercepted here; keyboard activation of an anchor
// still produces a native click that bubbles to this listener, and app links
// keep their own handling (the app-link listener bails on
// `event.defaultPrevented`). Middle-click/auxclick deliberately keeps the
// browser convention of opening in a new window.
export const FILE_REFERENCE_LINK_SELECTOR = '[data-openchamber-file-link="true"]';

type FileReferenceClickGuardOptions = {
  /** File-reference candidate carried by an anchor href, or null when the href is not file-like. */
  hrefCandidate: (anchor: HTMLAnchorElement) => string | null;
  /** True when the candidate is a resolvable file reference. */
  isResolvable: (raw: string) => boolean;
  /** Open the file reference carried by the element. */
  openFileReference: (element: HTMLElement) => void;
};

type FileReferenceClickContainer = {
  addEventListener: (type: string, listener: (event: MouseEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: MouseEvent) => void) => void;
};

const findAnnotatedFileReference = (target: EventTarget | null): HTMLElement | null => {
  if (!(target instanceof Element)) return null;
  const element = target.closest(FILE_REFERENCE_LINK_SELECTOR);
  return element instanceof HTMLElement ? element : null;
};

const findUnannotatedFileReferenceAnchor = (
  target: EventTarget | null,
  options: FileReferenceClickGuardOptions,
): HTMLAnchorElement | null => {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  const raw = options.hrefCandidate(anchor);
  if (!raw || !options.isResolvable(raw)) return null;
  return anchor;
};

export const attachFileRefClickGuard = (
  container: FileReferenceClickContainer,
  options: FileReferenceClickGuardOptions,
): (() => void) => {
  const handleClick = (event: MouseEvent) => {
    const element = findAnnotatedFileReference(event.target)
      ?? findUnannotatedFileReferenceAnchor(event.target, options);
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    options.openFileReference(element);
  };
  container.addEventListener('click', handleClick);
  return () => container.removeEventListener('click', handleClick);
};