/**
 * The save path's contract with the platform.
 *
 * The native save dialog shows a file-type filter. A document saved as HTML
 * is not a Markdown file, and the dialog that says otherwise misleads the
 * person saving it. The export therefore names the format it wrote, and the
 * platform offers that type of file.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/** The command the save path invoked, and the arguments it sent. */
type DesktopCall = {
  command: string;
  args: Record<string, string | number | boolean | null | undefined>;
};

const calls: DesktopCall[] = [];

const desktop = await import('@/lib/desktop');

mock.module('@/lib/desktop', () => ({
  ...desktop,
  isVSCodeRuntime: () => false,
  openDesktopPath: async () => false,
  revealDesktopPath: async () => false,
  hasDesktopInvoke: () => true,
  isDesktopLocalOriginActive: () => true,
  invokeDesktop: async (command: string, args: Record<string, string | number | boolean | null | undefined> = {}) => {
    calls.push({ command, args });
    return '/tmp/session-export';
  },
}));

const { saveAsMarkdownDesktop } = await import('@/lib/exportSession');

beforeEach(() => {
  calls.length = 0;
});

afterAll(() => {
  calls.length = 0;
});

describe('the export save path', () => {
  test('the desktop save dialog is told which type of file is being saved', async () => {
    await saveAsMarkdownDesktop('<html></html>', 'session.html', 'html');

    const call = calls.find((entry) => entry.command === 'desktop_save_markdown_file');
    expect(call?.args.filter).toBe('html');
  });

  test('a JSON export asks for a JSON file', async () => {
    await saveAsMarkdownDesktop('{}', 'session.json', 'json');

    const call = calls.find((entry) => entry.command === 'desktop_save_markdown_file');
    expect(call?.args.filter).toBe('json');
  });

  test('a Markdown export asks for a Markdown file', async () => {
    await saveAsMarkdownDesktop('# Session', 'session.md', 'markdown');

    const call = calls.find((entry) => entry.command === 'desktop_save_markdown_file');
    expect(call?.args.filter).toBe('markdown');
  });
});
