import React from 'react';
import type { ToolPopupContent } from '../message/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { runtimeAssetsNeedHeaders } from '@/lib/runtime-asset';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { isFilePathWithinDirectory } from '@/lib/path-utils';
import { isMarkdownDocumentReference, resolveMarkdownDocumentReference } from '@/components/views/files/previews/useMarkdownLocalAssets';
import { getPreparedMarkdownImageUrl, isLocalMarkdownImageSource, loadMessageImageBlob, loadPreparedImageAsDataUrl, prepareLocalMarkdownImages, resolveMarkdownImageSource, resolveWorkspaceMarkdownImageSource, type PreparedMarkdownImage } from './markdownImageAssets';

export type MarkdownDocumentAssets = {
  filePath: string;
  workspaceRoot: string | null;
  onOpenFile: (absolutePath: string) => void;
  colorScheme: 'light' | 'dark';
};

type GalleryImage = { source: string; filename: string; element: HTMLElement; resolve: () => Promise<string>; load: () => Promise<Blob> };
// Parts of one message share the existing popup gallery. Entries live only while
// their React-owned image is mounted and loaded, and retain no resolved URLs.
const galleries = new Map<string, Set<GalleryImage>>();

type MediaOwner = {
  mode: 'assistant' | 'local' | 'document';
  sessionId?: string;
  messageId?: string;
  directory: string;
  documentAssets?: Pick<MarkdownDocumentAssets, 'filePath' | 'workspaceRoot'>;
};

export class MarkdownMediaOwner {
  controller = new AbortController();
  private disposed = false;
  private sources = new Map<string, number>();
  private batch: Promise<Map<string, PreparedMarkdownImage>> | undefined;
  private refreshing: Promise<Map<string, PreparedMarkdownImage>> | undefined;
  private documentUrls = new Map<string, Promise<string>>();
  private runtimeKey = getRuntimeKey();
  private resolver = getRuntimeUrlResolver();
  constructor(readonly options: MediaOwner) {}

  connect(): void {
    if (!this.disposed && this.controller.signal.aborted) this.controller = new AbortController();
  }

