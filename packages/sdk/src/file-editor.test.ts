import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { readHostMessage, type GuestMessage, type HostMessage } from './contract.ts';
import {
  GUEST_FILE_EDITOR_CONTENT_MAX,
  createFileSaveTracker,
  isFileEditorPattern,
  matchesFileEditorPattern,
} from './file-editor.ts';
import { connectHost, type HostFrame } from './host.ts';
import { parseManifestJson } from './parse.ts';
import { guestMessageSchema, hostMessageSchema, parseGuestMessage, parseHostMessage } from './protocol.ts';

const envelope = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION } as const;

describe('file-name patterns', () => {
  test('match the name case-insensitively with * and ?', () => {
    expect(matchesFileEditorPattern('Flow.excalidraw', '*.excalidraw')).toBe(true);
    expect(matchesFileEditorPattern('flow.EXCALIDRAW', '*.excalidraw')).toBe(true);
    expect(matchesFileEditorPattern('flow.excalidraw.md', '*.excalidraw.md')).toBe(true);
    expect(matchesFileEditorPattern('flow.excalidraw.md', '*.excalidraw')).toBe(false);
    expect(matchesFileEditorPattern('a1.note', '??.note')).toBe(true);
    expect(matchesFileEditorPattern('abc.note', '??.note')).toBe(false);
    expect(matchesFileEditorPattern('a(b).x+y', 'a(b).x+y')).toBe(true);
  });

  test('refuse paths, NUL, and wildcard-only patterns', () => {
    for (const pattern of ['', '*', '**', '?*', 'dir/*.md', 'a\\b', 'a\0b', 'x'.repeat(129)]) {
      expect(isFileEditorPattern(pattern)).toBe(false);
      expect(matchesFileEditorPattern('anything', pattern)).toBe(false);
    }
  });
});

describe('createFileSaveTracker', () => {
  test('edits during a write stay dirty; undo back to the saved version is clean', () => {
    const tracker = createFileSaveTracker('v0');
    expect(tracker.observe('v0')).toEqual({ edited: false, dirty: false });
    expect(tracker.observe('v1')).toEqual({ edited: true, dirty: true });
    // The host snapshots v1, then the user keeps drawing while it writes.
    expect(tracker.observe('v2')).toEqual({ edited: true, dirty: true });
    expect(tracker.markSaved('v1')).toBe(true);
    expect(tracker.observe('v1')).toEqual({ edited: true, dirty: false });
    expect(tracker.markSaved('v1')).toBe(false);
  });
});

