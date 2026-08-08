import { describe, expect, test } from 'bun:test';
import {
  allocateSseStreamId,
  buildSseHeaders,
  abortAllSseStreams,
  stopWebviewSseProxy,
} from './webviewSseHelpers.ts';
import { isSameActiveEditorFilePayload } from './activeEditorFileTypes.ts';
import { findMoveToRightSidebarCommandId, isCursorLikeHost } from './sidebarPlacement.ts';

describe('webview SSE helpers', () => {
  test('allocates stream ids and preserves valid requested ids', () => {
    let counter = 0;
    expect(allocateSseStreamId(undefined, () => ++counter)).toMatch(/^sse_1_\d+$/);
    expect(allocateSseStreamId('sse_webview_1_2', () => ++counter)).toBe('sse_webview_1_2');
    expect(allocateSseStreamId('not-a-valid-id', () => ++counter)).toMatch(/^sse_2_\d+$/);
  });

  test('merges SSE headers and aborts/stops streams', () => {
    expect(buildSseHeaders({ Authorization: 'Bearer x' })).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer x',
    });

    const streams = new Map();
    const a = new AbortController();
    const b = new AbortController();
    streams.set('a', a);
    streams.set('b', b);
    abortAllSseStreams(streams);
    expect(streams.size).toBe(0);
    expect(a.signal.aborted && b.signal.aborted).toBe(true);

    const single = new Map();
    const controller = new AbortController();
    single.set('sse_1', controller);
    const response = stopWebviewSseProxy(
      { id: '1', type: 'api:sse:stop', payload: { streamId: 'sse_1' } },
      single,
    );
    expect(response.success).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(single.size).toBe(0);
  });
});

describe('active editor payload equality', () => {
  test('compares file metadata and selection', () => {
    const base = {
      filePath: '/tmp/a.ts',
      fileName: 'a.ts',
      relativePath: 'a.ts',
      fileSize: 10,
      selection: { startLine: 1, endLine: 2, text: 'hi' },
    };
    expect(isSameActiveEditorFilePayload(base, { ...base })).toBe(true);
    expect(isSameActiveEditorFilePayload(base, { ...base, fileSize: 11 })).toBe(false);
    expect(isSameActiveEditorFilePayload(base, null)).toBe(false);
  });
});

describe('sidebar placement helpers', () => {
  test('detects Cursor-like hosts and preferred move commands', () => {
    expect(isCursorLikeHost('Cursor')).toBe(true);
    expect(isCursorLikeHost('Visual Studio Code')).toBe(false);
    expect(
      findMoveToRightSidebarCommandId(['workbench.action.moveViewToSecondarySideBar']),
    ).toBe('workbench.action.moveViewToSecondarySideBar');
    expect(
      findMoveToRightSidebarCommandId(['workbench.action.moveSomethingViewToAuxiliaryBar']),
    ).toBe('workbench.action.moveSomethingViewToAuxiliaryBar');
    expect(findMoveToRightSidebarCommandId(['unrelated.command'])).toBe(null);
  });
});
