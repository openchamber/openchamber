import { afterAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// The dialog renders through a portal, which the test does not need: the
// choices it holds are what the test reads.
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

const { I18nProvider } = await import('@/lib/i18n');
const { ExportSessionDialog } = await import('./ExportSessionDialog');

afterAll(() => {
  browser.close();
});

type Choice = { format: string; mode: string; includeSubagents: boolean };

const render = async (options: {
  includeSubagents?: boolean;
  descendantCount?: number;
  sessionListComplete?: boolean;
  onConfirm?: (choice: Choice) => void;
}): Promise<{
  container: HTMLElement;
  text: () => string;
  click: (label: string) => void;
  toggle: () => void;
  chosen: Choice[];
}> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const chosen: Choice[] = [];

  const Harness = () => {
    const [includeSubagents, setIncludeSubagents] = React.useState(options.includeSubagents ?? true);
    const [format, setFormat] = React.useState<'markdown' | 'html' | 'json'>('markdown');
    const [mode, setMode] = React.useState<'readable' | 'detailed'>('readable');
    return (
      <I18nProvider>
        <ExportSessionDialog
          open
          onOpenChange={() => {}}
          formats={['markdown', 'html', 'json']}
          format={format}
          onFormatChange={setFormat}
          mode={mode}
          onModeChange={setMode}
          descendantCount={options.descendantCount ?? 0}
          sessionListComplete={options.sessionListComplete ?? true}
          includeSubagents={includeSubagents}
          onIncludeSubagentsChange={setIncludeSubagents}
          onConfirm={(nextFormat, nextMode, include) => {
            chosen.push({ format: nextFormat, mode: nextMode, includeSubagents: include });
            options.onConfirm?.({ format: nextFormat, mode: nextMode, includeSubagents: include });
          }}
        />
      </I18nProvider>
    );
  };

  await act(async () => {
    root.render(<Harness />);
  });

  // A choice is picked by what it says: a radio's own button carries no
  // text, so the label beside it names it.
  const click = async (label: string) => {
    const target = [...container.querySelectorAll<HTMLElement>('button, label')].find((candidate) => {
      const text = candidate.textContent?.trim() ?? '';
      return text === label || candidate.getAttribute('aria-label') === label;
    });
    expect(target).toBeTruthy();
    await act(async () => {
      target?.click();
    });
  };

  // The sub-agent switch is a checkbox, and the reader turns it by clicking
  // it.
  const toggle = async () => {
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box).toBeTruthy();
    await act(async () => {
      box?.click();
    });
  };

  return { container, text: () => container.textContent ?? '', click, toggle, chosen };
};

describe('ExportSessionDialog', () => {
  test('offers the three formats and names what each is for', async () => {
    const dialog = await render({});
    const text = dialog.text();

    expect(text).toContain('Markdown');
    expect(text).toContain('HTML');
    expect(text).toContain('JSON');
    expect(text).toContain('readable conversation');
    expect(text).toContain('search and filters');
    expect(text).toContain('source records');
  });

  test('confirms the default format and the readable detail level', async () => {
    let choice: Choice | undefined;
    const dialog = await render({ onConfirm: (value) => { choice = value; } });

    await dialog.click('Export');

    expect(choice?.format).toBe('markdown');
    expect(choice?.mode).toBe('readable');
  });

  test('choosing the full detail level is what the export writes', async () => {
    let choice: Choice | undefined;
    const dialog = await render({ onConfirm: (value) => { choice = value; } });

    await dialog.click('Full details');
    await dialog.click('Export');

    expect(choice?.mode).toBe('detailed');
  });

  test('the detail level belongs to the readable formats, not to JSON', async () => {
    const dialog = await render({});
    expect(dialog.text()).toContain('Full details');

    await dialog.click('JSON');

    expect(dialog.text()).not.toContain('Full details');
  });

  test('the HTML export offers the detail level too', async () => {
    const dialog = await render({});
    expect(dialog.text()).toContain('Full details');

    await dialog.click('HTML');

    expect(dialog.text()).toContain('Full details');
  });

  test('a session without sub-agent tasks does not offer them', async () => {
    const dialog = await render({ descendantCount: 0 });
    expect(dialog.text()).not.toContain('Include sub-agent tasks');
  });

  test('a session with sub-agent sessions offers them', async () => {
    const dialog = await render({ descendantCount: 2 });
    expect(dialog.text()).toContain('Include sub-agent tasks');
    expect(dialog.text()).toContain('2 sub-agent sessions');
  });

  test('a session whose list is still being read keeps the sub-agent switch', async () => {
    // The number of sub-agent sessions is not known yet, but the reader may
    // still have a choice to make about them, so the switch stays.
    const dialog = await render({ sessionListComplete: false });
    expect(dialog.text()).toContain('The number of sub-agent sessions is not known yet');
    expect(dialog.text()).toContain('Include sub-agent tasks');
  });

  test('the text of an unknown count says what the choice will do', async () => {
    // The export follows the switch, so the text has to follow it too.
    const included = await render({ sessionListComplete: false });
    expect(included.text()).toContain('The export will include the sub-agent work it finds');

    const excluded = await render({ sessionListComplete: false, includeSubagents: false });
    expect(excluded.text()).toContain('The export will leave the sub-agent work out');
    expect(excluded.text()).not.toContain('The export will include the sub-agent work it finds');
  });

  test('the sub-agent switch works while the count is unknown', async () => {
    let choice: Choice | undefined;
    const dialog = await render({ sessionListComplete: false, onConfirm: (value) => { choice = value; } });

    await dialog.toggle();
    await dialog.click('Export');

    expect(choice?.includeSubagents).toBe(false);
  });
});