describe('contributes.fileEditors', () => {
  const pageless = { id: 'excalidraw', name: 'Excalidraw', icon: 'pencil-ruler-2' };
  const editor = { id: 'canvas', title: 'Excalidraw', match: ['*.excalidraw', '*.excalidraw.md'], entry: 'editor/index.html' };
  // Manifests arrive as JSON bytes, so malformed shapes go through the same door.
  const parse = <Contributes,>(contributes: Contributes) => parseManifestJson(JSON.stringify({ apiVersion: 1, contributes }));

  test('a file editor alone is enough and may use granted capabilities', () => {
    const result = parse({ panel: pageless, fileEditors: [editor], capabilities: ['files'] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.manifest.contributes.fileEditors).toEqual([editor]);
  });

  test('a file-editor-only package cannot declare things that open or invoke another frame', () => {
    for (const extra of [{ page: { entry: 'page.html' } }, { attach: 'dialog' }, { commands: [{ name: 'draw' }] }]) {
      expect(parse({ panel: pageless, fileEditors: [editor], ...extra })).toMatchObject({ ok: false, code: 'invalid-panel' });
    }
    expect(parse({ panel: { ...pageless, entry: 'panel/index.html' }, fileEditors: [editor], commands: [{ name: 'draw' }] }))
      .toMatchObject({ ok: true });
  });

  test('refuses bad ids, titles, patterns, entries, duplicates, and empty lists', () => {
    for (const fileEditors of [
      [],
      [{ ...editor, id: 'Canvas' }],
      [{ ...editor, title: '' }],
      [{ ...editor, title: 'x'.repeat(61) }],
      [{ ...editor, match: [] }],
      [{ ...editor, match: ['*'] }],
      [{ ...editor, match: ['drawings/*.excalidraw'] }],
      [{ ...editor, entry: 'editor/main.js' }],
      [{ ...editor, entry: '../editor.html' }],
      [editor, editor],
    ]) {
      expect(parse({ panel: pageless, fileEditors })).toMatchObject({ ok: false, code: 'invalid-file-editors' });
    }
  });
});

describe('file editor wire messages', () => {
  test('host pushes parse and reach the guest reader', () => {
    const open = { ...envelope, type: 'file-open', payload: { path: '/repo/a.excalidraw', name: 'a.excalidraw', content: '{}', readOnly: false, encoding: 'text' } } as const;
    const snapshot = { ...envelope, type: 'file-snapshot', id: 'fs-1', payload: { purpose: 'save' } } as const;
    const saved = { ...envelope, type: 'file-saved', payload: { version: 'v1' } } as const;
    for (const message of [open, snapshot, saved]) {
      expect(parseHostMessage(message)).toEqual(message);
      expect(readHostMessage(message)).toEqual(message);
    }
    expect(hostMessageSchema.safeParse({ ...snapshot, payload: { purpose: 'export' } }).success).toBe(false);
    expect(parseHostMessage({ ...open, payload: { ...open.payload, content: 'x'.repeat(GUEST_FILE_EDITOR_CONTENT_MAX + 1) } })).toBeNull();
  });

  test('binary files travel as bytes, within the same size limit', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const open = { ...envelope, type: 'file-open', payload: { path: 'a.docx', name: 'a.docx', readOnly: false, encoding: 'binary', bytes } } as const;
    expect(parseHostMessage(open)).toEqual(open);
    expect(hostMessageSchema.safeParse({ ...open, payload: { ...open.payload, bytes: 'UEsDBA==' } }).success).toBe(false);
    expect(hostMessageSchema.safeParse({ ...open, payload: { ...open.payload, bytes: new Uint8Array(GUEST_FILE_EDITOR_CONTENT_MAX + 1) } }).success).toBe(false);
    const answer: GuestMessage = { ...envelope, type: 'file-snapshot-result', id: 'fs-1', payload: { snapshot: { bytes, version: 'v1' } } };
    expect(parseGuestMessage(answer)).toEqual(answer);
  });

  test('guest messages parse and refuse oversized snapshots', () => {
    const messages: GuestMessage[] = [
      { ...envelope, type: 'file-change', payload: { dirty: true, edited: true } },
      { ...envelope, type: 'file-save' },
      { ...envelope, type: 'file-unsupported' },
      { ...envelope, type: 'file-snapshot-result', id: 'fs-1', payload: { snapshot: { content: '{}', version: 'v1' } } },
      { ...envelope, type: 'file-snapshot-result', id: 'fs-2', payload: { error: 'Scene is not ready.' } },
    ];
    for (const message of messages) expect(parseGuestMessage(message)).toEqual(message);
    expect(parseGuestMessage({ ...envelope, type: 'file-snapshot-result', id: 'fs-3',
      payload: { snapshot: { content: 'x'.repeat(GUEST_FILE_EDITOR_CONTENT_MAX + 1), version: 'v' } } })).toBeNull();
    expect(guestMessageSchema.safeParse({ ...envelope, type: 'file-change', payload: { dirty: 'yes', edited: true } }).success).toBe(false);
  });
});

