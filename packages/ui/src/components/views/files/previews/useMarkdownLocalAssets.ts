import React from 'react';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';

const LOCAL_ASSET_ATTR = 'data-oc-local-asset';
const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

/** A `src`/`href` the page itself cannot resolve: not a URL, not an anchor. */
const isRelativeReference = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
  return !/^[a-z][a-z\d+.-]*:/i.test(trimmed);
};

const stripQueryAndHash = (value: string): string => value.split(/[?#]/, 1)[0] ?? '';

/** GitHub-style heading slug, which is what `#some-heading` links are written against. */
const headingSlug = (text: string): string => (
  text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-')
);

/** Scrolls to the heading a `#fragment` link points at; false when there is none. */
const scrollToHeading = (container: HTMLElement, fragment: string): boolean => {
  const wanted = decodeReference(fragment.replace(/^#/, '')).toLowerCase();
  if (!wanted) return false;
  for (const heading of Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
    if (heading.id === wanted || headingSlug(heading.textContent ?? '') === wanted) {
      heading.scrollIntoView({ block: 'start' });
      return true;
    }
  }
  return false;
};

const decodeReference = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

type SrcsetCandidate = { url: string; descriptor: string };

const parseSrcset = (value: string): SrcsetCandidate[] => value.split(',').flatMap((candidate) => {
  const [url, ...descriptor] = candidate.trim().split(/\s+/);
  return url ? [{ url, descriptor: descriptor.join(' ') }] : [];
});

const MEDIA_SOURCE_ATTR = 'data-oc-media';
const COLOR_SCHEME_FEATURE_RE = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi;

/**
 * `<source media="(prefers-color-scheme: dark)">` would follow the OS, while
 * the preview is painted in the app theme. The color-scheme feature is swapped
 * for one that is always true or never true for the app theme; the author's
 * query is kept on the element so a theme change re-evaluates it.
 */
const applyColorScheme = (container: HTMLElement, colorScheme: 'light' | 'dark') => {
  for (const source of Array.from(container.querySelectorAll<HTMLSourceElement>('picture > source[media]'))) {
    const original = source.getAttribute(MEDIA_SOURCE_ATTR) ?? source.getAttribute('media') ?? '';
    const media = original.replace(COLOR_SCHEME_FEATURE_RE, (_feature, scheme: string) => (
      scheme.toLowerCase() === colorScheme ? '(min-width: 0px)' : '(max-width: -1px)'
    ));
    if (media === original) continue;
    if (source.getAttribute(MEDIA_SOURCE_ATTR) !== original) source.setAttribute(MEDIA_SOURCE_ATTR, original);
    if (source.getAttribute('media') !== media) source.setAttribute('media', media);
  }
};

/**
 * Makes a Markdown file's relative images and links work inside the preview.
 *
 * The renderer emits `<img src="./shot.png">` and `<a href="notes.md">` as
 * written; the page would resolve both against the app's own URL and get
 * nothing. Images are fetched through the runtime and swapped for object URLs,
 * `<picture>`/`srcset` candidates the same way, links open the target file in
 * the viewer, and `#fragment` links scroll to the heading in this file. Resolution is against the file's
 * directory, not the workspace root, and a target outside the workspace is
 * read the way the File Editor already reads such files.
 */
export const useMarkdownLocalAssets = ({
  container,
  filePath,
  workspaceRoot,
  onOpenFile,
  enabled,
  colorScheme,
}: {
  /** The rendered preview; state rather than a ref so mounting re-runs the wiring. */
  container: HTMLElement | null;
  filePath: string | null;
  workspaceRoot: string | null;
  onOpenFile: (absolutePath: string) => void;
  enabled: boolean;
  /** The app theme's variant, which `prefers-color-scheme` sources follow. */
  colorScheme: 'light' | 'dark';
}) => {
  const onOpenFileRef = React.useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const colorSchemeRef = React.useRef(colorScheme);
  colorSchemeRef.current = colorScheme;

  // Theme changes re-evaluate the sources without tearing down loaded images.
  React.useEffect(() => {
    if (enabled && container) applyColorScheme(container, colorScheme);
  }, [colorScheme, container, enabled]);

  React.useEffect(() => {
    if (!enabled || !container || !filePath) return;

    const baseDirectory = filePath.slice(0, filePath.lastIndexOf('/') + 1) || '/';
    const resolve = (reference: string): string => (
      toAbsoluteFilePath(baseDirectory, decodeReference(stripQueryAndHash(reference)))
    );
    const readOptions = (absolutePath: string) => ({
      path: absolutePath,
      allowOutsideWorkspace: workspaceRoot && isFilePathWithinDirectory(absolutePath, workspaceRoot) ? undefined : 'true',
      directory: workspaceRoot || undefined,
    });

    let disposed = false;
    const runtimeKey = getRuntimeKey();
    const objectUrls = new Map<string, Promise<string>>();

    const loadImage = (absolutePath: string): Promise<string> => {
      const cached = objectUrls.get(absolutePath);
      if (cached) return cached;
      const pending = (async () => {
        const response = await runtimeFetch('/api/fs/raw', {
          query: readOptions(absolutePath),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Image read failed (${response.status})`);
        const blob = await response.blob();
        if (blob.size > MAX_LOCAL_IMAGE_BYTES) throw new Error('Image too large for preview');
        if (disposed || getRuntimeKey() !== runtimeKey) throw new Error('Preview closed');
        return URL.createObjectURL(blob);
      })();
      objectUrls.set(absolutePath, pending);
      pending.catch(() => objectUrls.delete(absolutePath));
      return pending;
    };

    const rewriteImages = () => {
      for (const image of Array.from(container.querySelectorAll<HTMLImageElement>('img[src]'))) {
        const source = image.getAttribute('src') ?? '';
        if (!isRelativeReference(source)) continue;
        // morphdom can put the relative src back on re-render; the cached
        // object URL is reapplied, and the marker says which file it stands
        // for so a changed link is not answered with the old picture.
        const absolutePath = resolve(source);
        image.setAttribute(LOCAL_ASSET_ATTR, absolutePath);
        void loadImage(absolutePath)
          .then((url) => {
            if (disposed || image.getAttribute(LOCAL_ASSET_ATTR) !== absolutePath) return;
            if (image.getAttribute('src') !== url) image.src = url;
          })
          .catch(() => {
            if (!disposed) image.removeAttribute(LOCAL_ASSET_ATTR);
          });
      }
      // `<picture>` sources and `srcset` candidates, loaded the same way.
      for (const element of Array.from(container.querySelectorAll<HTMLElement>('source[srcset], img[srcset]'))) {
        const candidates = parseSrcset(element.getAttribute('srcset') ?? '');
        if (!candidates.some((candidate) => isRelativeReference(candidate.url))) continue;
        const resolved = candidates.map((candidate) => ({
          ...candidate,
          path: isRelativeReference(candidate.url) ? resolve(candidate.url) : null,
        }));
        const marker = resolved.map((candidate) => candidate.path ?? candidate.url).join(',');
        element.setAttribute(LOCAL_ASSET_ATTR, marker);
        void Promise.all(resolved.map(async ({ url, descriptor, path }) => {
          const loaded = path ? await loadImage(path) : url;
          return descriptor ? `${loaded} ${descriptor}` : loaded;
        }))
          .then((parts) => {
            if (disposed || element.getAttribute(LOCAL_ASSET_ATTR) !== marker) return;
            const srcset = parts.join(', ');
            if (element.getAttribute('srcset') !== srcset) element.setAttribute('srcset', srcset);
          })
          .catch(() => {
            if (!disposed) element.removeAttribute(LOCAL_ASSET_ATTR);
          });
      }
      applyColorScheme(container, colorSchemeRef.current);
    };

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || !container.contains(anchor)) return;
      const href = anchor.getAttribute('href') ?? '';
      // The renderer marks every link `target=_blank`; a fragment would open
      // the whole app in a new window instead of moving within this file.
      if (href.startsWith('#')) {
        event.preventDefault();
        event.stopPropagation();
        scrollToHeading(container, href);
        return;
      }
      if (!isRelativeReference(href)) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenFileRef.current(resolve(href));
    };

    rewriteImages();
    const observer = new MutationObserver(rewriteImages);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'media'] });
    container.addEventListener('click', handleClick, true);

    return () => {
      disposed = true;
      observer.disconnect();
      container.removeEventListener('click', handleClick, true);
      for (const pending of objectUrls.values()) {
        void pending.then((url) => URL.revokeObjectURL(url)).catch(() => {});
      }
    };
  }, [container, enabled, filePath, workspaceRoot]);
};
