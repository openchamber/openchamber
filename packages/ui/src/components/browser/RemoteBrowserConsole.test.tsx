import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import type { SurfaceConsoleEntry } from '@/lib/browser/remoteSurfaceInspectorProtocol';
import { RemoteBrowserConsole } from './RemoteBrowserConsole';
import { fillTextarea, inspectorFixture, mountInspectorView } from './RemoteBrowserInspector.test-support';

const mountConsole = async () => {
  const fixture = inspectorFixture();
  await fixture.start();
  const view = await mountInspectorView(<RemoteBrowserConsole inspector={fixture.inspector} entries={[]} captureId="capture-1" filter="" active clearRevision={0} />);
  const input = view.host.querySelector('textarea');
  if (!input) throw new Error('Expected JavaScript editor');
  const result = async (text: string, isError = false) => {
    const command = fixture.commands.filter((entry) => entry.type === 'inspectorEvaluate').at(-1);
    if (!command) throw new Error('Expected evaluation command');
    await act(async () => fixture.inspector.receive(JSON.stringify({ ...command, type: 'inspectorEvaluated', text, isError, truncated: false })));
  };
  return { ...fixture, ...view, input, result };
};

const pageLog = (id: string, timestamp = 0): SurfaceConsoleEntry => ({
  id, text: id, timestamp, level: 'log', source: '', line: null, truncated: false,
});

const transcriptText = (host: HTMLDivElement) => Array.from(host.querySelectorAll('[role="log"] pre')).map((node) => node.textContent);

