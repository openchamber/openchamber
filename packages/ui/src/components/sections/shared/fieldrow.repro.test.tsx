import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';

// Browser-generated passkeys (e.g. Edge on Windows) use the full user-agent
// string as the device label, so it is very long.
const longLabel =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';

let windowInstance: Window;
let host: HTMLDivElement;
let root: Root;

afterEach(() => {
  root?.unmount();
});

describe('PasskeySettings long device-name label (issue #3181)', () => {
  test('label truncation requires min-w-0 on every flex ancestor', async () => {
    windowInstance = new Window({ width: 1000, height: 800 });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root.render(
        // Mirrors the PasskeySettings row (label = passkey.label with `truncate`).
        <SettingsFieldRow
          label={<span className="truncate">{longLabel}</span>}
          alignEnd={false}
          controlClassName="justify-between sm:flex-1"
        >
          <span className="typography-meta text-muted-foreground truncate">Added Aug 27, 2026</span>
          <button>Delete</button>
        </SettingsFieldRow>,
      );
    });

    // For `truncate` (overflow:hidden + text-overflow:ellipsis + white-space:nowrap)
    // to constrain a flex child, every flex ancestor between the row and the
    // truncated element must carry min-w-0. Without it, the flex item's default
    // min-width:auto stops it shrinking, and the long text overflows the 224px
    // label column, overlaying the date and delete button in the control column.
    const row = host.firstElementChild as HTMLElement;
    const labelColumn = row?.firstElementChild as HTMLElement;
    const innerFlex = labelColumn?.firstElementChild as HTMLElement;
    const labelDiv = innerFlex?.firstElementChild as HTMLElement;
    const labelSpan = labelDiv?.firstElementChild as HTMLElement;

    const flexAncestors = [labelColumn, innerFlex, labelDiv].filter(Boolean);
    const missingMinW0 = flexAncestors.filter(
      (el) => !String(el.className).split(/\s+/).includes('min-w-0'),
    );

    expect(labelSpan?.className.split(/\s+/)).toContain('truncate');
    // Repro: two intermediate flex containers lack min-w-0, so the ellipsis is
    // inert and the long label overflows its column.
    expect(missingMinW0.length).toBe(0);
  });
});
