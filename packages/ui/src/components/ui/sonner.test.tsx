import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';

import { Toaster } from './sonner';

describe('Toaster', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    toast.dismiss();
    windowInstance.close();
  });

  test('pins toast elevation without querying the document on unrelated DOM changes', async () => {
    await act(async () => root.render(<Toaster />));

    const documentQueries = spyOn(document, 'querySelectorAll');

    await act(async () => {
      toast('Saved');
    });
    await settle();

    const toastElement = document.querySelector<HTMLElement>('[data-sonner-toast]');
    expect(toastElement).not.toBeNull();
    expect(toastElement?.style.getPropertyPriority('box-shadow')).toBe('important');
    expect(toastElement?.style.getPropertyPriority('outline')).toBe('important');
    expect(toastElement?.getAttribute('tabindex')).toBe('-1');

    // What streaming does to the rest of the app: DOM writes outside the toaster.
    // Sonner itself may query while it shows a toast; only what follows counts.
    const queriesBefore = documentQueries.mock.calls.length;
    const transcript = document.createElement('div');
    document.body.append(transcript);
    for (let index = 0; index < 20; index += 1) {
      const token = document.createElement('span');
      token.textContent = `token ${index}`;
      transcript.append(token);
      transcript.setAttribute('style', `height: ${index}px`);
    }
    await settle();

    expect(documentQueries.mock.calls.length).toBe(queriesBefore);
  });

  test('draws a loading toast with the app spinner in place of sonner\'s own', async () => {
    await act(async () => root.render(<Toaster />));

    await act(async () => {
      toast.loading('Saving images');
    });
    await settle();

    const icon = document.querySelector('[data-sonner-toast] [data-icon]');
    expect(icon?.querySelector('[data-spinner]')).not.toBeNull();
    expect(icon?.querySelector('.sonner-loading-bar')).toBeNull();
  });
});