describe('remote browser console', () => {
  test('keeps asynchronous page logs after submitted commands even with remote clock skew and delayed results', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, 'first()');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    await fixture.result('first result');
    const entries = [pageLog('page after first', Date.now() - 60_000)];
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={entries} captureId="capture-1" filter="" active clearRevision={0} />);
    expect(transcriptText(fixture.host)).toEqual(['> first()', 'first result', 'page after first']);
    await fillTextarea(fixture.input, 'second()');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    const laterEntries = [...entries, pageLog('page while second is running', Date.now() - 120_000)];
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={laterEntries} captureId="capture-1" filter="" active clearRevision={0} />);
    expect(transcriptText(fixture.host)).toEqual(['> first()', 'first result', 'page after first', '> second()', 'page while second is running']);
    await fixture.result('second result');
    expect(transcriptText(fixture.host)).toEqual(['> first()', 'first result', 'page after first', '> second()', 'second result', 'page while second is running']);
  });

  test('keeps submission order after a shared or evicted page anchor and filters after merging', async () => {
    const fixture = await mountConsole();
    const entries = [pageLog('anchor')];
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={entries} captureId="capture-1" filter="" active clearRevision={0} />);
    for (const expression of ['match first()', 'match second()']) {
      await fillTextarea(fixture.input, expression);
      await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
      await fixture.result('undefined');
    }
    const currentEntries = [...entries, pageLog('match later page')];
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={currentEntries} captureId="capture-1" filter="match" active clearRevision={0} />);
    expect(transcriptText(fixture.host)).toEqual(['> match first()', 'undefined', '> match second()', 'undefined', 'match later page']);
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={currentEntries.slice(1)} captureId="capture-1" filter="" active clearRevision={0} />);
    expect(transcriptText(fixture.host)).toEqual(['> match first()', 'undefined', '> match second()', 'undefined', 'match later page']);
  });

  test('runs multiline JavaScript once with Ctrl+Enter and renders returned HTML as text', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, 'const n = 1;\nn + 1');
    await act(async () => {
      fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true }));
      fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true }));
    });
    const commands = fixture.commands.filter((entry) => entry.type === 'inspectorEvaluate');
    expect(commands.length).toBe(1);
    if (commands[0]?.type !== 'inspectorEvaluate') throw new Error('Expected evaluation');
    expect(commands[0].expression).toBe('const n = 1;\nn + 1');
    await fixture.result('<img src=x onerror=pageControlled()>');
    expect(fixture.host.querySelector('img')).toBeNull();
    expect(fixture.host.textContent).toContain('<img src=x onerror=pageControlled()>');
  });

  test('leaves Enter as a newline and supports Cmd+Enter', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, '42');
    const enter = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' });
    await act(async () => { fixture.input.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(false);
    expect(fixture.commands.some((command) => command.type === 'inspectorEvaluate')).toBe(false);
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', metaKey: true })));
    expect(fixture.commands.at(-1)?.type).toBe('inspectorEvaluate');
    await fixture.result('42');
  });

  test('restores command history and preserves the draft when navigating back to it', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, 'first()');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    await fixture.result('undefined');
    await fillTextarea(fixture.input, 'unfinished draft');
    const previous = fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Previous command"]');
    const next = fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Next command"]');
    if (!previous || !next) throw new Error('Expected command history controls');
    await act(async () => previous.click());
    expect(fixture.input.value).toBe('first()');
    await act(async () => next.click());
    expect(fixture.input.value).toBe('unfinished draft');
  });

  test('displays page exceptions as results and explicit evaluation failures as localized feedback', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, 'throw new Error("page")');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    await fixture.result('Error: page', true);
    expect(fixture.host.querySelector('[aria-label="JavaScript result"]')?.textContent).toBe('Error: page');
    await fillTextarea(fixture.input, 'await pending');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    const command = fixture.commands.at(-1);
    if (!command) throw new Error('Expected evaluation');
    await act(async () => fixture.inspector.receive(JSON.stringify({ ...command, type: 'inspectorError', code: 'EVALUATION_TIMEOUT', message: 'fixed server error' })));
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toBe('JavaScript timed out. The page may still be running it.');
  });

  test('discards a delayed result and history when the capture changes', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, 'pending()');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={[]} captureId="capture-2" filter="" active clearRevision={0} />);
    await fixture.result('old result');
    expect(fixture.host.textContent).not.toContain('old result');
    expect(fixture.host.textContent).not.toContain('pending()');
    expect(fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Previous command"]')?.disabled).toBe(true);
  });

  test('clears output while preserving history and keeps delayed results cleared', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, 'pending()');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={[]} captureId="capture-1" filter="" active clearRevision={1} />);
    await fixture.result('cleared result');
    expect(fixture.host.textContent).not.toContain('cleared result');
    expect(fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Previous command"]')?.disabled).toBe(false);
  });

  test('keeps history while Network is visible and rejects oversized input before evaluation', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, 'keep()');
    await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    await fixture.result('kept');
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={[]} captureId="capture-1" filter="" active={false} clearRevision={0} />);
    expect(fixture.host.querySelector('textarea')).toBeNull();
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={[]} captureId="capture-1" filter="" active clearRevision={0} />);
    const input = fixture.host.querySelector('textarea');
    if (!input) throw new Error('Expected console editor');
    expect(fixture.host.textContent).toContain('kept');
    await fillTextarea(input, 'x'.repeat(16_001));
    const count = fixture.commands.length;
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
    expect(fixture.commands.length).toBe(count);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  test('bounds command output and history to the latest fifty executions', async () => {
    const fixture = await mountConsole();
    for (let index = 0; index <= 50; index += 1) {
      await fillTextarea(fixture.input, String(index));
      await act(async () => fixture.input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })));
      await fixture.result(String(index));
    }
    expect(fixture.host.querySelectorAll('[aria-label="Executed JavaScript"]').length).toBe(50);
    const pageEntries = Array.from({ length: 300 }, (_, index) => pageLog(`page ${index}`));
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={pageEntries} captureId="capture-1" filter="" active clearRevision={0} />);
    expect(fixture.host.querySelector('[role="log"]')?.children.length).toBe(350);
    expect(transcriptText(fixture.host).at(-1)).toBe('page 299');
    const previous = fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Previous command"]');
    if (!previous) throw new Error('Expected previous command');
    for (let index = 0; index < 55; index += 1) await act(async () => previous.click());
    expect(fixture.input.value).toBe('1');
    expect(previous.disabled).toBe(true);
  });

  test('keeps IME composition local and disables execution without a capture', async () => {
    const fixture = await mountConsole();
    await fillTextarea(fixture.input, '日本語');
    const enter = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true, isComposing: true });
    await act(async () => { fixture.input.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(false);
    expect(fixture.commands.some((command) => command.type === 'inspectorEvaluate')).toBe(false);
    await fixture.render(<RemoteBrowserConsole inspector={fixture.inspector} entries={[]} captureId={null} filter="" active clearRevision={0} />);
    expect(fixture.input.disabled).toBe(true);
    const run = Array.from(fixture.host.querySelectorAll('button')).find((button) => button.textContent === 'Run');
    expect(run?.disabled).toBe(true);
  });
});