  register(source: string): () => void {
    this.sources.set(source, (this.sources.get(source) ?? 0) + 1);
    return () => {
      const count = (this.sources.get(source) ?? 1) - 1;
      if (count) this.sources.set(source, count); else this.sources.delete(source);
    };
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted || this.disposed || this.runtimeKey !== getRuntimeKey() || this.resolver !== getRuntimeUrlResolver()) throw new DOMException('Media owner changed', 'AbortError');
  }

  async resolve(source: string, video = false, refresh = false): Promise<string> {
    const signal = this.controller.signal;
    this.check(signal);
    const { mode, directory, sessionId, messageId, documentAssets } = this.options;
    if (mode === 'assistant') {
      await Promise.resolve();
      this.check(signal);
      if (![...this.sources.keys()].slice(0, 12).includes(source)) throw new Error('Message media limit');
    }
    const remote = /^(?:https?:)?\/\//i.test(source);
    if (remote) {
      if (mode !== 'document' && !video) throw new Error('Remote chat image');
      return source;
    }
    if (/^data:/i.test(source)) return resolveMarkdownImageSource(source, signal);
    if (mode === 'document') {
      if (!documentAssets) return source;
      if (!isMarkdownDocumentReference(source)) throw new Error('Document source is unavailable');
      const path = resolveMarkdownDocumentReference(documentAssets.filePath, source);
      const workspace = documentAssets.workspaceRoot;
      const query = { path, directory: workspace || undefined, allowOutsideWorkspace: workspace && isFilePathWithinDirectory(path, workspace) ? undefined : 'true' };
      if (video) {
        if (isVSCodeRuntime()) throw new Error('Video bridge is unavailable');
        await refreshRuntimeUrlAuthToken();
        this.check(signal);
        return getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', query);
      }
      const cached = this.documentUrls.get(path);
      if (cached) return cached;
      const pending = (async () => {
        const response = await runtimeFetch('/api/fs/raw', { query, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        if (!response.ok) throw new Error(`Image read failed (${response.status})`);
        const blob = await response.blob();
        if (blob.size > 25 * 1024 * 1024) throw new Error('Image too large for preview');
        this.check(signal);
        return URL.createObjectURL(blob);
      })();
      this.documentUrls.set(path, pending);
      return pending;
    }
    // Tool/reasoning local mode retains its direct local-source behavior.
    // Only assistant media uses the message grant / workspace bridge policy.
    if (mode === 'local') return source;
    if (isVSCodeRuntime()) {
      if (video) throw new Error('Video bridge is unavailable');
      const url = await resolveWorkspaceMarkdownImageSource(source, directory, signal);
      this.check(signal);
      return url;
    }
    if (!sessionId || !messageId) throw new Error('Missing media owner');
    // All owned nodes register in effects before the first viewport callback or
    // microtask requests the batch. Embedded images count toward the same cap.
    await Promise.resolve();
    this.check(signal);
    const sources = [...this.sources.keys()].slice(0, 12);
    if (!sources.includes(source)) throw new Error('Message media limit');
    if (!this.batch || refresh) {
      if (refresh && this.refreshing) this.batch = this.refreshing;
      else {
        this.batch = prepareLocalMarkdownImages({ sources: sources.filter(isLocalMarkdownImageSource), directory, sessionId, messageId, signal });
        if (refresh) {
          const pending = this.batch;
          this.refreshing = pending;
          void pending.finally(() => { if (this.refreshing === pending) this.refreshing = undefined; }).catch(() => {});
        }
      }
    }
    const prepared = (await this.batch).get(source);
    this.check(signal);
    if (prepared?.status !== 'ready') throw new Error('Image is unavailable');
    if (!video && runtimeAssetsNeedHeaders()) {
      const url = await loadPreparedImageAsDataUrl(prepared, directory, signal);
      this.check(signal);
      return url;
    }
    await refreshRuntimeUrlAuthToken();
    this.check(signal);
    return getPreparedMarkdownImageUrl(prepared, directory);
  }

  /**
   * An image's own bytes, to save it from the viewer. A message's local image
   * is read whole through its grant; a document's, already read, and an
   * inline one come from their object or data URL. A remote image is not
   * ours to read.
   */
  async load(source: string): Promise<Blob> {
    const signal = this.controller.signal;
    const { mode, directory, sessionId, messageId } = this.options;
    if (mode === 'assistant' && !isVSCodeRuntime() && isLocalMarkdownImageSource(source)) {
      if (!sessionId || !messageId) throw new Error('Missing media owner');
      return loadMessageImageBlob({ source, directory, sessionId, messageId, signal });
    }
    const url = await this.resolve(source);
    if (!/^(?:data|blob):/i.test(url)) throw new Error('Image cannot be saved');
    return (await fetch(url, { signal })).blob();
  }

  addGallery(image: GalleryImage): () => void {
    const key = `${this.runtimeKey}\0${this.options.sessionId ?? ''}\0${this.options.messageId ?? ''}`;
    let entries = galleries.get(key);
    if (!entries) { entries = new Set(); galleries.set(key, entries); }
    entries.add(image);
    return () => { entries.delete(image); if (!entries.size) galleries.delete(key); };
  }

  async openGallery(element: HTMLElement, show: (content: ToolPopupContent) => void): Promise<void> {
    const signal = this.controller.signal;
    this.check(signal);
    const key = `${this.runtimeKey}\0${this.options.sessionId ?? ''}\0${this.options.messageId ?? ''}`;
    const entries = [...galleries.get(key) ?? []].filter((entry) => entry.element.isConnected)
      .sort((a, b) => a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1);
    const results = await Promise.allSettled(entries.map((entry) => entry.resolve()));
    this.check(signal);
    const gallery = entries.flatMap((entry, index) => {
      const result = results[index];
      return result?.status === 'fulfilled' ? [{ url: result.value, filename: entry.filename, element: entry.element, load: entry.load }] : [];
    });
    const index = gallery.findIndex((entry) => entry.element === element);
    const current = gallery[index];
    if (!current) return;
    show({ open: true, title: current.filename, content: '', metadata: { tool: 'markdown-image-preview', filename: current.filename }, image: { url: current.url, filename: current.filename, load: current.load, gallery: gallery.map(({ url, filename, load }) => ({ url, filename, load })), index } });
  }

  disconnect(): void {
    this.controller.abort();
    for (const pending of this.documentUrls.values()) void pending.then((url) => URL.revokeObjectURL(url), () => {});
    this.documentUrls.clear();
    this.batch = undefined;
    this.refreshing = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }
}

type MarkdownMediaContextValue = {
  owner: MarkdownMediaOwner;
  mode: MediaOwner['mode'];
  settled: boolean;
  documentAssets?: MarkdownDocumentAssets;
  onShowPopup?: (content: ToolPopupContent) => void;
};
export const MediaContext = React.createContext<MarkdownMediaContextValue | null>(null);
export const MarkdownMediaLinkContext = React.createContext(false);
export const useMarkdownMedia = () => React.useContext(MediaContext);
