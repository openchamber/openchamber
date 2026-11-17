import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

import { formatSelectionMarkdown } from './selectionMarkdown';
import { saveSelectionMarkdown } from './selectionExport';
import type { SelectableUnit } from './selectableUnits';

const saveFileState: { impl: (file: File) => Promise<void>; calls: File[] } = {
  impl: async () => {},
  calls: [],
};
mock.module('../message/parts/saveFile', () => ({
  saveFile: (file: File) => {
    saveFileState.calls.push(file);
    return saveFileState.impl(file);
  },
}));

const setupDom = () => {
  const dom = new Window({ url: 'http://localhost' });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.document });
};

afterEach(() => {
  saveFileState.impl = async () => {};
  saveFileState.calls = [];
});

const units: SelectableUnit[] = [
  { kind: 'prompt', key: 'p1', messageId: 'msg-1', text: 'Hello' },
  { kind: 'answer', key: 'a1', messageId: 'msg-2', segments: ['Hi **there**'], providerID: null, modelID: null },
];

test('saveSelectionMarkdown saves the selection markdown as a .md file', async () => {
  setupDom();
  await saveSelectionMarkdown(units);
  expect(saveFileState.calls).toHaveLength(1);
  const file = saveFileState.calls[0]!;
  expect(file.name).toBe('messages-msg-1.md');
  expect(file.type).toBe('text/markdown');
  expect(await file.text()).toBe(formatSelectionMarkdown(units));
});

test('saveSelectionMarkdown falls back to a generic name without units', async () => {
  setupDom();
  await saveSelectionMarkdown([]);
  expect(saveFileState.calls).toHaveLength(1);
  expect(saveFileState.calls[0]!.name).toBe('messages-selection.md');
});