describe('connectHost file editor', () => {
  type Listener = (event: Event) => void;
  const createFrame = () => {
    const listeners = new Map<string, Set<Listener>>();
    const posted: GuestMessage[] = [];
    const frame: HostFrame & { dispatch: (event: Event) => void } = {
      parent: { postMessage: (message: GuestMessage) => { posted.push(message); } },
      addEventListener: (type: string, listener: Listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(listener);
      },
      removeEventListener: (type: string, listener: Listener) => {
        listeners.get(type)?.delete(listener);
      },
      dispatch: (event: Event) => {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      },
    };
    return { frame, posted, listenerCount: (type: string) => listeners.get(type)?.size ?? 0 };
  };
  const push = (frame: { dispatch: (event: Event) => void }, data: HostMessage) => frame.dispatch(new MessageEvent('message', { data }));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const file = { path: '/repo/a.excalidraw', name: 'a.excalidraw', content: '{"elements":[]}', readOnly: false, encoding: 'text' } as const;

  test('replays the open file, answers snapshots, and reports saves', async () => {
    const { frame, posted } = createFrame();
    const host = connectHost({ target: frame, acceptSource: () => true });

    push(frame, { ...envelope, type: 'file-snapshot', id: 'fs-0', payload: { purpose: 'save' } });
    await flush();
    expect(posted.at(-1)).toMatchObject({ type: 'file-snapshot-result', id: 'fs-0', payload: { error: 'This extension does not edit files.' } });

    push(frame, { ...envelope, type: 'file-open', payload: file });
    const opened: string[] = [];
    host.onFileOpen((document) => opened.push(document.content));
    expect(opened).toEqual([file.content]);
    // hello and iframe load both push the file; the repeat is not a reload.
    push(frame, { ...envelope, type: 'file-open', payload: { ...file } });
    push(frame, { ...envelope, type: 'file-open', payload: { ...file, content: '{"elements":[2]}' } });
    expect(opened).toEqual([file.content, '{"elements":[2]}']);

    const purposes: string[] = [];
    host.onFileSnapshot((purpose) => {
      purposes.push(purpose);
      if (purpose === 'handoff') throw new Error('Scene is not ready.');
      return { content: '{"elements":[1]}', version: 'v2' };
    });
    push(frame, { ...envelope, type: 'file-snapshot', id: 'fs-1', payload: { purpose: 'save' } });
    push(frame, { ...envelope, type: 'file-snapshot', id: 'fs-2', payload: { purpose: 'handoff' } });
    await flush();
    expect(purposes).toEqual(['save', 'handoff']);
    const answers = posted.filter((message) => message.type === 'file-snapshot-result');
    expect(answers[1]).toMatchObject({ id: 'fs-1', payload: { snapshot: { content: '{"elements":[1]}', version: 'v2' } } });
    expect(answers[2]).toMatchObject({ id: 'fs-2', payload: { error: 'Scene is not ready.' } });

    const saved: string[] = [];
    host.onFileSaved((version) => saved.push(version));
    push(frame, { ...envelope, type: 'file-saved', payload: { version: 'v2' } });
    expect(saved).toEqual(['v2']);

    host.reportFileChange({ dirty: true, edited: true });
    host.reportFileUnsupported();
    expect(posted.slice(-2)).toEqual([
      { ...envelope, type: 'file-change', payload: { dirty: true, edited: true } },
      { ...envelope, type: 'file-unsupported' },
    ]);
    host.dispose();
  });

  test('binary files: the same bytes pushed twice open once, and byte snapshots pass through', async () => {
    const { frame, posted } = createFrame();
    const host = connectHost({ target: frame, acceptSource: () => true });
    const binary = (bytes: number[]) => ({ path: 'a.xlsx', name: 'a.xlsx', readOnly: false, encoding: 'binary' as const, bytes: new Uint8Array(bytes) });
    const sizes: number[] = [];
    host.onFileOpen((document) => { if (document.encoding === 'binary') sizes.push(document.bytes.byteLength); });
    push(frame, { ...envelope, type: 'file-open', payload: binary([1, 2, 3]) });
    push(frame, { ...envelope, type: 'file-open', payload: binary([1, 2, 3]) });
    push(frame, { ...envelope, type: 'file-open', payload: binary([1, 2, 4]) });
    expect(sizes).toEqual([3, 3]);

    host.onFileSnapshot(() => ({ bytes: new Uint8Array([9, 9]), version: 'v9' }));
    push(frame, { ...envelope, type: 'file-snapshot', id: 'fs-1', payload: { purpose: 'save' } });
    await flush();
    const answer = posted.at(-1);
    expect(answer).toMatchObject({ type: 'file-snapshot-result', id: 'fs-1', payload: { snapshot: { version: 'v9' } } });
    if (answer?.type === 'file-snapshot-result' && 'snapshot' in answer.payload && 'bytes' in answer.payload.snapshot) {
      expect([...answer.payload.snapshot.bytes]).toEqual([9, 9]);
    } else {
      throw new Error('expected a byte snapshot');
    }
    host.dispose();
  });

  test('refuses a snapshot over the content limit instead of letting the host drop it', async () => {
    const { frame, posted } = createFrame();
    const host = connectHost({ target: frame, acceptSource: () => true });
    host.onFileSnapshot(() => ({ content: 'x'.repeat(GUEST_FILE_EDITOR_CONTENT_MAX + 1), version: 'v' }));
    push(frame, { ...envelope, type: 'file-snapshot', id: 'fs-1', payload: { purpose: 'save' } });
    await flush();
    expect(posted.at(-1)).toMatchObject({ id: 'fs-1', payload: { error: `The file is over ${GUEST_FILE_EDITOR_CONTENT_MAX} characters.` } });
    host.dispose();
  });

  test('Cmd/Ctrl+S inside the frame asks the host to save once a file editor registers', () => {
    const { frame, posted, listenerCount } = createFrame();
    const host = connectHost({ target: frame, acceptSource: () => true });
    const press = (keys: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), {
        metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...keys,
      });
      frame.dispatch(event);
      return event;
    };
    press({ key: 's', metaKey: true });
    expect(posted.some((message) => message.type === 'file-save')).toBe(false);

    host.onFileOpen(() => {});
    const save = press({ key: 's', metaKey: true });
    press({ key: 'S', ctrlKey: true });
    press({ key: 's', metaKey: true, shiftKey: true });
    press({ key: 's' });
    expect(save.defaultPrevented).toBe(true);
    expect(posted.filter((message) => message.type === 'file-save')).toHaveLength(2);

    host.dispose();
    expect(listenerCount('keydown')).toBe(0);
  });
});
