import { connectHost, createFileSaveTracker } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountEmpty } from '@openchamber/sdk/ui';

import { checklistVersion, insertItem, parseChecklist, serializeChecklist, type ChecklistLine } from './checklist.ts';

// A file editor never reads or writes the file. The host hands it the text
// (`onFileOpen`), asks for the edited text when it saves or moves it to its
// source view (`onFileSnapshot`), and says which snapshot reached the disk
// (`onFileSaved`). The editor reports its state (`reportFileChange`), and
// Cmd/Ctrl+S inside the frame already asks the host to save.

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');

const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; height: 100%; background: var(--oc-bg); color: var(--oc-fg); font-family: var(--oc-font); font-size: 13px; }
  #root { box-sizing: border-box; height: 100%; overflow: auto; padding: 16px 20px; }
  .note { margin: 2px 0; color: var(--oc-muted); white-space: pre-wrap; min-height: 1em; }
  .item { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
  .item input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--oc-primary); }
  .item input[type="text"] { flex: 1; min-width: 0; border: 1px solid transparent; border-radius: var(--oc-radius); padding: 4px 6px;
    background: transparent; color: inherit; font: inherit; }
  .item input[type="text"]:hover { border-color: var(--oc-border); }
  .item input[type="text"]:focus { outline: none; border-color: var(--oc-focus); background: var(--oc-elevated); }
  .item.done input[type="text"] { color: var(--oc-muted); text-decoration: line-through; }
  .item .remove { visibility: hidden; }
  .item:hover .remove, .item:focus-within .remove { visibility: visible; }
  .actions { margin-top: 12px; }
`;
document.head.append(style);

host.onReady((context) => applyHostReady(context, document.documentElement));

let lines: ChecklistLine[] = [];
let readOnly = false;
let tracker = createFileSaveTracker(null);

const content = (): string => serializeChecklist(lines);

// Typing changes the text only; structural edits redraw. Both report.
const reportChange = (): void => {
  host.reportFileChange(tracker.observe(checklistVersion(content())));
};

const render = (): void => {
  root.replaceChildren();
  if (!lines.some((line) => line.kind === 'item') && readOnly) {
    mountEmpty(root, { title: 'No items', body: 'This checklist is empty.' });
    return;
  }
  lines.forEach((line, index) => {
    if (line.kind === 'text') {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = line.text;
      root.append(note);
      return;
    }
    const row = document.createElement('div');
    row.className = line.done ? 'item done' : 'item';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = line.done;
    check.disabled = readOnly;
    check.addEventListener('change', () => {
      line.done = check.checked;
      row.className = line.done ? 'item done' : 'item';
      reportChange();
    });
    const text = document.createElement('input');
    text.type = 'text';
    text.value = line.text;
    text.readOnly = readOnly;
    text.setAttribute('aria-label', 'Item');
    text.addEventListener('input', () => {
      line.text = text.value;
      reportChange();
    });
    row.append(check, text);
    if (!readOnly) {
      const remove = document.createElement('span');
      remove.className = 'remove';
      mountButton(remove, {
        label: 'Remove', variant: 'ghost', size: 'xs',
        onClick: () => {
          lines = lines.filter((_, lineIndex) => lineIndex !== index);
          reportChange();
          render();
        },
      });
      row.append(remove);
    }
    root.append(row);
  });
  if (readOnly) return;
  const actions = document.createElement('div');
  actions.className = 'actions';
  mountButton(actions, {
    label: 'Add item', variant: 'secondary', size: 'sm',
    onClick: () => {
      lines = insertItem(lines, '');
      reportChange();
      render();
      const inputs = root.querySelectorAll<HTMLInputElement>('.item input[type="text"]');
      inputs.item(inputs.length - 1)?.focus();
    },
  });
  root.append(actions);
};

host.onFileOpen((file) => {
  // A text editor (the default `content`) is always handed text.
  if (file.encoding !== 'text') {
    host.reportFileUnsupported();
    return;
  }
  lines = parseChecklist(file.content);
  readOnly = file.readOnly;
  // The baseline is the text this editor would write back, so opening a file
  // that spells `[X]` does not count as an edit.
  tracker = createFileSaveTracker(checklistVersion(content()));
  render();
});

host.onFileSnapshot(() => {
  const text = content();
  return { content: text, version: checklistVersion(text) };
});

// Edits made while the host was writing leave the file dirty.
host.onFileSaved((version) => {
  host.reportFileChange({ dirty: tracker.markSaved(version), edited: false });
});
