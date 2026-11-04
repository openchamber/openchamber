import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { adoptRelayTunnel, deactivateRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { MarkdownMediaOwner } from '@/components/chat/markdown/markdown-media-context';
import { useRawAssetUrl } from './useRawAssetUrl';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

test('over the relay, Files media and prepared chat images are read through the tunnel', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  class Reader {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((bytes) => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
        this.onload?.();
      });
    }
  }
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, CustomEvent: dom.CustomEvent, FileReader: Reader, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const paths: string[] = [];
  const tunnel: RelayTunnelClient = {
    fetch: async (input) => {
      const url = new URL(String(input), 'http://tunnel');
      paths.push(url.pathname);
      if (url.pathname.endsWith('/markdown-image-grants')) return Response.json({ results: [{ source: '/tmp/qr.png', status: 'ready', path: '/tmp/qr.png', outsideFileGrant: 'grant' }] });
      expect(url.pathname).toBe('/api/fs/raw');
      if (url.searchParams.get('path') === '/tmp/qr.png') {
        expect(url.searchParams.get('outsideFileGrant')).toBe('grant');
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('%PDF', { headers: { 'Content-Type': 'application/pdf' } });
    },
    openWebSocket() { throw new Error('unused'); },
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => undefined,
    retry: () => undefined,
    close: () => undefined,
  };
  adoptRelayTunnel({ relayUrl: 'wss://relay.example/ws', serverId: 'srv_test', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }, tunnel);
  let latest: ReturnType<typeof useRawAssetUrl> | undefined;
  const reportError = () => undefined;
  const Probe = () => {
    latest = useRawAssetUrl({ path: '/repo/book.pdf', runtime: 'relay', directory: '/repo', revision: '0', outsideWorkspace: false }, reportError, 'read failed');
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const chat = new MarkdownMediaOwner({ mode: 'assistant', directory: '/repo', sessionId: 'ses_media', messageId: 'msg_media' });
  try {
    await act(async () => root.render(<Probe />));
    for (let i = 0; i < 100 && latest?.loading; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(latest?.src.startsWith('blob:')).toBe(true);
    chat.register('/tmp/qr.png');
    expect(await chat.resolve('/tmp/qr.png')).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(paths).toContain('/api/openchamber/sessions/ses_media/markdown-image-grants');
  } finally {
    chat.dispose();
    await act(async () => root.unmount());
    deactivateRelayTunnel();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
