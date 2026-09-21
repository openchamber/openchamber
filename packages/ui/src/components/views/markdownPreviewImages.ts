import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { blobToDataUrl, parseLocalImagePath } from '@/components/chat/markdown/markdownImageAssets';

/**
 * Resolve embedded local images inside the Markdown file preview.
 *
 * The preview parses Markdown into plain DOM without an owning session, so the
 * chat image-grant pipeline does not apply and a relative `<img src>` would
 * resolve against the app origin and always fail. This widget rewrites those
 * sources to workspace-contained files fetched through the authenticated raw
 * file route, the same boundary the chat image gallery and the image file
 * preview use. SVG stays loaded through `<img>`, where browsers never execute
 * scripts or load external references.
 */

const PREVIEW_IMAGE_CAP_BYTES = 10 * 1024 * 1024;
const PREVIEW_IMAGE_SCAN_DEBOUNCE_MS = 80;
const RESOLVED_ATTR = 'data-md-preview-image';

/** Mirrors the server raw-route image mime map; SVG is safe in the img sandbox. */
const PREVIEW_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);

/** A local image candidate worth resolving, or '' for sources the DOM already handles. */
export const getLocalPreviewImagePath = (source: string): string => {
  if (!source || /^(?:https?:)?\/\//i.test(source) || /^data:/i.test(source)) return '';
  const localPath = parseLocalImagePath(source);
  if (!localPath) return '';
  const extension = localPath.split('.').at(-1)?.toLowerCase() ?? '';
  return PREVIEW_IMAGE_EXTENSIONS.has(extension) ? localPath : '';
};

/**
 * Resolve an embedded image source against the directory of the previewed
 * file, keeping the image inside the active workspace.
 */
export const resolveLocalPreviewImagePath = ({
  source,
  filePath,
  directory,
}: {
  source: string;
  filePath: string;
  directory: string;
}): string => {
  const localPath = getLocalPreviewImagePath(source);
  if (!localPath) return '';
  const markdownPath = toAbsoluteFilePath(directory, filePath);
  const markdownBaseDirectory = getDirectoryForFilePath('', markdownPath);
  const imagePath = toAbsoluteFilePath(markdownBaseDirectory, localPath);
  if (!isFilePathWithinDirectory(imagePath, directory)) return '';
  return imagePath;
};

type PreviewImageFetcher = (imagePath: string, directory: string) => Promise<string>;

const rawAssetPreviewFetcher: PreviewImageFetcher = async (imagePath, directory) => {
  const response = await runtimeFetch('/api/fs/raw', {
    query: { path: imagePath, directory: directory || undefined },
  });
  if (!response.ok) throw new Error(`Unable to load image (${response.status})`);
  const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) throw new Error('Unsupported image type');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > PREVIEW_IMAGE_CAP_BYTES) {
    throw new Error('Image is too large');
  }
  const blob = await response.blob();
  if (blob.size > PREVIEW_IMAGE_CAP_BYTES) throw new Error('Image is too large');
  return blobToDataUrl(blob);
};

/**
  * One idempotent scan pass: stamp every `<img>` with its preview state and
  * swap local sources for resolved data URLs. Failed and non-resolvable
  * candidates are stamped too, so later DOM churn re-checks them but the
  * stamping itself never mutates source state that could loop.
  */
export const resolveMarkdownPreviewImages = async (
  container: HTMLElement,
  options: { filePath: string; directory: string },
  fetcher: PreviewImageFetcher,
  promisesByPath: Map<string, Promise<string | null>>,
): Promise<void> => {
  const images = Array.from(container.querySelectorAll<HTMLImageElement>(`img:not([${RESOLVED_ATTR}])`));
  const requests: Array<Promise<void>> = [];
  for (const image of images) {
    const imagePath = resolveLocalPreviewImagePath({
      source: image.getAttribute('src') ?? '',
      filePath: options.filePath,
      directory: options.directory,
    });
    image.setAttribute(RESOLVED_ATTR, imagePath ? 'pending' : 'outside');
    if (!imagePath) continue;
    let promise = promisesByPath.get(imagePath);
    if (!promise) {
      promise = fetcher(imagePath, options.directory)
        .catch(() => null)
        .finally(() => {
          promisesByPath.delete(imagePath);
        });
      promisesByPath.set(imagePath, promise);
    }
    // Each image gets its own stamp resolution; sharing a fetch must not
    // leave later duplicates stamped `pending` with no settled state.
    requests.push(promise.then((dataUrl) => {
      if (dataUrl) image.src = dataUrl;
      image.setAttribute(RESOLVED_ATTR, dataUrl ? 'resolved' : 'failed');
    }));
  }
  await Promise.all(requests);
};

type MarkdownPreviewImagesOptions = {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Path of the previewed Markdown file, relative to or absolute under `directory`. */
  filePath: string;
  /** Workspace root used for path resolution and the read boundary. */
  directory: string;
  enabled?: boolean;
  fetcher?: PreviewImageFetcher;
  /**
   * Mount signal: the hook captures `containerRef.current` once per effect
   * run, so a preview that mounts (or swaps its scroll container) later than
   * the surrounding effect deps settle needs this to re-arm the scan.
   */
  rescanKey?: unknown;
};

export const useMarkdownPreviewImages = ({
  containerRef,
  filePath,
  directory,
  enabled = true,
  fetcher = rawAssetPreviewFetcher,
  rescanKey,
}: MarkdownPreviewImagesOptions): void => {
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;
  const filePathRef = React.useRef(filePath);
  filePathRef.current = filePath;
  const promisesByPathRef = React.useRef(new Map<string, Promise<string | null>>());

  React.useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || !filePath || !directory) return;

    const scan = async () => {
      await resolveMarkdownPreviewImages(
        container,
        { filePath: filePathRef.current, directory },
        fetcherRef.current,
        promisesByPathRef.current,
      );
    };

    let scheduled: number | undefined;
    const scheduleScan = () => {
      if (scheduled !== undefined) return;
      scheduled = window.setTimeout(() => {
        scheduled = undefined;
        void scan();
      }, PREVIEW_IMAGE_SCAN_DEBOUNCE_MS);
    };

    const observer = new MutationObserver(scheduleScan);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    void scan();
    return () => {
      if (scheduled !== undefined) window.clearTimeout(scheduled);
      observer.disconnect();
    };
  }, [containerRef, directory, enabled, filePath, rescanKey]);
};
