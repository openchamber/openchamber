import { describe, expect, test } from 'bun:test';
import type { VSCodeThemeKind, VSCodeThemePayload } from '@openchamber/ui/lib/theme/vscode/adapter';
import { startVSCodeThemeBootstrap } from './vscodeThemeBootstrap';

// See issue #7262: a fork may inject the webview's `--vscode-*` variables
// after the bundle evaluates, so the bootstrap read can come back without
// editor colors. The stub carries the variables and the theme event surface
// the real read and publish touch; the frame clock stands in for animation
// frames.

interface WebviewDom {
  setVariable: (name: string, value: string) => void;
  published: VSCodeThemePayload[];
}

const installWebviewDom = (): WebviewDom => {
  const variables = new Map<string, string>();
  let themeMeta: { setAttribute: (name: string, value: string) => void } | null = null;

  const classList = (classes: Set<string>) => ({
    add: (name: string) => { classes.add(name); },
    remove: (...names: string[]) => { names.forEach((name) => classes.delete(name)); },
    contains: (name: string) => classes.has(name),
  });

  const documentStub = {
    documentElement: { classList: classList(new Set<string>()), style: {} },
    body: { classList: classList(new Set<string>()), style: { backgroundColor: '' } },
    head: { appendChild: (element: { setAttribute: (name: string, value: string) => void }) => { themeMeta = element; } },
    querySelector: () => themeMeta,
    createElement: () => ({ setAttribute: (_name: string, _value: string) => undefined }),
  };

  const published: VSCodeThemePayload[] = [];
  const windowStub = {
    matchMedia: () => ({ matches: false }),
    dispatchEvent: (event: { type: string; detail?: VSCodeThemePayload }) => {
      if (event.type === 'openchamber:vscode-theme' && event.detail) {
        published.push(event.detail);
      }
      return true;
    },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({
      getPropertyValue: (name: string) => variables.get(name) ?? '',
    }),
  });

  return {
    setVariable: (name: string, value: string) => { variables.set(name, value); },
    published,
  };
};

interface FrameClock {
  schedule: (callback: () => void) => number;
  tick: (frames?: number) => void;
  pending: () => number;
}

const frameClock = (): FrameClock => {
  const queue: Array<() => void> = [];
  return {
    schedule: (callback: () => void) => {
      queue.push(callback);
      return queue.length;
    },
    tick: (frames = 1) => {
      for (let i = 0; i < frames; i += 1) {
        const callback = queue.shift();
        if (!callback) break;
        callback();
      }
    },
    pending: () => queue.length,
  };
};

describe('startVSCodeThemeBootstrap', () => {
  test('a read with editor colors publishes once and schedules no re-read', () => {
    const dom = installWebviewDom();
    dom.setVariable('--vscode-editor-background', '#1e1e2e');
    dom.setVariable('--vscode-editor-foreground', '#cdd6f4');
    const clock = frameClock();

    startVSCodeThemeBootstrap(() => 'dark', { schedule: clock.schedule });

    expect(dom.published).toHaveLength(1);
    expect(dom.published[0]?.palette.colors['editor.background']).toBe('#1e1e2e');
    expect(dom.published[0]?.palette.kind).toBe('dark');
    expect(clock.pending()).toBe(0);
    clock.tick(3);
    expect(dom.published).toHaveLength(1);
  });

  test('a read without editor colors re-reads per frame until the variables arrive', () => {
    const dom = installWebviewDom();
    const clock = frameClock();

    startVSCodeThemeBootstrap(() => 'dark', { schedule: clock.schedule });

    expect(dom.published).toHaveLength(1);
    expect(Object.keys(dom.published[0]?.palette.colors ?? {})).toHaveLength(0);

    // Past the two re-reads a theme change already gets, the read is still
    // empty and a re-read is still waiting.
    clock.tick(5);
    expect(dom.published).toHaveLength(1);
    expect(clock.pending()).toBe(1);

    // A fork injects the variables after the webview has loaded.
    dom.setVariable('--vscode-editor-background', '#1e1e2e');
    dom.setVariable('--vscode-editor-foreground', '#cdd6f4');
    clock.tick(1);

    expect(dom.published).toHaveLength(2);
    expect(dom.published[1]?.palette.colors['editor.background']).toBe('#1e1e2e');
    expect(dom.published[1]?.theme.colors.surface.background).toBe('#1e1e2e');
    expect(clock.pending()).toBe(0);
    clock.tick(2);
    expect(dom.published).toHaveLength(2);
  });

  test('an unrelated token arriving first keeps the re-read waiting for the editor canvas and text', () => {
    const dom = installWebviewDom();
    const clock = frameClock();

    startVSCodeThemeBootstrap(() => 'dark', { schedule: clock.schedule });

    dom.setVariable('--vscode-focusBorder', '#007acc');
    clock.tick(3);
    expect(dom.published).toHaveLength(1);
    expect(clock.pending()).toBe(1);

    dom.setVariable('--vscode-editor-background', '#133355');
    dom.setVariable('--vscode-editor-foreground', '#cdd6f4');
    clock.tick(1);

    expect(dom.published).toHaveLength(2);
    expect(dom.published[1]?.theme.colors.surface.background).toBe('#133355');
    expect(clock.pending()).toBe(0);
  });

  test('the re-read stops when the variables never arrive', () => {
    const dom = installWebviewDom();
    const clock = frameClock();

    startVSCodeThemeBootstrap(() => 'dark', { schedule: clock.schedule });

    clock.tick(200);

    expect(dom.published).toHaveLength(1);
    expect(Object.keys(dom.published[0]?.palette.colors ?? {})).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  test('the re-read publishes under the kind the host last reported', () => {
    const dom = installWebviewDom();
    const clock = frameClock();
    let kind: VSCodeThemeKind = 'dark';

    startVSCodeThemeBootstrap(() => kind, { schedule: clock.schedule });

    clock.tick(1);
    kind = 'light';
    dom.setVariable('--vscode-editor-background', '#eff1f3');
    dom.setVariable('--vscode-editor-foreground', '#3c4043');
    clock.tick(1);

    expect(dom.published).toHaveLength(2);
    expect(dom.published[1]?.palette.kind).toBe('light');
    expect(dom.published[1]?.palette.colors['editor.background']).toBe('#eff1f3');
  });

  test('the published theme lands on the window global the shared UI reads', () => {
    const dom = installWebviewDom();
    dom.setVariable('--vscode-editor-background', '#1e1e2e');
    dom.setVariable('--vscode-editor-foreground', '#cdd6f4');
    const clock = frameClock();

    startVSCodeThemeBootstrap(() => 'dark', { schedule: clock.schedule });

    expect(window.__OPENCHAMBER_VSCODE_THEME__?.metadata.variant).toBe('dark');
  });
});
