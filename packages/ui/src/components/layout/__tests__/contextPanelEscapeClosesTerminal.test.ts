/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2644
 *
 * Escape while focus is inside the terminal must reach the PTY (e.g. Vim
 * Normal mode). The context panel still closes on Escape when focus is on
 * non-terminal panel chrome.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');
const mobileWorkspaceDrawerSource = readFileSync(
  join(__dirname, '..', '..', '..', 'apps', 'MobileWorkspaceDrawer.tsx'),
  'utf-8',
);

describe('issue #2644: Escape in terminal must not close the context panel', () => {
  test('the context panel captures Escape at the panel level', () => {
    expect(contextPanelSource).toContain('onKeyDownCapture={handlePanelKeyDownCapture}');
  });

  test('the capture handler skips closing when the event target is inside the terminal', () => {
    const start = contextPanelSource.indexOf('const handlePanelKeyDownCapture = React.useCallback(');
    expect(start).toBeGreaterThan(-1);
    const end = contextPanelSource.indexOf('}, [handleClose]);', start);
    expect(end).toBeGreaterThan(start);
    const handler = contextPanelSource.slice(start, end);

    expect(handler).toContain("event.key !== 'Escape'");
    expect(handler).toContain('isTerminalEventTarget(event.target)');
    expect(handler).toContain('event.preventDefault()');
    expect(handler).toContain('event.stopPropagation()');
    expect(handler).toContain('handleClose()');

    // Guard must return before preventDefault/stopPropagation so ghostty-web's
    // bubble-phase keydown listener can forward Escape to the PTY.
    const guardIndex = handler.indexOf('isTerminalEventTarget(event.target)');
    const preventIndex = handler.indexOf('event.preventDefault()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(preventIndex).toBeGreaterThan(guardIndex);
  });

  test('ContextPanel imports the shared terminal focus helper', () => {
    expect(contextPanelSource).toContain("from '@/lib/terminalFocus'");
    expect(contextPanelSource).toContain('isTerminalEventTarget');
  });

  test('mobile drawer keeps its terminal Escape exception', () => {
    const handlerStart = mobileWorkspaceDrawerSource.indexOf("if (event.key === 'Escape'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mobileWorkspaceDrawerSource.slice(handlerStart, handlerStart + 200);
    expect(handler).toContain("tabRef.current !== 'terminal'");
  });
});

type Listener = { capture: boolean; onEvent: (event: SimulatedEvent) => void };
type SimulatedEvent = {
  type: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  target: SimNode;
  preventDefault(): void;
  stopPropagation(): void;
};

class SimNode {
  readonly children: SimNode[] = [];
  private listeners: Listener[] = [];
  private parent: SimNode | null = null;

  addListener(listener: Listener): void {
    this.listeners.push(listener);
  }

  attach(child: SimNode): void {
    child.parent = this;
    this.children.push(child);
  }

  dispatch(type: string): SimulatedEvent {
    const buildPath = (target: SimNode): SimNode[] => {
      const ancestors: SimNode[] = [];
      let cursor: SimNode | null = target;
      while (cursor !== null) {
        ancestors.push(cursor);
        cursor = cursor.parent;
      }
      ancestors.reverse();
      return ancestors;
    };
    const path = buildPath(this);

    const event: SimulatedEvent = {
      type,
      defaultPrevented: false,
      propagationStopped: false,
      target: this,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        event.propagationStopped = true;
      },
    };

    for (let i = 0; i < path.length; i += 1) {
      if (event.propagationStopped) return event;
      for (const listener of path[i].listeners) {
        if (!listener.capture) continue;
        listener.onEvent(event);
        if (event.propagationStopped) return event;
      }
    }
    for (let i = path.length - 1; i >= 0; i -= 1) {
      if (event.propagationStopped) return event;
      for (const listener of path[i].listeners) {
        if (listener.capture) continue;
        listener.onEvent(event);
        if (event.propagationStopped) return event;
      }
    }
    return event;
  }
}

describe('issue #2644: fixed Escape propagation to the terminal', () => {
  test('when the panel skips terminal Escape, the terminal bubble handler receives it', () => {
    const panel = new SimNode();
    const terminalContainer = new SimNode();
    panel.attach(terminalContainer);

    const calls: string[] = [];
    const panelEscapeHandler = (event: SimulatedEvent) => {
      // Fixed behavior: do not close / stop when the target is the terminal.
      if (event.target === terminalContainer) {
        calls.push('panel-capture-skipped');
        return;
      }
      calls.push('panel-capture-closed');
      event.preventDefault();
      event.stopPropagation();
    };
    const terminalKeydownHandler = () => {
      calls.push('terminal-bubble');
    };

    panel.addListener({ capture: true, onEvent: panelEscapeHandler });
    terminalContainer.addListener({ capture: false, onEvent: terminalKeydownHandler });

    const event = terminalContainer.dispatch('keydown');

    expect(calls).toEqual(['panel-capture-skipped', 'terminal-bubble']);
    expect(event.propagationStopped).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('Escape outside the terminal still closes via the capture handler', () => {
    const panel = new SimNode();
    const headerButton = new SimNode();
    const terminalContainer = new SimNode();
    panel.attach(headerButton);
    panel.attach(terminalContainer);

    const calls: string[] = [];
    panel.addListener({
      capture: true,
      onEvent: (event) => {
        if (event.target === terminalContainer) return;
        calls.push('panel-capture-closed');
        event.preventDefault();
        event.stopPropagation();
      },
    });
    terminalContainer.addListener({
      capture: false,
      onEvent: () => calls.push('terminal-bubble'),
    });

    const event = headerButton.dispatch('keydown');
    expect(calls).toEqual(['panel-capture-closed']);
    expect(event.propagationStopped).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });
});
