import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';

import type { RelayTunnelWebSocket } from './tunnel-client';

const socketEventSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('open') }),
  z.object({ id: z.string(), type: z.literal('message'), data: z.string(), binary: z.boolean() }),
  z.object({ id: z.string(), type: z.literal('error') }),
  z.object({ id: z.string(), type: z.literal('close'), code: z.number().int(), reason: z.string() }),
]);

interface NativeSocketOptions {
  id: string;
  url: string;
  headers: Record<string, string>;
  protocols: string[];
}

interface NativeSocketPlugin {
  open(options: NativeSocketOptions): Promise<void>;
  send(options: { id: string; data: string; binary: boolean }): Promise<void>;
  close(options: { id: string; code: number; reason: string }): Promise<void>;
  addListener(name: 'socketEvent', listener: (event: z.input<typeof socketEventSchema>) => void): Promise<PluginListenerHandle>;
}

const nativeSocket = registerPlugin<NativeSocketPlugin>('RuntimeWebSocket');

export const nativeWebSocketHeaders = (
  url: string, baseUrl: string, headers: Record<string, string>,
): Record<string, string> | null => {
  const target = new URL(url);
  const base = new URL(baseUrl);
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return null;
  if (target.username || target.password) return null;
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  return target.origin === base.origin && target.pathname.startsWith(base.pathname)
    ? { ...headers } : null;
};

// The native bridge carries binary frames as base64; consumers receive the same
// ArrayBuffer shape as the private relay. Copy views using their exact byte range.
const encodeBinary = (data: ArrayBuffer | ArrayBufferView): string => {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
};

export const openNativeWebSocket = (
  url: string,
  headers: Record<string, string>,
  protocols: string[] = [],
  plugin: NativeSocketPlugin = nativeSocket,
): RelayTunnelWebSocket => {
  if (new Set(protocols).size !== protocols.length || protocols.some((value) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value))) {
    throw new SyntaxError('Invalid WebSocket protocols');
  }
  const id = crypto.randomUUID();
  let state = 0;
  let listener: PluginListenerHandle | null = null;
  let opening = false;
  let writes = Promise.resolve();
  let queuedBytes = 0;

  const finish = (code: number, reason: string): void => {
    if (state === 3) return;
    state = 3;
    void listener?.remove().catch(() => undefined);
    listener = null;
    globalThis.window?.removeEventListener('pagehide', unload);
    socket.onclose?.({ code, reason });
  };
  const fail = (): void => {
    if (state === 3) return;
    socket.onerror?.();
    finish(1006, '');
    if (opening) void plugin.close({ id, code: 1000, reason: '' }).catch(() => undefined);
  };

  const socket: RelayTunnelWebSocket = {
    get readyState() { return state; },
    binaryType: 'arraybuffer',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (state === 0) throw new DOMException('WebSocket is connecting', 'InvalidStateError');
      if (state !== 1) return;
      const binary = data instanceof ArrayBuffer || ArrayBuffer.isView(data);
      const size = binary ? data.byteLength : new TextEncoder().encode(data).byteLength;
      queuedBytes += size;
      if (queuedBytes > 16 * 1024 * 1024) { fail(); return; }
      const payload = binary ? encodeBinary(data) : data;
      writes = writes.then(async () => {
        if (state === 3) return;
        await plugin.send({ id, data: payload, binary });
      }).catch(fail).finally(() => { queuedBytes -= size; });
    },
    close(code = 1000, reason = '') {
      if (code !== 1000 && (code < 3000 || code > 4999 || !Number.isInteger(code))) {
        throw new DOMException('Invalid close code', 'InvalidAccessError');
      }
      if (new TextEncoder().encode(reason).byteLength > 123) throw new SyntaxError('Close reason is too long');
      if (state >= 2) return;
      state = 2;
      if (!opening) { finish(1000, ''); return; }
      writes = writes.then(() => plugin.close({ id, code, reason })).catch(fail);
    },
  };
  const unload = (): void => socket.close();
  globalThis.window?.addEventListener('pagehide', unload);

  void plugin.addListener('socketEvent', (raw) => {
    const parsed = socketEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id || state === 3) return;
    const event = parsed.data;
    switch (event.type) {
      case 'open':
        if (state !== 0) return;
        state = 1;
        socket.onopen?.();
        break;
      case 'message': {
        if (state !== 1) return;
        let data: string | ArrayBuffer = event.data;
        if (event.binary) {
          try { data = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0)).buffer; }
          catch { fail(); return; }
        }
        socket.onmessage?.({ data });
        break;
      }
      case 'error': fail(); break;
      case 'close': finish(event.code, event.reason); break;
    }
  }).then(async (handle) => {
    if (state === 3) { await handle.remove(); return; }
    listener = handle;
    opening = true;
    // Keep open ahead of close and sends even when the bridge resolves slowly.
    writes = plugin.open({ id, url, headers: { ...headers }, protocols });
    await writes;
  }).catch(fail);
  return socket;
};
